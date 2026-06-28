"""记忆质量加固测试。

覆盖 docs/LONG_TERM_MEMORY_ARCHITECTURE.md 第 5、6 节：
- 写入去重（content_hash）
- 召回距离阈值过滤
- 事实键规范校验
- episode 长度限制
- 元数据完整性（salience/topic/content_hash/embedding_model/status/access_count）
- 用户控制方法（list_facts/list_episodes/delete_episode/export_all/clear_all）

测试隔离：沿用 test_memory_integrity.py 的 mock chromadb 模式，不依赖真实向量库或 .env。
"""
import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch, AsyncMock


def load_memory_module():
    """加载 memory.py，mock 掉 chromadb / services / config 的外部依赖。"""
    chromadb = types.ModuleType("chromadb")
    chromadb_config = types.ModuleType("chromadb.config")
    chromadb_config.Settings = object
    services = types.ModuleType("services")
    services.AIService = types.SimpleNamespace(get_embedding=AsyncMock(return_value=[0.1, 0.2]))
    config = types.ModuleType("config")
    config.Config = types.SimpleNamespace(DATA_DIR="/tmp/neuro_test", LLM_MODEL="test-model")
    config.ensure_data_dir = lambda *a, **k: "/tmp/neuro_test"
    path = Path(__file__).with_name("memory.py")
    spec = importlib.util.spec_from_file_location("memory_quality_under_test", path)
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {
        "chromadb": chromadb,
        "chromadb.config": chromadb_config,
        "services": services,
        "config": config,
    }):
        spec.loader.exec_module(module)
    return module


class FakeCollection:
    """模拟 Chroma collection，记录 add/get/query/delete/update 调用。"""

    def __init__(self):
        self.docs = {}  # id -> {"document": str, "metadata": dict}
        self.name = "episodes_test"

    def count(self):
        return len(self.docs)

    def add(self, *, documents, embeddings, metadatas, ids):
        for doc, meta, eid in zip(documents, metadatas, ids):
            self.docs[eid] = {"document": doc, "metadata": dict(meta)}

    def get(self, *, limit=None, offset=0, where=None, ids=None, include=None):
        if ids:
            return {
                "ids": [i for i in ids if i in self.docs],
                "documents": [self.docs[i]["document"] for i in ids if i in self.docs],
                "metadatas": [dict(self.docs[i]["metadata"]) for i in ids if i in self.docs],
            }
        items = list(self.docs.items())
        # where 过滤（简单实现：所有 key 都需匹配）
        if where:
            filtered = []
            for eid, entry in items:
                meta = entry["metadata"]
                if all(meta.get(k) == v for k, v in where.items()):
                    filtered.append((eid, entry))
            items = filtered
        items = items[offset:]
        if limit is not None:
            items = items[:limit]
        return {
            "ids": [eid for eid, _ in items],
            "documents": [e["document"] for _, e in items],
            "metadatas": [dict(e["metadata"]) for _, e in items],
        }

    def query(self, *, query_embeddings, n_results):
        # 返回所有记忆，距离按存储顺序递增（测试用，不真实但足够覆盖逻辑）
        items = list(self.docs.items())
        docs = [e["document"] for _, e in items][:n_results]
        metas = [dict(e["metadata"]) for _, e in items][:n_results]
        ids = [eid for eid, _ in items][:n_results]
        # 距离递增：第一条最近(0.1)，往后越来越远
        distances = [0.1 + i * 0.2 for i in range(len(docs))]
        return {"ids": [ids], "documents": [docs], "metadatas": [metas], "distances": [distances]}

    def update(self, *, ids, metadatas):
        for eid, meta in zip(ids, metadatas):
            if eid in self.docs:
                self.docs[eid]["metadata"].update(meta)

    def delete(self, *, ids):
        for eid in ids:
            self.docs.pop(eid, None)


class FakeChroma:
    def __init__(self):
        self.collections = {}

    def get_or_create_collection(self, name):
        if name not in self.collections:
            self.collections[name] = FakeCollection()
        return self.collections[name]

    def delete_collection(self, name):
        self.collections.pop(name, None)


def _make_store(memory_module, tmpdir):
    """构造一个 MemorySystem 实例，注入 fake chroma 和临时 facts 路径。"""
    store = object.__new__(memory_module.MemorySystem)
    store.user_id = "test_user"
    store.facts_dir = tmpdir
    store.facts_path = str(Path(tmpdir) / "facts.json")
    store.facts = {}
    store.chroma = FakeChroma()
    store.episodic_col = store.chroma.get_or_create_collection("episodes_test")
    return store


class WriteQualityTest(unittest.IsolatedAsyncioTestCase):
    """写入质量：去重、键规范、长度限制、元数据完整性。"""

    async def test_duplicate_episode_is_not_written_twice(self):
        m = load_memory_module()
        with tempfile.TemporaryDirectory() as d:
            store = _make_store(m, d)
            await store.execute_updates({"new_episode": "主人今天说他正在学吉他"})
            self.assertEqual(store.episodic_col.count(), 1)
            # 同一句话（哪怕空白不同）不应重复写入
            await store.execute_updates({"new_episode": "  主人今天说他正在学吉他  "})
            self.assertEqual(store.episodic_col.count(), 1, "重复 episode 应被去重")

    async def test_invalid_fact_keys_are_rejected(self):
        m = load_memory_module()
        with tempfile.TemporaryDirectory() as d:
            store = _make_store(m, d)
            await store.execute_updates({
                "new_facts": {
                    "favorite_drink": "无糖咖啡",   # 合法
                    "BadKey": "应被拒绝",            # 大写非法
                    "with space": "应被拒绝",        # 空格非法
                    "a" * 65: "应被拒绝",            # 超长非法
                    "ok_key_123": "合法",            # 合法
                }
            })
            self.assertEqual(store.facts, {"favorite_drink": "无糖咖啡", "ok_key_123": "合法"})

    async def test_episode_over_length_is_truncated(self):
        m = load_memory_module()
        with tempfile.TemporaryDirectory() as d:
            store = _make_store(m, d)
            long_text = "主人在学吉他" + "啊" * 600
            await store.execute_updates({"new_episode": long_text})
            self.assertEqual(store.episodic_col.count(), 1)
            stored_doc = list(store.episodic_col.docs.values())[0]["document"]
            self.assertLessEqual(len(stored_doc), m.EPISODE_MAX_LEN)

    async def test_episode_metadata_is_complete(self):
        m = load_memory_module()
        with tempfile.TemporaryDirectory() as d:
            store = _make_store(m, d)
            await store.execute_updates(
                {"new_episode": "主人答应周末陪我看电影"},
                emotion="love",
            )
            meta = list(store.episodic_col.docs.values())[0]["metadata"]
            # 必须有的字段（架构文档 4.2）
            for key in ("content_hash", "salience", "topic", "embedding_model",
                        "status", "access_count", "last_accessed_at", "date", "emotion"):
                self.assertIn(key, meta, f"元数据缺少 {key}")
            self.assertEqual(meta["emotion"], "love")
            self.assertEqual(meta["status"], "active")
            self.assertEqual(meta["embedding_model"], "test-model")
            self.assertEqual(meta["access_count"], 0)
            # "答应" 命中高重要词 → salience 0.9
            self.assertAlmostEqual(meta["salience"], 0.9)
            self.assertEqual(meta["topic"], "life")  # 命中"电影"

    async def test_empty_and_malformed_instructions_are_ignored(self):
        m = load_memory_module()
        with tempfile.TemporaryDirectory() as d:
            store = _make_store(m, d)
            for instruction in (None, [], "string", {"new_facts": "not_dict"}, {"new_episode": {}}):
                await store.execute_updates(instruction)
            self.assertEqual(store.episodic_col.count(), 0)
            self.assertEqual(store.facts, {})


class RecallQualityTest(unittest.IsolatedAsyncioTestCase):
    """召回质量：距离阈值过滤、去重、访问元数据更新。"""

    async def test_recall_filters_out_irrelevant_by_distance(self):
        m = load_memory_module()
        # patch RECALL_DISTANCE_LIMIT 到 0.5，让 FakeCollection 的距离 0.1+0.2*i 中
        # 第 3 条(0.5)、第 4 条(0.7) 被过滤
        with patch.object(m, "RECALL_DISTANCE_LIMIT", 0.45):
            with tempfile.TemporaryDirectory() as d:
                store = _make_store(m, d)
                # 灌 5 条记忆
                for i in range(5):
                    await store.execute_updates({"new_episode": f"事件 {i}"})
                # 距离序列 0.1,0.3,0.5,0.7,0.9 → 只有前 2 条通过阈值
                ctx = await store.get_longmemory_context("查询")
                self.assertIn("事件 0", ctx)
                self.assertIn("事件 1", ctx)
                self.assertNotIn("事件 2", ctx, "距离超阈值的记忆不应进入 Prompt")

    async def test_recall_updates_access_count(self):
        m = load_memory_module()
        with tempfile.TemporaryDirectory() as d:
            store = _make_store(m, d)
            await store.execute_updates({"new_episode": "主人喜欢喝无糖咖啡"})
            before = list(store.episodic_col.docs.values())[0]["metadata"]["access_count"]
            self.assertEqual(before, 0)
            await store.get_longmemory_context("咖啡")
            after = list(store.episodic_col.docs.values())[0]["metadata"]["access_count"]
            self.assertGreater(after, 0, "召回后 access_count 应递增")

    async def test_recall_dedupes_same_content_hash(self):
        m = load_memory_module()
        with tempfile.TemporaryDirectory() as d:
            store = _make_store(m, d)
            # 手动灌两条 content_hash 相同的记忆（绕过写入去重）
            eid1, eid2 = "id1", "id2"
            shared_hash = "samehash"
            store.episodic_col.docs[eid1] = {
                "document": "主人喜欢咖啡", "metadata": {"date": "2026-06-01", "content_hash": shared_hash, "salience": 0.4}
            }
            store.episodic_col.docs[eid2] = {
                "document": "主人喜欢咖啡", "metadata": {"date": "2026-06-02", "content_hash": shared_hash, "salience": 0.4}
            }
            ctx = await store.get_longmemory_context("咖啡")
            # 同 hash 只应出现一次
            self.assertEqual(ctx.count("主人喜欢咖啡"), 1)


class UserControlTest(unittest.IsolatedAsyncioTestCase):
    """用户控制：list_facts / list_episodes / delete_episode / export_all / clear_all。"""

    async def test_list_facts_returns_readonly_copy(self):
        m = load_memory_module()
        with tempfile.TemporaryDirectory() as d:
            store = _make_store(m, d)
            store.facts = {"favorite_drink": "咖啡"}
            result = store.list_facts()
            self.assertEqual(result, {"favorite_drink": "咖啡"})
            result["favorite_drink"] = "茶"  # 修改副本不应影响原数据
            self.assertEqual(store.facts["favorite_drink"], "咖啡")

    async def test_list_episodes_returns_metadata(self):
        m = load_memory_module()
        with tempfile.TemporaryDirectory() as d:
            store = _make_store(m, d)
            await store.execute_updates({"new_episode": "主人在学吉他"}, emotion="happy")
            episodes = store.list_episodes()
            self.assertEqual(len(episodes), 1)
            ep = episodes[0]
            for key in ("id", "content", "date", "emotion", "salience", "topic", "access_count"):
                self.assertIn(key, ep)
            self.assertEqual(ep["emotion"], "happy")

    async def test_delete_episode_removes_it(self):
        m = load_memory_module()
        with tempfile.TemporaryDirectory() as d:
            store = _make_store(m, d)
            await store.execute_updates({"new_episode": "事件 A"})
            eid = list(store.episodic_col.docs.keys())[0]
            ok = store.delete_episode(eid)
            self.assertTrue(ok)
            self.assertEqual(store.episodic_col.count(), 0)

    async def test_delete_episode_rejects_bad_id(self):
        m = load_memory_module()
        with tempfile.TemporaryDirectory() as d:
            store = _make_store(m, d)
            self.assertFalse(store.delete_episode(""))
            self.assertFalse(store.delete_episode(None))
            self.assertFalse(store.delete_episode(123))

    async def test_export_all_contains_facts_and_episodes(self):
        m = load_memory_module()
        with tempfile.TemporaryDirectory() as d:
            store = _make_store(m, d)
            store.facts = {"name": "主人"}
            await store.execute_updates({"new_episode": "事件 X"})
            exported = store.export_all()
            self.assertEqual(exported["user_id"], "test_user")
            self.assertIn("exported_at", exported)
            self.assertEqual(exported["facts"], {"name": "主人"})
            self.assertEqual(len(exported["episodes"]), 1)

    async def test_clear_all_wipes_facts_and_episodes(self):
        m = load_memory_module()
        with tempfile.TemporaryDirectory() as d:
            store = _make_store(m, d)
            store.facts = {"a": "b"}
            await store.execute_updates({"new_episode": "事件 Y"})
            self.assertGreater(store.episodic_col.count(), 0)
            result = store.clear_all()
            self.assertEqual(result["facts_cleared"], 1)
            self.assertEqual(result["episodes_cleared"], 1)
            self.assertEqual(store.facts, {})
            self.assertEqual(store.episodic_col.count(), 0)


class HelpersTest(unittest.TestCase):
    """纯函数：hash 规范化、键校验、主题分类、重要度估计。"""

    def test_content_hash_ignores_whitespace(self):
        m = load_memory_module()
        self.assertEqual(m._content_hash("主人 喜欢 咖啡"), m._content_hash("主人喜欢咖啡"))
        self.assertEqual(m._content_hash("  主人\n喜欢\t咖啡  "), m._content_hash("主人喜欢咖啡"))

    def test_is_valid_fact_key(self):
        m = load_memory_module()
        self.assertTrue(m._is_valid_fact_key("favorite_drink"))
        self.assertTrue(m._is_valid_fact_key("a1_b2_c3"))
        self.assertFalse(m._is_valid_fact_key("BadKey"))
        self.assertFalse(m._is_valid_fact_key("with space"))
        self.assertFalse(m._is_valid_fact_key(""))
        self.assertFalse(m._is_valid_fact_key("a" * 65))
        self.assertFalse(m._is_valid_fact_key(None))

    def test_classify_topic(self):
        m = load_memory_module()
        self.assertEqual(m._classify_topic("主人在做 Godot 项目"), "work")
        self.assertEqual(m._classify_topic("主人准备考研"), "study")
        self.assertEqual(m._classify_topic("周末去看电影"), "life")
        self.assertEqual(m._classify_topic("主人对花生过敏"), "health")
        self.assertEqual(m._classify_topic("主人和妈妈打电话"), "relation")
        self.assertEqual(m._classify_topic("今天天气不错"), "other")

    def test_estimate_salience(self):
        m = load_memory_module()
        self.assertAlmostEqual(m._estimate_salience("主人答应周末陪我"), 0.9)
        self.assertAlmostEqual(m._estimate_salience("主人正在准备面试"), 0.6)
        self.assertAlmostEqual(m._estimate_salience("今天吃了火锅"), 0.4)
        self.assertAlmostEqual(m._estimate_salience(""), 0.2)


if __name__ == "__main__":
    unittest.main()
