"""
旧数据目录 → 持久数据目录的一次性迁移。

背景：users.db / user_facts/ / memory_db/ / .jwt_secret 原先落在 backend 源码目录，
打包、覆盖安装或只读安装目录会造成持久化风险。这里把它们迁到 Config.DATA_DIR。

设计约束（见 docs/LONG_TERM_MEMORY_ARCHITECTURE.md 4.1）：
1. 新目录为空且旧目录有数据时才迁移。
2. 文件先复制到临时目录校验，再原子切换。
3. 迁移成功后保留旧数据一段时间，不立即删除。
4. 迁移日志只写数量和状态，不写记忆正文（隐私）。
5. 幂等：重复启动不会重复迁移或覆盖新数据。
"""
import os
import shutil
import tempfile
from pathlib import Path

from config import Config, ensure_data_dir

# 旧源码目录（backend/）。迁移源始终从这里找，不受启动工作目录影响。
LEGACY_DIR = os.path.dirname(os.path.abspath(__file__))

# 旧目录下需要迁移的相对条目（文件或目录）。
# persona_state.json 已被 db.py 的运行时迁移逻辑消费，这里也一并搬到新目录，
# 让 db.init_db 的 LEGACY_PERSONA_PATH（指向新目录）仍能读到历史选择。
LEGACY_ENTRIES = ("users.db", "user_facts", "memory_db", ".jwt_secret", "persona_state.json")


def _entry_exists(path: Path) -> bool:
    return path.exists() and (path.is_file() or any(path.iterdir()) if path.is_dir() else True)


def _safe_copy_entry(src: Path, dst: Path):
    """复制单个文件或目录到 dst（dst 不能已存在有效内容）。"""
    if src.is_file():
        shutil.copy2(src, dst)
    elif src.is_dir():
        # 目录整体复制；copytree 要求 dst 不存在，先复制到 dst 内的临时名再重命名
        tmp_dst = dst.with_name(dst.name + ".part")
        if tmp_dst.exists():
            shutil.rmtree(tmp_dst)
        shutil.copytree(src, tmp_dst)
        os.replace(tmp_dst, dst)


def migrate_legacy_data(target_dir: str | None = None, legacy_dir: str | None = None) -> dict:
    """把旧目录数据迁移到 target_dir。

    返回摘要 dict（仅含数量和状态，不含任何记忆正文）：
        {"migrated": [...], "skipped": [...], "reason": "..."}
    """
    target = Path(target_dir or Config.DATA_DIR)
    legacy = Path(legacy_dir or LEGACY_DIR)
    ensure_data_dir(str(target))

    migrated: list[str] = []
    skipped: list[str] = []

    # 已迁移标记：新目录存在一个 .migrated 标记文件即认为迁移完成（幂等）。
    marker = target / ".migrated"
    if marker.exists():
        return {"migrated": [], "skipped": list(LEGACY_ENTRIES), "reason": "already migrated"}

    for name in LEGACY_ENTRIES:
        src = legacy / name
        dst = target / name
        if not src.exists():
            skipped.append(name)
            continue
        # 空目录跳过，避免无谓复制
        if src.is_dir() and not any(src.iterdir()):
            skipped.append(name)
            continue
        # 目标已存在有效内容则跳过，绝不覆盖（幂等 + 安全）
        if dst.exists():
            if dst.is_file():
                if dst.stat().st_size > 0:
                    skipped.append(name)
                    continue
            elif dst.is_dir() and any(dst.iterdir()):
                skipped.append(name)
                continue

        # 原子写：先写临时目录，校验后移动到目标。
        try:
            with tempfile.TemporaryDirectory(dir=str(target)) as staging:
                staged = Path(staging) / name
                _safe_copy_entry(src, staged)
                # 校验：staged 存在且非空
                if staged.is_file() and staged.stat().st_size == 0 and src.stat().st_size > 0:
                    raise OSError(f"staged {name} empty after copy")
                # 移动到最终位置（同目录 rename 是原子的）
                if dst.exists():
                    # 竞态兜底：dst 在过程中被创建，放弃以保留它
                    skipped.append(name)
                    continue
                os.replace(staged, dst)
                migrated.append(name)
        except OSError as exc:
            # 单条迁移失败不影响其它条目；记录原因（不含正文）后继续。
            print(f"⚠️ 迁移 {name} 失败: {exc}")
            skipped.append(name)

    # 写入迁移标记（只记迁移过的条目名，不记内容）
    try:
        marker.write_text(
            "\n".join(sorted(migrated)) if migrated else "(none)",
            encoding="utf-8",
        )
    except OSError:
        pass

    print(f"📦 数据目录迁移完成: 迁移 {len(migrated)} 项, 跳过 {len(skipped)} 项 -> {target}")
    return {"migrated": migrated, "skipped": skipped, "reason": "ok"}
