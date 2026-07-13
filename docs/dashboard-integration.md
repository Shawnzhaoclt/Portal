# Portal Dashboard Integration

Portal dashboards can be opened directly from internal web applications or embedded in an iframe/web part.

## Dashboard URLs

Use the dashboard link page for copy-ready URLs and iframe snippets:

```text
http://10.40.68.23:5173/dashboard_links
```

Current dashboard routes:

```text
http://10.40.68.23:5173/dashboard_critical_team_overview
http://10.40.68.23:5173/dashboard_critical_asset_tracking
http://10.40.68.23:5173/map_critical_asset_facility
http://10.40.68.23:5173/map_critical_asset_history
http://10.40.68.23:5173/map_stm_risk
```

For iframe embedding, append `?embed=1`:

```html
<iframe
  src="http://10.40.68.23:5173/map_critical_asset_facility?embed=1"
  width="100%"
  height="900"
  style="border:0;"
  loading="lazy"
  title="Critical Asset Facility"
></iframe>
```

## Programmatic Catalog

Other applications can retrieve dashboard metadata from:

```text
http://10.40.68.23:8000/api/dashboards
```

The response includes each dashboard title, path, direct URL, embed URL, and iframe snippet.

## Thumbnail Capture Rules

Portal resource thumbnails are generated from the live resource page, not from cropped portal cards or edited mockups.

- Capture at the same aspect ratio used by the portal preview frame. The current standard is a `2048x806` browser viewport scaled to a `1600x630` PNG.
- Scale the full screenshot into the thumbnail size. Do not crop or clip the right side. The portal card image uses `object-fit: contain` so the full thumbnail remains visible.
- Use each resource's standalone URL. For dashboard, table, and report resources, append `?embed=1`; append `&theme=dark` or `?theme=dark` for dark thumbnails.
- Dark thumbnails must be captured while the page is actually running in dark mode. Do not recolor a light screenshot.
- Map thumbnails must show the real rendered map and key map controls. Center the relevant geography in the capture; for citywide storm water maps, keep the City of Charlotte centered and confirm upper-right controls and right-side panels are visible.
- Validate each thumbnail before committing: no browser chrome, no loading screen, no error banner, no blank map canvas, no clipped right edge, and no important UI hidden under the portal popup close-button area.
- Remove temporary raw screenshots after the scaled thumbnail is written.

## Configuration

If the public frontend host changes, set:

```text
PORTAL_PUBLIC_FRONTEND_BASE_URL=https://your-portal-host.example.gov
```

If a third-party application needs to call the FastAPI endpoints directly from browser JavaScript, add its origin:

```text
PORTAL_CORS_ORIGINS=https://your-sharepoint-site.sharepoint.com,https://your-portal.example.gov
```

Use a regex only when the allowed origin set is intentionally broad:

```text
PORTAL_CORS_ORIGIN_REGEX=https://.*\.sharepoint\.com
```

Legacy `ARF_*` environment variable names are still accepted, but new configuration should use `PORTAL_*`.

## SharePoint Note

SharePoint Online pages are served over HTTPS. Modern browsers usually block embedded HTTP iframe content on HTTPS pages. For SharePoint Online embedding, publish Portal through HTTPS, such as an internal reverse proxy or gateway certificate.
