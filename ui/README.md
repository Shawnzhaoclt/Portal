# Portal UI

React, TypeScript, and Vite presentation layer for the Portal desktop application.

```text
src/desktop/    Tauri runtime and local-command adapters
src/dashboards/ Dashboard and table views
src/management/ Management UI
src/resources/  Resource pages, assets, and per-resource metadata
```

Run inside Tauri:

```powershell
pnpm desktop:dev
```

Compile and build:

```powershell
pnpm build
```

Resource code calls `src/desktop/request.ts`. It does not fetch Portal data from localhost.
