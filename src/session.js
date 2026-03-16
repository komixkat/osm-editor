/**
 * session.js — Persistence: localStorage auto-save + JSON import/export
 */

import { AppState, EventBus, EV } from './state.js';

const LS_KEY = 'osm_editor_session_v1';
const LS_OSM_KEY = 'osm_editor_raw_v1';

// ─── AUTO-SAVE ─────────────────────────────────────────────────────────────

let _autoSaveTimer = null;

export function scheduleAutoSave() {
  clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(saveToLocalStorage, 800);
}

export function saveToLocalStorage() {
  try {
    const session = serializeSession();
    localStorage.setItem(LS_KEY, JSON.stringify(session));
  } catch (e) {
    console.warn('[session] localStorage save failed:', e.message);
  }
}

export function loadFromLocalStorage() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return false;
    const session = JSON.parse(raw);
    return applySession(session);
  } catch (e) {
    console.warn('[session] localStorage load failed:', e.message);
    return false;
  }
}

// Save the raw OSM XML separately (can be large)
export function saveRawOSM(xmlString) {
  try {
    localStorage.setItem(LS_OSM_KEY, xmlString);
  } catch (e) {
    console.warn('[session] Could not save raw OSM (likely too large):', e.message);
  }
}

export function loadRawOSM() {
  return localStorage.getItem(LS_OSM_KEY) || null;
}

// ─── SERIALIZE / DESERIALIZE ──────────────────────────────────────────────────

export function serializeSession() {
  return {
    version: 1,
    fileName: AppState.osm.fileName,
    scale: AppState.ui.scale,
    floorHeight: AppState.ui.floorHeight,
    edits: {
      buildings: [...AppState.edits.buildings.entries()].map(([id, edit]) => ({ id, ...edit })),
      userLayers: AppState.edits.userLayers,
    },
    savedAt: new Date().toISOString(),
  };
}

function applySession(session) {
  if (!session || session.version !== 1) return false;

  // Restore edits
  AppState.edits.buildings = new Map(
    (session.edits?.buildings ?? []).map(e => {
      const { id, ...rest } = e;
      return [id, rest];
    })
  );
  AppState.edits.userLayers = session.edits?.userLayers ?? [];

  // Restore UI settings
  if (session.scale) AppState.ui.scale = session.scale;
  if (session.floorHeight) AppState.ui.floorHeight = session.floorHeight;

  EventBus.emit(EV.SESSION_LOADED, { fileName: session.fileName, savedAt: session.savedAt });
  return true;
}

// ─── MANUAL EXPORT ───────────────────────────────────────────────────────────

export function exportSessionJSON() {
  const session = serializeSession();
  const blob = new Blob([JSON.stringify(session, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (AppState.osm.fileName?.replace('.osm', '') || 'session') + '_edits.json';
  a.click();
  URL.revokeObjectURL(a.href);
  EventBus.emit(EV.STATUS, 'Session exported');
}

export function importSessionJSON(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const session = JSON.parse(e.target.result);
        const ok = applySession(session);
        if (ok) {
          EventBus.emit(EV.REDRAW_2D);
          EventBus.emit(EV.REBUILD_3D);
          EventBus.emit(EV.STATUS, `Session loaded: ${session.savedAt}`);
          resolve(session);
        } else {
          reject(new Error('Invalid or incompatible session file'));
        }
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

// ─── REGISTER AUTO-SAVE LISTENERS ────────────────────────────────────────────

export function initSession() {
  // Auto-save on any edit
  EventBus.on(EV.FEATURE_UPDATED, scheduleAutoSave);
  EventBus.on(EV.FEATURE_ADDED,   scheduleAutoSave);
  EventBus.on(EV.FEATURE_DELETED, scheduleAutoSave);
  EventBus.on(EV.LAYER_ADDED,     scheduleAutoSave);
  EventBus.on(EV.LAYER_DELETED,   scheduleAutoSave);
}
