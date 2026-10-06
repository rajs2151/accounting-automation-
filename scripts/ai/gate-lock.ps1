# Shared test lock for parallel agents (Cursor + Claude Code in separate worktrees).
# All test runs use the same Docker Postgres test DBs (daftar_test, daftar_e2e) and the same node_modules/venv volumes,
# so only one run may happen at a time. The lock is an exclusively opened file; Windows releases it automatically if
# the process dies, so a crashed run never leaves a stale lock.
# Usage (dot-source):  . "$PSScriptRoot\gate-lock.ps1";  $lock = Enter-GateLock "unit";  try { ... } finally { Exit-GateLock $lock }

function Enter-GateLock([string]$what = "tests") {
  $path = Join-Path $env:USERPROFILE ".arnibooks-gates.lock"
  $waited = $false
  while ($true) {
    try {
      $fs = [IO.File]::Open($path, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
      $info = [Text.Encoding]::UTF8.GetBytes("pid=$PID what=$what since=$(Get-Date -Format s) repo=$((Get-Location).Path)")
      $fs.SetLength(0); $fs.Write($info, 0, $info.Length); $fs.Flush()
      if ($waited) { Write-Host "Test lock acquired ($what)." }
      return $fs
    } catch [System.IO.IOException] {
      if (-not $waited) { Write-Host "Another agent is running tests; waiting for the shared test lock ($what)..." }
      $waited = $true
      Start-Sleep 15
    }
  }
}

function Exit-GateLock($fs) {
  if ($fs) { $fs.Close() }
}
