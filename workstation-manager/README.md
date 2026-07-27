# Portal Workstation Manager

`Portal Workstation Manager` is a standalone React, Rust, and Tauri desktop
application for workstation-side source synchronization. It is independent of the
Portal application and does not host a local web server.

The UI reads status from `sync/sync.settings.json` and the source-sync
run-history file. It starts and stops the trusted Python publication process directly.

## Source Layout

\`\`\`text
workstation-manager/
  config/workstation-manager.settings.json
  sync/                        Python coordinator
  src/                         React UI
  src-tauri/                   Rust/Tauri host
  scripts/build_portable.py
\`\`\`

The configured `syncDirectory` is relative to the configuration file. In this
repository it resolves to `../sync`; in a portable build, the same relative
layout is preserved.

## Development

\`\`\`text
pnpm install
pnpm tauri:dev
\`\`\`

## Portable Build

\`\`\`text
pnpm tauri:build
pnpm portable
\`\`\`

`pnpm portable` always writes to:
`C:\\Users\\105692\\webapps\\Portal\\workstation-manager\\dist\\Portal-Workstation-Manager`.

The client receives the generated portable folder only. Rust, Node.js, and the
development source tree are not required on the client workstation.

## Portal Releases

The **Releases** page publishes Portal desktop updates to the configured shared
release directory. It reads both the Portal portable folder and
`updates.releaseRoot` from the configured Portal settings file; it does not use
hard-coded deployment paths.

Choose the update type explicitly:

- **System database only** replaces only `config\system.db`.
- **Portal executable only** replaces only `Portal.exe`.
- **Full portable folder** publishes the complete ZIP and refreshes the
  first-time installation bundle.

Provide a newer semantic release version such as `0.2.1`. Full releases must
match the `VERSION` file in the Portal portable folder. The manager rejects an
older or duplicate shared-release version.

## Python Sync Worker

This initial manager build controls the existing Python source-sync worker and
therefore expects its configured Python runtime to be available. The manager
itself is independent of Portal and has no local web service. Bundling the
Python runtime with the worker is a separate packaging step, so the same
portable manager can later be deployed without a Conda installation.
