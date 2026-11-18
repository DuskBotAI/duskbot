# Installs a dusk bot setup.exe silently, opens it and waits for the background server; exits 1 when it never came up.
# -Variant sets up a home PC condition first: defender (real-time scanning on, GitHub's exclusions removed), user (a
# Windows account whose name has a space and non-ASCII letters), proxy (dead proxy in the environment), ports (the
# app's ports reserved the way Hyper-V/WSL reserve ranges), engines (engine CLIs installed), slowcli (an engine CLI
# that answers after 75 s). Several can be joined with commas.
param([Parameter(Mandatory)][string]$Installer, [Parameter(Mandatory)][string]$Out, [string]$Variant = "clean", [int]$WaitSeconds = 420)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $Out | Out-Null
function Note($line) { $line | Tee-Object -FilePath "$Out\summary.txt" -Append }
Note "variant $Variant"

$cred = $null
$appData = $env:APPDATA; $localAppData = $env:LOCALAPPDATA
switch ($Variant.Split(",")) {
  "defender" {
    foreach ($s in @(@{ DisableRealtimeMonitoring = $false }, @{ DisableBehaviorMonitoring = $false }, @{ DisableIOAVProtection = $false },
        @{ DisableScriptScanning = $false }, @{ DisableArchiveScanning = $false }, @{ DisableBlockAtFirstSeen = $false },
        @{ MAPSReporting = 2 }, @{ SubmitSamplesConsent = 1 }, @{ PUAProtection = 1 })) {
      try { Set-MpPreference @s; Note "set $(@($s.Keys)[0])" } catch { Note "refused $(@($s.Keys)[0]): $($_.Exception.Message)" }
    }
    $pref = Get-MpPreference
    foreach ($kind in 'ExclusionPath', 'ExclusionProcess', 'ExclusionExtension') {
      foreach ($v in @($pref.$kind | Where-Object { $_ })) { $r = @{}; $r[$kind] = $v; try { Remove-MpPreference @r } catch { Note "kept exclusion $v" } }
    }
    $st = Get-MpComputerStatus
    Note "defender realtime=$($st.RealTimeProtectionEnabled) onaccess=$($st.OnAccessProtectionEnabled) mode=$($st.AMRunningMode)"
  }
  "user" {
    $name = "Zoe " + [char]0x00C5 + "str" + [char]0x00F6 + "m"
    $pass = "Sm0ke!" + [guid]::NewGuid().ToString("N").Substring(0, 12)
    New-LocalUser -Name $name -Password (ConvertTo-SecureString $pass -AsPlainText -Force) -PasswordNeverExpires | Out-Null
    Add-LocalGroupMember -Group "Users" -Member $name
    $cred = @{ name = $name; pass = $pass }
  }
  "proxy" {
    foreach ($k in "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy") { [Environment]::SetEnvironmentVariable($k, "http://127.0.0.1:9", "Process") }
    Note "proxy env set to a dead proxy"
  }
  "engines" {
    npm install -g --silent @anthropic-ai/claude-code @openai/codex @google/gemini-cli opencode-ai 2>&1 | Out-File "$Out\npm-install.txt"
    foreach ($c in "claude", "codex", "gemini", "opencode") { Note "$c -> $((Get-Command $c -ErrorAction SilentlyContinue).Source)" }
  }
  "slowcli" {
    # an engine CLI that takes 75 s to answer, as a cold CLI under an antivirus scan can
    New-Item -ItemType Directory -Force -Path "C:\slowcli" | Out-Null
    Set-Content -Path "C:\slowcli\claude.cmd" -Value "@ping -n 76 127.0.0.1 >nul`r`n@echo 2.1.0 (Claude Code)" -Encoding ascii
    [Environment]::SetEnvironmentVariable("PATH", "C:\slowcli;$env:PATH", "Process")
    Note "claude -> $((Get-Command claude -ErrorAction SilentlyContinue).Source)"
  }
  "upgrade" {
    # 0.2.15 first, opened until its server is up, then the installer under test over it
    Invoke-WebRequest -Uri "https://dusk.bot/releases/0.2.15/DuskBot-0.2.15-setup.exe" -OutFile "$env:TEMP\old-setup.exe"
    Start-Process -FilePath "$env:TEMP\old-setup.exe" -ArgumentList "/S" -Wait
    $old = Get-ChildItem -Path "$env:LOCALAPPDATA\Programs" -Recurse -Depth 2 -Filter "*.exe" | Where-Object { Test-Path (Join-Path $_.DirectoryName "resources\app.asar") } | Select-Object -First 1
    Start-Process -FilePath $old.FullName | Out-Null
    $t = Get-Date
    while (((Get-Date) - $t).TotalSeconds -lt 180) {
      Start-Sleep -Seconds 5
      $l = Join-Path $env:APPDATA "duskbot\logs\server.log"
      if ((Test-Path $l) -and ((Get-Content -Raw $l) -match "server ready pid=")) { Note "0.2.15 came up"; break }
    }
    Start-Sleep -Seconds 20
    Get-Process | Where-Object { $_.Path -like "$($old.DirectoryName)*" } | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 5
    Copy-Item (Join-Path $env:APPDATA "duskbot\logs\server.log") "$Out\server-0.2.15.log" -ErrorAction SilentlyContinue
  }
  "ports" {
    foreach ($port in 8799, 18799, 28799) { netsh int ipv4 add excludedportrange protocol=tcp startport=$port numberofports=2 | Out-Null }
    netsh int ipv4 show excludedportrange protocol=tcp | Out-File "$Out\excluded-ports.txt"
  }
}

# a scheduled task runs as that account with its own profile and environment, which Start-Process -Credential does not give
function RunAs($file, $arguments, [switch]$Wait) {
  $task = "smoke-" + [guid]::NewGuid().ToString("N").Substring(0, 8)
  $action = if ($arguments) { New-ScheduledTaskAction -Execute $file -Argument $arguments } else { New-ScheduledTaskAction -Execute $file }
  Register-ScheduledTask -TaskName $task -Action $action -User "$env:COMPUTERNAME\$($cred.name)" -Password $cred.pass -RunLevel Limited `
    -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 1)) | Out-Null
  Start-ScheduledTask -TaskName $task
  if ($Wait) {
    $t = Get-Date
    while (((Get-Date) - $t).TotalSeconds -lt 300) {
      Start-Sleep -Seconds 3
      $info = Get-ScheduledTaskInfo -TaskName $task
      if ((Get-ScheduledTask -TaskName $task).State -ne "Running" -and $info.LastTaskResult -ne 267011) { break }
    }
    Note "task $file ended $((Get-ScheduledTaskInfo -TaskName $task).LastTaskResult)"
  }
}
if ($cred) {
  Copy-Item $Installer "C:\smoke-setup.exe"
  RunAs "C:\smoke-setup.exe" "/S" -Wait
  $profile = (Get-CimInstance Win32_UserProfile | Where-Object { $_.LocalPath -like "*Zoe*" } | Select-Object -First 1).LocalPath
  Note "user profile $profile"
  $appData = Join-Path $profile "AppData\Roaming"; $localAppData = Join-Path $profile "AppData\Local"
  $p = [pscustomobject]@{ ExitCode = "via task" }
} else {
  $p = Start-Process -FilePath $Installer -ArgumentList "/S" -PassThru -Wait
}
Note "installer exit $($p.ExitCode)"
$exe = Get-ChildItem -Path (Join-Path $localAppData "Programs") -Recurse -Depth 2 -Filter "*.exe" -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -notmatch "^(Uninstall|elevate)" -and (Test-Path (Join-Path $_.DirectoryName "resources\app.asar")) } | Select-Object -First 1
if (-not $exe) { Get-ChildItem (Join-Path $localAppData "Programs") -Recurse -Depth 2 -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName } | Out-File "$Out\programs.txt"; throw "app exe not found" }
Note "exe $($exe.FullName)"
Get-ChildItem -Path $exe.DirectoryName -Recurse -Filter "*.node" | ForEach-Object { $_.FullName } | Out-File "$Out\native-modules.txt"
Get-ChildItem -Path (Join-Path $exe.DirectoryName "resources") -Recurse -Depth 1 | ForEach-Object { $_.FullName } | Out-File "$Out\resources.txt"
if ($cred) {
  RunAs $exe.FullName $null
  Start-Sleep -Seconds 3
  $app = Get-Process | Where-Object { $_.Path -eq $exe.FullName } | Select-Object -First 1
  if (-not $app) { Note "app process not seen"; $app = [pscustomobject]@{ HasExited = $false } }
} else {
  $app = Start-Process -FilePath $exe.FullName -PassThru -RedirectStandardOutput "$Out\app-stdout.txt" -RedirectStandardError "$Out\app-stderr.txt"
}
$started = Get-Date
$verdict = "timeout"
while (((Get-Date) - $started).TotalSeconds -lt $WaitSeconds) {
  Start-Sleep -Seconds 5
  $log = Get-ChildItem -Path $appData -Recurse -Depth 3 -Filter "server.log" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($log) {
    $text = Get-Content -Raw -Path $log.FullName -ErrorAction SilentlyContinue
    if ($text -match "server ready pid=") { $verdict = "ready"; break }
  }
  if ($app.HasExited) { $verdict = "app exited $($app.ExitCode)"; break }
}
Start-Sleep -Seconds 10
Note "verdict $verdict after $([int]((Get-Date) - $started).TotalSeconds)s"
foreach ($root in @($appData, $localAppData)) {
  foreach ($name in @("duskbot", "dusk bot", "Dusk Bot")) {
    $dir = Join-Path $root $name
    if (Test-Path $dir) {
      $tag = (Split-Path $root -Leaf) + "_" + ($name -replace ' ', '_')
      $dest = Join-Path $Out $tag
      Get-ChildItem -Path $dir -Recurse -Include "*.log", "*.txt" -ErrorAction SilentlyContinue |
        Where-Object { $_.Length -lt 20MB -and $_.FullName -notmatch "leveldb|Session Storage|IndexedDB" } | ForEach-Object {
          $target = Join-Path $dest ($_.FullName.Substring($dir.Length).TrimStart('\'))
          New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
          Copy-Item $_.FullName $target -ErrorAction SilentlyContinue
        }
      Get-ChildItem -Path $dir -Recurse -Depth 3 -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName } | Out-File "$Out\tree-$tag.txt"
    }
  }
}
Get-Process | Where-Object { $_.Path -like "$($exe.DirectoryName)*" } | Select-Object Id, ProcessName, StartTime, CPU | Out-File "$Out\processes.txt"
Get-Process | Where-Object { $_.Path -like "$($exe.DirectoryName)*" } | Stop-Process -Force -ErrorAction SilentlyContinue
if ($Variant -eq "defender") { Get-MpThreatDetection | Format-List | Out-File "$Out\defender-detections.txt" }
Get-Content "$Out\summary.txt"
if ($verdict -ne "ready") { exit 1 }
