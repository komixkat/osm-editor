# OSM → Minecraft Editor

A browser-based editor for OpenStreetMap files, designed for previewing and editing OSM data before converting to Minecraft worlds via [Arnis](https://github.com/louis-e/arnis).

## Features

- **Upload any `.osm` file** — exported from openstreetmap.org
- **2D editor** — pan/zoom canvas, click buildings to edit properties
- **3D preview** — buildings extruded by floor count, free-fly camera (Minecraft-style WASD) + orbit mode
- **Edit buildings** — set name, floor count, height, type, overhang flag
- **Paint ground** — grass, sports pitches, water bodies
- **Place trees** — oak, bamboo, palm, pine with configurable cluster radius
- **Draw routes** — roads, footpaths, cycleways, sidewalks
- **Terrain markers** — stairs, slopes, cliffs, raised platforms
- **Export patched OSM** — edits baked back into `.osm` for Arnis
- **Session persistence** — auto-saves to localStorage, manual JSON export/import
- **Scale selector** — 1×–5× (blocks per real metre)

## Usage

### Host on GitHub Pages

1. Fork or clone this repo
2. Push to GitHub
3. Enable GitHub Pages: Settings → Pages → Source: main branch / root
4. Visit `https://yourusername.github.io/osm-editor/`

### Run locally

Just open `index.html` in any modern browser. No build step, no npm.

For local development with proper module loading, serve with any static server:
```bash
python3 -m http.server 8080
# then open http://localhost:8080
```

Note: ES modules require a server (not `file://`) due to CORS.

## File Structure

```
osm-editor/
├── index.html          — Shell HTML, no logic
├── css/
│   └── style.css       — All styles
└── src/
    ├── main.js         — Entry point, wires modules together
    ├── state.js        — Central state + EventBus
    ├── parser.js       — OSM XML parser + export
    ├── renderer2d.js   — Canvas 2D renderer with viewport culling
    ├── renderer3d.js   — Three.js 3D renderer
    ├── tools.js        — Tool controller (select, paint, draw, delete)
    ├── ui.js           — Sidebar, panels, toolbar
    └── session.js      — localStorage + JSON save/load
```

## Architecture

All modules communicate through the **EventBus** in `state.js`. No module imports another module directly (except `state.js`). This makes each module independently testable and prevents circular dependencies.

```
user action
  → tools.js (interprets gesture)
    → state.js (mutates AppState, emits event)
      → renderer2d.js (redraws on REDRAW_2D)
      → renderer3d.js (rebuilds on REBUILD_3D)
      → ui.js (updates panel on FEATURE_SELECTED etc)
      → session.js (auto-saves on FEATURE_UPDATED etc)
```

## Performance for Large Files

- **Viewport culling**: 2D renderer only draws features visible in current viewport
- **AABB pre-check**: polygon hit test only runs after bounding-box check passes
- **Two-pass parsing**: nodes collected first, ways resolved in second pass — no repeated DOM queries
- **Lazy 3D rebuild**: 3D scene only rebuilt when switching to 3D view or after edits

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| S | Select tool |
| G | Grass paint |
| P | Pitch paint |
| W | Water paint |
| T | Place tree |
| R | Draw road |
| F | Draw footpath |
| X | Delete tool |
| Enter / dblclick | Finish drawing polygon/line |
| Esc | Cancel drawing |
| Ctrl+Z | Undo |
| Ctrl+Y | Redo |
| Tab | Toggle 2D/3D |
| Alt+drag | Pan (2D) |
| Scroll | Zoom (2D) |
| WASD | Fly camera (3D, after click) |
| Space/Shift | Fly up/down (3D) |
| Shift | Fast fly |
| Ctrl | Slow fly |

## Scale

The scale multiplier controls how many Minecraft blocks represent one real metre:
- **1×** — 1 block = 1m (accurate but too coarse for interior detail)
- **3×** — 1 block = 0.33m (recommended — corridors ~8 blocks, rooms ~12×9)
- **5×** — 1 block = 0.2m (very detailed but large world)

Set scale in the View tab. This adjusts the block grid overlay and scale indicator.
