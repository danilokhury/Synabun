# SynaBun — the Windows installer's "is the unpacked payload complete" check.
#
# The installer (synabun-extract.nsh) runs this right after unpacking the
# application into the install folder. Unpacking straight into place is fast, but
# a locked file or a full disk could leave some files missing or short while
# SynaBun.exe is already there — so the install must not be declared done on the
# window executable alone. This checks the whole payload against a manifest the
# build wrote into it (resources\synabun-payload.manifest: one
# "<install-relative path>\t<bytes>" line per file, except the manifest itself),
# by enumerating the install folder once (no per-file stat storm, no hashing of
# 1.5 GB) and comparing path + size.
#
# Inputs (environment, no path on the command line):
#   SYNABUN_VERIFY_DIR   the install folder (the manifest is at
#                        <dir>\resources\synabun-payload.manifest)
#   SYNABUN_VERIFY_LOG   a file to append a short log to (may be empty)
#
# Exit code: 0 every file present at its size; 3 one or more missing or the wrong
# size; 2 the manifest itself is missing or unreadable. One line on standard
# output names the first few bad files ("SYNABUN_VERIFY ok" or "SYNABUN_VERIFY
# bad: <path> (missing) ; <path> (size 10 != 20) ; ... (+N more)").

[CmdletBinding()]
param()
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

$dir = [string]$env:SYNABUN_VERIFY_DIR
$logPath = [string]$env:SYNABUN_VERIFY_LOG

function Write-VerifyLog([string]$message) {
  $line = '{0} {1}' -f (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss'), $message
  if ($logPath) { try { Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8 } catch {} }
}

if ([string]::IsNullOrWhiteSpace($dir) -or -not (Test-Path -LiteralPath $dir)) {
  Write-VerifyLog "verify: the install folder was not given or does not exist ($dir)"
  Write-Output 'SYNABUN_VERIFY error: no install folder'
  exit 2
}
$root = ([IO.Path]::GetFullPath($dir)).TrimEnd([char]92) + [char]92
$manifestPath = Join-Path $root 'resources\synabun-payload.manifest'
if (-not (Test-Path -LiteralPath $manifestPath)) {
  Write-VerifyLog "verify: the payload manifest is missing ($manifestPath)"
  Write-Output 'SYNABUN_VERIFY error: manifest missing'
  exit 2
}

# The manifest: "<relative path>\t<bytes>" per line.
$want = @()
try {
  foreach ($line in [IO.File]::ReadAllLines($manifestPath)) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $tab = $line.LastIndexOf([char]9)
    if ($tab -lt 1) { continue }
    $rel = $line.Substring(0, $tab)
    $size = 0L
    [void][long]::TryParse($line.Substring($tab + 1), [ref]$size)
    $want += [pscustomobject]@{ rel = $rel; size = $size }
  }
} catch {
  Write-VerifyLog "verify: the payload manifest could not be read"
  Write-Output 'SYNABUN_VERIFY error: manifest unreadable'
  exit 2
}
if ($want.Count -eq 0) {
  Write-VerifyLog "verify: the payload manifest is empty"
  Write-Output 'SYNABUN_VERIFY error: manifest empty'
  exit 2
}

# One enumeration of the install folder into a map of lower-case relative path -> length.
$have = @{}
try {
  foreach ($f in (Get-ChildItem -LiteralPath $root -Recurse -File -Force -ErrorAction SilentlyContinue)) {
    $full = $f.FullName
    if ($full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
      $have[$full.Substring($root.Length).ToLowerInvariant()] = [long]$f.Length
    }
  }
} catch {
  Write-VerifyLog "verify: the install folder could not be read"
  Write-Output 'SYNABUN_VERIFY error: could not read the install folder'
  exit 2
}

$bad = New-Object System.Collections.Generic.List[string]
foreach ($entry in $want) {
  $key = $entry.rel.ToLowerInvariant()
  if (-not $have.ContainsKey($key)) {
    $bad.Add("$($entry.rel) (missing)")
  } elseif ($have[$key] -ne $entry.size) {
    $bad.Add("$($entry.rel) (size $($have[$key]) != $($entry.size))")
  }
  if ($bad.Count -ge 20) { break }
}

if ($bad.Count -eq 0) {
  Write-VerifyLog "verify: all $($want.Count) payload files present at their size"
  Write-Output 'SYNABUN_VERIFY ok'
  exit 0
}
$shown = $bad | Select-Object -First 5
$more = $bad.Count - $shown.Count
$desc = ($shown -join ' ; ')
if ($more -gt 0) { $desc = "$desc ; (+$more more)" }
Write-VerifyLog "verify: incomplete payload — $desc"
Write-Output ('SYNABUN_VERIFY bad: ' + $desc)
exit 3
