import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

import db
from presence import initial_care_delay


class PresencePersistenceTest(unittest.TestCase):
    def test_long_absence_gets_one_earlier_care_moment(self):
        now = 1_700_000_000

        self.assertEqual(initial_care_delay(None, now), 45 * 60)
        self.assertEqual(initial_care_delay(now - 60 * 60, now), 45 * 60)
        self.assertEqual(initial_care_delay(now - 25 * 60 * 60, now), 5 * 60)

    def test_last_seen_survives_legacy_database_migration(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "users.db"
            legacy_personas = Path(directory) / "persona_state.json"
            legacy_personas.write_text('{"user-1":"coach"}', encoding="utf-8")
            with closing(sqlite3.connect(database)) as connection:
                connection.execute("""CREATE TABLE users (
                    user_id TEXT PRIMARY KEY,
                    username TEXT UNIQUE NOT NULL,
                    password_hash TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                )""")
                connection.execute(
                    "INSERT INTO users VALUES (?,?,?,?)",
                    ("user-1", "neuro", "hash", 1),
                )
                connection.commit()

            with patch.object(db, "DB_PATH", str(database)), patch.object(
                db,
                "LEGACY_PERSONA_PATH",
                str(legacy_personas),
                create=True,
            ):
                db.init_db()
                self.assertIsNone(db.get_last_seen("user-1"))
                db.set_last_seen("user-1", 1_700_000_000)
                self.assertEqual(db.get_last_seen("user-1"), 1_700_000_000)
                self.assertEqual(db.get_persona_id("user-1"), "coach")
                db.set_persona_id("user-1", "private")
                self.assertEqual(db.get_persona_id("user-1"), "private")

    def test_brain_loads_and_records_persisted_presence(self):
        source = Path(__file__).with_name("main.py").read_text(encoding="utf-8")

        self.assertIn("db.get_last_seen(user_id)", source)
        self.assertIn("db.set_last_seen(self.user_id", source)

    def test_proactive_care_is_infrequent(self):
        source = Path(__file__).with_name("main.py").read_text(encoding="utf-8")

        self.assertIn("self.boredom_threshold = 45 * 60", source)
        self.assertIn("self.max_threshold = 6 * 60 * 60", source)
        self.assertIn(
            "self.current_threshold = initial_care_delay(persisted_last_seen, now)",
            source,
        )

    def test_init_db_does_not_touch_global_data_dir_when_db_path_is_patched(self):
        """回归：init_db 必须只创建 DB_PATH 的父目录，不能硬编码建 Config.DATA_DIR，
        否则测试 patch DB_PATH 到临时目录时仍会污染真实的系统数据目录。
        """
        import config

        sentinel = Path(config.Config.DATA_DIR)
        users_db_existed = (sentinel / "users.db").exists()
        # 用一个肯定不存在的哨兵子路径验证：init_db 不应去碰它。
        sentinel_subdir = sentinel / "_initdb_pollution_sentinel_do_not_exist"
        self.assertFalse(sentinel_subdir.exists())

        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "users.db"
            with patch.object(db, "DB_PATH", str(database)), patch.object(
                db, "LEGACY_PERSONA_PATH", str(Path(directory) / "persona_state.json"),
                create=True,
            ):
                db.init_db()
            # 建表成功（DB_PATH 指向临时目录）
            self.assertTrue(database.exists())

        # 关键断言：全局 Config.DATA_DIR 下没有因为 init_db 而多出哨兵目录。
        self.assertFalse(sentinel_subdir.exists())
        self.assertEqual((sentinel / "users.db").exists(), users_db_existed)


if __name__ == "__main__":
    unittest.main()
