# The Recycle Bin, for lib/file-explorer-system.js. Two uses, and a path is always the script's argument (it is
# never part of a command line that is parsed again):
#
#   file-explorer-trash.ps1 -Probe <folder>   says what is known of the bin that serves that folder, as one line
#                                             of JSON, and removes nothing
#   file-explorer-trash.ps1 <path>            moves that file or folder to the Recycle Bin
#
# Nothing is decided here. The Shell deletes for good, without a word, what its bin cannot keep (a network or a
# removable drive, a bin that is switched off, an item larger than the bin), so the server asks first and applies
# its rule, recycleVerdict() in lib/file-explorer-system.js, which is tested without Windows. It runs the second
# form only for an item that rule says the bin will keep. Nobody has run this script on Windows yet.
param([Parameter(Mandatory = $true, Position = 0)][string]$LiteralPath, [switch]$Probe)
$ErrorActionPreference = 'Stop'

if ($Probe) {
  # The facts. A setting that is not there and a setting that could not be read are told apart: the first is
  # Windows' default (the bin is on, with the system's own limit), the second is nothing known, and the rule
  # takes "not known" for "not sure" and hands the bin nothing.
  #   driveType      Win32_Volume.DriveType of the volume the folder is on (3 is a local disk); 0 when no volume
  #                  is found for it (a network drive, a drive made by subst)
  #   volumeBytes    how large that volume is
  #   maxCapacityMB  the bin's own limit on that volume; $null when it was never set up
  #   nukeOnDelete   "Don't move files to the Recycle Bin" is chosen for that volume: $true, $false (also when
  #                  the setting is not there), or $null when it could not be read
  #   policyOff      the same, by policy: $true, $false (also when there is no such policy), or $null when a
  #                  policy key could not be read
  $facts = @{ driveType = 0; volumeBytes = $null; maxCapacityMB = $null; nukeOnDelete = $null; policyOff = $null }

  # The values of one registry key: a table (empty when the key is not there), or $null when it could not be read.
  function Read-Key([string]$Key) {
    try {
      $values = @{}
      $item = Get-ItemProperty -LiteralPath $Key -ErrorAction Stop
      if ($null -ne $item) { foreach ($property in $item.PSObject.Properties) { $values[$property.Name] = $property.Value } }
      return $values
    } catch [System.Management.Automation.ItemNotFoundException] {
      return @{}
    } catch {
      return $null
    }
  }

  try {
    $folder = [System.IO.Path]::GetFullPath($LiteralPath).TrimEnd('\') + '\'
    # The volume whose mount point is the longest beginning of the folder: a volume mounted in a folder is found too.
    $volume = Get-CimInstance -ClassName Win32_Volume |
      Where-Object { $_.Name -and $folder.StartsWith($_.Name, [System.StringComparison]::OrdinalIgnoreCase) } |
      Sort-Object -Property { $_.Name.Length } -Descending |
      Select-Object -First 1
    if ($volume) {
      $facts.driveType = [int]$volume.DriveType
      if ($volume.Capacity) { $facts.volumeBytes = [double]$volume.Capacity }
      $id = [regex]::Match([string]$volume.DeviceID, '\{[0-9A-Fa-f-]{36}\}').Value
      if ($id) {
        $bin = Read-Key "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\BitBucket\Volume\$id"
        if ($null -ne $bin) {
          if ($bin.ContainsKey('MaxCapacity') -and $null -ne $bin['MaxCapacity']) { $facts.maxCapacityMB = [double]$bin['MaxCapacity'] }
          $facts.nukeOnDelete = ($bin.ContainsKey('NukeOnDelete') -and $bin['NukeOnDelete'] -eq 1)
        }
      }
    }
    $off = $false
    $read = $true
    foreach ($hive in 'HKCU:', 'HKLM:') {
      $policy = Read-Key "$hive\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer"
      if ($null -eq $policy) { $read = $false }
      elseif ($policy.ContainsKey('NoRecycleFiles') -and $policy['NoRecycleFiles'] -eq 1) { $off = $true }
    }
    # Switched off by one hive is off, whatever the other says; otherwise both must have been read to say "on".
    if ($off) { $facts.policyOff = $true } elseif ($read) { $facts.policyOff = $false }
  } catch {
    $facts.error = [string]$_.Exception.Message
  }
  [Console]::Out.WriteLine(($facts | ConvertTo-Json -Compress))
  exit 0
}

Add-Type -AssemblyName Microsoft.VisualBasic
if (Test-Path -LiteralPath $LiteralPath -PathType Container) {
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($LiteralPath, 'OnlyErrorDialogs', 'SendToRecycleBin')
} elseif (Test-Path -LiteralPath $LiteralPath) {
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($LiteralPath, 'OnlyErrorDialogs', 'SendToRecycleBin')
} else {
  exit 3
}
