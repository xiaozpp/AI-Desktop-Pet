# -*- mode: python ; coding: utf-8 -*-
from pathlib import Path

from PyInstaller.utils.hooks import collect_all


spec_dir = Path(SPECPATH)

datas = []
binaries = []
hiddenimports = []

for package in [
    "bcrypt",
    "chromadb",
    "dashscope",
    "fastapi",
    "httpx",
    "jwt",
    "openai",
    "PIL",
    "pyautogui",
    "pydantic",
    "dotenv",
    "tiktoken",
    "uvicorn",
]:
    try:
        package_datas, package_binaries, package_hidden = collect_all(package)
    except Exception:
        continue
    datas += package_datas
    binaries += package_binaries
    hiddenimports += package_hidden


a = Analysis(
    [str(spec_dir / "main.py")],
    pathex=[str(spec_dir)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="neuro-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="neuro-backend",
)
