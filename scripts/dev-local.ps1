<#
  Live dev mode for localhost - see code changes without rebuilding Docker images.
    .\scripts\dev-local.ps1 -Web       # Next dev server with hot reload on http://127.0.0.1:3000 (new window)
    .\scripts\dev-local.ps1 -Worker    # worker container runs Python from .\worker\src (restart picks up changes)
    .\scripts\dev-local.ps1 -Restart   # restart the dev worker after Python changes (seconds)
    .\scripts\dev-local.ps1 -Stable    # back to the built images (worker from its image; web stays on :43123)
  The Docker web app on :43123 keeps running as the stable copy. Postgres/MinIO/worker are shared with it.
  Dev mode serves whatever is in this folder right now - including half-finished edits while the AI loop runs.
#>
param([switch]$Web, [switch]$Worker, [switch]$Restart, [switch]$Stable)
$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $Repo
$compose = @("-f", "docker-compose.yml", "-f", "docker-compose.dev.yml")

if ($Worker) {
  docker compose @compose up -d --no-build worker
  Write-Host "Worker now runs code from .\worker\src. After Python changes: .\scripts\dev-local.ps1 -Restart"
}
if ($Restart) {
  docker compose @compose restart worker
  Write-Host "Worker restarted with the current .\worker\src."
}
if ($Stable) {
  docker compose up -d --no-build worker
  Write-Host "Worker back on its built image."
}
if ($Web) {
  docker compose up -d postgres minio | Out-Null
  $envs = @{
    DATABASE_URL           = "postgresql://daftar_app:daftar-local-only@127.0.0.1:5432/daftar"
    DATABASE_URL_SUPER     = "postgresql://daftar:daftar-local-only@127.0.0.1:5432/daftar"
    S3_ENDPOINT            = "http://127.0.0.1:59000"
    S3_PUBLIC_ENDPOINT     = "http://127.0.0.1:59000"
    S3_ACCESS_KEY          = "daftar"
    S3_SECRET_KEY          = "daftar-local-only"
    S3_BUCKET              = "statements"
    S3_REGION              = "us-east-1"
    IBAN_ENCRYPTION_KEY    = "dev-only-iban-key-change-me"
    OCR_PROVIDER           = "local"
    WORKER_BASE_URL        = "http://127.0.0.1:4711"
    WORKER_TOKEN           = "dev-worker-token"
    PDF_PROBE_MIN_CHARS    = "30"
    PORTAL_SECURITY_STATUS = "FAIL"
    REQUIRE_DOWNLOAD_MFA   = "true"
    MFA_DEMO_CODE          = "000000"
    MFA_TTL_SECONDS        = "300"
  }
  $set = ($envs.GetEnumerator() | ForEach-Object { "`$env:$($_.Key)='$($_.Value)'" }) -join "; "
  Start-Process powershell -ArgumentList @("-NoExit", "-Command", "$set; Set-Location -LiteralPath '$Repo'; npx next dev --turbopack -H 127.0.0.1 -p 3000")
  Write-Host "Dev web starting in a new window: http://127.0.0.1:3000/books (first page load compiles, ~20-40 s)."
}
if (-not ($Web -or $Worker -or $Restart -or $Stable)) { Get-Help $PSCommandPath -Detailed | Out-String | Write-Host }
