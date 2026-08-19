# Storm Water Map Export Templates

## 1. Purpose

The Storm Water Asset Risk Map uses versioned JSON templates to define printable
map composition. A user selects a template before entering a title or setting the
map extent. The template controls visual structure; runtime map information remains
outside the template.

This separation supports consistent Department branding, predictable PDF output,
and future templates without adding hardcoded rendering branches.

## 2. Design principles

- Establish hierarchy through position, size, whitespace, contrast, and line weight.
- Keep the map as the dominant element and reserve only the space required for
  identity, orientation, metadata, and branding.
- Use one sans-serif family and a small, explicit type scale.
- Use uppercase labels only for short metadata headings, never for long values.
- Use a monochrome north arrow with reduced detail so it remains legible at print size.
- Rotate the north arrow with the map bearing and display rotation numerically.
- Snap scale denominators to the nearest 100.
- Treat title, author, generated date, scale, rotation, map extent, and map image as
  runtime values rather than persisted template content.

## 3. Included templates

### 3.1 Engineering Plan Sheet

- US Tabloid, 11 x 17 inches, landscape, 300 DPI.
- Formal right-side title block occupying 8.1 percent of page width.
- Vertical title treatment for a conventional engineering-sheet silhouette.
- Four fixed cells: 22 percent north arrow, 30 percent identity, 28 percent
  metadata, and 20 percent branding.
- Best for engineering review, planning records, and field coordination.

### 3.2 Operations Field Map

- US Letter, landscape, 300 DPI.
- Compact bottom title band occupying 14 percent of page height.
- Horizontal title and short operational metadata for quick scanning.
- Maximizes the map area and prints well on standard office or field printers.
- Best for crews, inspections, meetings, and day-to-day operational use.

### 3.3 Executive Briefing Map

- US Letter, portrait, 300 DPI.
- Bottom title band occupying 17 percent of page height.
- Larger title, restrained supporting text, and lighter borders.
- Best for reports, decision briefings, and stakeholder communication.

## 4. Template selection workflow

1. The export wizard first displays three template cards with a miniature preview,
   name, intended use, page size, and orientation.
2. Selecting a card applies its defaults. The user can still change the title,
   subtitle, page size, orientation, and quality when the template permits it.
3. The fixed print frame is calculated from the effective template and page settings.
4. The review screen renders the same template definition used by the PDF generator.
5. The exported filename includes the sanitized title and generation timestamp.

The last selected template ID may be saved as a user preference. Template files
themselves remain application-managed and read-only in the Desktop package.

## 5. JSON ownership

Template definitions are stored with the map resource:

```text
ui/src/resources/maps/stm-risk-map/map-templates/
```

Each template has a stable ID and `schemaVersion`. The shared JSON Schema validates
the allowed page sizes, layout placements, cell proportions, typography, north-arrow
behavior, metadata rows, branding, and default values.

The following values must never be stored as resolved template data:

- signed-in user name;
- generated date and time;
- current map scale or rotation;
- current map extent or selected features;
- generated map image;
- local or shared filesystem paths.

## 6. Rendering rules

- The preview and PDF renderer must consume the same normalized template object.
- Cell percentages must total 100. Invalid templates fail validation before display.
- Fonts unavailable to the PDF renderer fall back to Arial-compatible Helvetica.
- Text is truncated or wrapped within declared bounds; it never changes cell size.
- The official Department logo preserves its aspect ratio and clear space.
- The north arrow is black and white, uses only the `N` label, and rotates with map
  bearing.
- Page numbering and usage labels share one compact footer line.

## 7. Extension strategy

Future templates are added as new JSON files and registered in a small template
manifest. Existing template IDs are immutable. A material incompatible change uses
a new template ID or schema version, allowing older saved user preferences to fall
back safely to the Engineering Plan Sheet.
