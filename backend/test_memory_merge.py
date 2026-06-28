"""会话总结合并 / 事实冲突 / 记忆触发主动搭话 的测试。

覆盖：
- merge_similar_episodes：超阈值触发、相似对合并、原记录归档、摘要写入
- 事实冲突：新旧值不同记录冲突、get_fact_context 注入提示、consume 清空
- pick_unrecalled_highlight：优先高 salience 低 access_count、无候选返回 None

沿用 test_memory_quality.py 的 mock 模式。
"""
import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch, AsyncMock


def load_memory_module():
    chromadb = types.ModuleType("chromadb")
    chromadb_config = types.ModuleType("chromadb.config")
    chromadb_config.Settings = object
    services = types.ModuleType("services")
    services.AIService = types.SimpleNamespace(get_embedding=AsyncMock(return_value=[0.1, 0.2]))
    config = types.ModuleType("config")
    config.Config = types.SimpleNamespace(DATA_DIR="/tmp/neuro_test", LLM_MODEL="test-model")
    config.ensure_data_dir = lambda *a, **k: "/tmp/neuro_test"
    path = Path(__file__).with_name("memory.py")
    spec = importlib.util.spec_from_file_location("memory_merge_under_test", path)
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
    """模拟 Chroma collection，支持 where 过滤和 embeddings。"""

    def __init__(self):
        self.docs = {}  # id -> {"document": str, "metadata": dict, "embedding": list}

    def count(self):
        return len(self.docs)

    def add(self, *, documents, embeddings, metadatas, ids):
        for doc, emb, meta, eid in zip(documents, embeddings, metadatas, ids):
            self.docs[eid] = {"document": doc, "metadata": dict(meta), "embedding": list(emb)}

    def get(self, *, limit=None, offset=0, where=None, ids=None, include=None):
        if ids:
            return {
                "ids": [i for i in ids if i in self.docs],
                "documents": [self.docs[i]["document"] for i in ids if i in self.docs],
                "metadatas": [dict(self.docs[i]["metadata"]) for i in ids if i in self.docs],
                "embeddings": [self.docs[i]["embedding"] for i in ids if i in self.docs] if "embeddings" in (include or []) else [],
            }
        items = list(self.docs.items())
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
        result = {
            "ids": [eid for eid, _ in items],
            "documents": [e["document"] for _, e in items],
            "metadatas": [dict(e["metadata"]) for _, e in items],
        }
        if include and "embeddings" in include:
            result["embeddings"] = [e["embedding"] for _, e in items]
        return result

    def query(self, *, query_embeddings, n_results):
        items = list(self.docs.items())[:n_results]
        return {
            "ids": [[eid for eid, _ in items]],
            "documents": [[e["document"] for _, e in items]],
            "metadatas": [[dict(e["metadata"]) for _, e in items]],
            "distances": [[0.1 + i * 0.2 for i in range(len(items))]],
        }

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
    store = object.__new__(memory_module.MemorySystem)
    store.user_id = "test_user"
    store.facts_dir = tmpdir
    store.facts_path = str(Path(tmpdir) / "facts.json")
    store.facts = {}
    store.chroma = FakeChroma()
    store.episodic_col = store.chroma.get_or_create_collection("episodes_test")
    store._pending_fact_conflicts = []
    return store


class FactConflictTest(unittest.IsolatedAsyncioTestCase):
    """事实冲突：新旧值不同时记录，注入 prompt，消费后清空。"""

    async def test_conflict_recorded_when_value_changes(self):
        m = load_memory_module()
        with tempfile.TemporaryDirectory() as d:
            store = _make_store(m, d)
            store.facts = {"favorite_drink": "咖啡"}
            await store.execute_updates({"new_facts": {"favorite_drink": "茶"}})
            self.assertEqual(len(store._pending_fact_conflicts), 1)
            self.assertEqual(store._pending_fact_conflicts[0]["key"], "favorite_drink")
            self.assertEqual(store._pending_fact_conflicts[0]["old"], "咖啡")
            self.assertEqual(store._pending_fact_conflicts[0]["new"], "茶")

    async def test_no_conflict_when_value_same(self):
        m = load_memory_module()
        with tempfile.TemporaryDirectory() as d:
            store = _make_store(m, d)
            store.facts = {"favorite_drink": "咖啡"}
            await store.execute_updates({"new_facts": {"favorite_drink": "咖啡"}})
            self.assertEqual(len(store._pending_fact_conflicts), 0)

    async def test_no_conflict_when_key_new(self):
        m = load_memory_module()
        with tempfile.TemporaryDirectory() as d:
            store = _make_store(m, d)
            await store.execute_updates({"new_facts": {"new_key": "value"}})
            self.assertEqual(len(store._pending_fact_conflicts), 0)

    def test_get_fact_context_includes_conflict_hint(self):
        m = load_memory_module()
        with tempfile.TemporaryDirectory() as d:
            store = _make_store(m, d)
            store.facts = {"favorite_drink": "茶"}
            store._pending_fact_conflicts = [
                {"key": "favorite_drink", "old": "咖啡", "new": "茶"}
            ]
            ctx = store.get_fact_context()
            self.assertIn("事实冲突", ctx)
            self.assertIn("咖啡", ctx)
            self.assertIn("茶", ctx)
            self.assertIn("favorite_drink", ctx)

    def test_get_fact_context_no_hint_when_no_conflict(self):
        m = load_memory_module()
        with tempfile.TemporaryDirectory() as d:
            store = _make_store(m, d)
            store.facts = {"a": "b"}
            ctx = store.get_fact_context()
            self.assertNotIn("事实冲突", ctx)

    def test_consume_clears_conflicts(self):
        m = load_memory_module()
        with tempfile.TemporaryDirectory() as d:
            store = _make_store(m, d)
            store._pending_fact_conflicts = [{"key": "k", "old": "a", "new": "b"}]
            consumed = store.consume_fact_conflicts()
            self.assertEqual(len(consumed), 1)
            self.assertEqual(len(store._pending_fact_conflicts), 0)
            # 再消费一次应为空
            self.assertEqual(store.consume_fact_conflicts(), [])


class MergeTest(unittest.IsolatedAsyncioTestCase):
    """会话总结合并：相似记忆合并，原记录归档。"""

    async def test_merge_combines_similar_episodes(self):
        m = load_memory_module()
        with tempfile.TemporaryDirectory() as d:
            store = _make_store(m, d)
            # 灌两条相似的 embedding（距离接近 0）
            store.episodic_col.add(
                documents=["主人喜欢喝咖啡", "主人爱喝咖啡"],
                embeddings=[[1.0, 0.0], [0.99, 0.01]],
                metadatas=[
                    {"status": "active", "topic": "life", "salience": 0.4, "content_hash": "h1", "date": "2026-06-01"},
                    {"status": "active", "topic": "life", "salience": 0.4, "content_hash": "h2", "date": "2026-06-02"},
                ],
                ids=["e1", "e2"],
            )
            merged = store.merge_similar_episodes()
            self.assertGreaterEqual(merged, 1)
            # 原两条应标 archived
            for eid in ["e1", "e2"]:
                self.assertEqual(store.episodic_col.docs[eid]["metadata"]["status"], "archived")
            # 应新增一条摘要记录
            active_count = sum(1 for v in store.episodic_col.docs.values() if v["metadata"].get("status") == "active")
            self.assertGreaterEqual(active_count, 1)

    async def test_merge_skips_dissimilar_episodes(self):
        m = load_memory_module()
        with tempfile.TemporaryDirectory() as d:
            store = _make_store(m, d)
            # 两条不相似的 embedding（距离大）
            store.episodic_col.add(
                documents=["主人在学吉他", "主人在做项目"],
                embeddings=[[1.0, 0.0], [0.0, 1.0]],
                metadatas=[
                    {"status": "active", "topic": "study", "salience": 0.6, "content_hash": "h1", "date": "2026-06-01"},
                    {"status": "active", "topic": "work", "salience": 0.6, "content_hash": "h2", "date": "2026-06-02"},
                ],
                ids=["e1", "e2"],
            )
            merged = store.merge_similar_episodes()
            self.assertEqual(merged, 0)
            # 两条仍 active
            self.assertEqual(store.episodic_col.docs["e1"]["metadata"]["status"], "active")
            self.assertEqual(store.episodic_col.docs["e2"]["metadata"]["status"], "active")

    async def test_merge_respects_batch_size(self):
        m = load_memory_module()
        with patch.object(m, "MERGE_BATCH_SIZE", 2):
            with tempfile.TemporaryDirectory() as d:
                store = _make_store(m, d)
                # 灌 6 条全相似的
                store.episodic_col.add(
                    documents=[f"事件 {i}" for i in range(6)],
                    embeddings=[[1.0, 0.0] for _ in range(6)],
                    metadatas=[
                        {"status": "active", "topic": "life", "salience": 0.4, "content_hash": f"h{i}", "date": "2026-06-01"}
                        for i in range(6)
                    ],
                    ids=[f"e{i}" for i in range(6)],
                )
                merged = store.merge_similar_episodes()
                self.assertLessEqual(merged, 2)

    async def test_merge_only_archives_active(self):
        m = load_memory_module()
        with tempfile.TemporaryDirectory() as d:
            store = _make_store(m, d)
            store.episodic_col.add(
                documents=["A", "A"],
                embeddings=[[1.0, 0.0], [1.0, 0.0]],
                metadatas=[
                    {"status": "archived", "topic": "life", "salience": 0.4, "content_hash": "h1", "date": "2026-06-01"},
                    {"status": "active", "topic": "life", "salience": 0.4, "content_hash": "h2", "date": "2026-06-02"},
                ],
                ids=["archived1", "active1"],
            )
            merged = store.merge_similar_episodes()
            # 只有 1 条 active，无法配对
            self.assertEqual(merged, 0)


class HighlightTest(unittest.IsolatedAsyncioTestCase):
    """记忆触发主动搭话：优先高 salience + 低 access_count。"""

    async def test_pick_returns_high_salience_low_access(self):
        m = load_memory_module()
        with tempfile.TemporaryDirectory() as d:
            store = _make_store(m, d)
            store.episodic_col.add(
                documents=["主人答应周末陪我看电影", "今天吃了火锅", "主人准备考研"],
                embeddings=[[0.1, 0.2]] * 3,
                metadatas=[
                    {"status": "active", "salience": 0.9, "access_count": 0, "date": "2026-06-01", "content_hash": "h1"},
                    {"status": "active", "salience": 0.4, "access_count": 0, "date": "2026-06-02", "content_hash": "h2"},
                    {"status": "active", "salience": 0.6, "access_count": 1, "date": "2026-06-03", "content_hash": "h3"},
                ],
                ids=["e1", "e2", "e3"],
            )
            result = store.pick_unrecalled_highlight()
            self.assertIsNotNone(result)
            # 应该是 e1 或 e3（salience >= 0.6 且 access <= 2），不是 e2
            self.assertIn(result["id"], ["e1", "e3"])

    async def test_pick_returns_none_when_no_candidate(self):
        m = load_memory_module()
        with tempfile.TemporaryDirectory() as d:
            store = _make_store(m, d)
            store.episodic_col.add(
                documents=["今天吃了火锅"],
                embeddings=[[0.1, 0.2]],
                metadatas=[
                    {"status": "active", "salience": 0.4, "access_count": 0, "date": "2026-06-01", "content_hash": "h1"},
                ],
                ids=["e1"],
            )
            # salience 0.4 < HIGHLIGHT_SALIENCE_MIN(0.6)，无候选
            result = store.pick_unrecalled_highlight()
            self.assertIsNone(result)

    async def test_pick_returns_none_when_empty(self):
        m = load_memory_module()
        with tempfile.TemporaryDirectory() as d:
            store = _make_store(m, d)
            result = store.pick_unrecalled_highlight()
            self.assertIsNone(result)

    async def test_pick_excludes_archived(self):
        m = load_memory_module()
        with tempfile.TemporaryDirectory() as d:
            store = _make_store(m, d)
            store.episodic_col.add(
                documents=["主人答应周末陪我看电影"],
                embeddings=[[0.1, 0.2]],
                metadatas=[
                    {"status": "archived", "salience": 0.9, "access_count": 0, "date": "2026-06-01", "content_hash": "h1"},
                ],
                ids=["e1"],
            )
            result = store.pick_unrecalled_highlight()
            self.assertIsNone(result)


class EmbeddingDistanceTest(unittest.TestCase):
    """embedding 距离计算纯函数。"""

    def test_identical_vectors_distance_zero(self):
        m = load_memory_module()
        self.assertAlmostEqual(m._embedding_distance([1.0, 0.0], [1.0, 0.0]), 0.0, places=5)

    def test_orthogonal_vectors_distance_one(self):
        m = load_memory_module()
        self.assertAlmostEqual(m._embedding_distance([1.0, 0.0], [0.0, 1.0]), 1.0, places=5)

    def test_different_length_returns_none(self):
        m = load_memory_module()
        self.assertIsNone(m._embedding_distance([1.0, 0.0], [1.0]))

    def test_empty_returns_none(self):
        m = load_memory_module()
        self.assertIsNone(m._embedding_distance([], []))


if __name__ == "__main__":
    unittest.main()
