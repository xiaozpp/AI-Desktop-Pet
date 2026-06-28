import os
import sys
from dotenv import load_dotenv

env_file = os.getenv("NEURO_ENV_FILE", "").strip()
if env_file:
    load_dotenv(env_file)
else:
    load_dotenv()


def resolve_data_dir() -> str:
    """解析持久数据目录。

    优先级：
    1. NEURO_DATA_DIR 环境变量（显式覆盖，便于测试和便携部署；仅服务端读取，不接受客户端输入）。
    2. Windows: %LOCALAPPDATA%\\Neuro
       macOS:   ~/Library/Application Support/Neuro
       Linux:   ~/.local/share/Neuro (遵循 XDG，或 $XDG_DATA_HOME)
    """
    configured = os.getenv("NEURO_DATA_DIR", "").strip()
    if configured:
        return os.path.abspath(configured)

    if sys.platform.startswith("win"):
        base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
        return os.path.join(base, "Neuro")
    if sys.platform == "darwin":
        return os.path.join(os.path.expanduser("~"), "Library", "Application Support", "Neuro")
    # Linux / 其他
    xdg = os.environ.get("XDG_DATA_HOME")
    base = xdg if xdg else os.path.join(os.path.expanduser("~"), ".local", "share")
    return os.path.join(base, "Neuro")


def ensure_data_dir(path: str | None = None) -> str:
    """确保数据目录存在（幂等）。返回最终目录路径。"""
    target = path or Config.DATA_DIR
    os.makedirs(target, exist_ok=True)
    return target


class Config:
    # LLM (主脑对话，默认 DeepSeek)
    LLM_API_KEY = os.getenv("LLM_API_KEY")
    LLM_BASE_URL = os.getenv("LLM_BASE_URL")
    LLM_MODEL = os.getenv("LLM_MODEL", "deepseek-chat")

    # Vision (视觉感知/看屏幕，默认 GLM-4V；DeepSeek 无视觉能力，独立 client)
    VISION_API_KEY = os.getenv("VISION_API_KEY")
    VISION_BASE_URL = os.getenv("VISION_BASE_URL")
    VISION_MODEL = os.getenv("VISION_MODEL", "glm-4v-plus")

    # Profile / Intent (原 DeepSeek 意图分析，已废弃但保留)
    PROFILE_KEY = os.getenv("PROFILE_LLM_KEY")
    PROFILE_BASE = os.getenv("PROFILE_LLM_BASE")

    # SiliconFlow (Embedding 用，STT 默认已迁到阿里云)
    SILICON_KEY = os.getenv("SILICON_API_KEY")
    SILICON_BASE = os.getenv("SILICON_BASE_URL")
    STT_MODEL = os.getenv("STT_MODEL", "FunAudioLLM/SenseVoiceSmall")

    # 阿里云百炼 CosyVoice (TTS - 御姐音) + Qwen-ASR (STT，复用同一 key)
    DASHSCOPE_API_KEY = os.getenv("DASHSCOPE_API_KEY")
    TTS_MODEL = os.getenv("TTS_MODEL", "cosyvoice-v1")
    TTS_VOICE = os.getenv("TTS_VOICE", "longyuan")  # longyuan = 龙渊(御姐)
    # 语音识别 provider：dashscope(阿里云 Qwen-ASR) | siliconflow(旧 SenseVoiceSmall)
    # 阿里云 OpenAI 兼容模式 endpoint，复用 DASHSCOPE_API_KEY
    STT_PROVIDER = os.getenv("STT_PROVIDER", "dashscope")
    DASHSCOPE_COMPAT_BASE = os.getenv(
        "DASHSCOPE_COMPAT_BASE", "https://dashscope.aliyuncs.com/compatible-mode/v1"
    )
    DASHSCOPE_STT_MODEL = os.getenv("DASHSCOPE_STT_MODEL", "qwen3-asr-flash")

    # Proxy
    PROXY = os.getenv("PROXY_URL")

    # 持久数据目录：优先 NEURO_DATA_DIR 环境变量；否则按平台落到系统应用数据目录，
    # 避免打包/覆盖安装/只读安装目录导致持久化丢失。
    DATA_DIR = resolve_data_dir()
