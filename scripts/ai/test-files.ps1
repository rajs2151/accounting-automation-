<#
  Fast feedback while working: run only some TypeScript test files, in the same Docker setup as the unit gate
  (fresh daftar_test DB, all migrations), or only some worker pytest files.
  Usage (repo root):
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/ai/test-files.ps1 src/server/books/inbox-review.test.ts
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/ai/test-files.ps1 -Py tests/test_extraction_e2.py
  The full gates (scripts/ai/gates.ps1) must still pass before finishing; this is only for quick iterations.
#>
param([switch]$Py, [Parameter(ValueFromRemainingArguments = $true)][string[]]$Files)
$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$R = $Repo.Replace('\', '/')
if (-not $Files) { Write-Host "Give one or more test files."; exit 2 }
if ($Py) {
  docker compose up -d postgres minio | Out-Null
  # pytest-inner.sh runs the whole suite; for a subset, reuse its venv and run pytest on the given files.
  $inner = "set -e; mkdir -p /work; tar -C /src --exclude=./node_modules --exclude=./.next --exclude=./.git -cf - worker fixtures db | tar -C /work -xf -; " +
           "cd /work; sed -i 's/127.0.0.1/postgres/g' worker/tests/conftest.py; apt-get -qq update >/dev/null 2>&1; " +
           "apt-get -qq install -y --no-install-recommends postgresql-client libgl1 libglib2.0-0 libgomp1 tesseract-ocr >/dev/null 2>&1; " +
           "/venv/bin/pip install -q --no-deps -e ./worker; cd worker; /venv/bin/python -m pytest -q --tb=short " + ($Files -join ' ')
  docker run --rm --network accountingautomation_default -e S3_ENDPOINT=http://minio:9000 -v "${R}:/src:ro" `
    -v arnibooks_ai_venv:/venv -v arnibooks_ai_pycache:/root/.cache -w /work python:3.12 bash -c $inner
} else {
  docker compose up -d postgres minio | Out-Null
  docker run --rm --network accountingautomation_default -v "${R}:/src:ro" -v arnibooks_ai_node_modules:/work/node_modules `
    -w /work node:22 bash /src/scripts/ai/unit-inner.sh test @Files
}
exit $LASTEXITCODE
