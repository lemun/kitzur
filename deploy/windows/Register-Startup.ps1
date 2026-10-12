$ErrorActionPreference = 'Stop'
$root = Join-Path $env:LOCALAPPDATA 'Kitzur'
$startupDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
New-Item -ItemType Directory -Force -Path $startupDir | Out-Null
$linkPath = Join-Path $startupDir 'Kitzur.lnk'
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($linkPath)
$link.TargetPath = Join-Path $PSHOME 'powershell.exe'
$manager = Join-Path $root 'app\deploy\windows\Kitzur.ps1'
$link.Arguments = '-NoProfile -WindowStyle Hidden -File "' + $manager + '" -Action Start'
$link.WorkingDirectory = $root
$link.WindowStyle = 7
$link.Description = 'Start the per-user Kitzur local proxy at login'
$link.Save()
Write-Output 'Kitzur login startup registered for this user.'
