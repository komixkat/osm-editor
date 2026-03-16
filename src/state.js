/**
 * state.js — Central application state + event bus
 * All modules communicate through AppState and EventBus only.
 * No module imports another module directly.
 */

// ─── EVENT BUS ───────────────────────────────────────────────────────────────
export const EventBus = (() => {
  const listeners = {};
  return {
    on(event, fn) {
      (listeners[event] ??= []).push(fn);
      return () => this.off(event, fn);
    },
    off(event, fn) {
      if (listeners[event]) listeners[event] = listeners[event].filter(f => f !== fn);
    },
    emit(event, data) {
      (listeners[event] ?? []).forEach(fn => fn(data));
    }
  };
})();

// ─── EVENTS (string constants to avoid typos) ────────────────────────────────
export const EV = {
  OSM_LOADED:        'osm:loaded',
  FEATURE_SELECTED:  'feature:selected',
  FEATURE_UPDATED:   'feature:updated',
  FEATURE_ADDED:     'feature:added',
  FEATURE_DELETED:   'feature:deleted',
  LAYER_ADDED:       'layer:added',
  LAYER_DELETED:     'layer:deleted',
  SCALE_CHANGED:     'scale:changed',
  VIEW_MODE_CHANGED: 'view:mode_changed',   // '2d' | '3d'
  TOOL_CHANGED:      'tool:changed',
  SESSION_LOADED:    'session:loaded',
  REDRAW_2D:         'redraw:2d',
  REBUILD_3D:        'rebuild:3d',
  STATUS:            'ui:status',
};

// ─── APP STATE ────────────────────────────────────────────────────────────────
export const AppState = {
  // OSM raw data (parsed, immutable after load)
  osm: {
    nodes: new Map(),       // id → {lat, lon}
    buildings: [],          // [{id, coords:[[x,z],...], tags:{}}]
    roads: [],              // [{id, coords, tags}]
    landuse: [],            // [{id, coords, tags}]
    bounds: { minX:0, maxX:0, minZ:0, maxZ:0 },
    fileName: null,
  },

  // User edits (persisted)
  edits: {
    buildings: new Map(),   // osmId → {name, levels, height, type, roof, note, _deleted}
    userLayers: [],         // [{id, kind, coords/cx/cz, ...props}]
  },

  // Viewport / tool state (not persisted)
  ui: {
    tool: 'select',
    selectedId: null,
    selectedKind: null,     // 'building' | 'userLayer'
    viewMode: '2d',         // '2d' | '3d'
    scale: 3,               // blocks per real metre
    floorHeight: 3,         // real metres per floor
    drawPoints: [],
    isDrawing: false,
  },

  // History stack for undo
  _history: [],
  _historyPtr: -1,
};

// ─── HISTORY ──────────────────────────────────────────────────────────────────
export function pushHistory() {
  const snap = JSON.stringify({
    buildings: [...AppState.edits.buildings.entries()],
    userLayers: AppState.edits.userLayers,
  });
  // Truncate forward history on new action
  AppState._history = AppState._history.slice(0, AppState._historyPtr + 1);
  AppState._history.push(snap);
  if (AppState._history.length > 50) AppState._history.shift();
  AppState._historyPtr = AppState._history.length - 1;
}

export function undo() {
  if (AppState._historyPtr <= 0) return;
  AppState._historyPtr--;
  _restoreSnapshot(AppState._history[AppState._historyPtr]);
  EventBus.emit(EV.REDRAW_2D);
  EventBus.emit(EV.REBUILD_3D);
  EventBus.emit(EV.STATUS, 'Undo');
}

export function redo() {
  if (AppState._historyPtr >= AppState._history.length - 1) return;
  AppState._historyPtr++;
  _restoreSnapshot(AppState._history[AppState._historyPtr]);
  EventBus.emit(EV.REDRAW_2D);
  EventBus.emit(EV.REBUILD_3D);
  EventBus.emit(EV.STATUS, 'Redo');
}

function _restoreSnapshot(snap) {
  const parsed = JSON.parse(snap);
  AppState.edits.buildings = new Map(parsed.buildings);
  AppState.edits.userLayers = parsed.userLayers;
}

// ─── ID GENERATOR ─────────────────────────────────────────────────────────────
let _uid = 1;
export const uid = () => 'ul_' + (_uid++).toString(36);

// ─── BUILDING EDIT HELPERS ───────────────────────────────────────────────────
export function getBuildingEdit(osmId) {
  return AppState.edits.buildings.get(osmId) ?? {};
}

export function updateBuildingEdit(osmId, patch) {
  const existing = AppState.edits.buildings.get(osmId) ?? {};
  AppState.edits.buildings.set(osmId, { ...existing, ...patch });
}

// ─── USER LAYER HELPERS ──────────────────────────────────────────────────────
export function addUserLayer(layer) {
  AppState.edits.userLayers.push({ ...layer, id: uid() });
  return AppState.edits.userLayers[AppState.edits.userLayers.length - 1];
}

export function deleteUserLayer(id) {
  AppState.edits.userLayers = AppState.edits.userLayers.filter(l => l.id !== id);
}

export function updateUserLayer(id, patch) {
  const idx = AppState.edits.userLayers.findIndex(l => l.id === id);
  if (idx !== -1) AppState.edits.userLayers[idx] = { ...AppState.edits.userLayers[idx], ...patch };
}
