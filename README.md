# OSM → Minecraft Editor

A browser-based editor for converting OpenStreetMap data into Minecraft-ready layouts. Upload any `.osm` file, tag buildings, paint ground cover, preview in 3D, then export a patched `.osm` for use with [Arnis](https://github.com/louis-e/arnis).

**Live:** https://komixkat.github.io/osm-editor

---

## Getting Started

1. Go to [openstreetmap.org](https://openstreetmap.org), navigate to your area
2. Click **Share → Format: OSM XML → Download**
3. Drag the `.osm` file onto the editor, or click **Upload .osm**

---

## Features

| Feature | Description |
|---|---|
| **2D editor** | Pan (Alt+drag or middle-click), zoom (scroll). Click buildings to select and edit. |
| **Building editor** | Set name, floor count, height, type, overhang flag, notes. All changes baked into export. |
| **Paint tools** | Draw grass, sports pitch, water, trees, roads, paths, sidewalks, terrain markers as polygons. |
| **3D preview** | Buildings extruded by floor count. Fly camera (WASD) or orbit. Toggleable grids and axes. |
| **Session save** | Auto-saves to localStorage. Export/import session JSON. Re-upload OSM + session to restore. |
| **Export** | Patched `.osm` with all edits as OSM tags, ready for Arnis. |

---

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `S` | Select tool |
| `G` | Grass paint |
| `P` | Sports pitch paint |
| `W` | Water paint |
| `T` | Place tree |
| `R` | Draw road |
| `F` | Draw path/footway |
| `X` | Delete tool |
| `Tab` | Toggle 2D / 3D |
| `Enter` or double-click | Finish polygon/polyline |
| `Esc` | Cancel drawing |
| `Ctrl+Z` | Undo |
| `Ctrl+Y` | Redo |
| `Alt+drag` | Pan in 2D view |
| `Scroll` | Zoom in/out |
| **In 3D fly mode:** | |
| Click canvas | Capture mouse |
| `WASD` | Move |
| `Space / Shift` | Up / Down |
| `Shift` (held) | Fast move |
| `Esc` | Release mouse |

---

## Architecture

Pure static files — no build step, no npm. ES modules loaded directly by the browser.

```
osm-editor/
├── index.html          Shell only — no inline logic
├── css/style.css       All styles
├── src/
│   ├── state.js        AppState + EventBus + undo/redo
│   ├── parser.js       OSM XML parser + patched OSM export
│   ├── renderer2d.js   Canvas 2D — pan/zoom, hit testing, drawing
│   ├── renderer3d.js   Three.js — loaded lazily when 3D is first opened
│   ├── tools.js        All drawing and selection tools
│   ├── ui.js           Sidebar panels, toolbar, DOM rendering
│   ├── session.js      localStorage auto-save + JSON export/import
│   └── main.js         Entry point — wires modules, file loading
└── .github/
    └── workflows/
        └── deploy.yml  GitHub Pages deployment
```

**Three.js loads lazily** — the 2D editor works fully offline. Three.js (r128) is fetched from cdnjs only when you first click "3D View".

---

## Deploying (GitHub Pages)

1. Fork or push to GitHub
2. Go to **Settings → Pages → Source → GitHub Actions**
3. Push to `main` — the included workflow deploys automatically

---

## Export & Arnis

Click **Export → Patched .osm** to download the OSM file with your edits embedded as standard OSM tags (`name`, `building:levels`, `building:height`, `building:material`, `building:colour`, etc.).

Feed the exported `.osm` directly to Arnis:
```
arnis --file your_export.osm --scale 3
```

The scale selector in the editor (1×–5×) sets blocks per real metre. Default 3× recommended.

---

## License

MIT
