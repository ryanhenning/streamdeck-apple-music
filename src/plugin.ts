import streamDeck from "@elgato/streamdeck";
import { PlaylistDialAction } from "./actions/playlist-dial";
import { FavoriteTrackAction } from "./actions/favorite-track";
import { appleMusic } from "./services/apple-music";
import { appleMusicApp } from "./services/apple-music-app";

// Enable trace logging during development
streamDeck.logger.setLevel("trace");

// Listen for global settings changes (e.g. from the Property Inspector)
streamDeck.settings.onDidReceiveGlobalSettings((ev) => {
	const settings = ev.settings as { developerToken?: string; userToken?: string; libraryPath?: string };
	appleMusicApp.setLibraryPath(settings.libraryPath);
	if (settings.developerToken || settings.userToken) {
		appleMusic.setTokens({
			developerToken: settings.developerToken,
			userToken: settings.userToken
		});
		streamDeck.logger.info("Updated Apple Music tokens from global settings");
	}
});

// Load existing global settings on startup
streamDeck.settings.getGlobalSettings<{ developerToken?: string; userToken?: string; libraryPath?: string }>().then((settings) => {
	appleMusicApp.setLibraryPath(settings?.libraryPath);
	if (settings?.developerToken || settings?.userToken) {
		appleMusic.setTokens({
			developerToken: settings.developerToken,
			userToken: settings.userToken
		});
		streamDeck.logger.info("Loaded Apple Music tokens from startup global settings");
	}
}).catch((err) => {
	streamDeck.logger.warn(`Could not load global settings on startup: ${err}`);
});

// Register our actions
streamDeck.actions.registerAction(new PlaylistDialAction());
streamDeck.actions.registerAction(new FavoriteTrackAction());

// Connect to Stream Deck
streamDeck.connect();
