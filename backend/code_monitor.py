"""
编程监控模块 - 读 Claude Code / Codex 日志推断编程状态

数据源：
- Claude Code: ~/.claude/projects/**/*.jsonl  (每行 {type, ...})
- Codex:       ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl  (每行 {timestamp, type, payload})

状态推断规则（按优先级）：
1. 最近 30s 内有活动 + 末行是 function_call/tool_use → "coding"（正在干活）
2. 最近 30s 内有活动 + 末行是 user/assistant 文本 → "thinking"（思考中）
3. 最近 5min 内有活动 → "idle_recent"（刚歇下）
4. 超过 5min 无活动 → "idle"
"""
import os
import json
import time
import glob
from datetime import datetime


def _user_profile() -> str:
    return os.path.expanduser("~")


# ============================================================
# 数据源探测：找各工具最新的 jsonl 文件
# ============================================================

def _find_latest_claude_session() -> str | None:
    """找 ~/.claude/projects 下最近修改的 .jsonl"""
    base = os.path.join(_user_profile(), ".claude", "projects")
    if not os.path.isdir(base):
        return None
    files = glob.glob(os.path.join(base, "**", "*.jsonl"), recursive=True)
    if not files:
        return None
    return max(files, key=os.path.getmtime)


def _find_latest_codex_session() -> str | None:
    """找 ~/.codex/sessions 下最近修改的 rollout-*.jsonl"""
    base = os.path.join(_user_profile(), ".codex", "sessions")
    if not os.path.isdir(base):
        return None
    files = glob.glob(os.path.join(base, "**", "rollout-*.jsonl"), recursive=True)
    if not files:
        return None
    return max(files, key=os.path.getmtime)


# ============================================================
# 单行解析：判断这行代表"工具调用"还是"文本交流"
# ============================================================

def _classify_line(line: str, source: str) -> str:
    """返回该行的活动类型: 'tool_use' | 'text' | 'other'"""
    try:
        obj = json.loads(line)
    except json.JSONDecodeError:
        return "other"

    if source == "claude":
        t = obj.get("type", "")
        # Claude: assistant 消息里可能含 tool_use；user 文本算 text
        if t == "assistant":
            msg = obj.get("message", {})
            content = msg.get("content", [])
            if isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get("type") in ("tool_use", "tool_result"):
                        return "tool_use"
            return "text"
        if t == "user":
            return "text"
        return "other"

    if source == "codex":
        t = obj.get("type", "")
        payload = obj.get("payload", {})
        # Codex: response_item + payload.type=function_call → 工具调用
        if t == "response_item":
            ptype = payload.get("type", "")
            if ptype in ("function_call", "local_shell_call", "tool_call"):
                return "tool_use"
            if ptype in ("message",):
                return "text"
        if t in ("user_message", "assistant_message"):
            return "text"
        return "other"

    return "other"


# ============================================================
# 状态推断核心
# ============================================================

# 候选源: (查找函数, 显示名, 源标识)
_SOURCES = [
    (_find_latest_codex_session,   "Codex",       "codex"),
    (_find_latest_claude_session,  "Claude Code", "claude"),
]

# 时间阈值（秒）
ACTIVE_WINDOW = 30        # 30s 内算"活跃"
RECENT_WINDOW = 5 * 60    # 5min 内算"刚歇"


def poll() -> dict:
    """
    轮询所有数据源，返回当前编程状态。
    返回: {
        "state": "coding"|"thinking"|"idle_recent"|"idle",
        "tool": "Claude Code"|"Codex"|None,   # 哪个工具
        "duration_min": int,                   # 当前状态持续了多少分钟(基于最后活动)
        "idle_sec": float,                     # 距离最后活动多少秒
        "file": str                            # 数据源文件名(调试用)
    }
    """
    now = time.time()
    best = None  # (mtime, classify, tool_name, source, file)

    for finder, tool_name, source in _SOURCES:
        f = finder()
        if not f or not os.path.exists(f):
            continue
        mtime = os.path.getmtime(f)
        # 只考虑候选中"最新"的那个
        if best is None or mtime > best[0]:
            # 读最后一行判断活动类型
            last_class = _read_last_line_class(f, source)
            best = (mtime, last_class, tool_name, source, f)

    if best is None:
        return {
            "state": "idle", "tool": None,
            "duration_min": 0, "idle_sec": 0, "file": ""
        }

    mtime, last_class, tool_name, source, f = best
    idle_sec = max(0.0, now - mtime)

    # 状态推断
    if idle_sec <= ACTIVE_WINDOW:
        state = "coding" if last_class == "tool_use" else "thinking"
    elif idle_sec <= RECENT_WINDOW:
        state = "idle_recent"
    else:
        state = "idle"

    return {
        "state": state,
        "tool": tool_name,
        "duration_min": int(idle_sec // 60),
        "idle_sec": round(idle_sec, 1),
        "file": os.path.basename(f)
    }


def _read_last_line_class(filepath: str, source: str) -> str:
    """读文件最后一行，返回活动类型。读失败返回 'text' 兜底。"""
    try:
        # 高效读最后一行：seek 到末尾附近
        size = os.path.getsize(filepath)
        with open(filepath, "rb") as fh:
            # 最多读后 4KB 找最后一个换行
            fh.seek(max(0, size - 4096))
            tail = fh.read().decode("utf-8", errors="ignore")
        lines = [ln for ln in tail.splitlines() if ln.strip()]
        if not lines:
            return "text"
        return _classify_line(lines[-1], source)
    except Exception:
        return "text"


# ============================================================
# 自测
# ============================================================

if __name__ == "__main__":
    import pprint
    print("=== Claude latest session ===")
    print(" ", _find_latest_claude_session())
    print("=== Codex latest session ===")
    print(" ", _find_latest_codex_session())
    print("=== Current coding state ===")
    pprint.pprint(poll())
