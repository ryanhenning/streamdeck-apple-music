import {
	action,
	DialRotateEvent,
	DialDownEvent,
	TouchTapEvent,
	SingletonAction,
	WillAppearEvent,
	streamDeck
} from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";
import { ChildProcess, exec, execFile } from "node:child_process";
import { appleMusic, PlaylistSummary } from "../services/apple-music";

export type PlaylistDialSettings = JsonObject & {
	developerToken?: string;
	userToken?: string;
	currentIndex?: number;
};

@action({ UUID: "com.ryan-henning.streamdeck-apple-music.playlist-dial" })
export class PlaylistDialAction extends SingletonAction<PlaylistDialSettings> {
	private playlists: PlaylistSummary[] = [];
	private currentIndex = 0;
	private pendingPlayTimer: NodeJS.Timeout | null = null;
	private playProcess: ChildProcess | null = null;

	override async onWillAppear(ev: WillAppearEvent<PlaylistDialSettings>): Promise<void> {
		if (ev.payload.settings.developerToken || ev.payload.settings.userToken) {
			appleMusic.setTokens({
				developerToken: ev.payload.settings.developerToken,
				userToken: ev.payload.settings.userToken
			});
		}

		if (typeof ev.payload.settings.currentIndex === "number") {
			this.currentIndex = ev.payload.settings.currentIndex;
		}

		if (ev.action.isDial()) {
			await ev.action.setFeedbackLayout("layouts/apple-music-dial.json");
			await this.loadAndRender(ev.action);
		}
	}

	override async onDialRotate(ev: DialRotateEvent<PlaylistDialSettings>): Promise<void> {
		if (this.playlists.length === 0) {
			await this.loadAndRender(ev.action);
			return;
		}

		const ticks = ev.payload.ticks;
		this.currentIndex = (this.currentIndex + ticks) % this.playlists.length;
		if (this.currentIndex < 0) {
			this.currentIndex += this.playlists.length;
		}

		await ev.action.setSettings({
			...ev.payload.settings,
			currentIndex: this.currentIndex
		});

		await this.renderCurrent(ev.action);
	}

	override async onDialDown(ev: DialDownEvent<PlaylistDialSettings>): Promise<void> {
		if (this.playlists.length === 0) {
			await this.loadAndRender(ev.action);
			return;
		}

		const selected = this.playlists[this.currentIndex];
		if (!selected?.playUrl) return;
		const dial = ev.action.isDial() ? ev.action : null;

		// Only music:// links open inside the Apple Music app. Playlists without a
		// catalog globalId fall back to an https:// library link that opens in the
		// browser, so clicking "Play" in the app would play whatever page it's on.
		if (!selected.playUrl.startsWith("music://")) {
			streamDeck.logger.warn(`Playlist "${selected.name}" has no catalog ID; can't open it in the Apple Music app`);
			await ev.action.showAlert();
			await dial?.setFeedback({ title: "Can't open", subtitle: selected.name });
			return;
		}

		// Cancel any earlier press that's still waiting/searching, so two scripts
		// can't race each other to click Play.
		this.cancelPendingPlay();

		streamDeck.logger.info(`Opening playlist: ${selected.name} → ${selected.playUrl}`);
		const command = process.platform === "win32"
			? `start "" "${selected.playUrl}"`
			: `xdg-open "${selected.playUrl}"`;
		exec(command);

		await dial?.setFeedback({ title: "Opening...", subtitle: selected.name });

		// Apple Music's music:// URI only navigates to the playlist page — it won't
		// auto-start playback. Use Windows UI Automation to click the page's own
		// "Play" button (the media Play/Pause key only resumes the current queue).
		// The script itself retries until the page has loaded.
		if (process.platform === "win32") {
			this.pendingPlayTimer = setTimeout(() => {
				this.pendingPlayTimer = null;
				this.clickPlaylistPlayButton(selected.name, (ok, message) => {
					void dial?.setFeedback({ title: ok ? "▶ Playing" : message, subtitle: selected.name });
				});
			}, 1500);
		}
	}

	private cancelPendingPlay(): void {
		if (this.pendingPlayTimer) {
			clearTimeout(this.pendingPlayTimer);
			this.pendingPlayTimer = null;
		}
		if (this.playProcess) {
			this.playProcess.kill();
			this.playProcess = null;
		}
	}

	/**
	 * Use Windows UI Automation (via PowerShell) to find the Apple Music window and
	 * invoke the playlist page's "Play" button — but only once the page showing is
	 * the playlist we asked for. Retries for ~12s so a cold app start still works.
	 *
	 * Page check: walk up from the Play button a few levels (its header area) and
	 * look for an element whose Name is the playlist name. Searching the whole
	 * window isn't enough because the sidebar also lists playlist names.
	 * HEADER_DEPTH may need tuning — check the real tree with inspect.exe.
	 *
	 * Script exit codes: 0 = clicked, 2 = window not found, 3 = Play button not
	 * found, 4 = page never matched the playlist, 5 = Invoke failed.
	 */
	private clickPlaylistPlayButton(playlistName: string, onResult: (ok: boolean, message: string) => void): void {
		// Escape for a PowerShell single-quoted string literal.
		const psName = playlistName.replace(/'/g, "''");
		const psScript = `
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$Walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$PlaylistName = '${psName}'
$HEADER_DEPTH = 4

function Get-AppleMusicWindow {
	$proc = Get-Process -Name 'AppleMusic' -ErrorAction SilentlyContinue |
		Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
	if ($proc) { return $AE::FromHandle($proc.MainWindowHandle) }
	$cond = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, 'Apple Music')
	return $AE::RootElement.FindFirst($TS::Children, $cond)
}

function Restore-Window($win) {
	try {
		$wp = $win.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
		if ($wp.Current.WindowVisualState -eq [System.Windows.Automation.WindowVisualState]::Minimized) {
			$wp.SetWindowVisualState([System.Windows.Automation.WindowVisualState]::Normal)
		}
	} catch { }
}

function Test-PlaylistHeader($btn) {
	$nameCond = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $PlaylistName)
	$node = $btn
	for ($d = 0; $d -lt $HEADER_DEPTH; $d++) {
		$node = $Walker.GetParent($node)
		if (-not $node) { return $false }
		if ($node.FindFirst($TS::Descendants, $nameCond)) { return $true }
	}
	return $false
}

$btnCond = New-Object System.Windows.Automation.AndCondition(
	(New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)),
	(New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, 'Play'))
)

$window = $null
$sawButton = $false
for ($i = 0; $i -lt 15; $i++) {
	if (-not $window) {
		$window = Get-AppleMusicWindow
		if ($window) { Restore-Window $window }
	}
	if ($window) {
		$btn = $window.FindFirst($TS::Descendants, $btnCond)
		if ($btn) {
			$sawButton = $true
			if (Test-PlaylistHeader $btn) {
				try {
					$btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
					exit 0
				} catch { exit 5 }
			}
		}
	}
	Start-Sleep -Milliseconds 800
}
if (-not $window) { exit 2 }
if (-not $sawButton) { exit 3 }
exit 4
`;

		const encoded = Buffer.from(psScript, "utf16le").toString("base64");
		const child = execFile("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { windowsHide: true }, (err) => {
			if (this.playProcess === child) this.playProcess = null;
			if (!err) {
				streamDeck.logger.info(`Clicked Play for "${playlistName}" via UI Automation`);
				onResult(true, "Playing");
				return;
			}
			if (err.killed) {
				// Superseded by a newer dial press; that press owns the feedback now.
				streamDeck.logger.debug(`Play-click for "${playlistName}" cancelled`);
				return;
			}
			const messages: Record<number, string> = {
				2: "App not found",
				3: "No Play button",
				4: "Wrong page",
				5: "Click failed"
			};
			const message = (typeof err.code === "number" && messages[err.code]) || "Script error";
			streamDeck.logger.warn(`UI Automation for "${playlistName}": ${message} (${err.message})`);
			onResult(false, message);
		});
		this.playProcess = child;
	}

	/**
	 * Simulate a system-wide VK_MEDIA_PLAY_PAUSE key press via PowerShell
	 * using the Win32 keybd_event API.  Uses -EncodedCommand to avoid
	 * shell-escaping issues.
	 */
	private sendMediaPlayKey(): void {
		const psScript = [
			"Add-Type -MemberDefinition '",
			'[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, uint dwExtraInfo);',
			"' -Name U32 -Namespace W;",
			"[W.U32]::keybd_event(0xB3,0,0,0);",
			"[W.U32]::keybd_event(0xB3,0,2,0)"
		].join("");

		// Encode as UTF-16LE base64 for PowerShell's -EncodedCommand
		const encoded = Buffer.from(psScript, "utf16le").toString("base64");
		exec(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`, (err) => {
			if (err) {
				streamDeck.logger.warn("Failed to send media play key: " + err.message);
			} else {
				streamDeck.logger.info("Sent media Play/Pause key");
			}
		});
	}

	override async onTouchTap(ev: TouchTapEvent<PlaylistDialSettings>): Promise<void> {
		// Tapping the touch strip refreshes the library list
		if (ev.action.isDial()) {
			await ev.action.setFeedback({
				title: "Refreshing...",
				subtitle: "Syncing playlists"
			});
			await this.loadAndRender(ev.action, true);
		}
	}

	private async loadAndRender(actionInstance: any, forceRefresh = false): Promise<void> {
		try {
			this.playlists = await appleMusic.getPlaylists(forceRefresh);
			if (this.playlists.length === 0) {
				await actionInstance.setFeedback({
					title: "No Playlists",
					subtitle: "Check tokens in settings",
					counter: "0 / 0"
				});
				return;
			}

			if (this.currentIndex >= this.playlists.length) {
				this.currentIndex = 0;
			}

			await this.renderCurrent(actionInstance);
		} catch (err) {
			streamDeck.logger.error("Error loading playlists: " + (err as Error).message);
			await actionInstance.setFeedback({
				title: "Auth Error",
				subtitle: "Tap to retry",
				counter: "!"
			});
		}
	}

	private async renderCurrent(actionInstance: any): Promise<void> {
		const current = this.playlists[this.currentIndex];
		if (!current) return;

		await actionInstance.setFeedback({
			title: current.name.length > 20 ? current.name.substring(0, 19) + "…" : current.name,
			subtitle: current.trackCount ? `${current.trackCount} songs` : "Playlist",
			counter: `${this.currentIndex + 1} / ${this.playlists.length}`
		});
	}
}
