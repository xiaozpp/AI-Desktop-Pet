import json
import time
import os
import re
import random
import asyncio
import uuid
import hashlib
import datetime
import chromadb
from chromadb.config import Settings
from services import AIService
from config import Config, ensure_data_dir

# === 记忆质量约束（见 docs/LONG_TERM_MEMORY_ARCHITECTURE.md 第 5、6 节）===
# 这些常量是写入与召回的确定性边界，防止模型随意污染事实库 / 让无关记忆塞满 Prompt。
EPISODE_MAX_LEN = 500          # 单条经历摘要上限（字符），超长截断避免单条吃掉 token 预算
FACT_KEY_RE = re.compile(r"^[a-z0-9_]{1,64}$")  # 事实键只允许小写字母/数字/下划线，≤64
RECALL_DISTANCE_LIMIT = 0.85   # cosine 距离上限：超过此值视为无关，不进入 Prompt
RECALL_TOP_K = 5               # 召回候选数（过滤前）
RECALL_FINAL_K = 3             # 过滤后最终进入 Prompt 的条数
# 会话总结合并（架构文档第 7 节）
MERGE_THRESHOLD = 200          # active episode 超过此数触发后台合并
MERGE_SIMILARITY_DISTANCE = 0.35  # 距离小于此值视为相似，可合并
MERGE_BATCH_SIZE = 20          # 单次合并最多处理的相似对数，避免一次合并太久
# 记忆触发主动搭话：优先召回"重要但很久没想起"的记忆
HIGHLIGHT_SALIENCE_MIN = 0.6   # 只挑重要度 ≥ 此值的记忆做主动搭话素材
HIGHLIGHT_ACCESS_MAX = 2       # 被想起次数 ≤ 此值才算"久未想起"
# 重要度规则词表：命中→salience 提高。规则优先于再调一次 LLM（架构文档 6.2）。
SALIENCE_HIGH_KEYWORDS = ("承诺", "答应", "生日", "纪念日", "过敏", "必须", "一定要", "别忘")
SALIENCE_MID_KEYWORDS = ("项目", "正在学", "在做", "计划", "准备", "考试", "面试", "deadline", "ddl")
# 简单主题分类：用于未来按主题检索/合并，不影响召回主路径。
TOPIC_KEYWORDS = {
    "work": ("项目", "工作", "加班", "deadline", "ddl", "代码", "bug", "发布"),
    "study": ("学", "考", "课", "书", "论文", "面试", "研究"),
    "life": ("吃", "玩", "睡", "电影", "游戏", "旅行", "周末"),
    "health": ("病", "医院", "过敏", "减肥", "锻炼", "跑步"),
    "relation": ("朋友", "家人", "女朋友", "男朋友", "妈", "爸", "同事"),
}


def _normalize_text(text: str) -> str:
    """规范化文本用于 hash 去重：去首尾空白、合并连续空白、统一标点。"""
    if not isinstance(text, str):
        return ""
    return re.sub(r"\s+", "", text).strip()


def _content_hash(text: str) -> str:
    """计算规范化文本的 sha256，用于去重（同一件事不重复写入）。"""
    return hashlib.sha256(_normalize_text(text).encode("utf-8")).hexdigest()


def _is_valid_fact_key(key: str) -> bool:
    """事实键规范：小写字母/数字/下划线，长度 1-64。"""
    return isinstance(key, str) and bool(FACT_KEY_RE.match(key))


def _classify_topic(text: str) -> str:
    """简单关键词主题分类，命中即返回，否则 'other'。不调 LLM。"""
    if not text:
        return "other"
    for topic, keywords in TOPIC_KEYWORDS.items():
        if any(k in text for k in keywords):
            return topic
    return "other"


def _estimate_salience(text: str) -> float:
    """基于关键词规则估计重要度（0.0-1.0）。
    架构文档 6.2：先用规则，不必再调 LLM。
    - 命中高重要词（承诺/生日/过敏…）：0.9
    - 命中中重要词（项目/考试…）：0.6
    - 否则：0.4（普通有意义事件）
    """
    if not text:
        return 0.2
    if any(k in text for k in SALIENCE_HIGH_KEYWORDS):
        return 0.9
    if any(k in text for k in SALIENCE_MID_KEYWORDS):
        return 0.6
    return 0.4


class MemorySystem:
    def __init__(self, user_id: str = "guest"):
        self.user_id = user_id
        ensure_data_dir()
        # 1. 向量库 (存经历/对话片段) - 每用户独立 collection，物理隔离
        self.chroma = chromadb.PersistentClient(
            path=os.path.join(Config.DATA_DIR, "memory_db")
        )
        self.episodic_col = self.chroma.get_or_create_collection(f"episodes_{user_id}")

        # 2. 事实库 (存属性 JSON) - 每用户独立文件
        self.facts_dir = os.path.join(Config.DATA_DIR, "user_facts")
        os.makedirs(self.facts_dir, exist_ok=True)
        self.facts_path = os.path.join(self.facts_dir, f"{user_id}.json")
        self.facts = self._load_facts()

        # 3. 待处理的事实冲突队列（架构文档 6.3）。
        # 当新事实与旧事实值不同时，不静默覆盖：记录冲突，由 get_fact_context 注入
        # Prompt 让桌宠主动询问"你上次不是说X吗？怎么变了"。询问后清空。
        self._pending_fact_conflicts: list[dict] = []

    def _load_facts(self):
        if os.path.exists(self.facts_path):
            with open(self.facts_path, 'r', encoding='utf-8') as f:
                return json.load(f)
        return {}

    def _save_facts(self):
        temp_path = f"{self.facts_path}.tmp"
        try:
            with open(temp_path, 'w', encoding='utf-8') as f:
                json.dump(self.facts, f, ensure_ascii=False, indent=2)
            os.replace(temp_path, self.facts_path)
        finally:
            if os.path.exists(temp_path):
                os.remove(temp_path)

    def get_fact_context(self):
        """提供给主脑的所有已知信息。
        若有待处理的事实冲突，追加提示让桌宠主动询问（架构文档 6.3）。
        """
        facts_str = json.dumps(self.facts, ensure_ascii=False)
        conflicts = self._pending_fact_conflicts
        if conflicts:
            hints = []
            for c in conflicts:
                hints.append(f"  - {c['key']}: 之前是「{c['old']}」，现在主人说「{c['new']}」")
            facts_str += (
                "\n\n【事实冲突——请在回复中自然地询问主人，确认到底哪个对】\n"
                + "\n".join(hints)
                + "\n（询问后此提示会自动消失，不要反复问）"
            )
        return facts_str
    async def get_longmemory_context(self, user_text: str = None):
        memory_str = ""
        if user_text:
            # === 有输入：语义检索相关记忆 + 随机带一条旧事 ===
            # embedding 调用可能因网络较慢（阿里云约 1-2s），设 1.5s 超时：
            # 超时则跳过语义检索（记忆是锦上添花，不应拖慢对话响应）。
            query_vec = None
            try:
                query_vec = await asyncio.wait_for(
                    AIService.get_embedding(user_text), timeout=1.5
                )
            except asyncio.TimeoutError:
                print("⏱️ embedding 超时，跳过语义检索")
            if query_vec:
                results = self.episodic_col.query(
                    query_embeddings=[query_vec],
                    n_results=RECALL_TOP_K
                )
                if results['documents'] and results['documents'][0]:
                    docs = results['documents'][0]
                    metas = results['metadatas'][0]
                    distances = results['distances'][0]
                    ids = results['ids'][0] if results.get('ids') else [None] * len(docs)

                    ranked_memories = []
                    now = datetime.datetime.now()
                    seen_hashes = set()
                    for doc, meta, dist, eid in zip(docs, metas, distances, ids):
                        # 召回阈值：距离过远视为无关，不进入 Prompt（架构文档 5.1 P0 缺口）
                        if dist > RECALL_DISTANCE_LIMIT:
                            continue
                        # content_hash 去重：规范化后相同的记忆只保留得分最高的一条
                        h = meta.get("content_hash") if isinstance(meta, dict) else None
                        if not h:
                            h = _content_hash(doc)
                        if h in seen_hashes:
                            continue
                        seen_hashes.add(h)

                        base_score = 1 / (1 + dist)
                        date_str = meta.get('date', '1970-01-01') if isinstance(meta, dict) else '1970-01-01'
                        try:
                            mem_date = datetime.datetime.strptime(date_str, "%Y-%m-%d")
                            days_diff = (now - mem_date).days
                        except Exception:
                            days_diff = 9999
                        # 近期记忆小加权，但不要压太狠（旧事也值得回忆）
                        time_boost = 1.15 if days_diff <= 3 else (1.05 if days_diff <= 30 else 1.0)
                        # 重要度加权（架构文档 5.1：semantic 0.7 + salience 0.15 + recency 0.1 + access 0.05）
                        salience = float(meta.get("salience", 0.4)) if isinstance(meta, dict) else 0.4
                        ranked_memories.append({
                            "content": doc, "date": date_str,
                            "score": base_score * 0.70 + salience * 0.15 + time_boost * 0.10 + 0.05,
                            "id": eid,
                        })
                    ranked_memories.sort(key=lambda x: x['score'], reverse=True)
                    top_k = ranked_memories[:RECALL_FINAL_K]

                    # 更新被召回记忆的访问元数据（access_count / last_accessed_at）
                    # 让"经常被想起的事"在未来有微弱加权，也便于用户面板展示"最近想起"。
                    self._bump_access([m["id"] for m in top_k if m["id"]])

                    memory_str += "\n【你们之间相关的过往（请在回复中自然引用，让主人感到你记得）】\n"
                    for mem in top_k:
                        memory_str += f"- ({mem['date']}) {mem['content']}\n"

            # 随机带一条【久远但可能有惊喜】的记忆（20% 概率，让对话有"突然想起"的感觉）
            if random.random() < 0.2:
                random_old = self._fetch_random_old(days_ago_min=7)
                if random_old:
                    memory_str += f"\n【一条突然想起的旧事，可在合适时自然提起】\n- ({random_old['date']}) {random_old['content']}\n"

        else:
            # === 无输入（主动发言）：优先"重要但久未想起"的记忆，让搭话有惊喜感 ===
            highlight = self.pick_unrecalled_highlight()
            if highlight:
                memory_str += f"\n【突然想起的往事，可以用来开启话题】\n- ({highlight['date']}) {highlight['content']}\n"
            else:
                # 回退：纯随机一条
                total_count = self.episodic_col.count()
                if total_count > 0:
                    random_offset = random.randint(0, total_count - 1)
                    random_result = self.episodic_col.get(limit=1, offset=random_offset)
                    if random_result['documents']:
                        doc = random_result['documents'][0]
                        meta = random_result['metadatas'][0] if random_result['metadatas'] else {}
                        date_str = meta.get('date', '久远的回忆')
                        memory_str += f"\n【突然想起的往事，可以用来开启话题】\n- ({date_str}) {doc}\n"

        return memory_str

    def _fetch_random_old(self, days_ago_min: int = 7) -> dict | None:
        """取一条至少 N 天前的随机记忆"""
        try:
            total = self.episodic_col.count()
            if total == 0: return None
            # 随机抽几条，挑满足天数条件的
            sample_size = min(10, total)
            sample = self.episodic_col.get(
                limit=sample_size,
                offset=random.randint(0, total - sample_size),
            )
            now = datetime.datetime.now()
            candidates = []
            for doc, meta in zip(sample['documents'], sample['metadatas']):
                date_str = meta.get('date', '')
                try:
                    d = datetime.datetime.strptime(date_str, "%Y-%m-%d")
                    if (now - d).days >= days_ago_min:
                        candidates.append({"content": doc, "date": date_str})
                except Exception:
                    continue
            return random.choice(candidates) if candidates else None
        except Exception:
            return None



    async def execute_updates(self, update_instruction: dict, emotion: str = None):
        """
        执行主脑下达的记忆指令（强化版：带情绪/时间元数据 + 写入质量校验）。

        校验（架构文档 6.1）：
        - new_facts 键规范：只允许 [a-z0-9_] ≤64；非法键静默丢弃。
        - new_episode 长度限制：超长截断，避免单条吃掉 token 预算。
        - content_hash 去重：规范化文本相同的 episode 不重复写入。
        """
        if not isinstance(update_instruction, dict):
            return

        new_facts = update_instruction.get("new_facts")
        if isinstance(new_facts, dict):
            # 事实键规范校验：非法键静默丢弃，不污染事实库
            valid = {}
            for k, v in new_facts.items():
                if not _is_valid_fact_key(k):
                    print(f"⚠️ 拒绝非法事实键: {k!r}")
                    continue
                if v in (None, "", []):
                    continue
                # 事实冲突检测（架构文档 6.3）：新旧值不同时不静默覆盖，
                # 记录冲突让桌宠主动询问。用户明确改口才直接更新（见下方 _is_user_explicit_change）。
                if k in self.facts:
                    old_val = self.facts[k]
                    new_val_str = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
                    old_val_str = old_val if isinstance(old_val, str) else json.dumps(old_val, ensure_ascii=False)
                    if old_val_str != new_val_str:
                        self._pending_fact_conflicts.append({
                            "key": k, "old": old_val_str, "new": new_val_str,
                        })
                        print(f"⚠️ 事实冲突 {k}: {old_val_str!r} → {new_val_str!r}（已记录待询问）")
                valid[k] = v
            if valid:
                self.facts.update(valid)
                self._save_facts()

        new_episode = update_instruction.get("new_episode")
        if isinstance(new_episode, str) and new_episode.strip():
            # 长度限制：超长截断（保留完整语义边界比硬截断好，但第一版先硬截断）
            episode_text = new_episode.strip()
            if len(episode_text) > EPISODE_MAX_LEN:
                episode_text = episode_text[:EPISODE_MAX_LEN]

            # 去重：同 content_hash 已存在则跳过（架构文档 6.1 / 7 合并的前置防线）
            ep_hash = _content_hash(episode_text)
            if self._episode_hash_exists(ep_hash):
                print(f"↩️ 跳过重复记忆 (hash={ep_hash[:8]})")
                return

            vector = await AIService.get_embedding(episode_text)
            if vector:
                now = datetime.datetime.now()
                self.episodic_col.add(
                    documents=[episode_text],
                    embeddings=[vector],
                    metadatas=[{
                        "timestamp": time.time(),
                        "date": now.strftime("%Y-%m-%d"),
                        "time": now.strftime("%H:%M"),
                        "weekday": now.strftime("%a"),
                        "emotion": emotion or "neutral",
                        "content_hash": ep_hash,
                        "salience": _estimate_salience(episode_text),
                        "topic": _classify_topic(episode_text),
                        "embedding_model": Config.LLM_MODEL,
                        "status": "active",
                        "access_count": 0,
                        "last_accessed_at": 0,
                    }],
                    ids=[str(uuid.uuid4())]
                )
                print(f"✅ 记忆已存, 总记忆数: {self.episodic_col.count()}")

        # 会话总结合并（架构文档第 7 节）：active episode 超阈值时后台触发。
        # 不调 LLM，用 embedding 距离找相似对，合并成摘要记录，原记录标 archived。
        # 失败不影响主流程（记忆已写入成功）。
        try:
            active_count = self.episodic_col.count()
            if active_count > MERGE_THRESHOLD:
                merged = self.merge_similar_episodes()
                if merged > 0:
                    print(f"🔧 后台合并相似记忆: {merged} 对 → 已归档")
        except Exception as e:
            print(f"⚠️ 后台合并失败（不影响使用）: {e}")

    def _episode_hash_exists(self, ep_hash: str) -> bool:
        """检查同 content_hash 的 episode 是否已存在（去重）。
        旧数据没有 content_hash 字段时返回 False，保证向后兼容。"""
        try:
            res = self.episodic_col.get(where={"content_hash": ep_hash}, limit=1)
            return bool(res and res.get("ids"))
        except Exception:
            return False

    def _bump_access(self, episode_ids: list[str]) -> None:
        """更新被召回记忆的 access_count 和 last_accessed_at。
        失败不影响主流程（记忆召回已成功，元数据更新是 best-effort）。"""
        if not episode_ids:
            return
        now = time.time()
        for eid in episode_ids:
            if not eid:
                continue
            try:
                existing = self.episodic_col.get(ids=[eid], limit=1)
                if not existing or not existing.get("metadatas"):
                    continue
                meta = existing["metadatas"][0] or {}
                meta["access_count"] = int(meta.get("access_count", 0)) + 1
                meta["last_accessed_at"] = now
                self.episodic_col.update(ids=[eid], metadatas=[meta])
            except Exception:
                continue

    # === 用户控制接口（架构文档第 8 节）===
    # 让用户能查看/搜索/忘记/导出/清空自己的记忆，是"可玩性"的用户侧入口。
    # 所有方法基于已验证的 self.user_id，不接受外部传入的文件名/collection 名。

    def list_facts(self) -> dict:
        """列出当前用户的所有事实（只读副本）。"""
        return dict(self.facts)

    def list_episodes(self, limit: int = 50, offset: int = 0, topic: str | None = None) -> list[dict]:
        """列出/搜索经历，按时间倒序。可按 topic 过滤。
        返回精简字段：id/date/time/emotion/salience/topic/access_count/content(截断)。"""
        try:
            where = {"status": "active"}
            if topic:
                where = {"status": "active", "topic": topic}
            total = self.episodic_col.count()
            if total == 0:
                return []
            fetch_limit = min(limit, total - offset) if offset < total else 0
            if fetch_limit <= 0:
                return []
            res = self.episodic_col.get(
                limit=fetch_limit, offset=offset, where=where,
                include=["documents", "metadatas"],
            )
            items = []
            for eid, doc, meta in zip(
                res.get("ids", []),
                res.get("documents", []),
                res.get("metadatas", []),
            ):
                m = meta or {}
                items.append({
                    "id": eid,
                    "content": doc,
                    "date": m.get("date", ""),
                    "time": m.get("time", ""),
                    "emotion": m.get("emotion", "neutral"),
                    "salience": m.get("salience", 0.4),
                    "topic": m.get("topic", "other"),
                    "access_count": m.get("access_count", 0),
                })
            return items
        except Exception as e:
            print(f"⚠️ list_episodes 失败: {e}")
            return []

    def delete_episode(self, episode_id: str) -> bool:
        """忘记单条经历。物理删除（ Chroma delete）。
        下一版可改为 status='archived' 软删除，本版先物理删除保证用户'真的忘了'。"""
        if not isinstance(episode_id, str) or not episode_id:
            return False
        try:
            self.episodic_col.delete(ids=[episode_id])
            return True
        except Exception as e:
            print(f"⚠️ delete_episode 失败: {e}")
            return False

    def export_all(self) -> dict:
        """导出当前用户全部记忆为 JSON（事实 + 经历）。用于备份/迁移。"""
        return {
            "user_id": self.user_id,
            "exported_at": datetime.datetime.now().isoformat(),
            "facts": dict(self.facts),
            "episodes": self.list_episodes(limit=10000, offset=0),
        }

    def clear_all(self) -> dict:
        """清空当前用户全部记忆。返回删除条目数。
        事实文件清空 + Chroma collection 删除并重建（保证物理隔离）。"""
        facts_count = len(self.facts)
        episode_count = self.episodic_col.count()
        self.facts = {}
        self._save_facts()
        try:
            self.chroma.delete_collection(self.episodic_col.name)
            self.episodic_col = self.chroma.get_or_create_collection(self.episodic_col.name)
        except Exception as e:
            print(f"⚠️ 清空 collection 失败: {e}")
        return {"facts_cleared": facts_count, "episodes_cleared": episode_count}

    # === 会话总结合并（架构文档第 7 节）===
    def merge_similar_episodes(self) -> int:
        """合并相似记忆。返回合并的对数。

        策略（不调 LLM，纯规则）：
        1. 取所有 active episode，按 topic 分组。
        2. 每组内用 embedding 距离找相似对（距离 < MERGE_SIMILARITY_DISTANCE）。
        3. 相似对合并成一条摘要记录（拼接 + 去重关键词），原记录标 status=archived。
        4. 单次最多处理 MERGE_BATCH_SIZE 对，避免一次合并太久。

        合并产物是新摘要记录，原记录标记 archived 不立即删除（架构文档第 7 节）。
        """
        try:
            all_active = self.episodic_col.get(
                where={"status": "active"}, limit=MERGE_THRESHOLD + 50,
                include=["documents", "metadatas", "embeddings"],
            )
            if not all_active or not all_active.get("ids"):
                return 0

            ids = all_active["ids"]
            docs = all_active["documents"]
            metas = all_active["metadatas"]
            embs = all_active.get("embeddings", [])

            # 按 topic 分组
            by_topic: dict[str, list[int]] = {}
            for i, meta in enumerate(metas):
                topic = (meta or {}).get("topic", "other")
                by_topic.setdefault(topic, []).append(i)

            merged_pairs = 0
            archived_ids: list[str] = []
            now = datetime.datetime.now()

            for topic, indices in by_topic.items():
                if merged_pairs >= MERGE_BATCH_SIZE:
                    break
                if len(indices) < 2:
                    continue

                # 组内两两比较 embedding 距离
                for i_pos in range(len(indices)):
                    if merged_pairs >= MERGE_BATCH_SIZE:
                        break
                    i = indices[i_pos]
                    if ids[i] in archived_ids:
                        continue
                    if not embs or i >= len(embs):
                        continue
                    for j_pos in range(i_pos + 1, len(indices)):
                        if merged_pairs >= MERGE_BATCH_SIZE:
                            break
                        j = indices[j_pos]
                        if ids[j] in archived_ids:
                            continue
                        if not embs or j >= len(embs):
                            continue
                        dist = _embedding_distance(embs[i], embs[j])
                        if dist is None or dist >= MERGE_SIMILARITY_DISTANCE:
                            continue

                        # 合并：生成摘要新记录，原两条标 archived
                        summary = _merge_two_summaries(docs[i], docs[j])
                        summary_hash = _content_hash(summary)
                        if self._episode_hash_exists(summary_hash):
                            # 摘要已存在，直接归档原两条
                            archived_ids.extend([ids[i], ids[j]])
                            merged_pairs += 1
                            continue

                        vec = embs[i]  # 用第一条的 embedding 作为摘要向量（近似）
                        self.episodic_col.add(
                            documents=[summary],
                            embeddings=[vec],
                            metadatas=[{
                                "timestamp": time.time(),
                                "date": now.strftime("%Y-%m-%d"),
                                "time": now.strftime("%H:%M"),
                                "weekday": now.strftime("%a"),
                                "emotion": "neutral",
                                "content_hash": summary_hash,
                                "salience": max(
                                    float((metas[i] or {}).get("salience", 0.4)),
                                    float((metas[j] or {}).get("salience", 0.4)),
                                ),
                                "topic": topic,
                                "embedding_model": Config.LLM_MODEL,
                                "status": "active",
                                "access_count": 0,
                                "last_accessed_at": 0,
                                "merged_from": f"{ids[i]},{ids[j]}",
                            }],
                            ids=[str(uuid.uuid4())]
                        )
                        archived_ids.extend([ids[i], ids[j]])
                        merged_pairs += 1

            # 批量归档原记录
            if archived_ids:
                for eid in archived_ids:
                    try:
                        existing = self.episodic_col.get(ids=[eid], limit=1)
                        if existing and existing.get("metadatas"):
                            meta = existing["metadatas"][0] or {}
                            meta["status"] = "archived"
                            self.episodic_col.update(ids=[eid], metadatas=[meta])
                    except Exception:
                        continue

            return merged_pairs
        except Exception as e:
            print(f"⚠️ merge_similar_episodes 失败: {e}")
            return 0

    # === 事实冲突策略（架构文档 6.3）===
    def consume_fact_conflicts(self) -> list[dict]:
        """取出并清空待处理的事实冲突。
        brain 在 build_system_prompt 时调用，把冲突注入 Prompt 让桌宠主动询问。
        询问后冲突即清空，不会反复问同一个。"""
        if not self._pending_fact_conflicts:
            return []
        conflicts = list(self._pending_fact_conflicts)
        self._pending_fact_conflicts.clear()
        return conflicts

    # === 记忆触发主动搭话 ===
    def pick_unrecalled_highlight(self) -> dict | None:
        """挑一条"重要但久未想起"的记忆，用于主动搭话。

        策略：从 active episode 中筛 salience ≥ HIGHLIGHT_SALIENCE_MIN
        且 access_count ≤ HIGHLIGHT_ACCESS_MAX 的记忆，随机选一条。
        让桌宠"突然想起重要旧事"而非纯随机，提升搭话的惊喜感和记忆存在感。
        无符合条件的高亮记忆时返回 None，调用方回退到纯随机。
        """
        try:
            all_active = self.episodic_col.get(
                where={"status": "active"}, limit=MERGE_THRESHOLD + 50,
                include=["documents", "metadatas"],
            )
            if not all_active or not all_active.get("ids"):
                return None

            candidates = []
            for eid, doc, meta in zip(
                all_active["ids"], all_active["documents"], all_active["metadatas"]
            ):
                m = meta or {}
                salience = float(m.get("salience", 0.4))
                access = int(m.get("access_count", 0))
                if salience >= HIGHLIGHT_SALIENCE_MIN and access <= HIGHLIGHT_ACCESS_MAX:
                    candidates.append({
                        "id": eid, "content": doc,
                        "date": m.get("date", ""),
                        "salience": salience, "access_count": access,
                    })

            if not candidates:
                return None
            return random.choice(candidates)
        except Exception as e:
            print(f"⚠️ pick_unrecalled_highlight 失败: {e}")
            return None


def _embedding_distance(a: list[float], b: list[float]) -> float | None:
    """计算两个 embedding 的 cosine 距离。长度不等或空返回 None。"""
    if not a or not b or len(a) != len(b):
        return None
    import math
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if norm_a == 0 or norm_b == 0:
        return None
    return 1.0 - dot / (norm_a * norm_b)


def _merge_two_summaries(doc_a: str, doc_b: str) -> str:
    """合并两条记忆摘要为一条。纯文本拼接 + 长度限制，不调 LLM。
    第一版策略：取两条的关键信息，用分号连接，超长截断。"""
    combined = f"{doc_a}；{doc_b}"
    if len(combined) > EPISODE_MAX_LEN:
        combined = combined[:EPISODE_MAX_LEN]
    return combined
