<#
  arnibooks AI loop - Cursor implements, Claude reviews.
  Usage (from the repo root, normal PowerShell):
    .\scripts\ai\loop.ps1               # run the loop on .ai\CURSOR_TASK.md (stops on PASS / NEEDS_HUMAN / max iterations)
    .\scripts\ai\loop.ps1 -Once         # one iteration only (POC)
    .\scripts\ai\loop.ps1 -ReviewOnly   # skip Cursor; gates + review of the current HEAD vs -Base
    .\scripts\ai\loop.ps1 -Status       # print current state
    .\scripts\ai\loop.ps1 -Stop | -Pause | -Resume
  Never pushes, resets, force-pushes or deletes branches.
#>
[CmdletBinding()]
param(
  [switch]$Once, [switch]$ReviewOnly, [switch]$Status,
  [switch]$Stop, [switch]$Pause, [switch]$Resume,
  [string]$Base = ""
)
$ErrorActionPreference = "Stop"
$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $Repo
$AI = Join-Path $Repo ".ai"
$StateFile = Join-Path $AI "state.json"
$Cfg = Get-Content (Join-Path $AI "config.json") -Raw | ConvertFrom-Json

function Write-State($obj) { $obj | ConvertTo-Json -Depth 6 | Set-Content -Path $StateFile -Encoding UTF8 }
function Read-State { if (Test-Path $StateFile) { Get-Content $StateFile -Raw | ConvertFrom-Json } else { $null } }
function Log($msg) { $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg; Write-Host $line; if ($script:RunDir) { Add-Content (Join-Path $script:RunDir "loop.log") $line } }
function GitOut([string[]]$a) { $out = & git @a 2>&1; if ($LASTEXITCODE -ne 0) { throw "git $($a -join ' ') failed: $out" }; return $out }

# ---------- control commands ----------
if ($Stop)   { New-Item -ItemType File -Force (Join-Path $AI "STOP")  | Out-Null; Write-Host "STOP requested. The loop stops at the next checkpoint."; exit 0 }
if ($Pause)  { New-Item -ItemType File -Force (Join-Path $AI "PAUSE") | Out-Null; Write-Host "PAUSE requested."; exit 0 }
if ($Resume) { Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $AI "PAUSE"); Write-Host "Resumed."; exit 0 }
if ($Status) {
  $s = Read-State
  if (-not $s) { Write-Host "No run yet."; exit 0 }
  "Current phase : $($s.phase)"; "Current task  : $($s.task_id)"; "Iteration     : $($s.iteration) / $($Cfg.maxIterations)"
  "Cursor status : $($s.cursor)"; "Tests         : $($s.tests)"; "Decision      : $($s.decision)"
  "Last error    : $($s.last_error)"; "Next action   : $($s.next_action)"; "Run folder    : $($s.run_dir)"
  exit 0
}

function Check-Control {
  if (Test-Path (Join-Path $AI "STOP")) { Remove-Item -Force (Join-Path $AI "STOP"); Log "STOP file found - stopping."; Save -next "stopped by owner"; exit 0 }
  while (Test-Path (Join-Path $AI "PAUSE")) { Write-Host "Paused (run -Resume)..."; Start-Sleep 15 }
}

# ---------- preconditions ----------
$branch = (GitOut @("rev-parse","--abbrev-ref","HEAD")).Trim()
if ($branch -notmatch $Cfg.branchPattern) { throw "Refusing to run on branch '$branch' (must match $($Cfg.branchPattern))." }
$dirty = & git -c core.autocrlf=true status --porcelain --untracked-files=normal | Where-Object { $_ -notmatch '\.ai/' }
if ($dirty -and -not $ReviewOnly) {
  Write-Host "Working tree has uncommitted changes (commit or stash them yourself first):" -ForegroundColor Yellow
  $dirty | Select-Object -First 20 | ForEach-Object { Write-Host "  $_" }
  exit 1
}
$taskFile = Join-Path $AI "CURSOR_TASK.md"
if (-not (Test-Path $taskFile)) { throw ".ai\CURSOR_TASK.md missing" }
$taskId = ((Select-String -Path $taskFile -Pattern '^TASK ID:\s*(.+)$' | Select-Object -First 1).Matches[0].Groups[1].Value).Trim()

$script:St = [ordered]@{ phase=""; task_id=$taskId; iteration=0; cursor=""; tests=""; decision=""; last_error=""; next_action=""; run_dir="" }
$phaseLine = Select-String -Path $taskFile -Pattern '^PHASE:\s*(.+)$' | Select-Object -First 1
if ($phaseLine) { $St.phase = $phaseLine.Matches[0].Groups[1].Value.Trim() }
function Save([string]$next = "") { if ($next) { $St.next_action = $next }; Write-State $St }

function Run-WithTimeout([string]$cmd, [string]$logPath, [int]$minutes) {
  # Write the command to a temp script (avoids Windows argument-quoting problems), run it with a hard timeout.
  $tmp = "$logPath.cmd.ps1"
  ("Set-Location -LiteralPath '{0}'`r`n{1}`r`nexit `$LASTEXITCODE" -f $Repo, $cmd) | Set-Content -Path $tmp -Encoding UTF8
  $p = Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile","-ExecutionPolicy","Bypass","-File","`"$tmp`"") `
        -WorkingDirectory $Repo -RedirectStandardOutput $logPath -RedirectStandardError "$logPath.err" -PassThru -WindowStyle Hidden
  $null = $p.Handle   # PS 5.1: needed so ExitCode is populated
  if (-not $p.WaitForExit($minutes * 60 * 1000)) {
    try { & taskkill /PID $p.Id /T /F | Out-Null } catch {}
    $null = $p.WaitForExit(30000)   # let the killed tree release the redirected log file
    # The log can still be locked for a moment; never let the timeout note crash the loop.
    try { Add-Content $logPath "`nTIMEOUT after $minutes min" -ErrorAction Stop } catch { Set-Content "$logPath.timeout" "TIMEOUT after $minutes min" }
    return 124
  }
  if (Test-Path "$logPath.err") { Get-Content "$logPath.err" | Add-Content $logPath; Remove-Item "$logPath.err" }
  return $p.ExitCode
}

$iter = 0
while ($true) {
  $iter++
  Check-Control
  if ($iter -gt [int]$Cfg.maxIterations) { Log "Max iterations reached."; $St.decision="NEEDS_HUMAN_DECISION"; Save "max iterations reached - owner review"; break }
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $script:RunDir = Join-Path $AI ("runs\{0}-{1}-i{2}" -f $stamp, $taskId, $iter)
  New-Item -ItemType Directory -Force (Join-Path $RunDir "gates") | Out-Null
  $St.iteration = $iter; $St.run_dir = $RunDir; $St.decision = ""; $St.last_error = ""
  Copy-Item $taskFile (Join-Path $RunDir "task.md")

  $baseSha = if ($Base) { $Base } else { (GitOut @("rev-parse","HEAD")).Trim() }
  Log "Task $taskId iteration $iter on $branch @ $baseSha"

  # ---------- 1. Cursor implements ----------
  if (-not $ReviewOnly) {
    $St.cursor = "running"; Save "waiting for Cursor"
    $report = (Join-Path $RunDir "cursor-report.md").Replace('\','/')
    $prompt = "Read .ai/CURSOR_TASK.md and implement exactly that task in this repository, following .cursor/rules/arnibooks.mdc. " +
              "Before you finish, verify with the orchestrator's own gates (same Docker commands the reviewer trusts): " +
              "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/ai/gates.ps1 unit typecheck (add pytest if you changed worker/, e2e if you changed src/app, src/components, e2e or db). " +
              "Report the exact pass/fail counts they print; do not claim a pass you did not see. " +
              "Keep the change small; if the task cannot be finished in about 35 minutes, commit what is green, write the report with what is left, and stop. " +
              "Make local commits only on the current branch (never push). " +
              "When finished, write your report to $report and stop."
    $model = if ($Cfg.cursorModel) { "--model $($Cfg.cursorModel) " } else { "" }
    $cmd = "agent -p --force $model--output-format text `"$prompt`""
    $code = Run-WithTimeout $cmd (Join-Path $RunDir "cursor-output.txt") ([int]$Cfg.cursorTimeoutMinutes)
    $St.cursor = "exit $code"; Save
    if ($code -ne 0) { $St.last_error = "Cursor exited $code"; Log $St.last_error }
  }
  Check-Control

  # ---------- 2. collect evidence ----------
  $head = (GitOut @("rev-parse","HEAD")).Trim()
  & git diff "$baseSha..$head" | Set-Content (Join-Path $RunDir "diff.patch") -Encoding UTF8
  & git diff | Add-Content (Join-Path $RunDir "diff.patch")            # uncommitted leftovers, if any
  $changed = @(& git diff --name-only "$baseSha..$head") + @(& git diff --name-only) + @(& git ls-files --others --exclude-standard) | Sort-Object -Unique | Where-Object { $_ -and $_ -notmatch '^\.ai/' }
  $level2 = $changed | Where-Object { $f = $_; $Cfg.level2Paths | Where-Object { $f.StartsWith($_) } }
  $forbidden = $changed | Where-Object { $f = $_; $Cfg.forbiddenPaths | Where-Object { $f.StartsWith($_) } }

  # ---------- 3. gates (re-run by the orchestrator, not trusted from Cursor) ----------
  $gateSummary = @()
  foreach ($g in $Cfg.gates) {
    $applies = ($g.when -eq "*") -or (@($g.when -split ',') | Where-Object { $p = $_; $changed | Where-Object { $_.StartsWith($p) } })
    if (-not $applies) { $gateSummary += "$($g.name): SKIPPED (no matching changes)"; continue }
    Check-Control
    $St.tests = "running $($g.name)"; Save
    $gcmd = $g.command.Replace('${REPO}', $Repo.Replace('\','/'))
    Log "Gate $($g.name)..."
    $gc = Run-WithTimeout $gcmd (Join-Path $RunDir "gates\$($g.name).log") 40
    $res = if ($gc -eq 0) { "PASS" } else { "FAIL (exit $gc)" }
    if ($gc -ne 0 -and $g.name -eq "unit") {
      # Compare failing test names with the known pre-existing failures listed in config.knownUnitFailures
      $failNames = @(Select-String -Path (Join-Path $RunDir "gates\unit.log") -Pattern '^not ok \d+ - (.+)$' | ForEach-Object { $_.Matches[0].Groups[1].Value.Trim() })
      $known = @($Cfg.knownUnitFailures)
      $newFails = @($failNames | Where-Object { $known -notcontains $_ })
      $failNames | Set-Content (Join-Path $RunDir "gates\unit-failures.txt") -Encoding UTF8
      if ($failNames.Count -gt 0 -and $newFails.Count -eq 0) { $res = "PASS (only $($failNames.Count) known pre-existing failures)" }
      else { $res = "FAIL ($($newFails.Count) NEW failing tests: $($newFails -join ' | '))" }
    }
    $req = if ($g.required) { "required" } else { "informational" }
    $gateSummary += "$($g.name) [$req]: $res"
    Log "Gate $($g.name): $res"
  }
  $St.tests = ($gateSummary -join "; "); Save "reviewing"

  # ---------- 4. review package ----------
  $pkg = @"
# Review package - $taskId iteration $iter
- Branch: $branch
- Base: $baseSha   Head: $head
- Run folder: $($RunDir.Replace($Repo + '\',''))
## Changed files
$(($changed | ForEach-Object { "- $_" }) -join "`n")
## Level-2 files touched (need stronger evidence)
$(if ($level2) { ($level2 | ForEach-Object { "- $_" }) -join "`n" } else { "- none" })
## FORBIDDEN files touched (automatic NEEDS_HUMAN_DECISION if non-empty)
$(if ($forbidden) { ($forbidden | ForEach-Object { "- $_" }) -join "`n" } else { "- none" })
## Gates (re-run by orchestrator)
$(($gateSummary | ForEach-Object { "- $_" }) -join "`n")
Full logs: gates/*.log in the run folder. Diff: diff.patch. Cursor output: cursor-output.txt / cursor-report.md.
"@
  $pkg | Set-Content (Join-Path $RunDir "package.md") -Encoding UTF8

  # ---------- 5. Claude reviews ----------
  $rel = $RunDir.Replace($Repo + '\','').Replace('\','/')
  $reviewPrompt = "Review task $taskId. The task is .ai/CURSOR_TASK.md. The run package is $rel/package.md (diff: $rel/diff.patch, gate logs: $rel/gates/, Cursor output: $rel/cursor-output.txt). " +
                  "Base commit $baseSha, head $head - use git diff/show to inspect the real changes. Follow the reviewer brief exactly and end with ONLY the JSON object."
  $reviewPrompt | Set-Content (Join-Path $RunDir "review-prompt.txt") -Encoding UTF8
  $tools = "Read,Grep,Glob,Bash(git diff *),Bash(git show *),Bash(git log *),Bash(git status *)"
  $rcmd = "Get-Content -Raw '$($RunDir)\review-prompt.txt' | claude -p --output-format json --permission-mode dontAsk --allowedTools `"$tools`" --append-system-prompt-file .ai/REVIEWER.md"
  $St.decision = "reviewing"; Save
  $rc = Run-WithTimeout $rcmd (Join-Path $RunDir "review-raw.json") ([int]$Cfg.reviewTimeoutMinutes)

  # ---------- 6. parse decision ----------
  $decision = $null
  try {
    $raw = Get-Content (Join-Path $RunDir "review-raw.json") -Raw -Encoding UTF8
    $envl = $raw | ConvertFrom-Json
    $text = [string]$envl.result
    $start = $text.IndexOf('{'); $end = $text.LastIndexOf('}')
    $decision = $text.Substring($start, $end - $start + 1) | ConvertFrom-Json
    $decision | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $RunDir "decision.json") -Encoding UTF8
    if ($envl.total_cost_usd) { Log ("Review cost (est.): USD {0}" -f $envl.total_cost_usd) }
  } catch {
    $St.last_error = "Could not parse reviewer output (exit $rc): $($_.Exception.Message)"
    if ($raw -match 'Not logged in') { $St.last_error = "Claude Code is not logged in. Run 'claude' once in PowerShell, type /login, then re-run with -ReviewOnly -Base $baseSha" }
    Log $St.last_error
  }
  if ($forbidden -and $decision) { $decision.decision = "NEEDS_HUMAN_DECISION"; $decision.human_question = "Forbidden paths changed: $($forbidden -join ', ')" }

  $d = if ($decision) { $decision.decision } else { "NEEDS_HUMAN_DECISION" }
  $St.decision = $d
  $reviewMd = "# Review - $taskId iteration $iter`n`n**Decision: $d**`n`n" + $(if ($decision) { "$($decision.summary)`n`n" + (($decision.requirements | ForEach-Object { "- [$($_.result)] $($_.criterion) - $($_.evidence)" }) -join "`n") + "`n`nNeeds human validation: $((@($decision.needs_human_validation)) -join '; ')`n`nQuestion: $($decision.human_question)" } else { "Reviewer output unreadable - see review-raw.json" })
  $reviewMd | Set-Content (Join-Path $RunDir "review.md") -Encoding UTF8
  Copy-Item (Join-Path $RunDir "review.md") (Join-Path $AI "CLAUDE_REVIEW.md") -Force
  Add-Content -Encoding UTF8 (Join-Path $AI "STATUS.md") ("- {0} | {1} | i{2} | {3} | {4}" -f (Get-Date -Format "yyyy-MM-dd HH:mm"), $taskId, $iter, $d, $rel)
  Log "Decision: $d"

  if ($d -eq "PASS") { Save "PASS - owner checks needs_human_validation items, then queue the next task"; break }
  if ($d -ne "FAIL") { Save "NEEDS HUMAN - read .ai\CLAUDE_REVIEW.md"; break }

  # FAIL -> corrective task becomes the next Cursor task
  if ([string]::IsNullOrWhiteSpace($decision.next_task)) { Save "FAIL without next_task - owner review"; break }
  Copy-Item $taskFile (Join-Path $RunDir "task-before-fix.md")
  $decision.next_task | Set-Content $taskFile -Encoding UTF8
  Save "Cursor fixing (next iteration)"
  if ($Once -or $ReviewOnly) { Log "Stopping after one iteration (-Once/-ReviewOnly). Corrective task written to .ai\CURSOR_TASK.md"; break }
}
Write-Host "`nDone. Status:"; & $PSCommandPath -Status
