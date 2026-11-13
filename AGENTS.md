# AGENTS.md - Stream Deck+ Plugin Development Context

## Project Overview

This repository contains a custom Stream Deck+ plugin built using Node.js/TypeScript and the official Elgato SDK. Its primary purpose is to act as a local bridge on Windows, allowing you to browse playlists/albums, control playback, and view real-time track metadata directly from your Stream Deck+ hardware without needing to switch monitor inputs from your work machine to your personal PC.

---

## Technical Stack & Environment

- **Runtime**: Node.js v24 or higher (managed via `nvm` or `nvm-windows`).
- **Stream Deck Software**: Version 7.1 or higher.
- **CLI Tooling**: Official Elgato CLI (`@elgato/cli@latest`).
- **Development Environment**: WSL (Windows Subsystem for Linux) for source file management and build workflows, targeting the Windows Stream Deck plugin directory.

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
