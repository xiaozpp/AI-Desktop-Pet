import unittest
from pathlib import Path


class MemoryPrivacyContractTest(unittest.TestCase):
    def test_private_memory_content_is_not_logged(self):
        memory_source = Path(__file__).with_name("memory.py").read_text(encoding="utf-8")
        main_source = Path(__file__).with_name("main.py").read_text(encoding="utf-8")

        for term in ("{valid}", "{new_episode}", "mem['content'][:20]"):
            self.assertNotIn(term, memory_source)
        self.assertNotIn("thought = result_json", main_source)
        self.assertNotIn("\u4e3b\u52a8\u751f\u6210: {reply}", main_source)

    def test_system_prompt_does_not_seed_one_customers_memory_into_every_account(self):
        main_source = Path(__file__).with_name("main.py").read_text(encoding="utf-8")

        self.assertNotIn("你上次说要减肥", main_source)
        self.assertIn("记忆为空时，禁止编造", main_source)
        self.assertIn('user_id = payload["sub"]', main_source)
        self.assertIn("brain = await get_or_create_brain(user_id)", main_source)


if __name__ == "__main__":
    unittest.main()
