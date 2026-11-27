import {
	action,
	DialAction,
	DialDownEvent,
	DialRotateEvent,
	SingletonAction,
	TouchTapEvent,
	WillAppearEvent,
	streamDeck
} from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";
import { appleMusicApp, AppPlaylist } from "../services/apple-music-app";
import { truncate, wrapIndex } from "./playlist-dial-helpers";

export type PlaylistDialSettings = JsonObject & {
	/** Name of the playlist last shown, so the dial comes back to it. */
	currentName?: string;
};

/**
 * Stream Deck+ dial that browses the playlists in the Apple Music app's sidebar.
 * - Rotate: scroll through playlists (cover art + name on the touch strip)
 * - Push: play the shown playlist in order
 * - Tap the touch strip: shuffle the shown playlist
 * - Hold the touch strip: reload the playlist list from the app
 */
@action({ UUID: "com.ryan-henning.streamdeck-apple-music.playlist-dial" })
export class PlaylistDialAction extends SingletonAction<PlaylistDialSettings> {
	private playlists: AppPlaylist[] = [];
	private currentIndex = 0;
	private loading: Promise<void> | null = null;
	private busy = false;

	override async onWillAppear(ev: WillAppearEvent<PlaylistDialSettings>): Promise<void> {
		if (!ev.action.isDial()) return;
		await ev.action.setFeedbackLayout("layouts/apple-music-dial.json");
		if (this.playlists.length > 0) {
			await this.render(ev.action);
			return;
		}
		await this.load(ev.action, ev.payload.settings.currentName);
	}

	override async onDialRotate(ev: DialRotateEvent<PlaylistDialSettings>): Promise<void> {
		if (this.playlists.length === 0) {
			await this.load(ev.action);
			return;
		}
		this.currentIndex = wrapIndex(this.currentIndex + ev.payload.ticks, this.playlists.length);
		await this.render(ev.action);
		await ev.action.setSettings({ ...ev.payload.settings, currentName: this.playlists[this.currentIndex].name });
	}

	override async onDialDown(ev: DialDownEvent<PlaylistDialSettings>): Promise<void> {
		await this.playCurrent(ev.action, false);
	}

	override async onTouchTap(ev: TouchTapEvent<PlaylistDialSettings>): Promise<void> {
		if (ev.payload.hold) {
			await this.load(ev.action, this.playlists[this.currentIndex]?.name);
			return;
		}
		await this.playCurrent(ev.action, true);
	}

	private async playCurrent(dial: DialAction<PlaylistDialSettings>, shuffle: boolean): Promise<void> {
		if (this.playlists.length === 0) {
			await this.load(dial);
			return;
		}
		if (this.busy) return;
		const selected = this.playlists[this.currentIndex];
		this.busy = true;
		try {
			await dial.setFeedback({ subtitle: shuffle ? "Shuffling…" : "Starting…" });
			const status = await appleMusicApp.play(selected, shuffle);
			streamDeck.logger.info(`Played "${selected.name}" (shuffle=${shuffle}), status=${status}`);
			await dial.setFeedback({ subtitle: status === "Playing" ? (shuffle ? "Shuffling" : "Playing") : "Check Apple Music" });
		} catch (err) {
			streamDeck.logger.error(`Could not play "${selected.name}": ${(err as Error).message}`);
			await dial.showAlert();
			await dial.setFeedback({ subtitle: "Couldn't play" });
		} finally {
			this.busy = false;
		}
	}

	private load(dial: DialAction<PlaylistDialSettings>, keepName?: string): Promise<void> {
		this.loading ??= (async () => {
			await dial.setFeedback({ title: "Apple Music", subtitle: "Loading playlists…", counter: "", art: "" });
			try {
				this.playlists = await appleMusicApp.getPlaylists();
				const keep = keepName ? this.playlists.findIndex((p) => p.name === keepName) : -1;
				this.currentIndex = keep >= 0 ? keep : wrapIndex(this.currentIndex, this.playlists.length);
				if (this.playlists.length === 0) {
					await dial.setFeedback({ title: "No playlists", subtitle: "Hold strip to retry", counter: "" });
					return;
				}
				await this.render(dial);
			} catch (err) {
				streamDeck.logger.error(`Could not load playlists: ${(err as Error).message}`);
				await dial.setFeedback({ title: "Apple Music", subtitle: "Not reachable", counter: "Hold to retry" });
			}
		})().finally(() => {
			this.loading = null;
		});
		return this.loading;
	}

	private async render(dial: DialAction<PlaylistDialSettings>): Promise<void> {
		const current = this.playlists[this.currentIndex];
		if (!current) return;
		await dial.setFeedback({
			art: current.artwork ?? "",
			title: truncate(current.name, 14),
			subtitle: "Push: play · Tap: shuffle",
			counter: `${this.currentIndex + 1} / ${this.playlists.length}`
		});
	}
}
