import unittest
from pathlib import Path


class ProductContractTest(unittest.TestCase):
    def test_realtime_path_has_no_fake_pet_mechanics(self):
        source = Path(__file__).with_name("main.py").read_text(encoding="utf-8")

        for term in ("import pet_state", ".pet_state", '"pet_state"', '"pet_action"'):
            self.assertNotIn(term, source)


if __name__ == "__main__":
    unittest.main()
