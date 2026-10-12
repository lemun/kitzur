# Run using your organisation's approved PowerShell execution policy. Never changes it.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ManifestSha256,
  [string]$Profile = (Join-Path $PSScriptRoot '..\..\deployment\profile.json'),
  [string]$Tokenizer = (Join-Path $PSScriptRoot '..\..\deployment\tokenizer.json'),
  [switch]$NoStartup
)
$ErrorActionPreference = 'Stop'
$bundle = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$manifest = Join-Path $bundle 'SHA256SUMS'
if ((Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash -ne $ManifestSha256) {
  throw 'Bundle manifest does not match the checksum supplied through the approved deployment channel.'
}
# Verify scripts as data before executing any JavaScript from the bundle.
$seen = @{}
foreach ($line in (Get-Content -LiteralPath $manifest)) {
  if ($line -notmatch '^([a-f0-9]{64})  (?:\./)?(.+)$') { throw 'Invalid manifest entry.' }
  $expected = $Matches[1]
  $relative = $Matches[2]
  $unsafeSegments = @($relative.Split('/') | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' -or $_ -match '[. ]$' -or $_ -match '^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)' })
  if ([IO.Path]::IsPathRooted($relative) -or $relative -match '[\\:\x00-\x1f]' -or $unsafeSegments.Count -gt 0) { throw 'Unsafe manifest path.' }
  if ($seen.ContainsKey($relative)) { throw 'Duplicate manifest path.' }
  $seen[$relative] = $true
  $file = Join-Path $bundle $relative
  $parent = Split-Path -Parent $file
  while ($parent.Length -gt $bundle.Length) {
    if ((Get-Item -LiteralPath $parent).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Manifest parent must not be a link.' }
    $parent = Split-Path -Parent $parent
  }
  $item = Get-Item -LiteralPath $file
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Manifest must contain regular files.' }
  if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $expected) { throw 'Bundle file checksum mismatch.' }
}
if (-not $seen.ContainsKey('deploy/windows/manage.mjs')) { throw 'Bundle manager missing from manifest.' }
$node = (Get-Command node -CommandType Application -ErrorAction Stop).Source
& $node (Join-Path $PSScriptRoot 'manage.mjs') install $bundle $Profile $Tokenizer $(if ($NoStartup) { 'no-startup' } else { 'startup' })
if ($LASTEXITCODE -ne 0) { throw 'Kitzur setup failed. See the safe error above.' }
