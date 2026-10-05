<#
  Run the AI loop's gates exactly as the orchestrator does (commands come from .ai/config.json).
  Usage (repo root):  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/ai/gates.ps1 unit
                      powershell -NoProfile -ExecutionPolicy Bypass -File scripts/ai/gates.ps1 unit typecheck pytest e2e
  Exit code = number of failed gates (0 = all passed).
#>
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Names)
$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $Repo
$Cfg = Get-Content (Join-Path $Repo ".ai\config.json") -Raw | ConvertFrom-Json
if (-not $Names) { $Names = @($Cfg.gates | ForEach-Object { $_.name }) }
$failed = 0
foreach ($n in $Names) {
  $g = $Cfg.gates | Where-Object { $_.name -eq $n } | Select-Object -First 1
  if (-not $g) { Write-Host "Unknown gate '$n'. Known: $(($Cfg.gates | ForEach-Object { $_.name }) -join ', ')"; $failed++; continue }
  $cmd = $g.command.Replace('${REPO}', $Repo.Replace('\','/'))
  Write-Host "=== gate $n ==="
  Invoke-Expression $cmd
  $code = $LASTEXITCODE
  Write-Host "=== gate $n exit $code ==="
  if ($code -ne 0) { $failed++ }
}
exit $failed
