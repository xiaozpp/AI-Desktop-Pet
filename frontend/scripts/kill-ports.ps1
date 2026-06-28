# 清理桌宠占用的端口（5173 vite / 8000 backend）
$ports = 5173, 8000
$found = $false
foreach ($port in $ports) {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    foreach ($conn in $conns) {
        $pid = $conn.OwningProcess
        $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
        if ($proc) {
            Write-Host "killing port $port (PID $pid / $($proc.ProcessName))"
            Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
            $found = $true
        }
    }
}
if (-not $found) { Write-Host "ports already free" }
