# AGENTS.md - Stream Deck+ Plugin Development Context

## Project Overview

This repository contains a custom Stream Deck+ plugin built using Node.js/TypeScript and the official Elgato SDK. Its primary purpose is to act as a local bridge on Windows, allowing you to browse playlists/albums, control playback, and view real-time track metadata directly from your Stream Deck+ hardware without needing to switch monitor inputs from your work machine to your personal PC.

---

## Technical Stack & Environment

- **Runtime**: Node.js v24 or higher (managed via `nvm` or `nvm-windows`).
- **Stream Deck Software**: Version 7.1 or higher.
- **CLI Tooling**: Official Elgato CLI (`@elgato/cli@latest`).
- **Development Environment**: WSL (Windows Subsystem for Linux) for source file management and build workflows, targeting the Windows Stream Deck plugin directory.
- **Target app**: Apple Music for Windows (Microsoft Store, WinUI 3). Windows only. No Apple Music API keys or tokens are used.

---

## Architecture & Integration

- **Apple Music bridge (`com.ryan-henning.streamdeck-apple-music.sdPlugin/scripts/apple-music-bridge.ps1`)**: long-running Windows PowerShell 5.1 process, JSON lines over stdin/stdout. Uses Windows UI Automation on the Apple Music app (sidebar playlist items `IKIND:ePlaylist`, `PlayButtonElement`, `ShuffleButtonElement`, the now-playing bar `LCD` and its `Favorite` button) and Windows media controls (SMTC) for now-playing. Restores the previously focused window after acting.
- **Bridge client (`src/services/apple-music-app.ts`)**: spawns and queues requests to the bridge; attaches playlist covers.
- **Playlist artwork (`src/services/playlist-artwork.ts`)**: maps the playlist PID from the sidebar AutomationId (signed int64) to `item_to_artwork` → `cache_items` in `<library>/artwork.sqlite`, file `<library>/artwork/<artwork_id>_sk<size_kind>.<extension>`. The library is `<My Music>\Apple Music\Apple Music Library.musiclibrary` unless the `libraryPath` global setting overrides it.
- **Playlist dial (`src/actions/playlist-dial.ts`)**: rotate browses, push plays in order, touch tap shuffles, touch hold reloads.
- **Play Station key (`src/actions/play-station.ts`)**: starts "<Name>'s Station" or "Discovery Station" from the Home page's "Stations for You" shelf (GridViewItem tiles matched by their `TitleTextBlock`).
- **Favorite key (`src/actions/favorite-track.ts`)**: shows the current title and presses the app's Favorite button.
- Do not use Apple's web-player tokens (music.apple.com) or scrape them; that breaks Apple's terms.

---

## Common Development Commands

- `npm run watch`: Live watch-sync workflow. Rebuilds on file save with Rollup watcher, dynamically resolves Windows `%APPDATA%` to sync files, and reloads the plugin live via Stream Deck CLI (`streamdeck restart com.ryan-henning.streamdeck-apple-music`).
- `npm run build`: Compiles TypeScript with Rollup into `bin/plugin.js`.
- `npm run build:win`: Compiles TypeScript and deploys to Windows host `%APPDATA%\Elgato\StreamDeck\Plugins\`.
- `npm run deploy`: Fast sync of `.sdPlugin` directory to Windows host without rebuilding (for icons/manifest/layout changes).
- `npm run validate`: Validates `manifest.json` and plugin structure against Elgato's official schemas.
- `npm run pack`: Packages the plugin into a distributable `.streamDeckPlugin` file.
- `npm test`: Runs unit tests with Vitest.

---

## Hardware & Touch Strip Specifications

- **Supported Controllers**: Actions are configured with both `Keypad` and `Encoder` controllers in `manifest.json`.
- **Touch Strip Canvas**: The bottom LCD strip is divided into four independent **200 × 100 px** zones (one per rotary dial).
- **Layout System**: Uses custom JSON layouts (e.g., `layouts/apple-music-dial.json`) defined in the root directory. Visual items (`text`, `pixmap`, `bar`) are targeted dynamically using unique string keys.

---

## Core Event Lifecycle & SDK Handlers

- **`willAppear`**: Initializes the action instance, assigns layout templates via `setFeedbackLayout`, and pushes initial rendering.
- **`dialRotate`**: Listens to tick events (`payload.ticks`) where positive integers represent clockwise rotation and negative integers represent counter-clockwise rotation, driving smooth library list scrolling and pagination.
- **`dialPress` / `onDialDown`**: Detects physical pushes (`payload.pressed`) to trigger selections, play/pause commands, or track activations.
- **`touchTap`**: Handles LCD touch screen taps and hold states (`payload.hold`) to switch browsing modes (e.g., swapping between Playlists and Albums).
- **`setFeedback`**: Pushes dynamic text, indicators, and image assets to individual touch strip segments in real-time.

---

## Property Inspector & UI Configuration

- **Pathing**: Configured via `PropertyInspectorPath` inside `manifest.json`.
- **Components**: Leverages native Elgato UI web components (`sdpi-components.js`) for settings panels.
