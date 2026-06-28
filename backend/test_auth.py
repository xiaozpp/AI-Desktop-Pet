import unittest
import importlib.util
import os
import sys
import tempfile
import types
from pathlib import Path
from unittest.mock import patch


def load_auth_module():
    path = Path(__file__).with_name("auth.py")
    spec = importlib.util.spec_from_file_location("auth_under_test", path)
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {"jwt": types.ModuleType("jwt")}), patch.dict(
        os.environ,
        {"JWT_SECRET": "x" * 48},
    ):
        spec.loader.exec_module(module)
    return module


auth = load_auth_module()


class PasswordBoundaryTest(unittest.TestCase):
    def test_bcrypt_password_limits_are_validated(self):
        self.assertTrue(auth.is_password_acceptable("123456"))
        self.assertTrue(auth.is_password_acceptable("\u5bc6\u7801\u5bc6\u7801\u5bc6\u7801"))
        self.assertFalse(auth.is_password_acceptable("short"))
        self.assertFalse(auth.is_password_acceptable("x" * 73))

        with self.assertRaises(ValueError):
            auth.hash_password("x" * 73)

    def test_registration_uses_one_normalized_username(self):
        source = Path(__file__).with_name("main.py").read_text(encoding="utf-8")

        self.assertIn("username = creds.username.strip()", source)
        self.assertIn("len(username) > 64", source)
        self.assertNotIn("auth.create_access_token(user_id, creds.username)", source)

    def test_generated_jwt_secret_is_random_and_persistent(self):
        with tempfile.TemporaryDirectory() as directory:
            secret_file = Path(directory) / ".jwt_secret"
            with patch.dict(auth.os.environ, {}, clear=True):
                first = auth._load_secret(secret_file)
                second = auth._load_secret(secret_file)

        self.assertEqual(first, second)
        self.assertGreaterEqual(len(first), 48)
        source = Path(auth.__file__).read_text(encoding="utf-8")
        self.assertNotIn("pet_dev_secret_change_me_in_production", source)


if __name__ == "__main__":
    unittest.main()
