import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch


def load_memory_module():
    chromadb = types.ModuleType("chromadb")
    chromadb_config = types.ModuleType("chromadb.config")
    chromadb_config.Settings = object
    services = types.ModuleType("services")
    services.AIService = object
    path = Path(__file__).with_name("memory.py")
    spec = importlib.util.spec_from_file_location("memory_under_test", path)
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {
        "chromadb": chromadb,
        "chromadb.config": chromadb_config,
        "services": services,
    }):
        spec.loader.exec_module(module)
    return module


class MemoryIntegrityTest(unittest.IsolatedAsyncioTestCase):
    def test_failed_fact_write_keeps_previous_memory(self):
        memory = load_memory_module()
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "facts.json"
            target.write_text('{"stable": true}', encoding="utf-8")
            store = object.__new__(memory.MemorySystem)
            store.facts_path = str(target)
            store.facts = {"stable": False}

            with patch.object(memory.json, "dump", side_effect=RuntimeError("disk error")):
                with self.assertRaises(RuntimeError):
                    store._save_facts()

            self.assertEqual(target.read_text(encoding="utf-8"), '{"stable": true}')
            self.assertFalse(Path(f"{target}.tmp").exists())

    async def test_malformed_model_memory_instruction_is_ignored(self):
        memory = load_memory_module()
        store = object.__new__(memory.MemorySystem)

        for instruction in (None, [], {"new_facts": []}, {"new_episode": {}}):
            with self.subTest(instruction=instruction):
                await store.execute_updates(instruction)

    def test_old_memory_sampling_uses_a_random_collection_window(self):
        memory = load_memory_module()

        class Episodes:
            offset = None

            def count(self):
                return 100

            def get(self, *, limit, offset):
                self.offset = offset
                return {
                    "documents": ["an old promise"],
                    "metadatas": [{"date": "2000-01-01"}],
                }

        store = object.__new__(memory.MemorySystem)
        store.episodic_col = Episodes()
        with patch.object(memory.random, "randint", return_value=42):
            result = store._fetch_random_old()

        self.assertEqual(store.episodic_col.offset, 42)
        self.assertEqual(result["content"], "an old promise")


if __name__ == "__main__":
    unittest.main()
