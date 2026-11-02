# SynaBun - the install window of a Windows update (install-window.mjs says why it exists).
#
# Keep this file ASCII: Windows PowerShell 5.1 reads a script without a byte order
# mark in the ANSI code page (packaging/lib/windows-scripts.mjs). Every word it shows
# comes translated from install-window.json and install-view.json, read as UTF-8.
#
# It draws what it is told and decides almost nothing:
#   install-window.json  the words, the place, the log (once, at start)
#   install-view.json    the watchdog's latest view (win-swap.mjs composeWindowView),
#                        read four times a second: stage, mascot, status, percent,
#                        error, close
#   window-shown         written once the first frame is on screen; the app quits
#                        only after it, so there is never a moment with no window
# Its own rules, for a watchdog that stops answering: when the watchdog's process is
# gone and the last view was neither an end nor an error, it says so (stalled) with
# the log; and it never lives longer than maxMs. Closing it (Alt+F4, Close) never
# stops the install: the watchdog goes on and the new version opens by itself.

param(
  [Parameter(Mandatory = $true)][string]$Config,
  [Parameter(Mandatory = $true)][string]$View,
  [Parameter(Mandatory = $true)][string]$Shown,
  [int]$Watchdog = 0
)

# Stop while the window is built (a script that cannot draw ends, and the app goes on without it); every handler
# after that catches its own errors.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

function Read-Json([string]$path) {
  try {
    if (-not [IO.File]::Exists($path)) { return $null }
    $text = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    return ($text | ConvertFrom-Json)
  } catch { return $null }
}

$cfg = Read-Json $Config
if ($null -eq $cfg) { exit 2 }

$width = 340
$height = 400
if ($cfg.size) { $width = [int]$cfg.size.width; $height = [int]$cfg.size.height }

# The splash's geometry (pages/splash.css): 280 x 140 mascot drawn at 150 x 75, the
# DESIGN.md dark tokens (background #050505, text #ffffffe6, muted #ffffff8c, border
# #ffffff1a, the working gold #ffd700 at .85, success #86efac, danger #fca5a5).
$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="SynaBun" Width="$width" Height="$height" WindowStyle="None" ResizeMode="NoResize"
        AllowsTransparency="True" Background="Transparent" ShowInTaskbar="True" WindowStartupLocation="Manual"
        FontFamily="Inter, Segoe UI" FontSize="13" TextOptions.TextFormattingMode="Display">
  <Window.Resources>
    <Style x:Key="Btn" TargetType="Button">
      <Setter Property="Foreground" Value="#E6FFFFFF"/>
      <Setter Property="FontSize" Value="12"/>
      <Setter Property="FontWeight" Value="Medium"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Margin" Value="4,0"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="B" Background="#14FFFFFF" BorderBrush="#1AFFFFFF" BorderThickness="1" CornerRadius="5" Padding="12,6">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="B" Property="Background" Value="#26FFFFFF"/></Trigger>
              <Trigger Property="IsKeyboardFocused" Value="True"><Setter TargetName="B" Property="BorderBrush" Value="#93C5FD"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
  </Window.Resources>
  <Border x:Name="Frame" Background="#050505" BorderBrush="#1AFFFFFF" BorderThickness="1" CornerRadius="10">
    <Grid Margin="24,26,24,14">
      <Grid.RowDefinitions>
        <RowDefinition Height="24"/>
        <RowDefinition Height="*"/>
        <RowDefinition Height="Auto"/>
      </Grid.RowDefinitions>
      <StackPanel Grid.Row="0" Orientation="Horizontal" HorizontalAlignment="Center" VerticalAlignment="Center">
        <Image x:Name="Logo" Height="20" Opacity="0.92" Margin="0,0,10,0" RenderOptions.BitmapScalingMode="HighQuality"/>
        <TextBlock x:Name="LogoText" Text="SynaBun" FontFamily="Space Grotesk, Segoe UI" FontWeight="SemiBold" FontSize="15" Foreground="#E6FFFFFF" Margin="0,0,10,0" Visibility="Collapsed"/>
        <StackPanel Orientation="Horizontal" VerticalAlignment="Bottom" Margin="0,0,0,4">
          <Rectangle x:Name="Pill1" Width="10" Height="4" RadiusX="2" RadiusY="2" Margin="0,0,3,0" Fill="#59FFFFFF"><Rectangle.RenderTransform><TransformGroup><RotateTransform Angle="-12"/><TranslateTransform/></TransformGroup></Rectangle.RenderTransform></Rectangle>
          <Rectangle x:Name="Pill2" Width="10" Height="4" RadiusX="2" RadiusY="2" Margin="0,0,3,0" Fill="#59FFFFFF"><Rectangle.RenderTransform><TransformGroup><RotateTransform Angle="-12"/><TranslateTransform/></TransformGroup></Rectangle.RenderTransform></Rectangle>
          <Rectangle x:Name="Pill3" Width="10" Height="4" RadiusX="2" RadiusY="2" Fill="#59FFFFFF"><Rectangle.RenderTransform><TransformGroup><RotateTransform Angle="-12"/><TranslateTransform/></TransformGroup></Rectangle.RenderTransform></Rectangle>
        </StackPanel>
      </StackPanel>

      <StackPanel Grid.Row="1" VerticalAlignment="Center" HorizontalAlignment="Center">
        <Grid x:Name="BubbleBox" HorizontalAlignment="Center" Margin="0,0,0,14" MinHeight="36">
          <Border x:Name="Bubble" Background="#D9141418" BorderBrush="#14FFFFFF" BorderThickness="1" CornerRadius="14" Padding="14,8" MaxWidth="270" RenderTransformOrigin="0.5,1">
            <Border.RenderTransform><TransformGroup><ScaleTransform/><TranslateTransform/></TransformGroup></Border.RenderTransform>
            <TextBlock x:Name="Say" Foreground="#E6FFFFFF" TextAlignment="Center" TextWrapping="Wrap"/>
          </Border>
        </Grid>
        <Viewbox x:Name="Mascot" Width="150" Height="75" HorizontalAlignment="Center" RenderTransformOrigin="0.5,0.5">
          <Viewbox.RenderTransform><TranslateTransform/></Viewbox.RenderTransform>
          <Canvas Width="280" Height="140" ClipToBounds="False">
            <Rectangle x:Name="EyeL" Canvas.Left="80" Canvas.Top="24" Width="38" Height="72" RadiusX="19" RadiusY="19" Fill="#73FFFFFF" RenderTransformOrigin="0.5,0.5">
              <Rectangle.RenderTransform><TransformGroup><ScaleTransform/><RotateTransform/><TranslateTransform/></TransformGroup></Rectangle.RenderTransform>
            </Rectangle>
            <Rectangle x:Name="EyeR" Canvas.Left="162" Canvas.Top="24" Width="38" Height="72" RadiusX="19" RadiusY="19" Fill="#73FFFFFF" RenderTransformOrigin="0.5,0.5">
              <Rectangle.RenderTransform><TransformGroup><ScaleTransform/><RotateTransform/><TranslateTransform/></TransformGroup></Rectangle.RenderTransform>
            </Rectangle>
            <Path x:Name="MouthCalm" Data="M118,116 Q140,128 162,116" Stroke="#26FFFFFF" StrokeThickness="2.5" StrokeStartLineCap="Round" StrokeEndLineCap="Round"/>
            <Path x:Name="MouthHappy" Data="M111,112 Q140,138 169,112" Stroke="#8050DC78" StrokeThickness="2.5" StrokeStartLineCap="Round" StrokeEndLineCap="Round" Opacity="0"/>
            <Path x:Name="MouthSad" Data="M123,124 Q140,114 157,124" Stroke="#4DFFFFFF" StrokeThickness="2.5" StrokeStartLineCap="Round" StrokeEndLineCap="Round" Opacity="0"/>
          </Canvas>
        </Viewbox>
      </StackPanel>

      <StackPanel Grid.Row="2" HorizontalAlignment="Center">
        <TextBlock x:Name="Status" Foreground="#E6FFFFFF" TextAlignment="Center" TextTrimming="CharacterEllipsis" Margin="0,10,0,0" MinHeight="19"/>
        <Grid x:Name="Bar" Width="200" Height="3" Margin="0,10,0,0" ClipToBounds="True">
          <Border Background="#1AFFFFFF" CornerRadius="1.5"/>
          <Border x:Name="Fill" Background="#D9FFD700" CornerRadius="1.5" HorizontalAlignment="Left" Width="0"/>
          <Border x:Name="Travel" Background="#D9FFD700" CornerRadius="1.5" HorizontalAlignment="Left" Width="60">
            <Border.RenderTransform><TranslateTransform/></Border.RenderTransform>
          </Border>
        </Grid>
        <TextBlock x:Name="Meta" Foreground="#8CFFFFFF" FontFamily="JetBrains Mono, Consolas" FontSize="12" TextAlignment="Center" Margin="0,8,0,0" MinHeight="16"/>
        <StackPanel x:Name="ErrorBox" Visibility="Collapsed" Margin="0,6,0,0" MaxWidth="290">
          <TextBlock x:Name="ErrorText" Foreground="#FCA5A5" TextAlignment="Center" TextWrapping="Wrap"/>
          <TextBlock x:Name="ErrorDetail" Foreground="#8CFFFFFF" FontSize="12" TextAlignment="Center" TextWrapping="Wrap" Margin="0,4,0,0"/>
          <TextBox x:Name="LogPath" Foreground="#8CFFFFFF" Background="Transparent" BorderThickness="0" IsReadOnly="True" FontFamily="JetBrains Mono, Consolas" FontSize="11" TextAlignment="Center" TextWrapping="Wrap" Margin="0,4,0,0"/>
          <StackPanel Orientation="Horizontal" HorizontalAlignment="Center" Margin="0,10,0,0">
            <Button x:Name="OpenLog" Style="{StaticResource Btn}"/>
            <Button x:Name="CloseBtn" Style="{StaticResource Btn}"/>
          </StackPanel>
        </StackPanel>
      </StackPanel>
    </Grid>
  </Border>
</Window>
"@

$window = [Windows.Markup.XamlReader]::Parse($xaml)
$el = @{}
foreach ($name in 'Logo','LogoText','Pill1','Pill2','Pill3','Bubble','BubbleBox','Say','Mascot','EyeL','EyeR','MouthCalm','MouthHappy','MouthSad','Status','Bar','Fill','Travel','Meta','ErrorBox','ErrorText','ErrorDetail','LogPath','OpenLog','CloseBtn') {
  $el[$name] = $window.FindName($name)
}
$window.Title = [string]$cfg.text.title
$el.OpenLog.Content = [string]$cfg.text.openLog
$el.CloseBtn.Content = [string]$cfg.text.close

# The wordmark, from the copy beside this script (loaded whole: the file is never held open).
$logoShown = $false
try {
  if ($cfg.logo -and [IO.File]::Exists([string]$cfg.logo)) {
    $bmp = New-Object Windows.Media.Imaging.BitmapImage
    $bmp.BeginInit()
    $bmp.CacheOption = [Windows.Media.Imaging.BitmapCacheOption]::OnLoad
    $bmp.UriSource = New-Object Uri ([string]$cfg.logo)
    $bmp.EndInit()
    $el.Logo.Source = $bmp
    $logoShown = $true
  }
} catch { $logoShown = $false }
if (-not $logoShown) { $el.Logo.Visibility = 'Collapsed'; $el.LogoText.Visibility = 'Visible' }

# Where the splash was, so the window takes its place; centred on the screen otherwise.
$area = [Windows.SystemParameters]::WorkArea
if ($cfg.bounds -and $cfg.bounds.width -gt 0) {
  $window.Left = [double]$cfg.bounds.x + ([double]$cfg.bounds.width - $width) / 2
  $window.Top = [double]$cfg.bounds.y + ([double]$cfg.bounds.height - $height) / 2
} else {
  $window.Left = $area.Left + ($area.Width - $width) / 2
  $window.Top = $area.Top + ($area.Height - $height) / 2
}
if ($window.Left -lt $area.Left -or $window.Left + $width -gt $area.Right -or $window.Top -lt $area.Top -or $window.Top + $height -gt $area.Bottom) {
  $window.Left = $area.Left + ($area.Width - $width) / 2
  $window.Top = $area.Top + ($area.Height - $height) / 2
}

# -- Animations: the splash's keyframes (pages/splash.css), as WPF storyboards --
function New-Keys([string]$path, [double]$seconds, [double[][]]$frames, [double]$delay = 0) {
  $anim = New-Object Windows.Media.Animation.DoubleAnimationUsingKeyFrames
  $anim.Duration = [Windows.Duration]::new([TimeSpan]::FromSeconds($seconds))
  $anim.RepeatBehavior = [Windows.Media.Animation.RepeatBehavior]::Forever
  $anim.BeginTime = [TimeSpan]::FromSeconds($delay)
  foreach ($f in $frames) {
    $key = New-Object Windows.Media.Animation.SplineDoubleKeyFrame
    $key.KeyTime = [Windows.Media.Animation.KeyTime]::FromPercent($f[0])
    $key.Value = $f[1]
    $key.KeySpline = New-Object Windows.Media.Animation.KeySpline 0.42, 0, 0.58, 1
    [void]$anim.KeyFrames.Add($key)
  }
  [Windows.Media.Animation.Storyboard]::SetTargetProperty($anim, (New-Object Windows.PropertyPath $path))
  return $anim
}

$running = @()
function Stop-Motion {
  foreach ($item in $script:running) { try { $item[0].Stop($item[1]) } catch {} }
  $script:running = @()
}
function Start-Motion($target, $animations) {
  $sb = New-Object Windows.Media.Animation.Storyboard
  foreach ($a in $animations) { [void]$sb.Children.Add($a) }
  $sb.Begin($target, $true)
  $script:running += , @($sb, $target)
}

$eyeScaleY = '(UIElement.RenderTransform).(TransformGroup.Children)[0].(ScaleTransform.ScaleY)'
$eyeRotate = '(UIElement.RenderTransform).(TransformGroup.Children)[1].(RotateTransform.Angle)'
$eyeMoveY = '(UIElement.RenderTransform).(TransformGroup.Children)[2].(TranslateTransform.Y)'
$eyeMoveX = '(UIElement.RenderTransform).(TransformGroup.Children)[2].(TranslateTransform.X)'
$pillMoveY = '(UIElement.RenderTransform).(TransformGroup.Children)[1].(TranslateTransform.Y)'

function Set-Eye($eye, [string]$fill, [double]$scaleY, [double]$angle, [double]$y) {
  $eye.Fill = (New-Object Windows.Media.BrushConverter).ConvertFromString($fill)
  $group = $eye.RenderTransform
  $group.Children[0].ScaleY = $scaleY
  $group.Children[1].Angle = $angle
  $group.Children[2].Y = $y
  $group.Children[2].X = 0
}
function Set-Pills([string]$fill, [double[]]$y) {
  $i = 0
  foreach ($p in @($el.Pill1, $el.Pill2, $el.Pill3)) {
    $p.Fill = (New-Object Windows.Media.BrushConverter).ConvertFromString($fill)
    $p.RenderTransform.Children[1].Y = $y[$i]
    $i++
  }
}

$mascotState = ''
function Set-Mascot([string]$state) {
  if ($state -eq $script:mascotState) { return }
  $script:mascotState = $state
  Stop-Motion
  $el.MouthCalm.Opacity = 1; $el.MouthHappy.Opacity = 0; $el.MouthSad.Opacity = 0
  switch ($state) {
    'ready' {
      Set-Eye $el.EyeL '#CC50DC78' 0.3 -8 -4
      Set-Eye $el.EyeR '#CC50DC78' 0.3 8 -4
      $el.MouthCalm.Opacity = 0; $el.MouthHappy.Opacity = 1
      Set-Pills '#86EFAC' @(0, 0, 0)
    }
    'failed' {
      Set-Eye $el.EyeL '#99FFFFFF' 0.78 12 2
      Set-Eye $el.EyeR '#99FFFFFF' 0.74 -12 2
      $el.MouthCalm.Opacity = 0; $el.MouthSad.Opacity = 1
      Set-Pills '#FCA5A5' @(2, 3, 2)
    }
    'waking' {
      Set-Eye $el.EyeL '#B3FFFFFF' 0.46 0 0
      Set-Eye $el.EyeR '#B3FFFFFF' 0.46 0 0
      Set-Pills '#59FFFFFF' @(0, 0, 0)
      $glance = @(@(0, 0), @(0.12, 0), @(0.28, -9), @(0.44, -9), @(0.60, 9), @(0.76, 9), @(0.90, 0), @(1, 0))
      Start-Motion $el.EyeL @(New-Keys $eyeMoveX 2.6 $glance)
      Start-Motion $el.EyeR @(New-Keys $eyeMoveX 2.6 $glance)
    }
    default {
      # working: eyes wide open, taking turns; the pills hop
      Set-Eye $el.EyeL '#D9FFFFFF' 1 0 0
      Set-Eye $el.EyeR '#D9FFFFFF' 1 0 0
      Set-Pills '#D9FFD700' @(0, 0, 0)
      $moveY = @(@(0, 0), @(0.35, -7), @(0.60, 2), @(1, 0))
      $scaleY = @(@(0, 1), @(0.35, 1.04), @(0.60, 0.92), @(1, 1))
      Start-Motion $el.EyeL @((New-Keys $eyeMoveY 1.1 $moveY), (New-Keys $eyeScaleY 1.1 $scaleY))
      Start-Motion $el.EyeR @((New-Keys $eyeMoveY 1.1 $moveY 0.18), (New-Keys $eyeScaleY 1.1 $scaleY 0.18))
      $hop = @(@(0, 0), @(0.30, -6), @(0.60, 0), @(1, 0))
      Start-Motion $el.Pill1 @(New-Keys $pillMoveY 1.1 $hop)
      Start-Motion $el.Pill2 @(New-Keys $pillMoveY 1.1 $hop 0.14)
      Start-Motion $el.Pill3 @(New-Keys $pillMoveY 1.1 $hop 0.28)
    }
  }
}

# The bar travels while nothing says how far along it is.
$travel = New-Object Windows.Media.Animation.DoubleAnimation
$travel.From = -60; $travel.To = 200
$travel.Duration = [Windows.Duration]::new([TimeSpan]::FromSeconds(1.4))
$travel.RepeatBehavior = [Windows.Media.Animation.RepeatBehavior]::Forever
$el.Travel.RenderTransform.BeginAnimation([Windows.Media.TranslateTransform]::XProperty, $travel)

# -- What the mascot says: its lines in turn --
$lines = @()
$turn = 0
function Say([string]$text) {
  $el.Say.Text = $text
  $el.BubbleBox.Visibility = $(if ([string]::IsNullOrEmpty($text)) { 'Hidden' } else { 'Visible' })
}
$lineMs = 4200
if ($cfg.lineMs -ge 1000) { $lineMs = [int]$cfg.lineMs }
$lineTimer = New-Object Windows.Threading.DispatcherTimer
$lineTimer.Interval = [TimeSpan]::FromMilliseconds($lineMs)
$lineTimer.Add_Tick({
  try {
    if ($script:lines.Count -gt 1) {
      $script:turn = ($script:turn + 1) % $script:lines.Count
      Say $script:lines[$script:turn]
    }
  } catch {}
})
$lineTimer.Start()

# -- One view, as the watchdog wrote it --
$current = $null
$stage = ''
$terminal = $false
$closeAt = $null
function Apply($v) {
  if ($null -eq $v) { return }
  $script:current = $v
  Set-Mascot ([string]$v.mascot)
  $el.Status.Text = [string]$v.status
  $next = @()
  if ($v.lines) { $next = @($v.lines | ForEach-Object { [string]$_ }) }
  if ([string]$v.stage -ne $script:stage -or (($next -join "`n") -ne ($script:lines -join "`n"))) {
    $script:stage = [string]$v.stage
    $script:lines = $next
    $script:turn = 0
    if ($next.Count) { Say $next[0] } else { Say '' }
  }
  if ($null -ne $v.percent) {
    $el.Travel.Visibility = 'Collapsed'
    $el.Fill.Width = [Math]::Max(0, [Math]::Min(200, 2 * [double]$v.percent))
  } else {
    $el.Fill.Width = 0
    $el.Travel.Visibility = $(if ([string]$v.mascot -eq 'working' -or [string]$v.mascot -eq 'waking') { 'Visible' } else { 'Collapsed' })
  }
  $el.Meta.Text = [string]$v.label
  if ($v.error) {
    $script:terminal = $true
    $el.Bar.Visibility = 'Collapsed'
    $el.Meta.Visibility = 'Collapsed'
    $el.ErrorBox.Visibility = 'Visible'
    $el.ErrorText.Text = [string]$v.error
    $el.ErrorDetail.Text = [string]$v.detail
    $el.ErrorDetail.Visibility = $(if ([string]::IsNullOrEmpty([string]$v.detail)) { 'Collapsed' } else { 'Visible' })
    $log = [string]$v.log
    if ([string]::IsNullOrEmpty($log)) { $log = [string]$cfg.logPath }
    $el.LogPath.Text = ([string]$cfg.text.log).Replace('{path}', $log)
    $el.OpenLog.Tag = $log
    $el.OpenLog.Visibility = $(if ([string]::IsNullOrEmpty($log)) { 'Collapsed' } else { 'Visible' })
    $el.CloseBtn.Focus() | Out-Null
  } else {
    $el.Bar.Visibility = 'Visible'
    $el.Meta.Visibility = 'Visible'
    $el.ErrorBox.Visibility = 'Collapsed'
  }
  if ($v.close -and $null -eq $script:closeAt) {
    $script:terminal = $true
    $wait = 700
    if ($v.closeAfterMs -ge 0) { $wait = [int]$v.closeAfterMs }
    $script:closeAt = [DateTime]::UtcNow.AddMilliseconds($wait)
  }
}

$el.OpenLog.Add_Click({
  $path = [string]$el.OpenLog.Tag
  try {
    if ([IO.File]::Exists($path)) { Start-Process -FilePath (Join-Path $env:SystemRoot 'notepad.exe') -ArgumentList ('"' + $path + '"') }
    else { Start-Process -FilePath (Join-Path $env:SystemRoot 'explorer.exe') -ArgumentList ('"' + [IO.Path]::GetDirectoryName($path) + '"') }
  } catch {}
})
$el.CloseBtn.Add_Click({ $window.Close() })
$window.Add_MouseLeftButtonDown({ try { $window.DragMove() } catch {} })
$window.Add_KeyDown({ param($s, $e) if ($e.Key -eq 'Escape' -and $script:terminal) { $window.Close() } })

$started = [DateTime]::UtcNow
$maxMs = 40 * 60 * 1000
if ($cfg.maxMs -gt 0) { $maxMs = [double]$cfg.maxMs }
$lastStamp = [DateTime]::MinValue
$goneSince = $null

function Watchdog-Alive {
  if ($Watchdog -le 0) { return $true }
  try { $null = Get-Process -Id $Watchdog -ErrorAction Stop; return $true } catch { return $false }
}

$poll = New-Object Windows.Threading.DispatcherTimer
$poll.Interval = [TimeSpan]::FromMilliseconds(250)
$poll.Add_Tick({
  # An error in a tick would end the window: none may leave it.
  try {
    try {
      $info = New-Object IO.FileInfo $View
      if ($info.Exists -and $info.LastWriteTimeUtc -ne $script:lastStamp) {
        $v = Read-Json $View
        if ($null -ne $v) { $script:lastStamp = $info.LastWriteTimeUtc; Apply $v }
      }
    } catch {}
    $now = [DateTime]::UtcNow
    if ($null -ne $script:closeAt -and $now -ge $script:closeAt) { $window.Close(); return }
    if (($now - $script:started).TotalMilliseconds -gt $maxMs) { $window.Close(); return }
    if (-not $script:terminal) {
      if (Watchdog-Alive) { $script:goneSince = $null }
      elseif ($null -eq $script:goneSince) { $script:goneSince = $now }
      elseif (($now - $script:goneSince).TotalSeconds -ge 8) {
        $base = $cfg.views.failed
        Apply ([pscustomobject]@{ stage = 'failed'; mascot = 'failed'; status = [string]$base.status; lines = @(); percent = $null; label = ''; error = [string]$cfg.text.stalled; detail = ''; log = [string]$cfg.logPath; close = $false })
      }
    }
  } catch {}
})

$first = $true
$window.Add_ContentRendered({
  if ($script:first) {
    $script:first = $false
    try { $window.Activate() | Out-Null } catch {}
    try { [IO.File]::WriteAllText($Shown, [DateTime]::UtcNow.ToString('o')) } catch {}
  }
})
$window.Add_Closed({ $poll.Stop(); $lineTimer.Stop(); [Windows.Threading.Dispatcher]::CurrentDispatcher.InvokeShutdown() })

$w = $cfg.views.waiting
Apply ([pscustomobject]@{ stage = [string]$w.stage; mascot = [string]$w.mascot; status = [string]$w.status; lines = @($w.lines); percent = $null; label = ''; error = $null; close = $false })
$initial = Read-Json $View
if ($null -ne $initial) { Apply $initial }
$poll.Start()
# Started without a console (windowsHide): the first ShowWindow of such a process may take the hidden state of
# its start-up information instead of the one asked for. The second one always shows.
$window.Show()
$window.Hide()
$window.Show()
[Windows.Threading.Dispatcher]::Run()
exit 0
