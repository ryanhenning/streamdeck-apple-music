import { action, KeyAction, KeyDownEvent, SingletonAction, streamDeck, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";
import { appleMusicApp } from "../services/apple-music-app";
import { truncate } from "./playlist-dial-helpers";

export type FavoriteActionSettings = JsonObject;

/** How often the key refreshes the current song title, in ms. */
const POLL_MS = 3_000;

/**
 * Key that favorites the song Apple Music is playing, by pressing the Favorite button in the app's
 * now-playing bar. Shows the current title, read from Windows media controls.
 */
@action({ UUID: "com.ryan-henning.streamdeck-apple-music.favorite" })
export class FavoriteTrackAction extends SingletonAction<FavoriteActionSettings> {
	private keys = new Map<string, KeyAction<FavoriteActionSettings>>();
	private timer: NodeJS.Timeout | null = null;
	private lastTitle: string | null = null;
	private flashUntil = 0;

	override async onWillAppear(ev: WillAppearEvent<FavoriteActionSettings>): Promise<void> {
		if (!ev.action.isKey()) return;
		this.keys.set(ev.action.id, ev.action);
		await ev.action.setTitle(this.titleText());
		this.timer ??= setInterval(() => void this.refresh(), POLL_MS);
		void this.refresh();
	}

	override async onWillDisappear(ev: WillDisappearEvent<FavoriteActionSettings>): Promise<void> {
		this.keys.delete(ev.action.id);
		if (this.keys.size === 0 && this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	override async onKeyDown(ev: KeyDownEvent<FavoriteActionSettings>): Promise<void> {
		try {
			const result = await appleMusicApp.favoriteCurrent();
			streamDeck.logger.info(`Favorite pressed for "${this.lastTitle}" (button "${result.before}" → "${result.after}")`);
			await ev.action.showOk();
			this.flashUntil = Date.now() + 2_000;
			await ev.action.setTitle("Loved! ♥");
			setTimeout(() => void this.renderAll(), 2_000);
		} catch (err) {
			streamDeck.logger.error(`Could not favorite: ${(err as Error).message}`);
			await ev.action.showAlert();
		}
	}

	private async refresh(): Promise<void> {
		try {
			const now = await appleMusicApp.nowPlaying();
			const title = now?.title || null;
			if (title === this.lastTitle) return;
			this.lastTitle = title;
			await this.renderAll();
		} catch {
			// The bridge may be busy or Apple Music closed; try again on the next tick.
		}
	}

	private async renderAll(): Promise<void> {
		if (Date.now() < this.flashUntil) return;
		const text = this.titleText();
		await Promise.all([...this.keys.values()].map((k) => k.setTitle(text)));
	}

	private titleText(): string {
		return this.lastTitle ? `♥\n${truncate(this.lastTitle, 16)}` : "♥ Favorite";
	}
}
