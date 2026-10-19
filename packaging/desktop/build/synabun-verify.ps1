# SynaBun - the Windows installer's "is the unpacked payload complete" check.
#
# Keep this file ASCII. Windows PowerShell 5.1 reads a script without a byte
# order mark in the ANSI code page (Windows-1252 on an English or Portuguese
# Windows), so a UTF-8 character outside ASCII turns into other characters, and
# one of them (U+201D, the last byte of an em dash) ends a double-quoted string.
# SynaBun 2.0.7 shipped this file with an em dash in a string: it never parsed,
# and every install stopped here. packaging/tests/windows-scripts.test.mjs
# refuses any byte outside ASCII in a script the installer or the app ships.
#
# The installer (synabun-extract.nsh) runs this right after unpacking the
# application into the install folder: a locked file or a full disk could leave
# some files missing or short while SynaBun.exe is already there, so the install
# is not declared done on the window executable alone. This compares the whole
# payload with the manifest the build wrote into it
# (resources\synabun-payload.manifest: one "<install-relative path><TAB><bytes>"
# line per file, except the manifest itself) in one pass: the manifest is read
# into a dictionary, the install folder is listed once by .NET (each size comes
# with the listing: no per-file call, no hashing), and every file is looked up.
# About a second for 25,000 files.
#
# Inputs (environment, no path on the command line):
#   SYNABUN_VERIFY_DIR   the install folder
#   SYNABUN_VERIFY_LOG   a file to append a short log to (may be empty)
#
# Exit code, and the one line on standard output:
#   0  SYNABUN_VERIFY ok: <files> files, <bytes> bytes
#      every file of the manifest is there at its size
#   3  SYNABUN_VERIFY bad: <path> (missing) ; <path> (size 10, expected 20) ; ... (+N more)
#      one or more files missing or short, the manifest itself included
#   2  SYNABUN_VERIFY error: <what>
#      the check could not be made (the folder could not be read)
# The installer reads any other result (PowerShell did not start, a timeout) as
# "the check did not run", never as "the files are incomplete".

[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$dir = [string]$env:SYNABUN_VERIFY_DIR
$logPath = [string]$env:SYNABUN_VERIFY_LOG
$clock = [Diagnostics.Stopwatch]::StartNew()

function Write-VerifyLog([string]$message) {
  if (-not $logPath) { return }
  $line = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss') + ' ' + $message + "`r`n"
  try { [IO.File]::AppendAllText($logPath, $line) } catch {}
}

# Log, print the one line, and end with the exit code.
function Exit-Verify([int]$code, [string]$line, [string]$logText) {
  Write-VerifyLog ('verify: ' + $logText + ' (' + $clock.ElapsedMilliseconds + ' ms)')
  Write-Output $line
  exit $code
}

try {
  if ([string]::IsNullOrWhiteSpace($dir) -or -not [IO.Directory]::Exists($dir)) {
    Exit-Verify 2 'SYNABUN_VERIFY error: no install folder' ('the install folder was not given or does not exist: ' + $dir)
  }
  $root = ([IO.Path]::GetFullPath($dir)).TrimEnd([char]92) + [char]92
  $manifestRel = 'resources\synabun-payload.manifest'
  $manifestPath = $root + $manifestRel
  # The manifest is part of the payload: when it is not there, the unpacking is incomplete.
  if (-not [IO.File]::Exists($manifestPath)) {
    Exit-Verify 3 ('SYNABUN_VERIFY bad: ' + $manifestRel + ' (missing)') ('incomplete payload: ' + $manifestRel + ' is missing')
  }

  # The manifest: "<relative path><TAB><bytes>" per line.
  $want = [System.Collections.Generic.Dictionary[string,long]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($entry in [IO.File]::ReadAllLines($manifestPath)) {
    $tab = $entry.LastIndexOf([char]9)
    if ($tab -lt 1) { continue }
    $size = [long]0
    if (-not [long]::TryParse($entry.Substring($tab + 1), [ref]$size)) { continue }
    $want[$entry.Substring(0, $tab)] = $size
  }
  if ($want.Count -eq 0) {
    Exit-Verify 3 ('SYNABUN_VERIFY bad: ' + $manifestRel + ' (empty)') ('incomplete payload: ' + $manifestRel + ' lists no file')
  }

  # One listing of the install folder; each file the manifest names is compared by size.
  $found = 0
  $foundBytes = [long]0
  $wrongSize = 0
  $bad = [System.Collections.Generic.List[string]]::new()
  $expected = [long]0
  $folder = [IO.DirectoryInfo]::new($root)
  foreach ($file in $folder.EnumerateFiles('*', [IO.SearchOption]::AllDirectories)) {
    $rel = $file.FullName.Substring($root.Length)
    if ($want.TryGetValue($rel, [ref]$expected)) {
      if ($file.Length -eq $expected) {
        $found++
        $foundBytes += $expected
      } else {
        $wrongSize++
        if ($bad.Count -lt 20) { $bad.Add($rel + ' (size ' + $file.Length + ', expected ' + $expected + ')') }
      }
    }
  }

  $missing = $want.Count - $found - $wrongSize
  if ($missing -eq 0 -and $wrongSize -eq 0) {
    Exit-Verify 0 ('SYNABUN_VERIFY ok: ' + $found + ' files, ' + $foundBytes + ' bytes') ('all ' + $found + ' payload files present at their size, ' + $foundBytes + ' bytes')
  }
  # Name the first missing files (only now: a complete payload never pays for this).
  if ($missing -gt 0) {
    foreach ($key in $want.Keys) {
      if ($bad.Count -ge 20) { break }
      if (-not [IO.File]::Exists($root + $key)) { $bad.Add($key + ' (missing)') }
    }
  }
  $shown = @($bad | Select-Object -First 5)
  $desc = $shown -join ' ; '
  $more = $missing + $wrongSize - $shown.Count
  if ($more -gt 0) { $desc = $desc + ' ; (+' + $more + ' more)' }
  Exit-Verify 3 ('SYNABUN_VERIFY bad: ' + $desc) ('incomplete payload, ' + $missing + ' missing and ' + $wrongSize + ' of another size: ' + $desc)
} catch {
  $why = ([string]$_.Exception.Message) -replace '[\r\n]+', ' '
  Exit-Verify 2 ('SYNABUN_VERIFY error: ' + $why) ('the check could not be made: ' + $why)
}
