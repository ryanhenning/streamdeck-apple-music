import {
	action,
	KeyDownEvent,
	SingletonAction,
	streamDeck,
	WillAppearEvent,
	WillDisappearEvent
} from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";
import { appleMusic } from "../services/apple-music";
import { smtcService, type SmtcTrackInfo } from "../services/smtc";

export type FavoriteActionSettings = JsonObject & {
	userToken?: string;
	developerToken?: string;
};

@action({ UUID: "com.ryan-henning.streamdeck-apple-music.favorite" })
export class FavoriteTrackAction extends SingletonAction<FavoriteActionSettings> {
	private unregisterSmtc: (() => void) | null = null;
	private activeTrack: SmtcTrackInfo | null = null;

	override async onWillAppear(ev: WillAppearEvent<FavoriteActionSettings>): Promise<void> {
		this.unregisterSmtc = smtcService.addChangeListener((track) => {
			this.activeTrack = track;
			if (!ev.action.isKey()) return;
			if (track?.title) {
				const shortTitle = track.title.length > 18 ? track.title.slice(0, 15) + "..." : track.title;
				void ev.action.setTitle(`♥\n${shortTitle}`);
			} else {
				void ev.action.setTitle("♥ Favorite");
			}
		});
	}

	override async onWillDisappear(_ev: WillDisappearEvent<FavoriteActionSettings>): Promise<void> {
		if (this.unregisterSmtc) {
			this.unregisterSmtc();
			this.unregisterSmtc = null;
		}
	}

	override async onKeyDown(ev: KeyDownEvent<FavoriteActionSettings>): Promise<void> {
		if (ev.payload.settings.developerToken || ev.payload.settings.userToken) {
			appleMusic.setTokens({
				developerToken: ev.payload.settings.developerToken,
				userToken: ev.payload.settings.userToken
			});
		}

		const track = this.activeTrack || smtcService.getCurrentTrack();
		if (!track || !track.title) {
			streamDeck.logger.warn("No active track detected from Windows SMTC to favorite.");
			await ev.action.showAlert();
			return;
		}

		try {
			await ev.action.setTitle("Loving...");
			// Query Apple Music catalog for matching song ID by title & artist
			const searchTerm = track.artist ? `${track.title} ${track.artist}` : track.title;
			streamDeck.logger.info(`Searching Apple Music catalog for: "${searchTerm}"`);

			const match = await appleMusic.searchSong(searchTerm);
			if (!match?.id) {
				streamDeck.logger.warn(`Could not find song match for: ${searchTerm}`);
				await ev.action.showAlert();
				await ev.action.setTitle("Not Found");
				return;
			}

			streamDeck.logger.info(`Favoriting song ID ${match.id} (${match.name} - ${match.artistName})`);
			const success = await appleMusic.favoriteTrack(match.id);

			if (success) {
				await ev.action.showOk();
				await ev.action.setTitle("Loved! ♥");
			} else {
				await ev.action.showAlert();
				await ev.action.setTitle("Failed");
			}

			// Restore track title after 2 seconds
			setTimeout(() => {
				const current = this.activeTrack || smtcService.getCurrentTrack();
				if (current?.title) {
					const shortTitle = current.title.length > 18 ? current.title.slice(0, 15) + "..." : current.title;
					void ev.action.setTitle(`♥\n${shortTitle}`);
				} else {
					void ev.action.setTitle("♥ Favorite");
				}
			}, 2000);
		} catch (err) {
			streamDeck.logger.error("Failed to favorite track: " + (err as Error).message);
			await ev.action.showAlert();
			await ev.action.setTitle("Error");
		}
	}
}

