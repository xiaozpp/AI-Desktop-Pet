import contextlib
import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

import migrate


@contextlib.contextmanager
def _tmp_dirs():
    with tempfile.TemporaryDirectory() as legacy, tempfile.TemporaryDirectory() as target:
        yield Path(legacy), Path(target)


class DataMigrationTest(unittest.TestCase):
    def _make_legacy(self, legacy: Path):
        """构造一个有真实数据的旧目录。"""
        legacy.mkdir(parents=True, exist_ok=True)
        # users.db 带一行数据
        with closing(sqlite3.connect(legacy / "users.db")) as conn:
            conn.execute("CREATE TABLE users (user_id TEXT)")
            conn.execute("INSERT INTO users VALUES ('u-legacy')")
            conn.commit()
        (legacy / "user_facts").mkdir()
        (legacy / "user_facts" / "u-legacy.json").write_text("{}", encoding="utf-8")
        (legacy / ".jwt_secret").write_text("x" * 48, encoding="ascii")

    def _legacy_counts(self, legacy: Path) -> dict:
        return {
            "users": (legacy / "users.db").exists(),
            "facts_dir": (legacy / "user_facts").exists(),
            "facts_file": (legacy / "user_facts" / "u-legacy.json").exists(),
            "jwt": (legacy / ".jwt_secret").exists(),
        }

    def test_migrates_legacy_data_into_new_dir_and_keeps_legacy(self):
        with _tmp_dirs() as (legacy, target):
            self._make_legacy(legacy)
            before = self._legacy_counts(legacy)

            result = migrate.migrate_legacy_data(target_dir=str(target), legacy_dir=str(legacy))

            # 新目录得到数据
            self.assertTrue((target / "users.db").exists())
            self.assertTrue((target / "user_facts" / "u-legacy.json").exists())
            self.assertTrue((target / ".jwt_secret").exists())
            with closing(sqlite3.connect(target / "users.db")) as conn:
                rows = conn.execute("SELECT user_id FROM users").fetchall()
                self.assertEqual(rows, [("u-legacy",)])
            # 旧目录数据保留（不删除）
            self.assertEqual(self._legacy_counts(legacy), before)
            # 迁移摘要只含条目名，不含正文
            self.assertIn("users.db", result["migrated"])
            self.assertIn("user_facts", result["migrated"])
            # 迁移标记已写
            self.assertTrue((target / ".migrated").exists())

    def test_migration_is_idempotent(self):
        with _tmp_dirs() as (legacy, target):
            self._make_legacy(legacy)
            first = migrate.migrate_legacy_data(target_dir=str(target), legacy_dir=str(legacy))
            # 第一次标记后第二次不重复迁移
            self.assertTrue(first["migrated"])
            second = migrate.migrate_legacy_data(target_dir=str(target), legacy_dir=str(legacy))
            self.assertEqual(second["migrated"], [])
            self.assertEqual(second["reason"], "already migrated")

    def test_does_not_overwrite_existing_target_entry(self):
        with _tmp_dirs() as (legacy, target):
            self._make_legacy(legacy)
            # 新目录已存在一个有内容的 users.db（比如用户已在新目录注册）
            target.mkdir(parents=True, exist_ok=True)
            with closing(sqlite3.connect(target / "users.db")) as conn:
                conn.execute("CREATE TABLE users (user_id TEXT)")
                conn.execute("INSERT INTO users VALUES ('u-new')")
                conn.commit()

            migrate.migrate_legacy_data(target_dir=str(target), legacy_dir=str(legacy))

            # 新库的新用户不被旧库覆盖
            with closing(sqlite3.connect(target / "users.db")) as conn:
                rows = conn.execute("SELECT user_id FROM users").fetchall()
                self.assertEqual(rows, [("u-new",)])

    def test_migration_log_does_not_leak_memory_content(self):
        with _tmp_dirs() as (legacy, target):
            legacy.mkdir(parents=True, exist_ok=True)
            secret_content = "TOP_SECRET_PRIVATE_FACT_VALUE_xyz"
            (legacy / "user_facts").mkdir()
            (legacy / "user_facts" / "u.json").write_text(
                '{"private": "%s"}' % secret_content, encoding="utf-8"
            )

            result = migrate.migrate_legacy_data(target_dir=str(target), legacy_dir=str(legacy))

            # 迁移摘要里不能出现记忆正文
            flat = str(result)
            self.assertNotIn(secret_content, flat)
            self.assertNotIn("private", flat)


class DataDirResolutionTest(unittest.TestCase):
    def test_neuro_data_dir_env_overrides_default(self):
        import config

        # resolve_data_dir 对显式配置做 abspath 归一化（保证绝对路径），Windows 上
        # 会把 /custom/... 转为盘符路径。断言以归一化后的结果为准。
        custom = "/custom/neuro/data"
        expected = os.path.abspath(custom)
        with patch.dict(os.environ, {"NEURO_DATA_DIR": custom}, clear=False):
            self.assertEqual(config.resolve_data_dir(), expected)

    def test_ensure_data_dir_creates_directory(self):
        import tempfile

        import config

        with tempfile.TemporaryDirectory() as d:
            target = str(Path(d) / "nested" / "data")
            self.assertFalse(Path(target).exists())
            result = config.ensure_data_dir(target)
            self.assertEqual(result, target)
            self.assertTrue(Path(target).is_dir())
            # 幂等：再调一次不报错
            config.ensure_data_dir(target)


if __name__ == "__main__":
    unittest.main()
