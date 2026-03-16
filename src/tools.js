/**
 * tools.js — Tool controller
 * Handles all user interactions: select, paint, draw, delete.
 * Communicates exclusively through EventBus and AppState.
 */

import { AppState, EventBus, EV, uid, pushHistory, addUserLayer, deleteUserLayer, updateBuildingEdit, getBuildingEdit, undo, redo } from './state.js';
import { draw, hitTest, unproj, proj } from './renderer2d.js';
import { highlightBuilding, hitTest3D } from './renderer3d.js';

// ─── TOOL DEFINITIONS ─────────────────────────────────────────────────────────
export const TOOLS = {
  select:   { label: '✦ Select',    key: 's', cursor: 'default',    group: 'select' },
  grass:    { label: '⬛ Grass',     key: 'g', cursor: 'crosshair',  group: 'paint'  },
  pitch:    { label: '⬜ Pitch',     key: 'p', cursor: 'crosshair',  group: 'paint'  },
  water:    { label: '◈ Water',     key: 'w', cursor: 'crosshair',  group: 'paint'  },
  tree:     { label: '⬡ Trees',     key: 't', cursor: 'cell',       group: 'place'  },
  road:     { label: '━ Road',      key: 'r', cursor: 'crosshair',  group: 'draw'   },
  path:     { label: '⋯ Path',      key: 'f', cursor: 'crosshair',  group: 'draw'   },
  sidewalk: { label: '▬ Sidewalk',  key: null, cursor: 'crosshair', group: 'draw'   },
  terrain:  { label: '⛰ Terrain',   key: null, cursor: 'crosshair', group: 'draw'   },
  del:      { label: '✕ Delete',    key: 'x', cursor: 'not-allowed', group: 'edit'  },
};

// ─── TOOL OPTIONS (used by UI to render settings panel) ──────────────────────
export const TOOL_OPTIONS = {
  road:     { type: 'secondary', name: '', width: 1 },
  path:     { pathType: 'footway' },
  terrain:  { elevType: 'stairs', elev: 3 },
  tree:     { species: 'oak', radius: 15 },
};

// ─── BIND CANVAS ──────────────────────────────────────────────────────────────
let _canvas2d   = null;
let _canvas3d   = null;
let _tooltipEl  = null;

export function initTools(canvas2d, canvas3d, tooltipEl) {
  _canvas2d  = canvas2d;
  _canvas3d  = canvas3d;
  _tooltipEl = tooltipEl;

  _bind2DEvents();
  _bind3DEvents();
  _bindKeyboard();

  // Cursor move for coords display
  EventBus.on('cursor:move', ({ wx, wz, px, py }) => {
    _updateCoords(wx, wz);
    if (AppState.ui.tool === 'tree') {
      _updateTreePreview(wx, wz);
    }
    if (_tooltipEl) _updateTooltip(wx, wz, px, py);
  });
}

// ─── SET TOOL ─────────────────────────────────────────────────────────────────
export function setTool(name) {
  AppState.ui.tool       = name;
  AppState.ui.drawPoints = [];
  AppState.ui.isDrawing  = false;
  _canvas2d.style.cursor = TOOLS[name]?.cursor || 'default';
  EventBus.emit(EV.TOOL_CHANGED, name);
  EventBus.emit(EV.REDRAW_2D);
}

// ─── 2D CANVAS EVENTS ────────────────────────────────────────────────────────
function _bind2DEvents() {
  _canvas2d.addEventListener('mousedown', _on2DMouseDown);
  _canvas2d.addEventListener('dblclick',  _on2DDblClick);
  _canvas2d.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (AppState.ui.isDrawing && AppState.ui.drawPoints.length >= 2) {
      _finishDraw(null, null);
    }
  });
}

function _on2DMouseDown(e) {
  if (e.button === 1 || e.altKey) return; // pan — handled by renderer2d

  const r  = _canvas2d.getBoundingClientRect();
  const px = e.clientX - r.left;
  const py = e.clientY - r.top;
  const [wx, wz] = unproj(px, py);

  const tool = AppState.ui.tool;

  // ── Select ──────────────────────────────────────────────────────────────────
  if (tool === 'select') {
    const hit = hitTest(wx, wz);
    if (hit) {
      AppState.ui.selectedId   = hit.id;
      AppState.ui.selectedKind = hit.kind;
      EventBus.emit(EV.FEATURE_SELECTED, hit);
      highlightBuilding(hit.kind === 'building' ? hit.id : null);
    } else {
      AppState.ui.selectedId   = null;
      AppState.ui.selectedKind = null;
      EventBus.emit(EV.FEATURE_SELECTED, null);
      highlightBuilding(null);
    }
    draw();
    return;
  }

  // ── Delete ───────────────────────────────────────────────────────────────────
  if (tool === 'del') {
    const hit = hitTest(wx, wz);
    if (hit) _deleteFeature(hit);
    return;
  }

  // ── Place tree (single click) ────────────────────────────────────────────────
  if (tool === 'tree') {
    pushHistory();
    const opts = TOOL_OPTIONS.tree;
    const layer = addUserLayer({ kind: 'tree', cx: wx, cz: wz, radius: opts.radius, species: opts.species });
    EventBus.emit(EV.LAYER_ADDED, layer);
    EventBus.emit(EV.REBUILD_3D);
    draw();
    return;
  }

  // ── Polygon / polyline tools ─────────────────────────────────────────────────
  if (!AppState.ui.isDrawing) {
    AppState.ui.isDrawing  = true;
    AppState.ui.drawPoints = [[wx, wz]];
  } else {
    AppState.ui.drawPoints.push([wx, wz]);
  }
  draw();
}

function _on2DDblClick(e) {
  if (!AppState.ui.isDrawing) return;
  const r  = _canvas2d.getBoundingClientRect();
  const [wx, wz] = unproj(e.clientX - r.left, e.clientY - r.top);
  _finishDraw(wx, wz);
}

function _finishDraw(wx, wz) {
  if (wx !== null) AppState.ui.drawPoints.push([wx, wz]);
  const pts  = [...AppState.ui.drawPoints];
  const tool = AppState.ui.tool;

  AppState.ui.isDrawing  = false;
  AppState.ui.drawPoints = [];

  const isLine = ['road', 'path', 'sidewalk', 'terrain'].includes(tool);
  const minPts = isLine ? 2 : 3;
  if (pts.length < minPts) { draw(); return; }

  pushHistory();

  let layer;
  if (['grass', 'pitch', 'water'].includes(tool)) {
    layer = addUserLayer({ kind: tool, coords: pts });
  } else if (tool === 'road') {
    const o = TOOL_OPTIONS.road;
    layer = addUserLayer({ kind: 'road', coords: pts, roadType: o.type, name: o.name, width: o.width });
  } else if (tool === 'path') {
    layer = addUserLayer({ kind: 'path', coords: pts, pathType: TOOL_OPTIONS.path.pathType });
  } else if (tool === 'sidewalk') {
    layer = addUserLayer({ kind: 'sidewalk', coords: pts });
  } else if (tool === 'terrain') {
    const o = TOOL_OPTIONS.terrain;
    layer = addUserLayer({ kind: 'terrain', coords: pts, elevType: o.elevType, elev: o.elev });
  }

  if (layer) {
    EventBus.emit(EV.LAYER_ADDED, layer);
    EventBus.emit(EV.REBUILD_3D);
    EventBus.emit(EV.STATUS, `Added ${tool} (${pts.length} pts)`);
  }
  draw();
}

// ─── 3D CANVAS EVENTS ────────────────────────────────────────────────────────
function _bind3DEvents() {
  _canvas3d.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    const osmId = hitTest3D(e.clientX, e.clientY);
    if (osmId) {
      AppState.ui.selectedId   = osmId;
      AppState.ui.selectedKind = 'building';
      const bld = AppState.osm.buildings.find(b => b.id === osmId);
      EventBus.emit(EV.FEATURE_SELECTED, { id: osmId, kind: 'building', obj: bld });
      highlightBuilding(osmId);
      draw(); // sync 2D
    }
  });
}

// ─── DELETE ────────────────────────────────────────────────────────────────────
function _deleteFeature({ id, kind }) {
  pushHistory();
  if (kind === 'building') {
    updateBuildingEdit(id, { _deleted: true });
    EventBus.emit(EV.FEATURE_DELETED, { id, kind });
    EventBus.emit(EV.REBUILD_3D);
  } else if (kind === 'userLayer') {
    deleteUserLayer(id);
    EventBus.emit(EV.LAYER_DELETED, { id });
    EventBus.emit(EV.REBUILD_3D);
  }
  if (AppState.ui.selectedId === id) {
    AppState.ui.selectedId   = null;
    AppState.ui.selectedKind = null;
    EventBus.emit(EV.FEATURE_SELECTED, null);
  }
  draw();
  EventBus.emit(EV.STATUS, 'Deleted');
}

// ─── KEYBOARD ─────────────────────────────────────────────────────────────────
function _bindKeyboard() {
  document.addEventListener('keydown', e => {
    // Skip if typing in an input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

    // Tool shortcuts
    for (const [name, def] of Object.entries(TOOLS)) {
      if (def.key && e.key === def.key) { setTool(name); return; }
    }

    if (e.key === 'Escape') {
      AppState.ui.isDrawing  = false;
      AppState.ui.drawPoints = [];
      draw();
    }
    if (e.key === 'Enter' && AppState.ui.isDrawing && AppState.ui.drawPoints.length >= 2) {
      _finishDraw(null, null);
    }
    if (e.key === 'z' && (e.ctrlKey || e.metaKey) && !e.shiftKey) { e.preventDefault(); undo(); }
    if ((e.key === 'y' && (e.ctrlKey || e.metaKey)) || (e.key === 'z' && (e.ctrlKey || e.metaKey) && e.shiftKey)) { e.preventDefault(); redo(); }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (AppState.ui.selectedId && AppState.ui.selectedKind) {
        _deleteFeature({ id: AppState.ui.selectedId, kind: AppState.ui.selectedKind });
      }
    }
  });
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function _updateCoords(wx, wz) {
  const el = document.getElementById('coords-display');
  if (el) el.textContent = `X:${Math.round(wx)}  Z:${Math.round(wz)}`;
}

function _updateTreePreview(wx, wz) {
  // Signal renderer to show preview — renderer reads from AppState
  AppState.ui._treePreview = { x: wx, z: wz, radius: TOOL_OPTIONS.tree.radius };
  draw();
}

function _updateTooltip(wx, wz, px, py) {
  if (AppState.ui.tool !== 'select' || !_tooltipEl) return;
  const hit = hitTest(wx, wz);
  if (hit?.obj) {
    const edit = hit.kind === 'building' ? getBuildingEdit(hit.id) : {};
    const name = edit.name ?? hit.obj.tags?.name ?? hit.obj.kind ?? '';
    const lvl  = edit.levels ?? hit.obj.tags?.levels ?? '';
    _tooltipEl.style.display = 'block';
    _tooltipEl.style.left    = (px + 14) + 'px';
    _tooltipEl.style.top     = (py - 8) + 'px';
    _tooltipEl.textContent   = name + (lvl ? ` — ${lvl}F` : '');
  } else {
    _tooltipEl.style.display = 'none';
  }
}
