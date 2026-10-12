[CmdletBinding()]
param([ValidateSet('Start','Stop','Status','Diagnose','Uninstall')][string]$Action = 'Status')
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:LOCALAPPDATA 'Kitzur'
$node = Get-Content -LiteralPath (Join-Path $root 'node-path.txt') -Raw
& ($node.Trim()) (Join-Path $root 'app\deploy\windows\manage.mjs') $Action.ToLowerInvariant()
if ($LASTEXITCODE -ne 0) { throw 'Kitzur command failed. See the safe error above.' }
