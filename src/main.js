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
const canvas2d  = document.getElementById('canvas-2d');
const canvas3d  = document.getElementById('canvas-3d');
const tooltip   = document.getElementById('tooltip');
const dropZone  = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
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
  // Click to upload
  document.getElementById('upload-btn')?.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', e => {
    if (e.target.files[0]) _loadFile(e.target.files[0]);
  });

  // Drag and drop
  document.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  document.addEventListener('dragleave', e => { if (!e.relatedTarget) dropZone.classList.remove('drag-over'); });
  document.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = [...e.dataTransfer.files].find(f => f.name.endsWith('.osm') || f.name.endsWith('.xml'));
    if (file) _loadFile(file);
    else setStatus('Please drop an .osm file', true);
  });
}

async function _loadFile(file) {
  setStatus(`Loading ${file.name} (${_formatBytes(file.size)})…`);

  try {
    const text = await file.text();

    // Store raw for later export
    window._rawOSMString = text;
    saveRawOSM(text);

    parseOSM(text, file.name);

    // Show canvas, hide drop zone
    dropZone.style.display = 'none';
    document.getElementById('main-layout').style.display = 'flex';

    // Rebuild 3D
    rebuild();
    fitToBounds();
    draw();

    // Start 3D loop if in 3D mode
    if (AppState.ui.viewMode === '3d') startRenderLoop();

    setStatus(`Loaded: ${file.name}`);
  } catch (err) {
    setStatus('Error loading file: ' + err.message, true);
    console.error(err);
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
// Wait for Three.js CDN script to load, then init
if (window.THREE) {
  init();
} else {
  window.addEventListener('three-ready', init);
  // Fallback: poll
  const poll = setInterval(() => {
    if (window.THREE) { clearInterval(poll); init(); }
  }, 100);
}
