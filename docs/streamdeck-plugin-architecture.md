# Stream Deck+ Plugin Architecture & Design Context

## Overview

This repository contains a custom Stream Deck+ plugin designed to interface with local applications (such as Apple Music on Windows) using the official Elgato SDK and WebSocket protocols.

## Hardware & Layout Specifications

- **Controllers Supported**: `Keypad` and `Encoder`.
- **Touch Strip Dimensions**: 4 independent segments, each strictly **200 × 100 px** (800 × 100 px total width across all 4 dials).
- **Layout Management**: Custom JSON layouts (`layouts/apple-music-dial.json`) defined in the root directory and parsed by the Stream Deck core. Items include `text`, `pixmap`, and `bar` components tracked via unique string keys.

## Core Event Lifecycle

- **`willAppear`**: Initializes the action instance, assigns dynamic layout templates (`setFeedbackLayout`), and triggers initial display rendering.
- **`dialRotate`**: Receives tick events (`payload.ticks`) indicating positive (clockwise) or negative (counter-clockwise) rotation speed and direction. Used for smooth list scrolling and pagination.
- **`dialPress` / `onDialDown`**: Detects physical pushes (`payload.pressed`) to trigger actions or selections (e.g., playing a chosen media item).
- **`touchTap`**: Handles direct LCD touch events and hold states (`payload.hold`) to switch modes or reset selections.
- **`setFeedback`**: Pushes real-time text, status indicators, and asset updates dynamically to individual touch strip zones.
