# Development Workflow & CLI Standards

## Environment Setup

- **Runtime**: Node.js Version 24 or higher (managed via `nvm` or `nvm-windows`).
- **Stream Deck Application**: Version 7.1 or higher.
- **CLI Tooling**: Official Elgato CLI globally installed (`@elgato/cli@latest`).

## Project Commands

- **Scaffolding**: Run `streamdeck create` inside an initialized repository to generate default manifests, bins, and source structures.
- **Live Development**: Run `npm run watch` to compile changes in real-time and reload the plugin inside the desktop Stream Deck app.

## Property Inspector UI

- Configured via `PropertyInspectorPath` in `manifest.json`.
- Utilizes native Elgato UI components (`sdpi-components.js`) for seamless styling consistency inside configuration panels.
