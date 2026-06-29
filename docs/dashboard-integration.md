# Portal Dashboard Integration

Portal dashboards can be opened directly from internal web applications or embedded in an iframe/web part.

## Dashboard URLs

Use the dashboard link page for copy-ready URLs and iframe snippets:

```text
http://10.40.68.23:5173/dashboard_links
```

Current dashboard routes:

```text
http://10.40.68.23:5173/dashboard_critical_team
http://10.40.68.23:5173/dashboard_critical_asset_tracking
http://10.40.68.23:5173/dashboard_gis_critical_asset_facility
http://10.40.68.23:5173/dashboard_gis_critical_asset_history
```

For iframe embedding, append `?embed=1`:

```html
<iframe
  src="http://10.40.68.23:5173/dashboard_gis_critical_asset_facility?embed=1"
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
