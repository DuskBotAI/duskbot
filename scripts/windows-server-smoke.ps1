# Installs a dusk bot setup.exe silently, opens it and waits for the background server; exits 1 when it never came up.
# -Variant sets up a home PC condition first: defender (real-time scanning on, GitHub's exclusions removed), user (a
# Windows account whose name has a space and non-ASCII letters), proxy (dead proxy in the environment), ports (the
# app's ports reserved the way Hyper-V/WSL reserve ranges).
param([Parameter(Mandatory)][string]$Installer, [Parameter(Mandatory)][string]$Out, [string]$Variant = "clean", [int]$WaitSeconds = 420)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $Out | Out-Null
function Note($line) { $line | Tee-Object -FilePath "$Out\summary.txt" -Append }
Note "variant $Variant"

$cred = $null
$appData = $env:APPDATA; $localAppData = $env:LOCALAPPDATA
switch ($Variant) {
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
    $secure = ConvertTo-SecureString $pass -AsPlainText -Force
    New-LocalUser -Name $name -Password $secure -PasswordNeverExpires | Out-Null
    Add-LocalGroupMember -Group "Users" -Member $name
    $cred = New-Object System.Management.Automation.PSCredential("$env:COMPUTERNAME\$name", $secure)
    # creates the profile folder C:\Users\<name>
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "echo %USERPROFILE%> `"$Out\profile.txt`"" -Credential $cred -LoadUserProfile -Wait -WorkingDirectory "C:\"
    $profile = (Get-Content "$Out\profile.txt" -Raw).Trim()
    Note "user profile $profile"
    $appData = Join-Path $profile "AppData\Roaming"; $localAppData = Join-Path $profile "AppData\Local"
  }
  "proxy" {
    foreach ($k in "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy") { [Environment]::SetEnvironmentVariable($k, "http://127.0.0.1:9", "Process") }
    Note "proxy env set to a dead proxy"
  }
  "engines" {
    npm install -g --silent @anthropic-ai/claude-code @openai/codex @google/gemini-cli opencode-ai 2>&1 | Out-File "$Out\npm-install.txt"
    foreach ($c in "claude", "codex", "gemini", "opencode") { Note "$c -> $((Get-Command $c -ErrorAction SilentlyContinue).Source)" }
  }
  "ports" {
    foreach ($port in 8799, 18799, 28799) { netsh int ipv4 add excludedportrange protocol=tcp startport=$port numberofports=2 | Out-Null }
    netsh int ipv4 show excludedportrange protocol=tcp | Out-File "$Out\excluded-ports.txt"
  }
}

if ($cred) {
  $p = Start-Process -FilePath $Installer -ArgumentList "/S" -PassThru -Wait -Credential $cred -LoadUserProfile -WorkingDirectory "C:\"
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
  $app = Start-Process -FilePath $exe.FullName -PassThru -Credential $cred -LoadUserProfile -WorkingDirectory $exe.DirectoryName
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
