# Installs a dusk bot setup.exe silently, opens it and waits for the background server; exits 1 when it never came up.
param([Parameter(Mandatory)][string]$Installer, [Parameter(Mandatory)][string]$Out, [int]$WaitSeconds = 420)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$p = Start-Process -FilePath $Installer -ArgumentList "/S" -PassThru -Wait
"installer exit $($p.ExitCode)" | Tee-Object -FilePath "$Out\summary.txt"
$exe = Get-ChildItem -Path "$env:LOCALAPPDATA\Programs" -Recurse -Depth 2 -Filter "*.exe" -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -notmatch "^(Uninstall|elevate)" -and (Test-Path (Join-Path $_.DirectoryName "resources\app.asar")) } | Select-Object -First 1
if (-not $exe) { Get-ChildItem "$env:LOCALAPPDATA\Programs" -Recurse -Depth 2 | ForEach-Object { $_.FullName } | Out-File "$Out\programs.txt"; throw "app exe not found" }
"exe $($exe.FullName)" | Tee-Object -FilePath "$Out\summary.txt" -Append
Get-ChildItem -Path $exe.DirectoryName -Recurse -Filter "*.node" | ForEach-Object { $_.FullName } | Out-File "$Out\native-modules.txt"
Get-ChildItem -Path (Join-Path $exe.DirectoryName "resources") -Recurse -Depth 1 | ForEach-Object { $_.FullName } | Out-File "$Out\resources.txt"
$app = Start-Process -FilePath $exe.FullName -PassThru -RedirectStandardOutput "$Out\app-stdout.txt" -RedirectStandardError "$Out\app-stderr.txt"
$started = Get-Date
$verdict = "timeout"
while (((Get-Date) - $started).TotalSeconds -lt $WaitSeconds) {
  Start-Sleep -Seconds 5
  $log = Get-ChildItem -Path $env:APPDATA -Recurse -Depth 3 -Filter "server.log" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($log) {
    $text = Get-Content -Raw -Path $log.FullName -ErrorAction SilentlyContinue
    if ($text -match "duskbot server on ") { $verdict = "ready"; break }
  }
  if ($app.HasExited) { $verdict = "app exited $($app.ExitCode)"; break }
}
Start-Sleep -Seconds 10
"verdict $verdict after $([int]((Get-Date) - $started).TotalSeconds)s" | Tee-Object -FilePath "$Out\summary.txt" -Append
foreach ($root in @($env:APPDATA, $env:LOCALAPPDATA)) {
  foreach ($name in @("duskbot", "dusk bot", "Dusk Bot")) {
    $dir = Join-Path $root $name
    if (Test-Path $dir) {
      $tag = ($root -replace '[:\\ ]', '_') + "_" + ($name -replace ' ', '_')
      $dest = Join-Path $Out $tag
      Get-ChildItem -Path $dir -Recurse -Include "*.log", "*.txt" -ErrorAction SilentlyContinue |
        Where-Object { $_.Length -lt 20MB } | ForEach-Object {
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
Get-Content "$Out\summary.txt"
if ($verdict -ne "ready") { exit 1 }
