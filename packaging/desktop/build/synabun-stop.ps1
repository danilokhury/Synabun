# SynaBun — the Windows installer's "close the running SynaBun" helper.
#
# The installer (and the previous version's uninstaller it runs) include this
# through installer.nsh and run it once before any file is written or removed.
# SynaBun is not one process: the window (SynaBun.exe), its server on the bundled
# node.exe, synabun-cli.exe launchers and hooks, the long-lived "synabun-cli mcp"
# stdio servers an AI tool started, the bundled cloudflared.exe and the bundled
# Git Bash can each hold a file in the install folder open. Closing the window
# leaves the server running.
#
# What it does, in order:
#   1. graceful  — ask every SynaBun server (a loopback port owned by one of our
#                  processes) to shut down through POST /api/server/shutdown, so
#                  SQLite and the server's children close cleanly and the
#                  supervisor exits by itself (it exits on a clean stop; it never
#                  respawns one we did not ask it to restart).
#   2. force     — end whatever still runs from the folder(s), whole process
#                  trees (taskkill /T), in a loop that defeats a respawn and
#                  catches a process that started while we were killing.
#   3. wait free — until nothing runs from the folder(s) AND the window
#                  executable can be opened for exclusive write (a handle can
#                  linger a moment after the process ends, and a file can be held
#                  by a process we cannot see — an elevated one, or an unrelated
#                  holder; the file-free check runs even when no process is
#                  visible, so a locked file is never mistaken for a clean state).
#
# It only ever KILLS processes whose executable PATH is inside one of the folders
# it is given (the install folder, and any earlier desktop install folder the
# registry names), compared after both sides are resolved to their final
# filesystem path (so 8.3 short names, \\?\ prefixes and junction aliases do not
# hide a running install). A SynaBun installed by npm or Git runs from another
# folder, so it is never asked to stop and never killed; an unrelated process
# holding a file is reported, never killed.
#
# Everything is bounded by SYNABUN_STOP_BUDGET seconds: each shutdown request is
# capped by the time left (with time reserved for the force step), and every wait
# ends at the deadline. The installer also runs this under its own timeout.
#
# Inputs come in the environment (no path is ever on the command line):
#   SYNABUN_STOP_ROOTS   install folder(s), joined with a vertical bar
#   SYNABUN_STOP_LOG     a file to append a timestamped log to (may be empty)
#   SYNABUN_STOP_PROBE   a file to test for exclusive write at the end (the
#                        window executable), may be empty
#   SYNABUN_STOP_BUDGET  the whole thing, in seconds (default 25)
#   SYNABUN_STOP_DETECT  "1" to only report what runs, killing nothing
#
# Exit code: 0 nothing of ours runs and the files are free; 3 still running or a
# file is still in use; 2 it could not even look (CIM failed). One line on
# standard output names what is left ("SYNABUN_STOP ok" or "SYNABUN_STOP busy:
# <name>(<pid>) <path>; ..."). Everything else goes to the log file.

[CmdletBinding()]
param()
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

$rootsRaw = [string]$env:SYNABUN_STOP_ROOTS
$logPath  = [string]$env:SYNABUN_STOP_LOG
$probe    = [string]$env:SYNABUN_STOP_PROBE
$detect   = ([string]$env:SYNABUN_STOP_DETECT) -eq '1'
$budget   = 0
[void][int]::TryParse(([string]$env:SYNABUN_STOP_BUDGET), [ref]$budget)
if ($budget -le 0) { $budget = 25 }

$taskkill = Join-Path ([string]$env:SystemRoot) 'System32\taskkill.exe'
if (-not (Test-Path -LiteralPath $taskkill)) { $taskkill = 'taskkill.exe' }

function Write-StopLog([string]$message) {
  $line = '{0} {1}' -f (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss'), $message
  if ($logPath) { try { Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8 } catch {} }
}

# Resolve a path to its final filesystem path (GetFinalPathNameByHandle): short
# 8.3 names become long, junctions and symlinks are followed, a \\?\ prefix is
# dropped. A path that cannot be opened (gone, or an elevated process's image we
# may not read) falls back to a lexical full path, and the file-free check is the
# safety net for anything that leaves still holding a file.
$script:canonType = $null
try {
  $script:canonType = Add-Type -PassThru -Name SynaBunPath -Namespace SynaBun -MemberDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);
[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
public static extern uint GetFinalPathNameByHandleW(IntPtr h, StringBuilder buf, uint cch, uint flags);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern bool CloseHandle(IntPtr h);
public static string Final(string p) {
  if (String.IsNullOrEmpty(p)) return p;
  const uint BACKUP = 0x02000000; const uint OPEN_EXISTING = 3; const uint SHARE = 0x7;
  IntPtr h = CreateFileW(p, 0, SHARE, IntPtr.Zero, OPEN_EXISTING, BACKUP, IntPtr.Zero);
  if (h == IntPtr.Zero || h.ToInt64() == -1) return p;
  try {
    var sb = new StringBuilder(1024);
    uint n = GetFinalPathNameByHandleW(h, sb, (uint)sb.Capacity, 0);
    if (n == 0) return p;
    if (n > sb.Capacity) { sb = new StringBuilder((int)n + 1); n = GetFinalPathNameByHandleW(h, sb, (uint)sb.Capacity, 0); if (n == 0) return p; }
    string r = sb.ToString();
    if (r.StartsWith(@"\\?\UNC\")) return @"\\" + r.Substring(8);
    if (r.StartsWith(@"\\?\")) return r.Substring(4);
    return r;
  } finally { CloseHandle(h); }
}
'@
} catch { $script:canonType = $null }

function Resolve-Final([string]$path) {
  if ([string]::IsNullOrWhiteSpace($path)) { return $null }
  $r = $null
  if ($script:canonType) { try { $r = [SynaBun.SynaBunPath]::Final($path) } catch { $r = $null } }
  if ([string]::IsNullOrWhiteSpace($r)) { try { $r = [IO.Path]::GetFullPath($path) } catch { $r = $path } }
  return $r
}

# A folder, resolved, ending in a single backslash so a prefix test never matches
# "C:\Foo" against "C:\FooBar".
function Canon-Root([string]$path) {
  $r = Resolve-Final $path
  if ([string]::IsNullOrWhiteSpace($r)) { return $null }
  return $r.TrimEnd([char]92) + [char]92
}

$roots = @()
foreach ($part in ($rootsRaw -split '\|')) {
  $norm = Canon-Root $part
  if ($norm -and ($roots -notcontains $norm)) { $roots += $norm }
}

if ($roots.Count -eq 0) {
  Write-StopLog 'stop: no install folder was given; nothing to close'
  Write-Output 'SYNABUN_STOP ok (no folder)'
  exit 0
}
Write-StopLog ('stop: folders ' + ($roots -join ' ; ') + "  budget ${budget}s")

function Under-Roots([string]$path) {
  if ([string]::IsNullOrEmpty($path)) { return $false }
  $full = Resolve-Final $path
  if ([string]::IsNullOrEmpty($full)) { return $false }
  foreach ($root in $roots) {
    if ($full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}

# Every SynaBun process that runs from one of the folders, by executable path.
# Win32_Process.ExecutablePath is the real image path, so this never matches by a
# bare image name like node.exe or bash.exe; both sides are resolved first.
function Get-Found() {
  $out = @()
  try {
    foreach ($proc in (Get-CimInstance Win32_Process -ErrorAction Stop)) {
      if ($proc.ExecutablePath -and (Under-Roots $proc.ExecutablePath)) {
        $out += [pscustomobject]@{ pid = [int]$proc.ProcessId; name = [string]$proc.Name; path = [string]$proc.ExecutablePath }
      }
    }
  } catch {
    return $null
  }
  return ,$out
}

function Describe($list) {
  return (($list | ForEach-Object { "$($_.name)($($_.pid))" }) -join ', ')
}

# True once the window executable can be opened for exclusive write (or there is
# no probe / it does not exist yet). A locked file returns false.
function File-Free([string]$file) {
  if ([string]::IsNullOrEmpty($file) -or -not (Test-Path -LiteralPath $file)) { return $true }
  try {
    $stream = [IO.File]::Open($file, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $stream.Close()
    return $true
  } catch {
    return $false
  }
}

$deadline = (Get-Date).AddSeconds($budget)
$forceReserve = 6   # seconds kept back for the force + file-free steps
function Seconds-Left() { return ($deadline - (Get-Date)).TotalSeconds }

$initial = Get-Found
if ($null -eq $initial) {
  Write-StopLog 'stop: the list of running processes could not be read'
  Write-Output 'SYNABUN_STOP error: could not read the process list'
  exit 2
}

# --- detect: report what runs, kill nothing (the installer's prompt decision) --
if ($detect) {
  if ($initial.Count -eq 0) {
    Write-StopLog 'detect: SynaBun is not running'
    Write-Output 'SYNABUN_STOP ok'
    exit 0
  }
  Write-StopLog ('detect: running ' + (Describe $initial))
  Write-Output ('SYNABUN_STOP busy: ' + ((($initial | ForEach-Object { "$($_.name)($($_.pid)) $($_.path)" }) -join ' ; ')))
  exit 3
}

# --- 1. graceful: ask each of our servers to shut down (time-bounded) ----------
if ($initial.Count -gt 0) {
  Write-StopLog ('stop: running ' + (Describe $initial))
  $ourPids = @{}
  foreach ($proc in $initial) { $ourPids[[int]$proc.pid] = $true }
  $ports = @()
  try {
    foreach ($conn in (Get-NetTCPConnection -State Listen -ErrorAction Stop)) {
      if ($conn.OwningProcess -and $ourPids.ContainsKey([int]$conn.OwningProcess)) { $ports += [int]$conn.LocalPort }
    }
  } catch {
    Write-StopLog 'stop: the listening ports could not be read; going straight to a forced close'
  }
  $ports = @($ports | Sort-Object -Unique)
  foreach ($port in $ports) {
    $remain = [int][Math]::Floor((Seconds-Left)) - $forceReserve
    if ($remain -le 0) { Write-StopLog 'stop: no time left for more shutdown requests; forcing'; break }
    $to = [Math]::Min(5, $remain)
    try {
      Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/server/shutdown" -Method Post `
        -Headers @{ 'x-synabun-ui' = '1' } -Body '{}' -ContentType 'application/json' -TimeoutSec $to | Out-Null
      Write-StopLog "stop: asked the server on port $port to shut down"
    } catch {
      Write-StopLog "stop: the server on port $port did not accept a shutdown request"
    }
  }
  if ($ports.Count -gt 0) {
    # Let the clean stop run (it closes the database and the children, and the
    # supervisor exits) before any force. Bounded, and leaves time for the force.
    $graceEnd = (Get-Date).AddSeconds(8)
    $reserveEnd = $deadline.AddSeconds(-$forceReserve)
    if ($graceEnd -gt $reserveEnd) { $graceEnd = $reserveEnd }
    while ((Get-Date) -lt $graceEnd) {
      $still = Get-Found
      if ($null -eq $still -or $still.Count -eq 0) { break }
      Start-Sleep -Milliseconds 400
    }
    $after = Get-Found
    if ($null -ne $after -and $after.Count -eq 0) { Write-StopLog 'stop: SynaBun closed itself cleanly' }
  }

  # --- 2. force: end whatever still runs, whole trees, until nothing does ------
  while ((Seconds-Left) -gt 0) {
    $running = Get-Found
    if ($null -eq $running -or $running.Count -eq 0) { break }
    foreach ($proc in $running) { & $taskkill /PID $proc.pid /T /F *> $null }
    Write-StopLog ('stop: ended ' + (Describe $running))
    Start-Sleep -Milliseconds 500
  }
}

# --- 3. wait until the files are really free (ALWAYS, even if no process ran) --
while ((Seconds-Left) -gt 0) {
  $running = Get-Found
  if (($null -ne $running) -and ($running.Count -eq 0) -and (File-Free $probe)) { break }
  Start-Sleep -Milliseconds 400
}

$left = Get-Found
if ($null -eq $left) {
  Write-Output 'SYNABUN_STOP error: could not read the process list'
  exit 2
}
$free = File-Free $probe
if ($left.Count -eq 0 -and $free) {
  Write-StopLog 'stop: SynaBun is closed and its files are free'
  Write-Output 'SYNABUN_STOP ok'
  exit 0
}
$desc = (($left | ForEach-Object { "$($_.name)($($_.pid)) $($_.path)" }) -join ' ; ')
if (-not $desc) { $desc = "a file in $probe is still in use (by a process not under the install folder)" }
Write-StopLog ('stop: still busy — ' + $desc)
Write-Output ('SYNABUN_STOP busy: ' + $desc)
exit 3
