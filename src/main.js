/**
 * main.js — Application entry point.
 * Wires all modules together. No logic lives here — only init and plumbing.
 */

import { AppState, EventBus, EV }    from './state.js';
import { parseOSM }                  from './parser.js';
import { initRenderer2D, draw, fitToBounds } from './renderer2d.js';
import { initRenderer3D, rebuild, startRenderLoop, stopRenderLoop, resizeRenderer } from './renderer3d.js';
import { initTools, setTool }        from './tools.js';
import { initUI, setStatus, showTab } from './ui.js';
import { initSession, saveRawOSM, loadFromLocalStorage, loadRawOSM } from './session.js';

// ─── CANVAS REFS ──────────────────────────────────────────────────────────────
const canvas2d   = document.getElementById('canvas-2d');
const canvas3d   = document.getElementById('canvas-3d');
const tooltip    = document.getElementById('tooltip');
const dropZone   = document.getElementById('drop-zone');
const viewToggle = document.getElementById('view-toggle');

// ─── INIT ──────────────────────────────────────────────────────────────────────
async function init() {
  // Resize canvases to fill their containers
  _resizeAll();
  window.addEventListener('resize', _resizeAll);

  // Init modules
  initSession();
  initRenderer2D(canvas2d);

  try {
    await initRenderer3D(canvas3d);
  } catch (e) {
    console.warn('[main] 3D renderer init failed:', e.message);
    document.getElementById('canvas-3d-wrap').innerHTML =
      `<div class="no-webgl">WebGL not available. 3D view disabled.<br>${e.message}</div>`;
  }

  initTools(canvas2d, canvas3d, tooltip);
  initUI();

  // File loading
  _bindFileHandlers();

  // View toggle (2D ↔ 3D)
  _bindViewToggle();

  // Try restore previous session
  _tryRestoreSession();

  // Initial draw
  draw();

  EventBus.emit(EV.STATUS, 'Ready — drop an .osm file or click Upload');
}

// ─── RESIZE ───────────────────────────────────────────────────────────────────
function _resizeAll() {
  const dpr = devicePixelRatio;

  const wrap2d = canvas2d.parentElement;
  const w2 = wrap2d.clientWidth, h2 = wrap2d.clientHeight;
  canvas2d.width  = w2 * dpr;
  canvas2d.height = h2 * dpr;
  canvas2d.style.width  = w2 + 'px';
  canvas2d.style.height = h2 + 'px';

  const wrap3d = canvas3d.parentElement;
  const w3 = wrap3d.clientWidth, h3 = wrap3d.clientHeight;
  canvas3d.style.width  = w3 + 'px';
  canvas3d.style.height = h3 + 'px';
  resizeRenderer(w3, h3);

  draw();
}

// ─── FILE LOADING ─────────────────────────────────────────────────────────────
function _bindFileHandlers() {
  const fileInput    = document.getElementById('file-input');
  const sessionInput = document.getElementById('session-input');

  // ── Header "Upload .osm" button ──────────────────────────────────────────────
  document.getElementById('upload-btn').addEventListener('click', () => fileInput.click());

  // ── Drop zone "Or click to upload" button ────────────────────────────────────
  document.getElementById('drop-upload-btn').addEventListener('click', () => fileInput.click());

  // ── OSM file input change ────────────────────────────────────────────────────
  fileInput.addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) {
      _loadFile(file);
      fileInput.value = ''; // reset so same file can be re-uploaded
    }
  });

  // ── Session button ───────────────────────────────────────────────────────────
  document.getElementById('session-btn').addEventListener('click', () => sessionInput.click());

  sessionInput.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    sessionInput.value = '';
    const { importSessionJSON } = await import('./session.js');
    try {
      await importSessionJSON(file);
    } catch (err) {
      setStatus('Session load error: ' + err.message, true);
      console.error(err);
    }
  });

  // ── Drag and drop ─────────────────────────────────────────────────────────────
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
    if (file) _loadFile(file);
    else setStatus('Please drop an .osm file', true);
  });
}

async function _loadFile(file) {
  setStatus(`Loading ${file.name} (${_formatBytes(file.size)})…`);

  try {
    const text = await file.text();

    // Keep raw XML in memory for patched-OSM export
    window._rawOSMString = text;
    saveRawOSM(text);

    parseOSM(text, file.name);

    // Swap drop zone → editor
    dropZone.style.display = 'none';
    document.getElementById('main-layout').style.display = 'flex';

    rebuild();
    fitToBounds();
    draw();

    if (AppState.ui.viewMode === '3d') startRenderLoop();

    setStatus(`Loaded: ${file.name} — ${AppState.osm.buildings.length} buildings`);
  } catch (err) {
    setStatus('Error loading file: ' + err.message, true);
    console.error('[main] _loadFile error:', err);
  }
}

// ─── VIEW TOGGLE ──────────────────────────────────────────────────────────────
function _bindViewToggle() {
  viewToggle?.addEventListener('click', () => {
    const current = AppState.ui.viewMode;
    _setViewMode(current === '2d' ? '3d' : '2d');
  });

  // Keyboard: Tab toggles 2D/3D
  document.addEventListener('keydown', e => {
    if (e.key === 'Tab' && !e.shiftKey && AppState.osm.buildings.length > 0) {
      e.preventDefault();
      _setViewMode(AppState.ui.viewMode === '2d' ? '3d' : '2d');
    }
  });
}

function _setViewMode(mode) {
  AppState.ui.viewMode = mode;
  const wrap2d = document.getElementById('canvas-2d-wrap');
  const wrap3d = document.getElementById('canvas-3d-wrap');

  if (mode === '2d') {
    wrap2d.style.display = 'block';
    wrap3d.style.display = 'none';
    stopRenderLoop();
    viewToggle.textContent = '3D View';
  } else {
    wrap2d.style.display = 'none';
    wrap3d.style.display = 'block';
    startRenderLoop();
    viewToggle.textContent = '2D View';
    _resizeAll();
  }
  EventBus.emit(EV.VIEW_MODE_CHANGED, mode);
}

// ─── SESSION RESTORE ──────────────────────────────────────────────────────────
async function _tryRestoreSession() {
  const rawOSM = loadRawOSM();
  const hadSession = loadFromLocalStorage();

  if (rawOSM && hadSession) {
    try {
      window._rawOSMString = rawOSM;
      setStatus('Restoring previous session…');
      parseOSM(rawOSM, AppState.osm.fileName || 'previous.osm');
      dropZone.style.display = 'none';
      document.getElementById('main-layout').style.display = 'flex';
      rebuild();
      fitToBounds();
      draw();
      setStatus('Session restored — ' + (AppState.osm.fileName || 'previous session'));
    } catch (e) {
      console.warn('[main] Session restore failed:', e);
      setStatus('Could not restore previous session');
    }
  }
}

// ─── UTILS ────────────────────────────────────────────────────────────────────
function _formatBytes(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + 'KB';
  return (bytes / 1024 / 1024).toFixed(1) + 'MB';
}

// ─── BOOT ─────────────────────────────────────────────────────────────────────
// three.js loads synchronously via <script> tag before this module runs,
// so window.THREE should already exist. Poll as safety net.
function _boot() {
  if (window.THREE) {
    init();
  } else {
    let attempts = 0;
    const poll = setInterval(() => {
      attempts++;
      if (window.THREE) { clearInterval(poll); init(); }
      else if (attempts > 50) {
        clearInterval(poll);
        document.getElementById('status-msg').textContent = 'Error: Three.js failed to load from CDN. Check your internet connection.';
      }
    }, 100);
  }
}

_boot();
