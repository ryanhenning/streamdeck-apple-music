import streamDeck from "@elgato/streamdeck";
import { FavoriteTrackAction } from "./actions/favorite-track";
import { PlaylistDialAction } from "./actions/playlist-dial";
import { appleMusicApp } from "./services/apple-music-app";

// "trace" would also log every message from Stream Deck, including settings; keep it for local debugging only.
streamDeck.logger.setLevel("info");

type GlobalSettings = { libraryPath?: string };

// Optional override for where the Apple Music library (and its artwork cache) lives.
streamDeck.settings.onDidReceiveGlobalSettings((ev) => {
	appleMusicApp.setLibraryPath((ev.settings as GlobalSettings).libraryPath);
});
streamDeck.settings
	.getGlobalSettings<GlobalSettings>()
	.then((settings) => appleMusicApp.setLibraryPath(settings?.libraryPath))
	.catch((err) => streamDeck.logger.warn(`Could not load global settings on startup: ${err}`));

streamDeck.actions.registerAction(new PlaylistDialAction());
streamDeck.actions.registerAction(new FavoriteTrackAction());

streamDeck.connect();
