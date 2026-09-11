import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class ConfigEnvFileTest(unittest.TestCase):
    def test_neuro_env_file_is_loaded_before_config_values(self):
        with tempfile.TemporaryDirectory() as directory:
            env_file = Path(directory) / ".env"
            env_file.write_text(
                "LLM_API_KEY=from_packaged_env\nLLM_BASE_URL=https://example.test/v1\n",
                encoding="utf-8",
            )
            env = os.environ.copy()
            env.pop("LLM_API_KEY", None)
            env.pop("LLM_BASE_URL", None)
            env["NEURO_ENV_FILE"] = str(env_file)

            output = subprocess.check_output(
                [
                    sys.executable,
                    "-c",
                    "from config import Config; print(Config.LLM_API_KEY); print(Config.LLM_BASE_URL)",
                ],
                cwd=Path(__file__).parent,
                env=env,
                text=True,
            ).splitlines()

        self.assertEqual(output, ["from_packaged_env", "https://example.test/v1"])

if __name__ == "__main__":
    unittest.main()
