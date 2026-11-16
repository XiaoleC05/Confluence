<#
.SYNOPSIS
  Confluence / 高级记忆 — offline cross-directory end-to-end harness for the DSH 0.2.2-rc.1 host plugin.

.DESCRIPTION
  v0.2.0 (ADR-0007) makes shared memory UNIVERSAL: the boundary is the DSH profile,
  not the workspace. This harness proves the headline acceptance test offline:
  a session in directory A publishes memory and a session in a DIFFERENT directory
  B, in the same scratch profile, sees it in its passive pulse and can read it.

  It creates a throwaway DSH_HOME + headless scratch profile, installs this local
  bundle, then runs real headless sessions against a local Messages-API mock
  (loopback only, no network egress):

    warm-up   — <run>/workspace-a: one throwaway text-only session that absorbs the
                first-mount activation race (DSH plugin activation is async)
    session A — <run>/workspace-a: calls `confluence_post` and publishes one note
    session B — <run>/workspace-b: makes NO tool calls; its passive pulse must
                carry A's note (cross-directory universal memory)
    session C — <run>/workspace-b: calls `confluence_board` (board read from
                another directory, incl. the legacy note)
    session D — <run>/workspace-b: calls `confluence_read` with the real note id
                extracted from the global journal (full note body from another
                directory)
    session E — <run>/workspace-b: calls `confluence_recall` with a phrase spoken
                in session A (cross-directory recall)

  Between A and B the harness seeds a legacy v0.1.0 per-workspace journal
  (`workspaces/ws_<16hex>/journal.*.v1.jsonl` + MANIFEST.v1.json) into the scratch
  store: B/C/D must see it through the read-only legacy merge, and the files must
  be byte-identical afterwards.

  `test/e2e/assert-e2e.mjs` then asserts the store (`workspaces/ws_0000000000000000/`
  under the scratch DSH_HOME), pulses, committed session logs, board/read results,
  legacy integrity, tool-argument shape and pulse watermarks. Every run directory is
  kept under `.tmp/e2e/run-<stamp>/` (git-ignored) for evidence.

  The real `~/.dsh` profile is never opened: DSH_HOME is overridden for every child
  process, and the script asserts the desktop profile files are unchanged and that
  the real store holds no trace of this run.

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
$WorkspaceA = Join-Path $RunDir 'workspace-a'
$WorkspaceB = Join-Path $RunDir 'workspace-b'
$Profile = 'confluence-e2e'
$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
$Results = [System.Collections.Generic.List[object]]::new()
$Mocks = [System.Collections.Generic.List[object]]::new()

# v0.2.0 constants (docs/plan/scope-refactor-delta.md §0).
$GlobalScopeKey = 'ws_0000000000000000'
$GlobalScopeLabel = 'All sessions'
$NoteTitle = 'Cross-directory harness gotcha'
$LegacyWsKey = 'ws_1a2b3c4d5e6f7081'
$LegacyLabel = 'legacy-alpha'
$LegacyCanonicalPath = 'd:\05_code\legacy\projects\legacy-alpha'
$LegacyCreatedAt = '2026-01-02T03:04:05.000Z'
$LegacySeq = '01J9Z8K4M2' + ('0' * 14) + '1A'

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
  $scenarioPath = if ([System.IO.Path]::IsPathRooted($Scenario)) { $Scenario } else { Join-Path $Root "test\e2e\scenarios\$Scenario" }
  if (-not (Test-Path $scenarioPath)) { throw "scenario file not found: $scenarioPath" }
  if (Test-Path $PortFile) { Remove-Item $PortFile -Force }
  $arguments = @(
    (Join-Path $Root 'test\e2e\mock-llm.mjs'),
    '--scenario', $scenarioPath,
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

# Run one headless session from $Cwd against a private mock. Returns the exit code.
function Invoke-Session([string]$Name, [string]$Cwd, [string]$Scenario, [string]$Prompt) {
  $mock = Start-Mock $Scenario "mock-$Name.jsonl" (Join-Path $RunDir "mock-$Name.port")
  $env:DEEPSEEK_BASE_URL = "http://127.0.0.1:$($mock.Port)"
  Push-Location $Cwd
  try {
    & $DshPath --profile $Profile $Prompt 1> (Join-Path $RunDir "session-$Name.out.txt") 2> (Join-Path $RunDir "session-$Name.err.txt")
    $exitCode = $LASTEXITCODE
  } finally {
    Pop-Location
    Stop-Mock $mock
  }
  return $exitCode
}

function Show-StderrTail([string]$Name) {
  $file = Join-Path $RunDir "session-$Name.err.txt"
  if (-not (Test-Path $file)) { return }
  Write-Host "--- session $Name stderr (tail) ---"
  Get-Content $file -Tail 20 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
}

# Legacy v0.1.0 store fixture: a per-workspace journal + MANIFEST that the universal
# store must merge READ-ONLY into every view. Seeded AFTER session A so A sees an
# empty board (welcome copy) and B/C/D see the merge. The entry timestamp is recent
# on purpose: the pulse drops records older than PULSE_STALE_AFTER_MS (7 days), and a
# legacy note an upgrade just carried over is recent by definition.
function New-LegacySeed {
  $entryTs = (Get-Date).ToUniversalTime().AddDays(-1).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  $dir = Join-Path $ScratchHome "storages\confluence\v1\workspaces\$LegacyWsKey"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $manifest = [ordered]@{
    format = 'confluence.store/v1'
    formatVersion = 1
    ws = $LegacyWsKey
    workspace = [ordered]@{ key = $LegacyWsKey; canonicalPath = $LegacyCanonicalPath; createdAt = $LegacyCreatedAt }
    generation = 0
    snapshot = $null
    shards = @()
    seqRange = [ordered]@{ min = $null; max = $null }
    updatedAt = $LegacyCreatedAt
  }
  $manifestPath = Join-Path $dir 'MANIFEST.v1.json'
  $manifest | ConvertTo-Json -Depth 8 | Set-Content $manifestPath -Encoding utf8
  $entry = [ordered]@{
    v = 1
    type = 'entry'
    id = "cnf_$LegacySeq"
    ws = $LegacyWsKey
    kind = 'decision'
    title = 'Legacy alpha decision'
    body = 'Pre-existing v1 per-workspace note; merged read-only into the universal shared-memory view.'
    tags = @('legacy', 'fixture')
    author = [ordered]@{ sessionId = 'session-legacy-alpha'; title = 'Legacy alpha session'; origin = 'agent' }
    seq = $LegacySeq
    ts = $entryTs
  }
  $journalPath = Join-Path $dir 'journal.9001-c0ffee01.v1.jsonl'
  ($entry | ConvertTo-Json -Depth 8 -Compress) + "`n" | Set-Content $journalPath -Encoding utf8 -NoNewline
  $files = @()
  foreach ($file in @($manifestPath, $journalPath)) {
    $files += [pscustomobject]@{
      path = [System.IO.Path]::GetRelativePath($RunDir, $file).Replace('\', '/')
      sha256 = (Get-FileHash $file -Algorithm SHA256).Hash.ToLower()
      bytes = (Get-Item $file).Length
    }
  }
  $seed = [ordered]@{
    wsKey = $LegacyWsKey
    label = $LegacyLabel
    canonicalPath = $LegacyCanonicalPath
    entry = [ordered]@{ id = "cnf_$LegacySeq"; title = 'Legacy alpha decision'; kind = 'decision'; seq = $LegacySeq; ts = $entryTs }
    files = $files
  }
  $seed | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $RunDir 'legacy-seed.json') -Encoding utf8
  return $seed
}

# Read the writer note id back from the scratch GLOBAL journal (proves the universal
# write location and feeds the reader session's `confluence_read` ref).
function Find-GlobalNoteId([string]$Title) {
  $globalDir = Join-Path $ScratchHome "storages\confluence\v1\workspaces\$GlobalScopeKey"
  if (-not (Test-Path $globalDir)) { return $null }
  foreach ($file in Get-ChildItem $globalDir -Filter 'journal.*.v1.jsonl' -File -ErrorAction SilentlyContinue) {
    foreach ($line in Get-Content $file.FullName -ErrorAction SilentlyContinue) {
      if ([string]::IsNullOrWhiteSpace($line)) { continue }
      try { $record = $line | ConvertFrom-Json } catch { continue }
      if ($record.type -eq 'entry' -and $record.title -eq $Title) { return $record }
    }
  }
  return $null
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
$realStoreExistedBefore = Test-Path $realStore

New-Item -ItemType Directory -Force -Path $RunDir, $ScratchHome, $WorkspaceA, $WorkspaceB | Out-Null
Write-Host "Confluence cross-directory E2E — $Stamp"
Write-Host "  repo:        $Root"
Write-Host "  run dir:     $RunDir"
Write-Host "  dsh home:    $ScratchHome (scratch only)"
Write-Host "  workspace A: $WorkspaceA"
Write-Host "  workspace B: $WorkspaceB"

$savedDshHome = $env:DSH_HOME
$savedBaseUrl = $env:DEEPSEEK_BASE_URL
$savedApiKey = $env:DEEPSEEK_API_KEY
$noteEntry = $null
$legacySeed = $null
$writerAttempts = 0
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

  # ── warm-up: absorb the post-install activation race once ──────────────
  # DSH plugin activation is async; the very first headless session after an
  # install can build its first request before the plugin attached (observed:
  # 0 Confluence tools in request/header #1, all 6 in the next step). The warm-up
  # keeps the acceptance sessions measuring the product, not activation timing.
  $warmupExit = Invoke-Session 'warmup' $WorkspaceA 'warmup.json' 'Warm-up session: reply with one short sentence.'
  $warmupOut = Get-Content (Join-Path $RunDir 'session-warmup.out.txt') -Raw -ErrorAction SilentlyContinue
  $warmupOk = ($warmupExit -eq 0) -and ($warmupOut -match 'Warm-up session completed')
  Add-Result 'E2E-00d' 'scratch-profile warm-up session exits 0 (absorbs first-mount activation race)' $warmupOk "exit=$warmupExit"
  if (-not $warmupOk) { Show-StderrTail 'warmup' }

  # ── session A: publish a shared-memory note from workspace A ───────────
  # One bounded retry absorbs a cold-start race where the plugin attached after
  # the first request was built (retries are recorded in summary.json).
  $WriterPrompt = 'Publish one shared-memory note about the cross-directory E2E harness gotcha.'
  $writerAttempts = 0
  $writerExit = 1
  $writerOut = ''
  while ($writerAttempts -lt 2) {
    $writerAttempts += 1
    $writerExit = Invoke-Session 'a' $WorkspaceA 'tool-post.json' $WriterPrompt
    $writerOut = Get-Content (Join-Path $RunDir 'session-a.out.txt') -Raw -ErrorAction SilentlyContinue
    $writerAnswered = ($writerExit -eq 0) -and ($writerOut -match 'Board note accepted')
    $noteEntry = Find-GlobalNoteId $NoteTitle
    if ($writerAnswered -and $null -ne $noteEntry) { break }
    if ($writerAttempts -lt 2) {
      Write-Host '  WARN: writer note missing after attempt 1 (likely cold-start activation race); retrying once.'
      Remove-Item (Join-Path $RunDir 'mock-a.jsonl'), (Join-Path $RunDir 'session-a.out.txt'), (Join-Path $RunDir 'session-a.err.txt') -Force -ErrorAction SilentlyContinue
    }
  }
  $writerOk = ($writerExit -eq 0) -and ($writerOut -match 'Board note accepted') -and ($null -ne $noteEntry)
  Add-Result 'E2E-01a' 'session A (workspace-a) publishes one shared-memory note' $writerOk "exit=$writerExit attempts=$writerAttempts"
  if (-not $writerOk) { Show-StderrTail 'a' }

  # ── the note must land in the GLOBAL scope journal ─────────────────────
  $noteId = if ($null -ne $noteEntry) { [string]$noteEntry.id } else { '' }
  $globalOk = -not [string]::IsNullOrWhiteSpace($noteId)
  Add-Result 'E2E-01b' "writer note is in the global journal (workspaces/$GlobalScopeKey)" $globalOk "id=$noteId"
  if (-not $globalOk) {
    Write-Host "  expected the note under $ScratchHome\storages\confluence\v1\workspaces\$GlobalScopeKey"
  }

  # Note-reader scenario: static template + the real note id substituted per run.
  $noteReaderScenario = Join-Path $RunDir 'scenario-note-reader.json'
  $noteReaderTemplate = Get-Content (Join-Path $Root 'test\e2e\scenarios\note-read.template.json') -Raw
  $noteReaderPlaceholder = if ($globalOk) { $noteId } else { 'cnf_' + ('0' * 26) }
  $noteReaderTemplate.Replace('{{NOTE_ID}}', $noteReaderPlaceholder) | Set-Content $noteReaderScenario -Encoding utf8

  # ── session E: recall what was spoken in session A (one tool call) ─────
  # Runs right after A on purpose: recall searches at most 3 recent sessions,
  # so the writer must still be among the newest sessions (lifecycle cap).
  $recallExit = Invoke-Session 'e' $WorkspaceB 'recall.json' 'Recall what an earlier session said about the cross-directory harness gotcha.'
  $recallOut = Get-Content (Join-Path $RunDir 'session-e.out.txt') -Raw -ErrorAction SilentlyContinue
  $recallOk = ($recallExit -eq 0) -and ($recallOut -match 'Cross-directory recall confirmed')
  Add-Result 'E2E-01c' 'session E (workspace-b) recalls an excerpt from session A in another directory' $recallOk "exit=$recallExit"
  if (-not $recallOk) { Show-StderrTail 'e' }

  # ── seed the legacy v0.1.0 per-workspace journal (after A/E) ────────────
  $legacySeed = New-LegacySeed
  $legacyOk = Test-Path (Join-Path $ScratchHome "storages\confluence\v1\workspaces\$LegacyWsKey\MANIFEST.v1.json")
  Add-Result 'E2E-01d' "legacy v1 workspace journal seeded read-only ($LegacyWsKey, label $LegacyLabel)" $legacyOk ''

  # ── session B: passive pulse only (no tool calls) from workspace B ─────
  $pulseExit = Invoke-Session 'b' $WorkspaceB 'text-answer.json' 'Check the shared-memory pulse before you start: what did other sessions share?'
  $pulseOut = Get-Content (Join-Path $RunDir 'session-b.out.txt') -Raw -ErrorAction SilentlyContinue
  $pulseOk = ($pulseExit -eq 0) -and ($pulseOut -match 'Hello from the Confluence E2E mock model')
  Add-Result 'E2E-01e' 'session B (workspace-b, different directory, no tools) exits 0 with the mock answer' $pulseOk "exit=$pulseExit"
  if (-not $pulseOk) { Show-StderrTail 'b' }

  # ── session C: read the board (one tool call) from workspace B ─────────
  $boardExit = Invoke-Session 'c' $WorkspaceB 'board-read.json' 'Read the shared-memory board; which notes are on it?'
  $boardOut = Get-Content (Join-Path $RunDir 'session-c.out.txt') -Raw -ErrorAction SilentlyContinue
  $boardOk = ($boardExit -eq 0) -and ($boardOut -match 'Cross-directory board confirmed')
  Add-Result 'E2E-01f' 'session C (workspace-b) reads the shared board from another directory' $boardOk "exit=$boardExit"
  if (-not $boardOk) { Show-StderrTail 'c' }

  # ── session D: read the full note body (one tool call) from workspace B ─
  $noteReadExit = Invoke-Session 'd' $WorkspaceB $noteReaderScenario 'Read the newest shared-memory note from another directory.'
  $noteReadOut = Get-Content (Join-Path $RunDir 'session-d.out.txt') -Raw -ErrorAction SilentlyContinue
  $noteReadOk = ($noteReadExit -eq 0) -and ($noteReadOut -match 'Cross-directory note read confirmed')
  Add-Result 'E2E-01g' 'session D (workspace-b) reads the full note body from another directory' $noteReadOk "exit=$noteReadExit"
  if (-not $noteReadOk) { Show-StderrTail 'd' }

  # ── assertion script (store + pulses + session logs + legacy + watermarks) ──
  $assertArgs = @(
    (Join-Path $Root 'test\e2e\assert-e2e.mjs'),
    '--run', $RunDir,
    '--dsh-home', $ScratchHome,
    '--workspace-a', $WorkspaceA,
    '--workspace-b', $WorkspaceB,
    '--legacy-seed', (Join-Path $RunDir 'legacy-seed.json')
  )
  & $Node @assertArgs
  $assertExit = $LASTEXITCODE
  $assertOk = ($assertExit -eq 0)
  Add-Result 'E2E-02' 'assert-e2e.mjs: cross-directory pulse, global store, board/read, legacy merge, watermarks' $assertOk "exit=$assertExit"
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
  # The real DSH_HOME may legitimately already hold a Confluence store (the user's own
  # profile, or another live session). Guard the actual claim: THIS run wrote nothing
  # there. Scan the real store for this run's unique note title / run stamp.
  $realStoreFiles = 0
  $realStoreTraces = @()
  if (Test-Path $realStore) {
    $realFiles = @(Get-ChildItem -Recurse -File $realStore -ErrorAction SilentlyContinue)
    $realStoreFiles = $realFiles.Count
    if ($realFiles.Count -gt 0) {
      $realStoreTraces = @($realFiles | Select-String -SimpleMatch -Pattern @($NoteTitle, "run-$Stamp") -List -ErrorAction SilentlyContinue)
    }
  }
  $noRealTrace = ($realStoreTraces.Count -eq 0)
  $guardDetail = if ($realStoreExistedBefore) {
    "pre-existing real store ($realStoreFiles file(s)) scanned for this run's artifacts"
  } else {
    'real store absent before and after'
  }
  Add-Result 'GUARD-02' 'real DSH_HOME Confluence store contains no trace of this run' $noRealTrace $guardDetail
  $noScratchProfile = -not (Test-Path (Join-Path $realDshHome "profiles\$Profile"))
  Add-Result 'GUARD-03' 'no scratch e2e profile leaked into the real DSH_HOME' $noScratchProfile ''

  $summary = [pscustomobject]@{
    stamp = $Stamp
    runDir = $RunDir
    dshPath = $DshPath
    scratchDshHome = $ScratchHome
    workspaceA = $WorkspaceA
    workspaceB = $WorkspaceB
    globalScope = [pscustomobject]@{ key = $GlobalScopeKey; label = $GlobalScopeLabel }
    note = if ($null -ne $noteEntry) { [pscustomobject]@{ id = $noteEntry.id; seq = $noteEntry.seq; title = $noteEntry.title } } else { $null }
    legacy = if ($null -ne $legacySeed) { [pscustomobject]@{ wsKey = $legacySeed.wsKey; label = $legacySeed.label; entry = $legacySeed.entry } } else { $null }
    writerAttempts = $writerAttempts
    realStoreExistedBefore = [bool]$realStoreExistedBefore
    checks = $Results
    passed = @($Results | Where-Object { $_.Ok }).Count
    failed = @($Results | Where-Object { -not $_.Ok }).Count
  }
  $summary | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $RunDir 'summary.json') -Encoding utf8
  Write-Host ''
  Write-Host ("Confluence cross-directory E2E — {0} passed, {1} failed; artifacts: {2}" -f $summary.passed, $summary.failed, $RunDir)
  if ($summary.failed -gt 0) { exit 1 }
  exit 0
}
