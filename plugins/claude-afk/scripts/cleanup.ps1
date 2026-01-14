# Claude AFK Cleanup Script
# Kills orphaned permission-handler and daemon processes

$ErrorActionPreference = 'SilentlyContinue'

Write-Host "Finding claude-afk related processes..."

$processes = Get-CimInstance Win32_Process -Filter "name='node.exe'" |
    Where-Object { $_.CommandLine -like '*claude-afk*' }

if ($processes.Count -eq 0) {
    Write-Host "No claude-afk processes found."
    exit 0
}

Write-Host "Found $($processes.Count) process(es):"
foreach ($proc in $processes) {
    $type = if ($proc.CommandLine -like '*permission-handler*') { 'permission-handler' }
            elseif ($proc.CommandLine -like '*daemon*') { 'daemon' }
            else { 'unknown' }
    Write-Host "  PID $($proc.ProcessId): $type"
}

Write-Host ""
Write-Host "Killing processes..."

foreach ($proc in $processes) {
    try {
        Stop-Process -Id $proc.ProcessId -Force
        Write-Host "  Killed PID $($proc.ProcessId)"
    } catch {
        Write-Host "  Failed to kill PID $($proc.ProcessId): $_"
    }
}

# Also clean up lock files
$claudeAfkDir = Join-Path $env:USERPROFILE ".claude\claude-afk"
$lockFile = Join-Path $claudeAfkDir "daemon.lock"
$lockDir = Join-Path $claudeAfkDir "daemon.lock.lock"

Write-Host "Checking for lock files in: $claudeAfkDir"

if (Test-Path $lockFile) {
    Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
    Write-Host "Removed daemon.lock"
}

if (Test-Path $lockDir) {
    Remove-Item $lockDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "Removed daemon.lock.lock directory"
}

# Also check for any .lock files
Get-ChildItem -Path $claudeAfkDir -Filter "*.lock*" -ErrorAction SilentlyContinue | ForEach-Object {
    Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "Removed $($_.Name)"
}

Write-Host "Cleanup complete."
