/**
 * main.js — Application entry point.
 *
 * Key design decision: the 2D editor starts immediately with NO external
 * dependencies. Three.js is loaded lazily the first time 3D view is opened.
 * This means upload, pan, edit all work even if the CDN is down.
 */

import { AppState, EventBus, EV }                          from './state.js';
import { parseOSM }                                        from './parser.js';
import { initRenderer2D, draw, fitToBounds, zoomAt }       from './renderer2d.js';
import { initTools }                                       from './tools.js';
import { initUI, setStatus }                               from './ui.js';
import { initSession, saveRawOSM,
         loadFromLocalStorage, loadRawOSM }                from './session.js';

// ─── STATE ────────────────────────────────────────────────────────────────────
let _renderer3d   = null;   // loaded lazily
let _3dReady      = false;
let _3dLoading    = false;

// ─── DOM REFS ─────────────────────────────────────────────────────────────────
const canvas2d     = document.getElementById('canvas-2d');
const canvas3d     = document.getElementById('canvas-3d');
const tooltip      = document.getElementById('tooltip');
const dropZone     = document.getElementById('drop-zone');
const mainLayout   = document.getElementById('main-layout');
const fileInput    = document.getElementById('file-input');
const sessionInput = document.getElementById('session-input');
const viewToggle   = document.getElementById('view-toggle');
const wrap2d       = document.getElementById('canvas-2d-wrap');
const wrap3d       = document.getElementById('canvas-3d-wrap');

// ─── BOOT — runs immediately, no external deps ────────────────────────────────
async function init() {
  _resizeAll();
  window.addEventListener('resize', _resizeAll);

  // 2D renderer — pure canvas, zero dependencies
  initRenderer2D(canvas2d);
  initSession();
  initTools(canvas2d, canvas3d, tooltip);
  initUI();

  _bindFileHandlers();
  _bindViewToggle();

  // Try restore previous session (OSM + edits from localStorage)
  await _tryRestoreSession();

  draw();
  setStatus('Ready — upload an .osm file or drop it anywhere');
}

// ─── RESIZE ───────────────────────────────────────────────────────────────────
function _resizeAll() {
  const dpr = devicePixelRatio;
  const w2  = wrap2d.clientWidth  || wrap2d.parentElement.clientWidth;
  const h2  = wrap2d.clientHeight || wrap2d.parentElement.clientHeight;

  canvas2d.width        = w2 * dpr;
  canvas2d.height       = h2 * dpr;
  canvas2d.style.width  = w2 + 'px';
  canvas2d.style.height = h2 + 'px';

  if (_3dReady && _renderer3d) {
    const w3 = wrap3d.clientWidth;
    const h3 = wrap3d.clientHeight;
    canvas3d.style.width  = w3 + 'px';
    canvas3d.style.height = h3 + 'px';
    _renderer3d.resizeRenderer(w3, h3);
  }

  draw();
}

// ─── FILE LOADING ─────────────────────────────────────────────────────────────
function _bindFileHandlers() {
  // Header "Upload .osm" button
  document.getElementById('upload-btn').addEventListener('click', () => {
    fileInput.click();
  });

  // Drop zone button
  document.getElementById('drop-upload-btn').addEventListener('click', () => {
    fileInput.click();
  });

  // File input change
  fileInput.addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) { _loadOSMFile(file); fileInput.value = ''; }
  });

  // Session button
  document.getElementById('session-btn').addEventListener('click', () => {
    sessionInput.click();
  });

  sessionInput.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    sessionInput.value = '';
    const { importSessionJSON } = await import('./session.js');
    try {
      await importSessionJSON(file);
      draw();
      if (_3dReady && _renderer3d) _renderer3d.rebuild();
    } catch (err) {
      setStatus('Session load error: ' + err.message, true);
    }
  });

  // Drag and drop anywhere on the page
  let _dragCount = 0;
  document.addEventListener('dragenter', e => {
    e.preventDefault();
    _dragCount++;
    document.body.classList.add('dragging');
  });
  document.addEventListener('dragleave', () => {
    _dragCount--;
    if (_dragCount <= 0) { _dragCount = 0; document.body.classList.remove('dragging'); }
  });
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => {
    e.preventDefault();
    _dragCount = 0;
    document.body.classList.remove('dragging');
    const file = [...(e.dataTransfer?.files || [])].find(
      f => f.name.endsWith('.osm') || f.name.endsWith('.xml')
    );
    if (file) _loadOSMFile(file);
    else setStatus('Please drop an .osm file', true);
  });
}

async function _loadOSMFile(file) {
  setStatus(`Loading ${file.name} (${_formatBytes(file.size)})…`);
  try {
    const text = await file.text();
    window._rawOSMString = text;
    saveRawOSM(text);
    parseOSM(text, file.name);
    _showEditor();
    fitToBounds();
    draw();
    if (_3dReady && _renderer3d && AppState.ui.viewMode === '3d') {
      _renderer3d.rebuild();
    }
    setStatus(`Loaded: ${file.name} — ${AppState.osm.buildings.length} buildings, ${AppState.osm.roads.length} roads`);
  } catch (err) {
    setStatus('Error loading file: ' + err.message, true);
    console.error('[main] _loadOSMFile:', err);
  }
}

function _showEditor() {
  dropZone.style.display  = 'none';
  mainLayout.style.display = 'flex';
  // Trigger resize now that canvas containers have actual size
  setTimeout(_resizeAll, 0);
}

// ─── VIEW TOGGLE (2D ↔ 3D) ───────────────────────────────────────────────────
function _bindViewToggle() {
  viewToggle.addEventListener('click', () => {
    _setViewMode(AppState.ui.viewMode === '2d' ? '3d' : '2d');
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Tab' && !e.shiftKey && AppState.osm.buildings.length > 0) {
      e.preventDefault();
      _setViewMode(AppState.ui.viewMode === '2d' ? '3d' : '2d');
    }
  });
}

async function _setViewMode(mode) {
  if (mode === AppState.ui.viewMode) return;
  AppState.ui.viewMode = mode;

  if (mode === '3d') {
    wrap2d.style.display = 'none';
    wrap3d.style.display = 'block';
    viewToggle.textContent = '2D View';
    viewToggle.disabled = true;
    setStatus('Loading 3D renderer…');
    await _ensure3D();
    viewToggle.disabled = false;
    _resizeAll();
    if (_3dReady && _renderer3d) {
      _renderer3d.rebuild();
      _renderer3d.startRenderLoop();
    }
  } else {
    wrap3d.style.display = 'none';
    wrap2d.style.display = 'block';
    viewToggle.textContent = '3D View';
    if (_3dReady && _renderer3d) _renderer3d.stopRenderLoop();
    draw();
  }
  EventBus.emit(EV.VIEW_MODE_CHANGED, mode);
}

// ─── LAZY THREE.JS LOAD ───────────────────────────────────────────────────────
async function _ensure3D() {
  if (_3dReady) return;
  if (_3dLoading) return;
  _3dLoading = true;

  try {
    // Load Three.js from CDN dynamically — only when needed
    await _loadScript('https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js');

    if (!window.THREE) throw new Error('THREE not defined after script load');

    // Now safe to import renderer3d
    _renderer3d = await import('./renderer3d.js');
    window._renderer3d = _renderer3d;  // tools.js accesses via r3d()
    await _renderer3d.initRenderer3D(canvas3d);

    // Wire EventBus → renderer3d for camera/toggle controls from ui.js
    EventBus.on('camera:mode',         mode    => _renderer3d.setCameraMode(mode));
    EventBus.on('3d:toggle-grid',      checked => _renderer3d.toggleGrid(checked));
    EventBus.on('3d:toggle-blockgrid', checked => _renderer3d.toggleBlockGrid(checked));
    EventBus.on('3d:toggle-axes',      checked => _renderer3d.toggleAxes(checked));
    // Note: REBUILD_3D is handled internally by renderer3d itself

    _3dReady = true;
    setStatus('3D renderer ready');
  } catch (err) {
    _3dLoading = false;
    console.error('[main] 3D init failed:', err);
    wrap3d.innerHTML = `<div class="no-webgl">
      3D view unavailable: ${err.message}<br>
      <small>Check your internet connection (Three.js loads from CDN)</small>
    </div>`;
    setStatus('3D unavailable — using 2D only', true);
    // Fall back to 2D
    AppState.ui.viewMode = '2d';
    wrap3d.style.display = 'none';
    wrap2d.style.display = 'block';
    viewToggle.textContent = '3D View';
  }
}

function _loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src;
    s.crossOrigin = 'anonymous';
    s.onload  = resolve;
    s.onerror = () => reject(new Error(`Failed to load: ${src}`));
    document.head.appendChild(s);
  });
}

// ─── SESSION RESTORE ──────────────────────────────────────────────────────────
async function _tryRestoreSession() {
  try {
    const rawOSM     = loadRawOSM();
    const hadSession = loadFromLocalStorage();
    if (rawOSM && hadSession) {
      setStatus('Restoring previous session…');
      parseOSM(rawOSM, AppState.osm.fileName || 'restored.osm');
      _showEditor();
      fitToBounds();
      setStatus('Session restored — ' + (AppState.osm.fileName || 'previous session'));
    }
  } catch (e) {
    console.warn('[main] Session restore failed:', e);
    // Non-fatal — user can upload fresh
  }
}

// ─── UTILS ────────────────────────────────────────────────────────────────────
function _formatBytes(b) {
  if (b < 1024)        return b + ' B';
  if (b < 1048576)     return (b / 1024).toFixed(0) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

// ─── START ────────────────────────────────────────────────────────────────────
// DOMContentLoaded is guaranteed by the time a module script runs,
// but guard anyway.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
