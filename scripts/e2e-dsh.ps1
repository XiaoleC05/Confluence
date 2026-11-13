<#
.SYNOPSIS
  Confluence / 汇流 — offline end-to-end harness for the DSH 0.2.2-rc.1 host plugin.

.DESCRIPTION
  Creates a throwaway DSH_HOME + headless scratch profile, installs this local
  bundle, runs two real headless sessions in the same workspace against a local
  Messages-API mock (no network egress), then asserts the cross-session contract:
  the first session publishes a note with `confluence_post`, the second session's
  passive pulse carries that note. Every run directory is kept under
  `.tmp/e2e/run-<stamp>/` (git-ignored) for evidence.

  The real `~/.dsh` profile is never opened: DSH_HOME is overridden for every
  child process, and the script asserts the desktop profile files are unchanged.

.PARAMETER DshPath
  The `dsh.cmd` launcher. Defaults to the installed DeepSeek Harness runtime;
  when missing the harness prints SKIPPED and exits 0.

.PARAMETER WorkRoot
  Overrides the scratch root (default: <repo>/.tmp/e2e).

.EXAMPLE
  pwsh -File scripts/e2e-dsh.ps1
#>
[CmdletBinding()]
param(
  [string]$DshPath = 'C:\Users\71408\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd',
  [string]$WorkRoot = ''
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($WorkRoot)) { $WorkRoot = Join-Path $Root '.tmp\e2e' }
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$RunDir = Join-Path $WorkRoot "run-$Stamp"
$ScratchHome = Join-Path $RunDir 'dsh-home'
$Workspace = Join-Path $RunDir 'workspace'
$Profile = 'confluence-e2e'
$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
$Results = [System.Collections.Generic.List[object]]::new()
$Mocks = [System.Collections.Generic.List[object]]::new()

function Add-Result([string]$Id, [string]$Label, [bool]$Ok, [string]$Detail) {
  $Results.Add([pscustomobject]@{ Id = $Id; Label = $Label; Ok = $Ok; Detail = $Detail })
  $tag = if ($Ok) { 'PASS' } else { 'FAIL' }
  Write-Host ("{0}    {1}  {2}{3}" -f $tag, $Id, $Label, $(if ($Detail) { " — $Detail" } else { '' }))
}

function Wait-PortFile([string]$Path, [int]$TimeoutMs = 15000) {
  $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path $Path) {
      $value = (Get-Content $Path -Raw).Trim()
      if ($value -ne '') { return $value }
    }
    Start-Sleep -Milliseconds 100
  }
  throw "mock LLM did not write its port file within ${TimeoutMs}ms"
}

function Start-Mock([string]$Scenario, [string]$LogName, [string]$PortFile) {
  if (Test-Path $PortFile) { Remove-Item $PortFile -Force }
  $arguments = @(
    (Join-Path $Root 'test\e2e\mock-llm.mjs'),
    '--scenario', (Join-Path $Root "test\e2e\scenarios\$Scenario"),
    '--log', (Join-Path $RunDir $LogName),
    '--host', '127.0.0.1', '--port', '0',
    '--print-port-file', $PortFile
  )
  $process = Start-Process -FilePath $Node -ArgumentList $arguments -PassThru -WindowStyle Hidden
  $Mocks.Add($process)
  return @{ Process = $process; Port = (Wait-PortFile $PortFile) }
}

function Stop-Mock($Mock) {
  if ($null -eq $Mock) { return }
  try {
    if (-not $Mock.Process.HasExited) { Stop-Process -Id $Mock.Process.Id -Force -ErrorAction Stop }
  } catch {
    # Best effort.
  }
}

# ── prerequisites ─────────────────────────────────────────────────────────
if ([string]::IsNullOrWhiteSpace($Node)) {
  Write-Host 'SKIPPED: node is not on PATH.'
  exit 0
}
if (-not (Test-Path $DshPath)) {
  Write-Host "SKIPPED: dsh launcher not found at $DshPath"
  exit 0
}

$realDshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$desktopPackage = Join-Path $realDshHome 'profiles\desktop\package.json'
$desktopPatch = Join-Path $realDshHome 'profiles\desktop\cordis.patch.yml'
$beforePackage = if (Test-Path $desktopPackage) { (Get-FileHash $desktopPackage -Algorithm SHA256).Hash } else { '' }
$beforePatch = if (Test-Path $desktopPatch) { (Get-FileHash $desktopPatch -Algorithm SHA256).Hash } else { '' }
$realStore = Join-Path $realDshHome 'storages\confluence'

New-Item -ItemType Directory -Force -Path $RunDir, $ScratchHome, $Workspace | Out-Null
Write-Host "Confluence E2E — $Stamp"
Write-Host "  repo:     $Root"
Write-Host "  run dir:  $RunDir"
Write-Host "  dsh home: $ScratchHome (scratch only)"

$savedDshHome = $env:DSH_HOME
$savedBaseUrl = $env:DEEPSEEK_BASE_URL
$savedApiKey = $env:DEEPSEEK_API_KEY
try {
  $env:DSH_HOME = $ScratchHome
  $env:DEEPSEEK_API_KEY = 'mock-e2e-key'
  $env:DEEPSEEK_BASE_URL = 'http://127.0.0.1:1' # replaced per mock below

  # ── E2E-00: scratch profile + bundle install ───────────────────────────
  $createOut = & $DshPath --profile $Profile --from-default-profile headless --dump-config 2>&1 | Out-String
  $createOk = ($LASTEXITCODE -eq 0) -and ($createOut -match 'dsh-headless')
  Add-Result 'E2E-00a' 'fresh headless scratch profile composes' $createOk ($createOut -split "`n" | Select-Object -First 1)
  if (-not $createOk) { throw 'scratch profile creation failed' }

  $installOut = & $DshPath plugin --profile $Profile add $Root 2>&1 | Out-String
  $installOk = ($LASTEXITCODE -eq 0) -and ($installOut -match 'dsh-confluence')
  Add-Result 'E2E-00b' 'local bundle installs into the scratch profile' $installOk (($installOut -split "`n" | Where-Object { $_ -match 'dsh-confluence' } | Select-Object -First 1))

  $dump = & $DshPath --profile $Profile --dump-config 2>&1 | Out-String
  $rowOk = $dump -match '(?m)^- id: confluence\s*$' -and $dump -match 'name: dsh-confluence'
  Add-Result 'E2E-00c' 'composed profile contains the confluence row' $rowOk ''

  # ── session 1: publish a note ──────────────────────────────────────────
  $writer = Start-Mock 'tool-post.json' 'mock-writer.jsonl' (Join-Path $RunDir 'mock-writer.port')
  $env:DEEPSEEK_BASE_URL = "http://127.0.0.1:$($writer.Port)"
  Push-Location $Workspace
  try {
    & $DshPath --profile $Profile 'Write one shared workspace note about the E2E harness gotcha.' 1> (Join-Path $RunDir 'session1.out.txt') 2> (Join-Path $RunDir 'session1.err.txt')
    $writerExit = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  Stop-Mock $writer
  $writerOut = Get-Content (Join-Path $RunDir 'session1.out.txt') -Raw
  $writerOk = ($writerExit -eq 0) -and ($writerOut -match 'Board note accepted')
  Add-Result 'E2E-01a' 'session 1 exits 0 and the mock reports the published note' $writerOk "exit=$writerExit"
  if (-not $writerOk) {
    Write-Host '--- session 1 stderr (tail) ---'
    Get-Content (Join-Path $RunDir 'session1.err.txt') -Tail 20 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
  }

  # ── session 2: read the pulse in the same workspace ────────────────────
  $reader = Start-Mock 'text-answer.json' 'mock-reader.jsonl' (Join-Path $RunDir 'mock-reader.port')
  $env:DEEPSEEK_BASE_URL = "http://127.0.0.1:$($reader.Port)"
  Push-Location $Workspace
  try {
    & $DshPath --profile $Profile 'Check what happened in this workspace before you start.' 1> (Join-Path $RunDir 'session2.out.txt') 2> (Join-Path $RunDir 'session2.err.txt')
    $readerExit = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  Stop-Mock $reader
  $readerOut = Get-Content (Join-Path $RunDir 'session2.out.txt') -Raw
  $readerOk = ($readerExit -eq 0) -and ($readerOut -match 'Hello from the Confluence E2E mock model')
  Add-Result 'E2E-01b' 'session 2 exits 0 with the mock answer' $readerOk "exit=$readerExit"

  # ── assertion script (store + pulse + session logs + no inject) ────────
  $assertArgs = @(
    (Join-Path $Root 'test\e2e\assert-e2e.mjs'),
    '--run', $RunDir, '--dsh-home', $ScratchHome, '--workspace', $Workspace
  )
  & $Node @assertArgs
  $assertExit = $LASTEXITCODE
  $assertOk = ($assertExit -eq 0)
  Add-Result 'E2E-02' 'assert-e2e.mjs: store, pulse, session-log and no-inject checks' $assertOk "exit=$assertExit"
} catch {
  Add-Result 'E2E-ERROR' 'harness aborted before completing every check' $false $_.Exception.Message
} finally {
  foreach ($mock in $Mocks) { Stop-Mock $mock }
  $env:DSH_HOME = $savedDshHome
  $env:DEEPSEEK_BASE_URL = $savedBaseUrl
  $env:DEEPSEEK_API_KEY = $savedApiKey

  # ── guards: the real profile and its store were not touched ───────────
  $afterPackage = if (Test-Path $desktopPackage) { (Get-FileHash $desktopPackage -Algorithm SHA256).Hash } else { '' }
  $afterPatch = if (Test-Path $desktopPatch) { (Get-FileHash $desktopPatch -Algorithm SHA256).Hash } else { '' }
  $profileUntouched = ($beforePackage -eq $afterPackage) -and ($beforePatch -eq $afterPatch)
  Add-Result 'GUARD-01' 'real desktop profile files unchanged' $profileUntouched ''
  $noRealStore = -not (Test-Path $realStore)
  Add-Result 'GUARD-02' 'no Confluence store was created under the real DSH_HOME' $noRealStore ''

  $summary = [pscustomobject]@{
    stamp = $Stamp
    runDir = $RunDir
    dshPath = $DshPath
    checks = $Results
    passed = @($Results | Where-Object { $_.Ok }).Count
    failed = @($Results | Where-Object { -not $_.Ok }).Count
  }
  $summary | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $RunDir 'summary.json') -Encoding utf8
  Write-Host ''
  Write-Host ("Confluence E2E — {0} passed, {1} failed; artifacts: {2}" -f $summary.passed, $summary.failed, $RunDir)
  if ($summary.failed -gt 0) { exit 1 }
  exit 0
}
