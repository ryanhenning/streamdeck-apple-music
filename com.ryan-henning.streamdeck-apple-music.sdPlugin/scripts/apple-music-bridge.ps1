# Apple Music bridge for the Stream Deck plugin.
#
# Long-running Windows PowerShell 5.1 process. Reads one JSON request per line on stdin and writes one
# JSON response per line on stdout:
#   request:  {"id":1,"cmd":"listPlaylists","args":{}}
#   response: {"id":1,"ok":true,"result":...}  or  {"id":1,"ok":false,"error":"..."}
#
# It drives the Apple Music for Windows app (a WinUI 3 app) through UI Automation, so it needs no
# Apple Music API key. Commands:
#   listPlaylists        -> names, AutomationIds and persistent IDs of the sidebar playlists
#   play {aid, shuffle}  -> open that playlist and press Play (in order) or Shuffle
#   libraryInfo          -> where the "Apple Music Library.musiclibrary" folder is likely to be
#   thumbnails {items:[{src,dst}], size} -> resize artwork JPEGs to small PNGs for the touch strip
#   nowPlaying           -> title / artist / status from Windows media controls
#   favorite             -> press the now-playing bar's Favorite button
#   ping

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime

Add-Type -Namespace AmBridge -Name Win32 -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
'@

$AE = [System.Windows.Automation.AutomationElement]
$TreeScope = [System.Windows.Automation.TreeScope]
$AppUserModelId = 'AppleInc.AppleMusicWin_nzyj5cx40ttqa!App'

# ---------------------------------------------------------------------------------------------
# Windows media controls (SMTC), used to confirm playback actually started.
# ---------------------------------------------------------------------------------------------
$script:asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
	$_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
	$_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]

function Await($op, [Type]$type) {
	$task = $script:asTask.MakeGenericMethod($type).Invoke($null, @($op))
	$null = $task.Wait(5000)
	return $task.Result
}

$script:smtc = $null
function Get-AppleMusicPlaybackStatus {
	try {
		if (-not $script:smtc) {
			$script:smtc = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
		}
		foreach ($s in $script:smtc.GetSessions()) {
			if ($s.SourceAppUserModelId -like 'AppleInc.AppleMusicWin*') {
				return [string]$s.GetPlaybackInfo().PlaybackStatus
			}
		}
	} catch { }
	return $null
}

# ---------------------------------------------------------------------------------------------
# UI Automation helpers
# ---------------------------------------------------------------------------------------------
function Get-AppleMusicWindow {
	$ids = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
		try { $_.Path -like '*\WindowsApps\AppleInc.AppleMusicWin_*' } catch { $false }
	} | ForEach-Object { $_.Id })
	if ($ids.Count -eq 0) { return $null }
	$windows = $AE::RootElement.FindAll($TreeScope::Children, [System.Windows.Automation.Condition]::TrueCondition)
	foreach ($w in $windows) {
		if ($ids -contains $w.Current.ProcessId -and $w.Current.ClassName -eq 'WinUIDesktopWin32WindowClass') { return $w }
	}
	return $null
}

function Get-OrStartAppleMusicWindow {
	$win = Get-AppleMusicWindow
	if ($win) { return $win }
	Start-Process explorer.exe "shell:AppsFolder\$AppUserModelId"
	$deadline = (Get-Date).AddSeconds(20)
	while ((Get-Date) -lt $deadline) {
		Start-Sleep -Milliseconds 500
		$win = Get-AppleMusicWindow
		if ($win -and (Find-ByAutomationIdLike $win 'IKIND:ePlaylist')) { return $win }
	}
	if ($win) { return $win }
	throw 'Apple Music did not start.'
}

function Find-ById($root, [string]$automationId) {
	$cond = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, $automationId)
	return $root.FindFirst($TreeScope::Descendants, $cond)
}

function Find-ByAutomationIdLike($root, [string]$fragment) {
	$cond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem)
	foreach ($el in $root.FindAll($TreeScope::Descendants, $cond)) {
		if ($el.Current.AutomationId -like "*$fragment*") { return $el }
	}
	return $null
}

function Get-Pattern($el, $pattern) {
	$p = $null
	if ($el.TryGetCurrentPattern($pattern, [ref]$p)) { return $p }
	return $null
}

function Expand-SidebarFolders($win) {
	# Playlists inside sidebar folders only exist once the folder is expanded. Expanding a folder can
	# reveal nested folders, so repeat a few times.
	$cond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem)
	for ($pass = 0; $pass -lt 4; $pass++) {
		$expanded = $false
		foreach ($el in $win.FindAll($TreeScope::Descendants, $cond)) {
			$aid = $el.Current.AutomationId
			if ($aid -ne 'Sidebar_Header_Playlists' -and $aid -notlike '*IKIND:ePlaylist*') { continue }
			$ec = Get-Pattern $el ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
			if ($ec -and $ec.Current.ExpandCollapseState -eq [System.Windows.Automation.ExpandCollapseState]::Collapsed) {
				$ec.Expand(); $expanded = $true
			}
		}
		if (-not $expanded) { break }
		Start-Sleep -Milliseconds 250
	}
}

function Get-SidebarPlaylists {
	$win = Get-OrStartAppleMusicWindow
	Expand-SidebarFolders $win
	$cond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem)
	$list = New-Object System.Collections.ArrayList
	foreach ($el in $win.FindAll($TreeScope::Descendants, $cond)) {
		$aid = $el.Current.AutomationId
		if ($aid -notlike '*IKIND:ePlaylist*') { continue }
		$isFolder = $null -ne (Get-Pattern $el ([System.Windows.Automation.ExpandCollapsePattern]::Pattern))
		$null = $list.Add([ordered]@{ name = $el.Current.Name; aid = $aid; isFolder = $isFolder })
	}
	return , $list.ToArray()
}

function Wait-ForElement($win, [string]$automationId, $previousRuntimeId, [int]$timeoutMs) {
	# After navigating, wait for the page's button to be (re)created so we don't press the Play button
	# of the page that was showing before.
	$deadline = (Get-Date).AddMilliseconds($timeoutMs)
	$el = $null
	while ((Get-Date) -lt $deadline) {
		$el = Find-ById $win $automationId
		if ($el) {
			$rid = ($el.GetRuntimeId() -join '.')
			if (-not $previousRuntimeId -or $rid -ne $previousRuntimeId) { return $el }
		}
		Start-Sleep -Milliseconds 100
	}
	return $el
}

function Restore-Foreground([IntPtr]$previous) {
	# Selecting a sidebar item can bring a visible Apple Music window to the front. Put back whatever
	# window had focus before (a game, a browser...). AttachThreadInput lets us pass the foreground lock.
	if ($previous -eq [IntPtr]::Zero) { return }
	$now = [AmBridge.Win32]::GetForegroundWindow()
	if ($now -eq $previous) { return }
	$ownerPid = [uint32]0
	$fgThread = [AmBridge.Win32]::GetWindowThreadProcessId($now, [ref]$ownerPid)
	$me = [AmBridge.Win32]::GetCurrentThreadId()
	$attached = $false
	if ($fgThread -ne 0 -and $fgThread -ne $me) { $attached = [AmBridge.Win32]::AttachThreadInput($me, $fgThread, $true) }
	try { $null = [AmBridge.Win32]::SetForegroundWindow($previous) }
	finally { if ($attached) { $null = [AmBridge.Win32]::AttachThreadInput($me, $fgThread, $false) } }
}

function Invoke-PlayPlaylist([string]$aid, [bool]$shuffle) {
	$previousForeground = [AmBridge.Win32]::GetForegroundWindow()
	try { return Invoke-PlayPlaylistCore $aid $shuffle }
	finally { Restore-Foreground $previousForeground }
}

function Invoke-PlayPlaylistCore([string]$aid, [bool]$shuffle) {
	$win = Get-OrStartAppleMusicWindow
	$item = Find-ById $win $aid
	if (-not $item) {
		Expand-SidebarFolders $win
		$item = Find-ById $win $aid
	}
	if (-not $item) { throw "Playlist not found in the Apple Music sidebar: $aid" }

	$buttonId = if ($shuffle) { 'ShuffleButtonElement' } else { 'PlayButtonElement' }
	$before = Find-ById $win $buttonId
	$beforeId = if ($before) { $before.GetRuntimeId() -join '.' } else { $null }

	$sel = Get-Pattern $item ([System.Windows.Automation.SelectionItemPattern]::Pattern)
	if (-not $sel) { throw "Sidebar item can't be selected: $aid" }
	if ($sel.Current.IsSelected -and $before) {
		# The playlist's page is already showing, so selecting it again won't rebuild the page. Waiting for a
		# new button would just run into the timeout; press the one that's there.
		$button = $before
	} else {
		$sel.Select()
		$button = Wait-ForElement $win $buttonId $beforeId 3000
	}
	if (-not $button) { throw "The playlist page has no $buttonId." }
	$invoke = Get-Pattern $button ([System.Windows.Automation.InvokePattern]::Pattern)
	$invoke.Invoke()

	# Seen once: Play loaded track 1 but stayed paused. Press again if it isn't playing.
	$status = $null
	for ($i = 0; $i -lt 15; $i++) {
		Start-Sleep -Milliseconds 200
		$status = Get-AppleMusicPlaybackStatus
		if ($status -eq 'Playing') { break }
	}
	if ($status -ne 'Playing') {
		$invoke.Invoke()
		Start-Sleep -Milliseconds 800
		$status = Get-AppleMusicPlaybackStatus
	}
	return [ordered]@{ status = $status }
}

function Get-NowPlaying {
	try {
		if (-not $script:smtc) {
			$script:smtc = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
		}
		foreach ($s in $script:smtc.GetSessions()) {
			if ($s.SourceAppUserModelId -notlike 'AppleInc.AppleMusicWin*') { continue }
			$p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
			# Apple Music puts "Artist — Album" into the artist field and leaves the album empty.
			return [ordered]@{ title = $p.Title; artist = $p.Artist; status = [string]$s.GetPlaybackInfo().PlaybackStatus }
		}
	} catch { }
	return $null
}

function Invoke-FavoriteCurrent {
	# The now-playing bar (TransportBar > LCD) has a Button named 'Favorite' with no AutomationId.
	$win = Get-AppleMusicWindow
	if (-not $win) { throw 'Apple Music is not running.' }
	$lcd = Find-ById $win 'LCD'
	if (-not $lcd) { throw 'The now-playing bar was not found.' }
	$cond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
	$button = $null
	foreach ($b in $lcd.FindAll($TreeScope::Children, $cond)) {
		if ($b.Current.Name -like 'Favorite*' -or $b.Current.Name -like '*Favorite') { $button = $b; break }
	}
	if (-not $button) { throw 'No Favorite button in the now-playing bar.' }
	$before = $button.Current.Name
	$previousForeground = [AmBridge.Win32]::GetForegroundWindow()
	try { (Get-Pattern $button ([System.Windows.Automation.InvokePattern]::Pattern)).Invoke() }
	finally { Restore-Foreground $previousForeground }
	Start-Sleep -Milliseconds 300
	return [ordered]@{ before = $before; after = $button.Current.Name }
}

# ---------------------------------------------------------------------------------------------
# Library location and artwork thumbnails
# ---------------------------------------------------------------------------------------------
function Get-LibraryInfo {
	# The app keeps its library at <My Music>\Apple Music\Apple Music Library.musiclibrary and has no
	# readable setting for it. As a second guess, the one-time iTunes migration log records it.
	$music = [Environment]::GetFolderPath('MyMusic')
	$candidates = New-Object System.Collections.ArrayList
	$null = $candidates.Add((Join-Path $music 'Apple Music\Apple Music Library.musiclibrary'))
	$logDir = Join-Path $env:LOCALAPPDATA 'Packages\AppleInc.AppleMusicWin_nzyj5cx40ttqa\LocalCache\Roaming\Apple\AMPLibraryAgent\com.apple.AMPLibraryAgent\iTunes Migration'
	if (Test-Path -LiteralPath $logDir) {
		$logs = Get-ChildItem -LiteralPath $logDir -Filter '*.txt' | Sort-Object LastWriteTime -Descending
		foreach ($log in $logs) {
			$m = Select-String -LiteralPath $log.FullName -Pattern 'Location:\s*(.+\.musiclibrary)' | Select-Object -First 1
			if ($m) { $null = $candidates.Add($m.Matches[0].Groups[1].Value.Trim()); break }
		}
	}
	$existing = @($candidates | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'artwork.sqlite') } | Select-Object -Unique)
	return [ordered]@{ myMusic = $music; candidates = $candidates.ToArray(); existing = $existing }
}

function New-Thumbnails($items, [int]$size) {
	$done = 0
	foreach ($it in $items) {
		try {
			if (Test-Path -LiteralPath $it.dst) { $done++; continue }
			$dir = Split-Path -Parent $it.dst
			if (-not (Test-Path -LiteralPath $dir)) { $null = New-Item -ItemType Directory -Force -Path $dir }
			$src = [System.Drawing.Image]::FromFile($it.src)
			try {
				$bmp = New-Object System.Drawing.Bitmap($size, $size)
				$g = [System.Drawing.Graphics]::FromImage($bmp)
				$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
				$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
				$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
				$g.DrawImage($src, 0, 0, $size, $size)
				$g.Dispose()
				$bmp.Save($it.dst, [System.Drawing.Imaging.ImageFormat]::Png)
				$bmp.Dispose()
				$done++
			} finally { $src.Dispose() }
		} catch { }
	}
	return [ordered]@{ written = $done }
}

# ---------------------------------------------------------------------------------------------
# Request loop
# ---------------------------------------------------------------------------------------------
function Send($obj) {
	[Console]::Out.WriteLine((ConvertTo-Json -InputObject $obj -Compress -Depth 6))
	[Console]::Out.Flush()
}

Send ([ordered]@{ id = 0; ok = $true; result = 'ready' })

while ($true) {
	$line = [Console]::In.ReadLine()
	if ($null -eq $line) { break }
	if ($line.Trim() -eq '') { continue }
	$id = $null
	try {
		$req = ConvertFrom-Json $line
		$id = $req.id
		$a = $req.args
		$result = switch ($req.cmd) {
			'ping' { 'pong' }
			'listPlaylists' {
				# Expanding sidebar folders can bring a visible Apple Music window to the front, like Select does.
				$fg = [AmBridge.Win32]::GetForegroundWindow()
				try { , (Get-SidebarPlaylists) } finally { Restore-Foreground $fg }
			}
			'play' { Invoke-PlayPlaylist ([string]$a.aid) ([bool]$a.shuffle) }
			'libraryInfo' { Get-LibraryInfo }
			'thumbnails' { New-Thumbnails $a.items ([int]$a.size) }
			'nowPlaying' { Get-NowPlaying }
			'favorite' { Invoke-FavoriteCurrent }
			default { throw "Unknown command: $($req.cmd)" }
		}
		Send ([ordered]@{ id = $id; ok = $true; result = $result })
	} catch {
		Send ([ordered]@{ id = $id; ok = $false; error = $_.Exception.Message })
	}
}
