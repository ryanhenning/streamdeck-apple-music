import { action, KeyDownEvent, SingletonAction, streamDeck, WillAppearEvent, DidReceiveSettingsEvent } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";
import { appleMusicApp, StationKind } from "../services/apple-music-app";

export type PlayStationSettings = JsonObject & {
	/** Which station the key starts. Defaults to the personal station. */
	station?: StationKind;
};

const LABELS: Record<StationKind, string> = {
	personal: "My\nStation",
	discovery: "Discovery\nStation"
};

/** Key that starts your personal station or Discovery Station in the Apple Music app. */
@action({ UUID: "com.ryan-henning.streamdeck-apple-music.station" })
export class PlayStationAction extends SingletonAction<PlayStationSettings> {
	private busy = false;

	override async onWillAppear(ev: WillAppearEvent<PlayStationSettings>): Promise<void> {
		if (ev.action.isKey()) await ev.action.setTitle(LABELS[stationOf(ev.payload.settings)]);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<PlayStationSettings>): Promise<void> {
		if (ev.action.isKey()) await ev.action.setTitle(LABELS[stationOf(ev.payload.settings)]);
	}

	override async onKeyDown(ev: KeyDownEvent<PlayStationSettings>): Promise<void> {
		if (this.busy) return;
		const kind = stationOf(ev.payload.settings);
		this.busy = true;
		try {
			const result = await appleMusicApp.playStation(kind);
			streamDeck.logger.info(`Started ${kind} station: "${result.title}" status=${result.status} changed=${result.changed}`);
			if (result.status === "Playing" && result.changed) await ev.action.showOk();
			else await ev.action.showAlert();
		} catch (err) {
			streamDeck.logger.error(`Could not start ${kind} station: ${(err as Error).message}`);
			await ev.action.showAlert();
		} finally {
			this.busy = false;
		}
	}
}

function stationOf(settings: PlayStationSettings): StationKind {
	return settings.station === "discovery" ? "discovery" : "personal";
}
