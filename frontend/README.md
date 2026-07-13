# Portal Frontend

React + Vite frontend for Portal dashboards.

## Layout

```text
src/
  main.tsx
  dashboards/
    critical-team/      # Current Critical Team dashboard app, API, types, styles
    critical-assets/    # Legacy Critical Asset data/API helpers
  components/ui/        # shadcn/ui components
  lib/                  # Shared frontend utilities
```

Add future dashboards as sibling folders under `src/dashboards`.

## Scripts

```powershell
pnpm dev
pnpm exec tsc -b
pnpm ingest:critical-team
```

Critical Team dashboard route:

```text
http://10.40.68.23:5173/dashboard_critical_team_overview
```

Use `pnpm exec tsc -b` for a compile check when you want to keep only one `index.html`; `pnpm build` creates `dist/index.html` as a generated build artifact.
