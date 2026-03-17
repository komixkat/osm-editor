/**
 * renderer2d.js — 2D canvas renderer with viewport culling and spatial indexing.
 * Handles large OSM files by only drawing features visible in the current viewport.
 */

import { AppState, EventBus, EV, getBuildingEdit } from './state.js';

// ─── VIEWPORT STATE ───────────────────────────────────────────────────────────
let canvas = null;
let ctx    = null;
let _zoom  = 1;
let _panX  = 0;
let _panY  = 0;

// ─── INTERACTION STATE ────────────────────────────────────────────────────────
let _dragging  = false;
let _lastMx    = 0;
let _lastMy    = 0;
let _hoverId   = null;   // id of feature under cursor (for hover highlight)

// ─── INIT ──────────────────────────────────────────────────────────────────────
export function initRenderer2D(canvasEl) {
  canvas = canvasEl;
  ctx = canvas.getContext('2d');

  _bindEvents();
  EventBus.on(EV.REDRAW_2D, () => draw());
  EventBus.on(EV.OSM_LOADED, () => { fitToBounds(); draw(); });
}

// ─── COORDINATE PROJECTION ────────────────────────────────────────────────────
function _baseScale() {
  const W = canvas.width  / devicePixelRatio;
  const H = canvas.height / devicePixelRatio;
  const { minX, maxX, minZ, maxZ } = AppState.osm.bounds;
  const rangeX = Math.max(maxX - minX, 1);
  const rangeZ = Math.max(maxZ - minZ, 1);
  return Math.min((W - 40) / rangeX, (H - 40) / rangeZ);
}

export function proj(x, z) {
  const W  = canvas.width  / devicePixelRatio;
  const H  = canvas.height / devicePixelRatio;
  const bs = _baseScale();
  const sc = bs * _zoom;
  const { minX, minZ, maxX, maxZ } = AppState.osm.bounds;
  const rangeX = maxX - minX;
  const ox = (W - rangeX * bs) / 2 + _panX;
  const oy = H - 20 + _panY;
  return [ox + (x - minX) * sc, oy - (z - minZ) * sc, sc];
}

export function unproj(px, py) {
  const W  = canvas.width  / devicePixelRatio;
  const H  = canvas.height / devicePixelRatio;
  const bs = _baseScale();
  const sc = bs * _zoom;
  const { minX, minZ, maxX } = AppState.osm.bounds;
  const rangeX = maxX - minX;
  const ox = (W - rangeX * bs) / 2 + _panX;
  const oy = H - 20 + _panY;
  return [(px - ox) / sc + minX, (oy - py) / sc + minZ];
}

// ─── VIEWPORT CULLING ─────────────────────────────────────────────────────────
function _getViewBounds() {
  const W = canvas.width  / devicePixelRatio;
  const H = canvas.height / devicePixelRatio;
  const [minX, maxZ] = unproj(0, 0);
  const [maxX, minZ] = unproj(W, H);
  return { minX: minX - 50, maxX: maxX + 50, minZ: minZ - 50, maxZ: maxZ + 50 };
}

function _inView(cx, cz, vb) {
  return cx >= vb.minX && cx <= vb.maxX && cz >= vb.minZ && cz <= vb.maxZ;
}

function _polyInView(coords, vb) {
  // Quick AABB check against view bounds
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of coords) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return maxX >= vb.minX && minX <= vb.maxX && maxZ >= vb.minZ && minZ <= vb.maxZ;
}

// ─── ZOOM / PAN ────────────────────────────────────────────────────────────────
export function fitToBounds() {
  _zoom = 1; _panX = 0; _panY = 0;
}

export function zoomAt(factor, mouseX, mouseY) {
  const [wx, wz] = unproj(mouseX, mouseY);
  _zoom = Math.max(0.05, Math.min(50, _zoom * factor));
  const [npx, npy] = proj(wx, wz);
  _panX += mouseX - npx;
  _panY += mouseY - npy;
  draw();
}

export function getZoom() { return _zoom; }

// ─── BUILDING COLORS ──────────────────────────────────────────────────────────
const TYPE_COLORS = {
  university:    { fill: 'rgba(60,100,220,.6)',  stroke: '#4d88ff' },
  dormitory:     { fill: 'rgba(220,90,30,.65)',  stroke: '#ff8040' },
  residential:   { fill: 'rgba(40,160,60,.55)',  stroke: '#40cc60' },
  yes:           { fill: 'rgba(110,110,130,.5)', stroke: '#7777aa' },
  train_station: { fill: 'rgba(190,50,170,.55)', stroke: '#cc50d0' },
  hotel:         { fill: 'rgba(180,140,30,.55)', stroke: '#d4b030' },
  commercial:    { fill: 'rgba(200,100,40,.55)', stroke: '#e08030' },
};

const LANDUSE_COLORS = {
  grass:           'rgba(50,190,70,.18)',
  pitch:           'rgba(40,200,150,.2)',
  park:            'rgba(50,200,80,.2)',
  forest:          'rgba(30,120,50,.2)',
  water:           'rgba(20,80,200,.35)',
  farmland:        'rgba(180,160,80,.15)',
  residential:     'rgba(120,110,80,.1)',
  commercial:      'rgba(200,140,60,.1)',
  retail:          'rgba(200,100,60,.12)',
  industrial:      'rgba(150,120,100,.12)',
  university:      'rgba(60,100,200,.06)',
  research_institute: 'rgba(80,60,200,.07)',
  flowerbed:       'rgba(220,180,50,.2)',
  cemetery:        'rgba(100,140,80,.15)',
  military:        'rgba(180,80,80,.15)',
};

function _bldColor(bld) {
  const edit = getBuildingEdit(bld.id);
  const type = edit.type || bld.tags.type || 'yes';
  const name = (edit.name ?? bld.tags.name ?? '').toLowerCase();

  if (type === 'dormitory' || name.includes('hostel')) return TYPE_COLORS.dormitory;
  if (type === 'university' || name.match(/lab|block|institute|college|school|lecture/)) return TYPE_COLORS.university;
  if (type === 'residential' || name.match(/house|home|quarter|residenc|flat|apartm/)) return TYPE_COLORS.residential;
  if (type === 'train_station' || name.match(/station|metro|rail/)) return TYPE_COLORS.train_station;
  if (type === 'hotel' || name.match(/hotel|guest|lodge/)) return TYPE_COLORS.hotel;
  if (type === 'commercial' || name.match(/shop|market|mall|store/)) return TYPE_COLORS.commercial;
  return TYPE_COLORS[type] || TYPE_COLORS.yes;
}

const ROAD_STYLES = {
  motorway:    { color: '#e88020', width: 8 },
  trunk:       { color: '#e88020', width: 7 },
  primary:     { color: '#d8a030', width: 6 },
  secondary:   { color: '#c89020', width: 5 },
  tertiary:    { color: '#b07020', width: 4 },
  residential: { color: '#907030', width: 3 },
  service:     { color: '#806020', width: 2.5 },
  unclassified:{ color: '#806020', width: 2.5 },
  footway:     { color: '#806040', width: 1.5, dash: [3,2] },
  path:        { color: '#806040', width: 1.5, dash: [3,2] },
  cycleway:    { color: '#508060', width: 1.5, dash: [4,2] },
  steps:       { color: '#806040', width: 2, dash: [2,2] },
};

// ─── POLYGON HELPER ───────────────────────────────────────────────────────────
function _tracePoly(coords, close = true) {
  if (!coords || coords.length < 2) return;
  ctx.beginPath();
  const [x0, z0] = coords[0];
  const [px0, py0] = proj(x0, z0);
  ctx.moveTo(px0, py0);
  for (let i = 1; i < coords.length; i++) {
    const [px, py] = proj(coords[i][0], coords[i][1]);
    ctx.lineTo(px, py);
  }
  if (close) ctx.closePath();
}

// ─── MAIN DRAW ────────────────────────────────────────────────────────────────
export function draw() {
  if (!canvas || !ctx) return;

  const dpr = devicePixelRatio;
  const W   = canvas.width  / dpr;
  const H   = canvas.height / dpr;

  // Reset transform before clearing
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  // Background
  ctx.fillStyle = '#0c0e14';
  ctx.fillRect(0, 0, W, H);

  if (!AppState.osm.buildings.length && !AppState.osm.roads.length) {
    _drawEmptyState(W, H);
    return;
  }

  const vb = _getViewBounds();
  const sc = _baseScale() * _zoom;

  _drawGrid(W, H, sc);
  _drawLanduse(vb);
  _drawUserLayers(vb);
  _drawRoads(vb, sc);
  _drawBuildings(vb, sc);
  _drawDrawingPreview();
  _drawTrees(vb, sc);
  _drawOverlay(W, H, sc);
}

function _drawEmptyState(W, H) {
  ctx.fillStyle = 'rgba(255,255,255,.15)';
  ctx.font = 'bold 18px system-ui';
  ctx.textAlign = 'center';
  ctx.fillText('Drop an .osm file here or click Upload', W / 2, H / 2);
  ctx.font = '13px system-ui';
  ctx.fillStyle = 'rgba(255,255,255,.08)';
  ctx.fillText('Supports any OpenStreetMap export', W / 2, H / 2 + 28);
}

function _drawGrid(W, H, sc) {
  ctx.strokeStyle = 'rgba(255,255,255,.025)';
  ctx.lineWidth = 0.5;
  const step = sc < 0.05 ? 10000 : sc < 0.2 ? 2000 : sc < 1 ? 500 : 100;
  const { minX, maxX, minZ, maxZ } = AppState.osm.bounds;

  const startX = Math.floor(minX / step) * step;
  const startZ = Math.floor(minZ / step) * step;

  for (let x = startX; x <= maxX + step; x += step) {
    const [px, py0] = proj(x, minZ);
    const [, py1]   = proj(x, maxZ);
    if (px < -10 || px > W + 10) continue;
    ctx.beginPath(); ctx.moveTo(px, py0); ctx.lineTo(px, py1); ctx.stroke();
  }
  for (let z = startZ; z <= maxZ + step; z += step) {
    const [px0, py] = proj(minX, z);
    const [px1]     = proj(maxX, z);
    if (py < -10 || py > H + 10) continue;
    ctx.beginPath(); ctx.moveTo(px0, py); ctx.lineTo(px1, py); ctx.stroke();
  }
}

function _drawLanduse(vb) {
  for (const lu of AppState.osm.landuse) {
    if (!_polyInView(lu.coords, vb)) continue;
    _tracePoly(lu.coords);
    ctx.fillStyle = LANDUSE_COLORS[lu.tags.type] || 'rgba(100,100,100,.06)';
    ctx.fill();
  }
}

function _drawUserLayers(vb) {
  for (const layer of AppState.edits.userLayers) {
    const sel = layer.id === AppState.ui.selectedId;
    const hov = !sel && layer.id === _hoverId;

    if (layer.kind === 'tree') {
      if (!_inView(layer.cx, layer.cz, vb)) continue;
      const [px, py, sc] = proj(layer.cx, layer.cz);
      const r = Math.max(2, (layer.radius || 15) * sc);
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fillStyle   = sel ? 'rgba(80,255,80,.6)' : hov ? 'rgba(80,255,80,.45)' : 'rgba(30,160,50,.5)';
      ctx.strokeStyle = sel ? '#fff' : hov ? 'rgba(255,255,180,.9)' : 'rgba(80,220,80,.5)';
      ctx.lineWidth   = (sel || hov) ? 1.5 : 0.7;
      ctx.fill();
      ctx.stroke();
      continue;
    }

    if (!layer.coords || !_polyInView(layer.coords, vb)) continue;

    const isLine = ['road', 'path', 'sidewalk', 'terrain'].includes(layer.kind);
    _tracePoly(layer.coords, !isLine);

    if (isLine) {
      ctx.strokeStyle = hov ? 'rgba(255,255,180,.95)' : {
        road: 'rgba(220,170,40,.8)',
        path: 'rgba(200,190,140,.65)',
        sidewalk: 'rgba(200,200,180,.55)',
        terrain: 'rgba(200,140,40,.7)',
      }[layer.kind] || '#aaa';
      const sc = _baseScale() * _zoom;
      ctx.lineWidth = Math.max(1, sc * ({ road: 5, path: 2, sidewalk: 2.5, terrain: 3 }[layer.kind] || 2));
      ctx.setLineDash(layer.kind === 'terrain' ? [4, 3] : []);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      const colors = {
        grass: { fill: 'rgba(50,180,70,.35)',  stroke: 'rgba(60,210,80,.6)' },
        pitch: { fill: 'rgba(30,180,140,.3)',  stroke: 'rgba(40,210,160,.6)' },
        water: { fill: 'rgba(20,80,200,.45)',  stroke: 'rgba(40,120,255,.7)' },
      };
      const c = colors[layer.kind] || { fill: 'rgba(150,150,150,.2)', stroke: 'rgba(200,200,200,.4)' };
      ctx.fillStyle   = hov ? c.fill.replace(/[\d.]+\)$/, '0.6)') : c.fill;
      ctx.strokeStyle = sel ? '#fff' : hov ? 'rgba(255,255,180,.9)' : c.stroke;
      ctx.lineWidth   = (sel || hov) ? 1.5 : 0.8;
      ctx.fill();
      ctx.stroke();
    }
  }
}

function _drawRoads(vb, sc) {
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const road of AppState.osm.roads) {
    if (!_polyInView(road.coords, vb)) continue;
    const style = ROAD_STYLES[road.tags.highway] || ROAD_STYLES.service;
    _tracePoly(road.coords, false);
    ctx.strokeStyle = style.color + (style.color.length === 7 ? '99' : '');
    ctx.lineWidth   = Math.max(0.5, sc * style.width * 0.012);
    if (style.dash) { ctx.setLineDash(style.dash); }
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function _drawBuildings(vb, sc) {
  const selectedId = AppState.ui.selectedId;
  const hoverId    = _hoverId;

  for (const bld of AppState.osm.buildings) {
    if (!_inView(bld.cx, bld.cz, vb)) continue;
    const edit = getBuildingEdit(bld.id);
    if (edit._deleted) continue;

    const sel  = bld.id === selectedId;
    const hov  = !sel && bld.id === hoverId;
    const c    = _bldColor(bld);

    _tracePoly(bld.coords);
    ctx.fillStyle   = sel ? c.fill.replace(/[\d.]+\)$/, '0.9)')
                    : hov ? c.fill.replace(/[\d.]+\)$/, '0.7)')
                    : c.fill;
    ctx.strokeStyle = sel ? '#fff' : hov ? 'rgba(255,255,180,0.9)' : c.stroke;
    ctx.lineWidth   = sel ? 1.5 : hov ? 1.5 : Math.max(0.5, sc * 0.008);
    ctx.fill();
    ctx.stroke();

    if (sel) {
      ctx.strokeStyle = 'rgba(255,255,255,.3)';
      ctx.lineWidth   = 3;
      ctx.stroke();
    } else if (hov) {
      // Soft outer glow for hover
      ctx.strokeStyle = 'rgba(255,255,180,0.25)';
      ctx.lineWidth   = 4;
      ctx.stroke();
    }

    // Label (only when zoomed in enough)
    if (sc > 0.04) {
      const name   = (edit.name ?? bld.tags.name) || '';
      const levels = (edit.levels ?? bld.tags.levels) || '';
      if (!name && !levels) continue;

      const [px, py] = proj(bld.cx, bld.cz);
      const fs       = Math.max(7, Math.min(11, sc * 0.06));
      const label    = (name.length > 20 ? name.slice(0, 18) + '…' : name) + (levels ? ` [${levels}F]` : '');

      ctx.font         = `bold ${fs}px system-ui`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';

      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(8,10,18,.85)';
      ctx.beginPath();
      ctx.roundRect(px - tw / 2 - 2, py - fs / 2 - 1, tw + 4, fs + 2, 2);
      ctx.fill();

      ctx.fillStyle = sel ? '#fff' : hov ? 'rgba(255,255,180,1)' : c.stroke;
      ctx.fillText(label, px, py);
      ctx.textBaseline = 'alphabetic';
    }
  }
}

function _drawTrees(vb, sc) {
  // Already drawn in _drawUserLayers — this space reserved for OSM natural=tree nodes if needed
}

function _drawDrawingPreview() {
  const pts = AppState.ui.drawPoints;
  if (!pts.length) return;

  const tool  = AppState.ui.tool;
  const isLine = ['road', 'path', 'sidewalk', 'terrain'].includes(tool);

  _tracePoly(pts, !isLine);

  const pColors = {
    grass: 'rgba(50,200,80,.5)',
    pitch: 'rgba(40,200,160,.5)',
    water: 'rgba(30,100,220,.5)',
    road:  'rgba(220,160,40,.7)',
    path:  'rgba(200,190,140,.6)',
    sidewalk: 'rgba(200,200,180,.5)',
    terrain:  'rgba(200,140,40,.6)',
  };
  const pColor = pColors[tool] || 'rgba(100,200,255,.5)';

  ctx.setLineDash([4, 3]);
  ctx.strokeStyle = pColor;
  ctx.lineWidth   = 2;
  ctx.lineCap     = 'round';
  ctx.stroke();
  ctx.setLineDash([]);

  if (!isLine) {
    ctx.fillStyle = pColor.replace(/[\d.]+\)$/, '0.12)');
    ctx.fill();
  }

  // Draw vertex dots
  ctx.fillStyle = '#fff';
  for (const [x, z] of pts) {
    const [px, py] = proj(x, z);
    ctx.beginPath();
    ctx.arc(px, py, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

function _drawOverlay(W, H, sc) {
  // Compass
  const margin = 20;
  const ax = W - margin - 10;
  const ay = margin + 30;
  ctx.save();
  ctx.translate(ax, ay);
  ctx.fillStyle = 'rgba(255,255,255,.6)';
  ctx.font      = 'bold 11px system-ui';
  ctx.textAlign = 'center';
  ctx.fillText('N', 0, -14);
  ctx.beginPath();
  ctx.moveTo(0, -10); ctx.lineTo(4, 5); ctx.lineTo(0, 3); ctx.lineTo(-4, 5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Scale bar — show 100 world units
  const [bx1, by1] = proj(AppState.osm.bounds.minX + 20, AppState.osm.bounds.minZ + 40);
  const [bx2]      = proj(AppState.osm.bounds.minX + 120, AppState.osm.bounds.minZ + 40);
  if (bx2 > bx1 + 5) {
    ctx.strokeStyle = 'rgba(255,255,255,.4)';
    ctx.lineWidth   = 1.5;
    ctx.beginPath(); ctx.moveTo(bx1, by1); ctx.lineTo(bx2, by1); ctx.stroke();
    [bx1, bx2].forEach(x => {
      ctx.beginPath(); ctx.moveTo(x, by1 - 3); ctx.lineTo(x, by1 + 3); ctx.stroke();
    });
    ctx.fillStyle  = 'rgba(255,255,255,.4)';
    ctx.font       = '9px system-ui';
    ctx.textAlign  = 'center';
    ctx.fillText('100m', (bx1 + bx2) / 2, by1 - 5);
  }

  // Scale indicator pill
  const scale = AppState.ui.scale;
  ctx.fillStyle = 'rgba(79,136,255,.25)';
  ctx.beginPath();
  ctx.roundRect(10, 10, 180, 20, 4);
  ctx.fill();
  ctx.fillStyle  = '#4f88ff';
  ctx.font       = 'bold 10px system-ui';
  ctx.textAlign  = 'left';
  ctx.fillText(`Scale ${scale}×  ·  1 block = ${(1/scale).toFixed(2)}m real`, 16, 23);
}

// ─── HIT TESTING ──────────────────────────────────────────────────────────────
function _ptInPoly(px, pz, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i], [xj, zj] = pts[j];
    if ((zi > pz) !== (zj > pz) && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function _distToSegment(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq === 0) return Math.hypot(px - ax, pz - az);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lenSq));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

export function hitTest(wx, wz) {
  // Buildings first (most common target)
  for (const bld of AppState.osm.buildings) {
    const edit = getBuildingEdit(bld.id);
    if (edit._deleted) continue;
    if (_ptInPoly(wx, wz, bld.coords)) return { id: bld.id, kind: 'building', obj: bld };
  }
  // User layers
  for (const layer of AppState.edits.userLayers) {
    if (layer.kind === 'tree') {
      if (Math.hypot(wx - layer.cx, wz - layer.cz) < (layer.radius || 15)) {
        return { id: layer.id, kind: 'userLayer', obj: layer };
      }
      continue;
    }
    const isLine = ['road', 'path', 'sidewalk', 'terrain'].includes(layer.kind);
    if (isLine) {
      const sc    = _baseScale() * _zoom;
      const thresh = 8 / sc;
      for (let i = 0; i < layer.coords.length - 1; i++) {
        if (_distToSegment(wx, wz, ...layer.coords[i], ...layer.coords[i + 1]) < thresh) {
          return { id: layer.id, kind: 'userLayer', obj: layer };
        }
      }
    } else if (layer.coords && _ptInPoly(wx, wz, layer.coords)) {
      return { id: layer.id, kind: 'userLayer', obj: layer };
    }
  }
  return null;
}

// ─── EVENT BINDING ────────────────────────────────────────────────────────────
function _bindEvents() {
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  canvas.addEventListener('mousedown', e => {
    // Pan: middle-click, alt+drag, OR pan tool active
    if (e.button === 1 || e.altKey || AppState.ui.tool === 'pan') {
      _dragging = true; _lastMx = e.clientX; _lastMy = e.clientY;
      canvas.style.cursor = 'grabbing';
      e.preventDefault();
    }
  });

  canvas.addEventListener('mousemove', e => {
    if (_dragging) {
      _panX += e.clientX - _lastMx;
      _panY += e.clientY - _lastMy;
      _lastMx = e.clientX; _lastMy = e.clientY;
      draw();
    }
    const r = canvas.getBoundingClientRect();
    const [wx, wz] = unproj(e.clientX - r.left, e.clientY - r.top);
    EventBus.emit('cursor:move', { wx, wz, px: e.clientX - r.left, py: e.clientY - r.top });

    // Hover highlight — run hitTest, redraw only if hover changed
    if (!_dragging && AppState.osm.buildings.length > 0) {
      const hit = hitTest(wx, wz);
      const newId = hit?.id ?? null;
      if (newId !== _hoverId) {
        _hoverId = newId;
        draw();
      }
    }
  });

  canvas.addEventListener('mouseup', () => {
    if (_dragging) { _dragging = false; canvas.style.cursor = ''; }
  });

  canvas.addEventListener('mouseleave', () => {
    _dragging = false;
    if (_hoverId !== null) { _hoverId = null; draw(); }
  });

  canvas.addEventListener('contextmenu', e => e.preventDefault());
}
