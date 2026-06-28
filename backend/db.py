"""
用户数据库 - 原生 sqlite3，最简实现
单表 users(user_id, username, password_hash, created_at)
每次请求新建连接，避免多线程共享问题
"""
import sqlite3
import os
import json
from contextlib import contextmanager

from config import Config

# accounts/presence/persona 库迁到持久数据目录（见 docs 第 5 步）。
# 注意：保留 DB_PATH / LEGACY_PERSONA_PATH 这两个模块常量名，测试通过 patch 它们工作。
DB_PATH = os.path.join(Config.DATA_DIR, "users.db")
# persona_state.json 是旧的运行时状态文件，历史上落在 backend 源码目录；
# 迁移后它已被搬到 Config.DATA_DIR，这里指向新位置，init_db 仍能消费历史选择。
LEGACY_PERSONA_PATH = os.path.join(Config.DATA_DIR, "persona_state.json")


def init_db():
    """启动时调用，建表（IF NOT EXISTS 幂等）"""
    # 确保 DB_PATH 所在目录存在（而非硬编码 Config.DATA_DIR），这样测试 patch DB_PATH
    # 到临时目录时不会污染真实的系统数据目录。
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with get_conn() as c:
        c.execute("""CREATE TABLE IF NOT EXISTS users (
            user_id       TEXT PRIMARY KEY,
            username      TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at    INTEGER NOT NULL,
            last_seen_at  INTEGER,
            persona_id    TEXT
        )""")
        columns = {row["name"] for row in c.execute("PRAGMA table_info(users)")}
        if "last_seen_at" not in columns:
            c.execute("ALTER TABLE users ADD COLUMN last_seen_at INTEGER")
        if "persona_id" not in columns:
            c.execute("ALTER TABLE users ADD COLUMN persona_id TEXT")
        try:
            with open(LEGACY_PERSONA_PATH, "r", encoding="utf-8") as file:
                legacy_personas = json.load(file)
            if isinstance(legacy_personas, dict):
                c.executemany(
                    "UPDATE users SET persona_id=? WHERE user_id=? AND persona_id IS NULL",
                    [
                        (persona_id, user_id)
                        for user_id, persona_id in legacy_personas.items()
                        if isinstance(user_id, str) and isinstance(persona_id, str)
                    ],
                )
        except (OSError, json.JSONDecodeError):
            pass


@contextmanager
def get_conn():
    """每次请求新建连接，用完即关。row_factory=Row 让结果可像 dict 取值。"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def create_user(user_id: str, username: str, password_hash: str, created_at: int):
    """插入新用户。username 重复会抛 sqlite3.IntegrityError。"""
    with get_conn() as c:
        c.execute(
            "INSERT INTO users (user_id, username, password_hash, created_at) VALUES (?,?,?,?)",
            (user_id, username, password_hash, created_at),
        )


def get_user_by_username(username: str):
    """按用户名查询，返回 Row 或 None"""
    with get_conn() as c:
        return c.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()


def get_last_seen(user_id: str):
    with get_conn() as c:
        row = c.execute(
            "SELECT last_seen_at FROM users WHERE user_id=?",
            (user_id,),
        ).fetchone()
        return row["last_seen_at"] if row else None


def set_last_seen(user_id: str, timestamp: int):
    with get_conn() as c:
        c.execute(
            "UPDATE users SET last_seen_at=? WHERE user_id=?",
            (timestamp, user_id),
        )


def get_persona_id(user_id: str):
    with get_conn() as c:
        row = c.execute(
            "SELECT persona_id FROM users WHERE user_id=?",
            (user_id,),
        ).fetchone()
        return row["persona_id"] if row else None


def set_persona_id(user_id: str, persona_id: str):
    with get_conn() as c:
        c.execute(
            "UPDATE users SET persona_id=? WHERE user_id=?",
            (persona_id, user_id),
        )
