import unittest
from pathlib import Path

from personas import (
    DEFAULT_PERSONA_ID,
    PERSONAS,
    build_persona_prompt,
    get_persona_catalog_payload,
    normalize_persona_id,
)


class PersonaConfigTest(unittest.TestCase):
    def test_catalog_contains_the_four_commercial_roles(self):
        payload = get_persona_catalog_payload("creator")

        self.assertEqual(payload["active_persona_id"], "creator")
        self.assertEqual(len(payload["personas"]), 4)
        self.assertEqual(
            {persona["id"] for persona in payload["personas"]},
            {"creator", "companion", "coach", "private"},
        )

    def test_unknown_persona_falls_back_to_default(self):
        self.assertEqual(normalize_persona_id("not-real"), DEFAULT_PERSONA_ID)
        self.assertEqual(normalize_persona_id(None), DEFAULT_PERSONA_ID)

    def test_prompt_keeps_one_identity_and_shared_memory(self):
        prompt = build_persona_prompt("coach")

        self.assertIn(PERSONAS["coach"]["title"], prompt)
        self.assertIn("四种角色共享同一份长期记忆", prompt)
        self.assertIn("不要假装换了一个人", prompt)

    def test_persona_selection_uses_the_user_database(self):
        source = Path(__file__).with_name("personas.py").read_text(encoding="utf-8")

        self.assertNotIn("persona_state.json", source)
        self.assertIn("db.get_persona_id(user_id)", source)
        self.assertIn("db.set_persona_id(user_id, active_id)", source)


if __name__ == "__main__":
    unittest.main()
