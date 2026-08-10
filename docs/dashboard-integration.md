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

## Resource Thumbnail Design

Portal resource thumbnails are stable, branded cover illustrations that communicate
the resource's purpose at card size. They are not required to reproduce the live
resource page. AI-assisted image generation may be used during design, but every
image must be reviewed, approved, stored with the application, and published as a
normal static asset. Portal must never generate thumbnail images at runtime.

This approach replaces full-page screenshots because interface text and controls
are generally unreadable at thumbnail size, screenshots become stale when layouts
change, and visually similar resources are difficult to distinguish from one
another.

### Visual Standard

- Use a `1600x630` PNG canvas, matching the current Portal card preview ratio.
- Use a clean technical or restrained isometric illustration style rather than a
  photorealistic or decorative stock-image style.
- Use the Portal visual language: navy, storm-water blue, teal, off-white, and
  restrained orange accents.
- Give each image one clear focal subject and enough negative space to remain
  recognizable when scaled down.
- Keep important content inside a minimum 48-pixel safe area on every edge.
- Do not include generated words, labels, numbers, application controls, City or
  department logos, watermarks, or a duplicate resource title inside the image.
  The resource card supplies the title, type, accessible name, and actions.
- Do not include personal information, operationally sensitive information, or
  imagery that could be mistaken for an authoritative inspection result, risk
  boundary, engineering plan, or geographic record.
- Provide coordinated light and dark versions. Both versions must retain the same
  subject, composition, and identity; only palette, lighting, and contrast should
  change.
- Add resource-type badges and icons through the Portal interface rather than
  baking them into the generated bitmap so that they remain sharp and accessible.

### Resource Visual Vocabulary

| Resource purpose | Recommended visual subject |
| --- | --- |
| Asset Inspection Forms | Storm-water pipe, inspection clipboard or form, and a shield/check element |
| CCTV Review | Pipe interior, inspection camera, and a reviewed defect marker |
| Dashboards | Storm-water infrastructure combined with a simplified analytical chart motif |
| Data tables | Organized inspection records or grid structure with a clear data-flow motif |
| Work orders | Pipe asset, maintenance activity, and a work-order document |
| Risk maps | Abstract storm-water network, map geometry, and non-authoritative risk zones |
| Reports | Inspection or analytical document with a restrained chart or review motif |

Illustrations must express the business function without depicting fictional UI
screens, unreadable charts, or fake geographic detail. Two resources may share the
same visual family, but each resource must have a distinct composition or focal
subject.

### Resource Ownership and Metadata

- Every active card resource owns an explicit light thumbnail and dark thumbnail.
- Thumbnail selection must be declared by resource metadata. Portal must not infer
  a thumbnail from words in the resource key and must not use another resource's
  image as a fallback.
- Use predictable repository names:
  `ui/src/assets/portal-thumbnails/<resource-key-kebab-case>.png` and
  `ui/src/assets/portal-thumbnails/<resource-key-kebab-case>-dark.png`.
- A missing resource thumbnail may temporarily use a neutral illustration for its
  resource type, clearly distinct from every real resource cover. It must not use
  an unrelated resource screenshot.
- Resource publication should validate both files, exact dimensions, supported
  format, and successful loading before the resource is released.
- A future Portal Manager thumbnail editor should allow an administrator to upload,
  preview, replace, and validate the two assets without editing frontend source.
  The published files remain static release assets rather than database BLOBs or
  dynamically generated images.

### Review and Migration

The initial style approval set consists of:

1. Asset Inspection Forms;
2. Proactive Team CCTV Review; and
3. Critical Team Dashboards.

Review these three at their actual Portal card size in both themes before applying
the style to the remaining catalog. Approval must check recognizability, contrast,
consistent composition, absence of generated text or artifacts, and clear
distinction between resources.

Existing screenshot thumbnails remain in place until the corresponding replacement
has been approved. Replace them resource by resource; do not remove the complete
legacy set in one operation. Raw AI generations, rejected variants, and temporary
working files must not be included in the production UI bundle.

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
