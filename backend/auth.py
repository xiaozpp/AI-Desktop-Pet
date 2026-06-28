"""
鉴权模块 - bcrypt 哈希 + PyJWT 签发/校验
2026 最简方案：不用 passlib（已停维护）/python-jose（有 CVE）
"""
import bcrypt
import jwt
import os
import secrets
from pathlib import Path
from datetime import datetime, timedelta, timezone

from config import Config, ensure_data_dir

# 从环境变量读 secret，兜底一个开发用默认值（生产务必通过 .env 设置）
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 * 7  # 桌宠本地应用，token 给 7 天

# JWT secret 落到持久数据目录，避免随源码被打包/丢失。
# 保留 .jwt_secret 文件名和 _load_secret(path=...) 签名（测试依赖）。
_JWT_SECRET_FILENAME = ".jwt_secret"


def _default_secret_path() -> Path:
    return Path(Config.DATA_DIR) / _JWT_SECRET_FILENAME


def _load_secret(path: Path | str | None = None) -> str:
    secret_path = Path(path) if path is not None else _default_secret_path()
    configured = os.getenv("JWT_SECRET", "").strip()
    if configured:
        return configured

    try:
        existing = secret_path.read_text(encoding="ascii").strip()
        if len(existing) >= 32:
            return existing
    except FileNotFoundError:
        pass
    except OSError:
        pass

    # 生成新 secret 前确保目录存在
    ensure_data_dir(str(secret_path.parent))
    generated = secrets.token_urlsafe(48)
    try:
        secret_path.write_text(generated, encoding="ascii")
    except OSError as exc:
        raise RuntimeError("JWT secret could not be persisted") from exc
    return generated


SECRET_KEY = _load_secret()


def is_password_acceptable(password: str) -> bool:
    return (
        isinstance(password, str)
        and len(password) >= 6
        and len(password.encode("utf-8")) <= 72
    )


def hash_password(password: str) -> str:
    """bcrypt 哈希，返回 $2b$12$... 字符串"""
    if not is_password_acceptable(password):
        raise ValueError("password must be 6 characters and at most 72 UTF-8 bytes")
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    """校验明文密码是否匹配哈希"""
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except (ValueError, TypeError):
        return False


def create_access_token(user_id: str, username: str) -> str:
    """签发 JWT，sub 存 user_id（标准字段）"""
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user_id,
        "username": username,
        "iat": now,
        "exp": now + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def decode_token(token: str) -> dict:
    """
    验证并返回 payload。
    失败抛 jwt.PyJWTError（ExpiredSignatureError/InvalidTokenError 等），调用方需 try/except。
    """
    return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
