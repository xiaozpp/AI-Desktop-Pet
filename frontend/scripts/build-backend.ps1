$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$FrontendDir = Resolve-Path (Join-Path $ScriptDir '..')
$RepoRoot = Resolve-Path (Join-Path $FrontendDir '..')
$BackendDir = Join-Path $RepoRoot 'backend'
$BuildDir = Join-Path $FrontendDir 'build'
$BackendBundleDir = Join-Path $BuildDir 'backend'
$PyInstallerWorkDir = Join-Path $BuildDir 'pyinstaller-work'
$EnvFile = if ($env:NEURO_PACKAGE_ENV_FILE) { $env:NEURO_PACKAGE_ENV_FILE } else { Join-Path $BackendDir '.env' }
$Python = if ($env:PYTHON) { $env:PYTHON } else { 'python' }

if (-not (Test-Path -LiteralPath $EnvFile)) {
  throw 'Missing package env file. Create backend\.env or set NEURO_PACKAGE_ENV_FILE to the env file that should be bundled.'
}

$ResolvedBuildDir = [System.IO.Path]::GetFullPath($BuildDir)
$ResolvedBackendBundleDir = [System.IO.Path]::GetFullPath($BackendBundleDir)
if (-not $ResolvedBackendBundleDir.StartsWith($ResolvedBuildDir, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to clean unexpected backend bundle path: $ResolvedBackendBundleDir"
}

if (Test-Path -LiteralPath $BackendBundleDir) {
  Remove-Item -LiteralPath $BackendBundleDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $BackendBundleDir | Out-Null
New-Item -ItemType Directory -Force -Path $PyInstallerWorkDir | Out-Null

& $Python -m pip install -r (Join-Path $BackendDir 'requirements.txt') -r (Join-Path $BackendDir 'requirements-build.txt')
& $Python -m PyInstaller --noconfirm --clean --distpath $BackendBundleDir --workpath $PyInstallerWorkDir (Join-Path $BackendDir 'neuro-backend.spec')

Copy-Item -LiteralPath $EnvFile -Destination (Join-Path $BackendBundleDir '.env') -Force
Write-Host 'Packaged backend bundle is ready. Env file contents were not printed.'
