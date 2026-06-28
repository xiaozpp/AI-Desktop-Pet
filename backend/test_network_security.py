import unittest
from pathlib import Path


class NetworkSecurityContractTest(unittest.TestCase):
    def test_desktop_server_only_binds_to_loopback(self):
        source = Path(__file__).with_name("main.py").read_text(encoding="utf-8")

        self.assertIn('host="127.0.0.1"', source)
        self.assertNotIn('host="0.0.0.0"', source)

    def test_http_token_verification_uses_authorization_header(self):
        source = Path(__file__).with_name("main.py").read_text(encoding="utf-8")

        self.assertIn("authorization: str | None = Header(None)", source)
        self.assertNotIn("def verify_token(token: str", source)

    def test_packaged_electron_origin_is_allowed_without_wildcard_cors(self):
        source = Path(__file__).with_name("main.py").read_text(encoding="utf-8")

        self.assertIn('"null",  # Packaged Electron', source)
        self.assertNotIn('allow_origins=["*"]', source)


if __name__ == "__main__":
    unittest.main()
