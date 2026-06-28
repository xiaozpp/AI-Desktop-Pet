$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$FrontendDir = Resolve-Path (Join-Path $ScriptDir '..')
$ReleaseDir = Join-Path $FrontendDir 'dist-app'
$Target = Join-Path $ReleaseDir 'win-unpacked'

if (-not (Test-Path -LiteralPath $ReleaseDir)) {
  return
}

$ResolvedReleaseDir = [System.IO.Path]::GetFullPath($ReleaseDir)
$ResolvedTarget = [System.IO.Path]::GetFullPath($Target)
if (-not $ResolvedTarget.StartsWith($ResolvedReleaseDir, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to remove unexpected path: $ResolvedTarget"
}

if (Test-Path -LiteralPath $ResolvedTarget) {
  Remove-Item -LiteralPath $ResolvedTarget -Recurse -Force
}
