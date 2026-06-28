import unittest
from pathlib import Path


class MemoryStorageContractTest(unittest.TestCase):
    def test_vector_memory_path_uses_persistent_data_dir(self):
        """向量库路径必须走持久数据目录 (Config.DATA_DIR)，不再硬编码源码目录。

        背景：users.db / user_facts/ / memory_db/ 原先落在 backend 源码目录，
        打包或覆盖安装会丢失记忆。迁移后统一落到 Config.DATA_DIR。
        """
        source = Path(__file__).with_name("memory.py").read_text(encoding="utf-8")

        # 不再允许把向量库放在源码目录（旧的反模式）。
        self.assertNotIn('os.path.join(os.path.dirname(__file__), "memory_db")', source)
        self.assertNotIn('path="./memory_db"', source)
        # 必须通过 Config.DATA_DIR 解析持久目录。
        self.assertIn('Config.DATA_DIR, "memory_db"', source)

    def test_memory_module_imports_config_for_data_dir(self):
        source = Path(__file__).with_name("memory.py").read_text(encoding="utf-8")
        self.assertIn("from config import", source)


if __name__ == "__main__":
    unittest.main()
