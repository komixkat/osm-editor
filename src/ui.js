/**
 * ui.js — Sidebar, properties panel, toolbar rendering
 * All DOM manipulation is centralised here.
 */

import { AppState, EventBus, EV, updateBuildingEdit, updateUserLayer, getBuildingEdit, deleteUserLayer } from './state.js';
import { TOOLS, TOOL_OPTIONS, setTool } from './tools.js';
import { draw }          from './renderer2d.js';
import { rebuild, setCameraMode, getCameraMode, toggleGrid, toggleBlockGrid, toggleAxes } from './renderer3d.js';
import { exportSessionJSON, importSessionJSON } from './session.js';
import { buildExportOSM } from './parser.js';

// ─── INIT ──────────────────────────────────────────────────────────────────────
export function initUI() {
  _buildToolbar();
  _buildSidebar();
  _bindEventListeners();
  showTab('props');
}

// ─── TOOLBAR ─────────────────────────────────────────────────────────────────
function _buildToolbar() {
  const tb = document.getElementById('toolbar');
  if (!tb) return;

  // Group tool buttons
  const groups = {
    select: ['select'],
    paint:  ['grass', 'pitch', 'water'],
    place:  ['tree'],
    draw:   ['road', 'path', 'sidewalk', 'terrain'],
    edit:   ['del'],
  };

  let html = '';
  for (const [group, names] of Object.entries(groups)) {
    html += `<div class="tb-group" data-group="${group}">`;
    for (const name of names) {
      const def = TOOLS[name];
      const key = def.key ? ` <kbd>${def.key.toUpperCase()}</kbd>` : '';
      html += `<button class="tbtn" id="tbtn-${name}" data-tool="${name}" title="${def.label} ${def.key ? `(${def.key})` : ''}">${def.label}${key}</button>`;
    }
    html += '</div>';
  }
  tb.innerHTML = html;

  // Click handlers
  tb.addEventListener('click', e => {
    const btn = e.target.closest('[data-tool]');
    if (btn) setTool(btn.dataset.tool);
  });
}

function _updateToolbarActive(tool) {
  document.querySelectorAll('.tbtn[data-tool]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === tool);
  });
}

// ─── SIDEBAR ─────────────────────────────────────────────────────────────────
function _buildSidebar() {
  const tabs = document.getElementById('sb-tabs');
  if (!tabs) return;
  tabs.innerHTML = `
    <div class="sbtab active" data-tab="props">Properties</div>
    <div class="sbtab" data-tab="layers">Layers</div>
    <div class="sbtab" data-tab="view">View</div>
    <div class="sbtab" data-tab="export">Export</div>
  `;
  tabs.addEventListener('click', e => {
    const tab = e.target.closest('[data-tab]');
    if (tab) showTab(tab.dataset.tab);
  });
}

export function showTab(name) {
  document.querySelectorAll('.sbtab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  const body = document.getElementById('sb-body');
  if (!body) return;

  if (name === 'props')  body.innerHTML = _renderPropsTab();
  if (name === 'layers') body.innerHTML = _renderLayersTab();
  if (name === 'view')   body.innerHTML = _renderViewTab();
  if (name === 'export') body.innerHTML = _renderExportTab();

  _bindTabEvents(name);
}

// ─── PROPS TAB ────────────────────────────────────────────────────────────────
function _renderPropsTab() {
  const { selectedId, selectedKind, tool } = AppState.ui;

  if (!selectedId) return _renderToolHelp(tool);

  if (selectedKind === 'building') return _renderBuildingProps(selectedId);
  if (selectedKind === 'userLayer') {
    const layer = AppState.edits.userLayers.find(l => l.id === selectedId);
    return layer ? _renderLayerProps(layer) : _renderToolHelp(tool);
  }
  return _renderToolHelp(tool);
}

function _renderToolHelp(tool) {
  const hints = {
    select:   'Click a building or feature to select and edit.',
    grass:    'Click points to trace a grass area.\nDouble-click or Enter to close.',
    pitch:    'Same as grass — marks a sports pitch/field.',
    water:    'Trace water body outline. Double-click to finish.',
    tree:     'Single click to place a tree cluster.\nConfigure species and radius below.',
    road:     'Click points along road. Double-click to finish.',
    path:     'Trace footpath/steps. Double-click to finish.',
    sidewalk: 'Draw sidewalk edge line. Double-click to finish.',
    terrain:  'Mark elevation change (stairs/slope). Double-click to finish.',
    del:      'Click any building or feature to delete it.',
  };

  let extras = '';
  if (tool === 'tree') extras = _renderTreeOptions();
  if (tool === 'road') extras = _renderRoadOptions();
  if (tool === 'path') extras = _renderPathOptions();
  if (tool === 'terrain') extras = _renderTerrainOptions();

  return `
    <div class="props-hint">
      <div class="hint-tool">${TOOLS[tool]?.label || tool}</div>
      <div class="hint-text">${(hints[tool] || '').replace(/\n/g, '<br>')}</div>
    </div>
    ${extras}
    <div class="shortcuts-hint">
      <strong>Shortcuts:</strong> S select · G grass · P pitch · W water · T tree · R road · F path · X delete<br>
      Enter/dblclick = finish · Esc = cancel · Ctrl+Z = undo · Alt+drag = pan
    </div>
  `;
}

function _renderBuildingProps(osmId) {
  const bld  = AppState.osm.buildings.find(b => b.id === osmId);
  if (!bld) return '<p>Building not found</p>';
  const edit = getBuildingEdit(osmId);

  const types = ['university','dormitory','residential','commercial','industrial','hotel','yes'];
  const typeLabels = { university:'Academic/Uni', dormitory:'Hostel/Dorm', residential:'Residential', commercial:'Commercial', industrial:'Industrial', hotel:'Hotel/Guest', yes:'General' };
  const curType = edit.type || bld.tags.type || 'yes';

  return `
    <div class="props-section">
      <div class="props-title">Building</div>
      <div class="props-id">OSM ID: ${osmId}</div>
    </div>
    <label class="field-label">Name</label>
    <input class="field-input" id="p-name" value="${_esc(edit.name ?? bld.tags.name ?? '')}" placeholder="Building name">

    <label class="field-label">Floors <span class="field-sub">/ height in metres</span></label>
    <div class="field-row">
      <input class="field-input" id="p-levels" type="number" min="1" max="100" value="${_esc(edit.levels ?? bld.tags.levels ?? '')}" placeholder="floors">
      <input class="field-input" id="p-height" type="number" min="3" max="500" value="${_esc(edit.height ?? bld.tags.height ?? '')}" placeholder="metres">
    </div>
    <div class="field-hint">Floors × ${AppState.ui.floorHeight}m = height (height overrides if set)</div>

    <label class="field-label">Type</label>
    <div class="chip-grid">
      ${types.map(t => `<div class="chip ${curType === t ? 'sel' : ''}" data-type="${t}">${typeLabels[t]}</div>`).join('')}
    </div>

    <label class="field-label">Overhang / building part</label>
    <label class="toggle-row">
      <input type="checkbox" id="p-roof" ${edit.roof ? 'checked' : ''}>
      <span>Mark as building:part (upper floors only / overhang)</span>
    </label>

    <label class="field-label">Notes</label>
    <textarea class="field-input" id="p-note" rows="2" placeholder="Build notes...">${_esc(edit.note ?? '')}</textarea>

    <div class="props-meta">
      <span>X≈${Math.round(bld.cx)}  Z≈${Math.round(bld.cz)}</span>
      <span>${bld.coords.length} nodes</span>
    </div>

    <button class="btn-apply" id="apply-bld">Apply changes</button>
    <button class="btn-danger" id="del-bld">Remove from export</button>
  `;
}

function _renderLayerProps(layer) {
  if (layer.kind === 'tree') {
    return `
      <div class="props-section">
        <div class="props-title">Tree cluster</div>
      </div>
      <label class="field-label">Species</label>
      <select class="field-input" id="p-species">
        ${['oak','bamboo','palm','pine'].map(s => `<option value="${s}" ${layer.species===s?'selected':''}>${s}</option>`).join('')}
      </select>
      <label class="field-label">Cluster radius (blocks)</label>
      <input class="field-input" id="p-radius" type="number" value="${layer.radius||15}" min="3" max="200">
      <button class="btn-apply" id="apply-layer">Apply</button>
      <button class="btn-danger" id="del-layer">Delete tree</button>
    `;
  }
  if (layer.kind === 'road') {
    return `
      <div class="props-section"><div class="props-title">Road</div></div>
      <label class="field-label">Name</label>
      <input class="field-input" id="p-rname" value="${_esc(layer.name||'')}">
      <label class="field-label">Type</label>
      <select class="field-input" id="p-rtype">
        ${['motorway','primary','secondary','tertiary','residential','service','unclassified'].map(t=>`<option value="${t}" ${layer.roadType===t?'selected':''}>${t}</option>`).join('')}
      </select>
      <button class="btn-apply" id="apply-layer">Apply</button>
      <button class="btn-danger" id="del-layer">Delete road</button>
    `;
  }
  if (layer.kind === 'terrain') {
    return `
      <div class="props-section"><div class="props-title">Terrain: ${layer.elevType}</div></div>
      <label class="field-label">Type</label>
      <select class="field-input" id="p-etype">
        ${['stairs','slope','cliff','platform'].map(t=>`<option value="${t}" ${layer.elevType===t?'selected':''}>${t}</option>`).join('')}
      </select>
      <label class="field-label">Height change (blocks)</label>
      <input class="field-input" id="p-elev" type="number" value="${layer.elev||3}" min="1" max="200">
      <button class="btn-apply" id="apply-layer">Apply</button>
      <button class="btn-danger" id="del-layer">Delete marker</button>
    `;
  }

  return `
    <div class="props-section"><div class="props-title">${layer.kind} area</div></div>
    <div class="field-hint">${layer.coords?.length||0} vertices</div>
    <button class="btn-danger" id="del-layer">Delete</button>
  `;
}

// ─── TOOL OPTIONS FRAGMENTS ───────────────────────────────────────────────────
function _renderTreeOptions() {
  const o = TOOL_OPTIONS.tree;
  return `
    <div class="options-section">
      <label class="field-label">Species</label>
      <select class="field-input" id="opt-species">
        ${['oak','bamboo','palm','pine'].map(s=>`<option value="${s}" ${o.species===s?'selected':''}>${s}</option>`).join('')}
      </select>
      <label class="field-label">Cluster radius</label>
      <input class="field-input" id="opt-radius" type="number" value="${o.radius}" min="3" max="200">
    </div>
  `;
}

function _renderRoadOptions() {
  const o = TOOL_OPTIONS.road;
  return `
    <div class="options-section">
      <label class="field-label">Road type</label>
      <select class="field-input" id="opt-roadtype">
        ${['motorway','primary','secondary','tertiary','residential','service'].map(t=>`<option value="${t}" ${o.type===t?'selected':''}>${t}</option>`).join('')}
      </select>
      <label class="field-label">Name (optional)</label>
      <input class="field-input" id="opt-roadname" value="${_esc(o.name||'')}" placeholder="Road name">
    </div>
  `;
}

function _renderPathOptions() {
  const o = TOOL_OPTIONS.path;
  return `
    <div class="options-section">
      <label class="field-label">Path type</label>
      <select class="field-input" id="opt-pathtype">
        ${['footway','steps','cycleway','bridleway'].map(t=>`<option value="${t}" ${o.pathType===t?'selected':''}>${t}</option>`).join('')}
      </select>
    </div>
  `;
}

function _renderTerrainOptions() {
  const o = TOOL_OPTIONS.terrain;
  return `
    <div class="options-section">
      <label class="field-label">Elevation type</label>
      <select class="field-input" id="opt-elevtype">
        ${['stairs','slope','cliff','platform'].map(t=>`<option value="${t}" ${o.elevType===t?'selected':''}>${t}</option>`).join('')}
      </select>
      <label class="field-label">Height change (blocks)</label>
      <input class="field-input" id="opt-elev" type="number" value="${o.elev}" min="1" max="200">
    </div>
  `;
}

// ─── LAYERS TAB ───────────────────────────────────────────────────────────────
function _renderLayersTab() {
  const { buildings } = AppState.osm;
  const { userLayers } = AppState.edits;

  const namedBuildings = buildings.filter(b => {
    const e = getBuildingEdit(b.id);
    return !e._deleted && ((e.name ?? b.tags.name) || (e.levels ?? b.tags.levels));
  });

  const layerCounts = {
    grass:    userLayers.filter(l => l.kind === 'grass').length,
    pitch:    userLayers.filter(l => l.kind === 'pitch').length,
    water:    userLayers.filter(l => l.kind === 'water').length,
    tree:     userLayers.filter(l => l.kind === 'tree').length,
    road:     userLayers.filter(l => l.kind === 'road').length,
    path:     userLayers.filter(l => l.kind === 'path').length,
    sidewalk: userLayers.filter(l => l.kind === 'sidewalk').length,
    terrain:  userLayers.filter(l => l.kind === 'terrain').length,
  };

  return `
    <div class="layer-summary">
      <div class="layer-row"><div class="ldot" style="background:#4d88ff"></div>Buildings<span>${buildings.length} (${namedBuildings.length} edited)</span></div>
      <div class="layer-row"><div class="ldot" style="background:#3c8c3c"></div>Grass<span>${layerCounts.grass}</span></div>
      <div class="layer-row"><div class="ldot" style="background:#2ec4b6"></div>Pitch<span>${layerCounts.pitch}</span></div>
      <div class="layer-row"><div class="ldot" style="background:#1848b0"></div>Water<span>${layerCounts.water}</span></div>
      <div class="layer-row"><div class="ldot" style="background:#1a6030"></div>Trees<span>${layerCounts.tree}</span></div>
      <div class="layer-row"><div class="ldot" style="background:#c89020"></div>Roads<span>${layerCounts.road}</span></div>
      <div class="layer-row"><div class="ldot" style="background:#806040"></div>Paths<span>${layerCounts.path}</span></div>
      <div class="layer-row"><div class="ldot" style="background:#707060"></div>Sidewalks<span>${layerCounts.sidewalk}</span></div>
      <div class="layer-row"><div class="ldot" style="background:#804010"></div>Terrain<span>${layerCounts.terrain}</span></div>
    </div>
    <hr class="divider">
    <button class="btn-secondary" id="clear-user-layers">Clear all added layers</button>
    <hr class="divider">
    <div class="field-label">Named / edited buildings</div>
    <div class="bld-list">
      ${namedBuildings.slice(0, 50).map(b => {
        const e = getBuildingEdit(b.id);
        const nm = e.name ?? b.tags.name ?? '?';
        const lv = e.levels ?? b.tags.levels ?? '';
        return `<div class="bld-item" data-id="${b.id}">${nm}${lv ? ` [${lv}F]` : ''}</div>`;
      }).join('')}
      ${namedBuildings.length > 50 ? `<div class="field-hint">…and ${namedBuildings.length - 50} more</div>` : ''}
    </div>
  `;
}

// ─── VIEW TAB ─────────────────────────────────────────────────────────────────
function _renderViewTab() {
  return `
    <label class="field-label">Scale (blocks per real metre)</label>
    <select class="field-input" id="opt-scale">
      ${[1,2,3,4,5].map(s=>`<option value="${s}" ${AppState.ui.scale===s?'selected':''}>${s}× (1 block = ${(1/s).toFixed(2)}m)</option>`).join('')}
    </select>

    <label class="field-label">Floor height (metres)</label>
    <input class="field-input" id="opt-floorh" type="number" value="${AppState.ui.floorHeight}" min="2" max="10" step="0.5">
    <div class="field-hint">Each floor = this many real metres. Default 3m.</div>

    <hr class="divider">
    <div class="field-label">3D Camera</div>
    <div class="btn-group">
      <button class="btn-toggle ${getCameraMode()==='fly'?'active':''}" id="cam-fly">✈ Fly (WASD)</button>
      <button class="btn-toggle ${getCameraMode()==='orbit'?'active':''}" id="cam-orbit">◎ Orbit</button>
    </div>
    <div class="field-hint">Fly: click 3D view to lock mouse, then WASD + mouse to move. Shift=fast, Ctrl=slow.</div>

    <hr class="divider">
    <div class="field-label">3D Overlays</div>
    <label class="toggle-row"><input type="checkbox" id="tog-grid" checked><span>World grid</span></label>
    <label class="toggle-row"><input type="checkbox" id="tog-blockgrid"><span>Block grid (Minecraft blocks)</span></label>
    <label class="toggle-row"><input type="checkbox" id="tog-axes" checked><span>Axes helper</span></label>
  `;
}

// ─── EXPORT TAB ────────────────────────────────────────────────────────────────
function _renderExportTab() {
  const hasOSM = !!AppState.osm.fileName;
  return `
    <div class="export-section">
      <div class="field-label">Session</div>
      <button class="btn-primary" id="exp-session">↓ Save session JSON</button>
      <label class="btn-secondary file-btn">
        ↑ Load session JSON <input type="file" accept=".json" id="imp-session" style="display:none">
      </label>
      <div class="field-hint">Session JSON stores all your edits without the OSM data. Re-upload the OSM + session to restore.</div>
    </div>
    <hr class="divider">
    <div class="export-section">
      <div class="field-label">Patched OSM export</div>
      ${hasOSM
        ? `<button class="btn-primary" id="exp-osm">↓ Export patched .osm</button>
           <div class="field-hint">Exports original OSM with your building edits (floors, names, types) and user layers (grass, water, trees, roads) baked in as OSM tags. Feed directly into Arnis.</div>`
        : `<div class="field-hint">Load an .osm file first to enable OSM export.</div>`
      }
    </div>
    <hr class="divider">
    <div class="field-label">Statistics</div>
    <div class="stats-grid">
      <div>Buildings</div><div>${AppState.osm.buildings.length}</div>
      <div>Roads</div><div>${AppState.osm.roads.length}</div>
      <div>Landuse</div><div>${AppState.osm.landuse.length}</div>
      <div>Edited</div><div>${AppState.edits.buildings.size}</div>
      <div>User layers</div><div>${AppState.edits.userLayers.length}</div>
    </div>
  `;
}

// ─── TAB EVENT BINDING ────────────────────────────────────────────────────────
function _bindTabEvents(tab) {
  const body = document.getElementById('sb-body');

  if (tab === 'props') {
    // Building property apply
    body.querySelector('#apply-bld')?.addEventListener('click', () => {
      const id = AppState.ui.selectedId;
      if (!id) return;
      const patch = {
        name:   document.getElementById('p-name')?.value ?? '',
        levels: document.getElementById('p-levels')?.value ?? '',
        height: document.getElementById('p-height')?.value ?? '',
        roof:   document.getElementById('p-roof')?.checked ?? false,
        note:   document.getElementById('p-note')?.value ?? '',
      };
      const chip = body.querySelector('.chip.sel');
      if (chip) patch.type = chip.dataset.type;
      updateBuildingEdit(id, patch);
      EventBus.emit(EV.FEATURE_UPDATED, { id });
      EventBus.emit(EV.REBUILD_3D);
      EventBus.emit(EV.STATUS, 'Building updated');
      draw();
    });

    // Building type chips
    body.querySelectorAll('.chip[data-type]').forEach(chip => {
      chip.addEventListener('click', () => {
        body.querySelectorAll('.chip[data-type]').forEach(c => c.classList.remove('sel'));
        chip.classList.add('sel');
      });
    });

    // Delete building
    body.querySelector('#del-bld')?.addEventListener('click', () => {
      const id = AppState.ui.selectedId;
      if (!id) return;
      if (confirm('Remove from export? (Can be undone with Ctrl+Z)')) {
        updateBuildingEdit(id, { _deleted: true });
        AppState.ui.selectedId = null;
        EventBus.emit(EV.FEATURE_DELETED, { id });
        EventBus.emit(EV.REBUILD_3D);
        showTab('props');
        draw();
      }
    });

    // User layer apply
    body.querySelector('#apply-layer')?.addEventListener('click', () => {
      const id = AppState.ui.selectedId;
      if (!id) return;
      const layer = AppState.edits.userLayers.find(l => l.id === id);
      if (!layer) return;
      const patch = {};
      if (layer.kind === 'tree') {
        patch.species = document.getElementById('p-species')?.value;
        patch.radius  = parseFloat(document.getElementById('p-radius')?.value) || 15;
      } else if (layer.kind === 'road') {
        patch.name     = document.getElementById('p-rname')?.value || '';
        patch.roadType = document.getElementById('p-rtype')?.value;
      } else if (layer.kind === 'terrain') {
        patch.elevType = document.getElementById('p-etype')?.value;
        patch.elev     = parseFloat(document.getElementById('p-elev')?.value) || 3;
      }
      updateUserLayer(id, patch);
      EventBus.emit(EV.FEATURE_UPDATED, { id });
      EventBus.emit(EV.REBUILD_3D);
      draw();
    });

    body.querySelector('#del-layer')?.addEventListener('click', () => {
      const id = AppState.ui.selectedId;
      if (!id) return;
      deleteUserLayer(id);
      AppState.ui.selectedId = null;
      EventBus.emit(EV.LAYER_DELETED, { id });
      EventBus.emit(EV.REBUILD_3D);
      showTab('props');
      draw();
    });

    // Tool option live-binding
    ['opt-species','opt-radius','opt-roadtype','opt-roadname','opt-pathtype','opt-elevtype','opt-elev'].forEach(id => {
      document.getElementById(id)?.addEventListener('change', e => {
        const v = e.target.type === 'number' ? parseFloat(e.target.value) : e.target.value;
        if (id === 'opt-species')   TOOL_OPTIONS.tree.species = v;
        if (id === 'opt-radius')    TOOL_OPTIONS.tree.radius  = v;
        if (id === 'opt-roadtype')  TOOL_OPTIONS.road.type    = v;
        if (id === 'opt-roadname')  TOOL_OPTIONS.road.name    = v;
        if (id === 'opt-pathtype')  TOOL_OPTIONS.path.pathType = v;
        if (id === 'opt-elevtype')  TOOL_OPTIONS.terrain.elevType = v;
        if (id === 'opt-elev')      TOOL_OPTIONS.terrain.elev = v;
      });
    });
  }

  if (tab === 'layers') {
    body.querySelector('#clear-user-layers')?.addEventListener('click', () => {
      if (confirm('Clear all grass, water, trees, roads etc?')) {
        AppState.edits.userLayers = [];
        EventBus.emit(EV.REBUILD_3D);
        draw();
        showTab('layers');
      }
    });
    body.querySelectorAll('.bld-item[data-id]').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.id;
        AppState.ui.selectedId   = id;
        AppState.ui.selectedKind = 'building';
        showTab('props');
        EventBus.emit(EV.FEATURE_SELECTED, { id, kind: 'building' });
        draw();
      });
    });
  }

  if (tab === 'view') {
    document.getElementById('opt-scale')?.addEventListener('change', e => {
      AppState.ui.scale = parseInt(e.target.value);
      EventBus.emit(EV.SCALE_CHANGED, AppState.ui.scale);
      draw();
    });
    document.getElementById('opt-floorh')?.addEventListener('change', e => {
      AppState.ui.floorHeight = parseFloat(e.target.value) || 3;
      EventBus.emit(EV.REBUILD_3D);
    });
    document.getElementById('cam-fly')?.addEventListener('click', () => {
      setCameraMode('fly');
      document.getElementById('cam-fly')?.classList.add('active');
      document.getElementById('cam-orbit')?.classList.remove('active');
    });
    document.getElementById('cam-orbit')?.addEventListener('click', () => {
      setCameraMode('orbit');
      document.getElementById('cam-orbit')?.classList.add('active');
      document.getElementById('cam-fly')?.classList.remove('active');
    });
    document.getElementById('tog-grid')?.addEventListener('change', e => toggleGrid(e.target.checked));
    document.getElementById('tog-blockgrid')?.addEventListener('change', e => toggleBlockGrid(e.target.checked));
    document.getElementById('tog-axes')?.addEventListener('change', e => toggleAxes(e.target.checked));
  }

  if (tab === 'export') {
    document.getElementById('exp-session')?.addEventListener('click', exportSessionJSON);
    document.getElementById('imp-session')?.addEventListener('change', async e => {
      const file = e.target.files[0];
      if (file) {
        try { await importSessionJSON(file); showTab('layers'); }
        catch (err) { setStatus('Error: ' + err.message, true); }
      }
    });
    document.getElementById('exp-osm')?.addEventListener('click', () => {
      if (!window._rawOSMString) { setStatus('Original OSM not in memory — re-upload the file first', true); return; }
      const xml  = buildExportOSM(window._rawOSMString);
      const blob = new Blob([xml], { type: 'application/xml' });
      const a    = document.createElement('a');
      a.href     = URL.createObjectURL(blob);
      a.download = (AppState.osm.fileName?.replace('.osm','') || 'export') + '_patched.osm';
      a.click();
      URL.revokeObjectURL(a.href);
      EventBus.emit(EV.STATUS, 'Patched OSM exported');
    });
  }
}

// ─── TOP-LEVEL EVENT BINDING ──────────────────────────────────────────────────
function _bindEventListeners() {
  EventBus.on(EV.TOOL_CHANGED,      name => { _updateToolbarActive(name); showTab('props'); });
  EventBus.on(EV.FEATURE_SELECTED,  hit  => { showTab('props'); });
  EventBus.on(EV.OSM_LOADED,        info => {
    document.getElementById('file-name-display').textContent = info.fileName;
    document.getElementById('file-stats').textContent = `${info.buildings} buildings · ${info.roads} roads · ${info.elapsed}ms`;
    showTab('props');
  });
  EventBus.on(EV.STATUS, msg => setStatus(msg));
}

// ─── STATUS BAR ──────────────────────────────────────────────────────────────
export function setStatus(msg, isError = false) {
  const el = document.getElementById('status-msg');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

// ─── UTIL ─────────────────────────────────────────────────────────────────────
function _esc(str) { return String(str ?? '').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }
