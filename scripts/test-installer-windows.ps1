param(
  [Parameter(Mandatory=$true)][string]$PreviousInstaller,
  [Parameter(Mandatory=$true)][string]$NextInstaller,
  [Parameter(Mandatory=$true)][string]$ExpectedVersion,
  [switch]$DisposableEnvironment
)
$ErrorActionPreference = 'Stop'
if (!$DisposableEnvironment) { throw 'Run only in a fresh disposable Windows VM/account, then pass -DisposableEnvironment.' }
$guid = '4a4fa002-f570-5b20-bccf-7ef9f76dbe3d'
$registry = "HKCU:\Software\$guid"
$profile = Join-Path $env:APPDATA 'WorldRenew'
$install = Join-Path $env:LOCALAPPDATA 'Programs\WorldRenew'
if ((Test-Path $registry) -or (Test-Path "HKLM:\Software\$guid") -or (Test-Path $profile) -or (Test-Path $install)) { throw 'Existing WorldRenew data or installation found; refusing to run.' }
if (Get-Process WorldRenew -ErrorAction SilentlyContinue) { throw 'WorldRenew is running; refusing to run.' }
$previous = (Resolve-Path $PreviousInstaller).Path
$next = (Resolve-Path $NextInstaller).Path
$tempRoot = Join-Path $env:TEMP ('WorldRenew-upgrade-test-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tempRoot | Out-Null
function Install-TestBuild($file) {
  $process = Start-Process -FilePath $file -ArgumentList '/S' -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Installer exit code $($process.ExitCode)" }
}
Install-TestBuild $previous
$oldPath = (Get-ItemProperty $registry).InstallLocation
if (!(Test-Path (Join-Path $oldPath 'WorldRenew.exe'))) { throw 'Initial installation missing.' }
if ([IO.Path]::GetFullPath($oldPath).TrimEnd('\') -ne [IO.Path]::GetFullPath($install).TrimEnd('\')) { throw 'Unexpected per-user installation directory.' }
$sentinels = @(
  (Join-Path $profile 'updates\settings.json'),
  (Join-Path $profile 'projects\selections\disposable-template.json'),
  (Join-Path $profile 'templates\disposable-template.wrbuild'),
  (Join-Path $tempRoot 'world\level.dat'),
  (Join-Path $tempRoot 'template.wrbuild')
)
foreach ($file in $sentinels) {
  New-Item -ItemType Directory -Force -Path (Split-Path $file) | Out-Null
  [IO.File]::WriteAllText($file, 'Disposable preservation sentinel ' + [guid]::NewGuid())
}
$hashes = @{}; foreach ($file in $sentinels) { $hashes[$file] = (Get-FileHash $file -Algorithm SHA256).Hash }
Install-TestBuild $next
$newPath = (Get-ItemProperty $registry).InstallLocation
if ($newPath -ne $oldPath) { throw 'Upgrade changed the installation location.' }
$exe = Join-Path $newPath 'WorldRenew.exe'
if ((Get-Item $exe).VersionInfo.ProductVersion -ne $ExpectedVersion) { throw 'Unexpected installed application version.' }
foreach ($file in $sentinels) { if ((Get-FileHash $file -Algorithm SHA256).Hash -ne $hashes[$file]) { throw "Preservation failed: $file" } }
$shortcut = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\WorldRenew.lnk'
if (!(Test-Path $shortcut)) { throw 'Start menu shortcut is missing.' }
$shortcutTarget = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcut).TargetPath
if ($shortcutTarget -ne $exe) { throw 'Shortcut must point directly to the persistent installed executable.' }
$desktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'WorldRenew.lnk'
if (!(Test-Path $desktopShortcut)) { throw 'Desktop shortcut is missing.' }
# Launch the installed executable twice; no portable launcher or re-extraction is involved.
foreach ($attempt in 1..2) {
  $launched = Start-Process -FilePath $exe -PassThru
  Start-Sleep -Seconds 5
  if ($launched.HasExited) { throw 'Installed application exited during launch.' }
  $launched.CloseMainWindow() | Out-Null
  if (!$launched.WaitForExit(15000)) { throw 'Installed application did not close cleanly.' }
}
$uninstaller = Join-Path $newPath 'Uninstall WorldRenew.exe'
$process = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru
if ($process.ExitCode -ne 0) { throw 'Uninstall failed.' }
$deadline = [DateTime]::UtcNow.AddSeconds(30)
while ((Test-Path $registry) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }
if (Test-Path $registry) { throw 'Uninstall did not finish within 30 seconds.' }
if (Test-Path $exe) { throw 'Uninstall left the installed executable.' }
if (Test-Path $shortcut) { throw 'Uninstall left the Start menu shortcut.' }
foreach ($file in $sentinels) { if ((Get-FileHash $file -Algorithm SHA256).Hash -ne $hashes[$file]) { throw "Uninstall preservation failed: $file" } }
@{ passed=$true; installPathUnchanged=$true; sentinelFilesPreserved=$sentinels.Count; expectedVersion=$ExpectedVersion; previousSHA256=(Get-FileHash $previous).Hash; nextSHA256=(Get-FileHash $next).Hash } | ConvertTo-Json | Set-Content (Join-Path $tempRoot 'result.json')
Write-Output "PASS. Evidence remains at $tempRoot. Destroy the disposable VM/account when finished."
