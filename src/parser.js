/**
 * parser.js — OSM XML parser
 * Handles large files by streaming through nodes/ways without building
 * a full DOM representation. Projects lat/lon → flat X/Z in one pass.
 */

import { AppState, EventBus, EV, pushHistory } from './state.js';

// ─── PROJECTION ───────────────────────────────────────────────────────────────
// Converts (lat, lon) to (x, z) in metres from the SW corner of the bounding box.
// x = West→East, z = South→North

let _projOriginLat = 0;
let _projOriginLon = 0;
const DEG_TO_M_LAT = 111320; // metres per degree latitude (constant)

function degreesToMetresLon(lat) {
  return Math.cos((lat * Math.PI) / 180) * 111320;
}

export function project(lat, lon) {
  const x = (lon - _projOriginLon) * degreesToMetresLon(_projOriginLat);
  const z = (lat - _projOriginLat) * DEG_TO_M_LAT;
  return [x, z];
}

// ─── MAIN PARSE FUNCTION ──────────────────────────────────────────────────────

/**
 * parseOSM(xmlString) → populates AppState.osm
 * Uses a two-pass approach:
 *   Pass 1: collect all nodes (id → {lat,lon})
 *   Pass 2: process ways, projecting node refs on the fly
 * This avoids building a full node lookup table per-way.
 */
export function parseOSM(xmlString, fileName) {
  const t0 = performance.now();

  // Parse XML
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'application/xml');

  const parseError = doc.querySelector('parsererror');
  if (parseError) throw new Error('Invalid OSM XML: ' + parseError.textContent);

  // ── Extract bounds ──────────────────────────────────────────────────────────
  const boundsEl = doc.querySelector('bounds');
  if (!boundsEl) throw new Error('No <bounds> element in OSM file');

  const minlat = parseFloat(boundsEl.getAttribute('minlat'));
  const minlon = parseFloat(boundsEl.getAttribute('minlon'));
  const maxlat = parseFloat(boundsEl.getAttribute('maxlat'));
  const maxlon = parseFloat(boundsEl.getAttribute('maxlon'));

  _projOriginLat = minlat;
  _projOriginLon = minlon;

  // ── Pass 1: collect nodes ───────────────────────────────────────────────────
  const nodeMap = new Map();
  const nodeEls = doc.getElementsByTagName('node');
  for (let i = 0; i < nodeEls.length; i++) {
    const n = nodeEls[i];
    nodeMap.set(n.getAttribute('id'), {
      lat: parseFloat(n.getAttribute('lat')),
      lon: parseFloat(n.getAttribute('lon')),
    });
  }

  // ── Pass 2: process ways ────────────────────────────────────────────────────
  const buildings = [];
  const roads = [];
  const landuse = [];

  const wayEls = doc.getElementsByTagName('way');

  for (let i = 0; i < wayEls.length; i++) {
    const way = wayEls[i];
    const id = way.getAttribute('id');

    // Read tags
    const tags = {};
    const tagEls = way.getElementsByTagName('tag');
    for (let j = 0; j < tagEls.length; j++) {
      tags[tagEls[j].getAttribute('k')] = tagEls[j].getAttribute('v');
    }

    // Resolve node refs → projected coordinates
    const ndEls = way.getElementsByTagName('nd');
    const coords = [];
    for (let j = 0; j < ndEls.length; j++) {
      const node = nodeMap.get(ndEls[j].getAttribute('ref'));
      if (node) coords.push(project(node.lat, node.lon));
    }
    if (coords.length < 2) continue;

    // Compute centroid
    const cx = coords.reduce((s, [x]) => s + x, 0) / coords.length;
    const cz = coords.reduce((s, [, z]) => s + z, 0) / coords.length;

    // Classify
    if ('building' in tags || tags['building:part']) {
      buildings.push({
        id,
        coords,
        cx, cz,
        tags: {
          name:    tags.name || tags.alt_name || '',
          levels:  tags['building:levels'] || tags.levels || '',
          height:  tags.height || '',
          type:    tags.building || 'yes',
          amenity: tags.amenity || '',
          note:    '',
        },
      });
    } else if ('highway' in tags) {
      if (!['footway', 'steps', 'path', 'cycleway', 'track', 'proposed'].includes(tags.highway)) {
        roads.push({ id, coords, cx, cz, tags: { highway: tags.highway, name: tags.name || '', lanes: tags.lanes || '' } });
      } else {
        // Include footways/paths as their own category
        roads.push({ id, coords, cx, cz, tags: { highway: tags.highway, name: tags.name || '', lanes: '' } });
      }
    } else if ('landuse' in tags || 'leisure' in tags || 'natural' in tags || tags.amenity) {
      landuse.push({
        id, coords, cx, cz,
        tags: {
          type: tags.landuse || tags.leisure || tags.natural || tags.amenity || 'area',
          name: tags.name || '',
        },
      });
    }
  }

  // ── Compute projected bounds ─────────────────────────────────────────────────
  const [projMaxX, projMaxZ] = project(maxlat, maxlon);
  const [projMinX, projMinZ] = project(minlat, minlon);

  // ── Populate AppState ────────────────────────────────────────────────────────
  AppState.osm.nodes      = nodeMap;
  AppState.osm.buildings  = buildings;
  AppState.osm.roads      = roads;
  AppState.osm.landuse    = landuse;
  AppState.osm.bounds     = { minX: projMinX, maxX: projMaxX, minZ: projMinZ, maxZ: projMaxZ };
  AppState.osm.fileName   = fileName;

  const elapsed = (performance.now() - t0).toFixed(0);
  console.log(`[parser] Parsed ${fileName}: ${buildings.length} buildings, ${roads.length} roads, ${landuse.length} landuse in ${elapsed}ms`);

  // Push a clean snapshot so Ctrl+Z always has a "before any edits" state to return to
  AppState._history = [];
  AppState._historyPtr = -1;
  pushHistory();

  EventBus.emit(EV.OSM_LOADED, {
    buildings: buildings.length,
    roads: roads.length,
    landuse: landuse.length,
    elapsed,
    fileName,
  });

  // Seed history so Ctrl+Z never undoes to a blank state
  AppState._history    = [];
  AppState._historyPtr = -1;
  pushHistory();
}

// ─── OSM EXPORT ──────────────────────────────────────────────────────────────
/**
 * exportPatchedOSM() → returns XML string with user edits baked in.
 * Re-projects coordinates back to lat/lon using inverse of project().
 */
export function unproject(x, z) {
  const lon = x / degreesToMetresLon(_projOriginLat) + _projOriginLon;
  const lat = z / DEG_TO_M_LAT + _projOriginLat;
  return { lat, lon };
}

export function buildExportOSM(originalXmlString) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(originalXmlString, 'application/xml');

  const { buildings, edits } = AppState.osm;

  for (const bld of buildings) {
    const edit = AppState.edits.buildings.get(bld.id);
    if (!edit) continue;

    const wayEl = doc.querySelector(`way[id="${bld.id}"]`);
    if (!wayEl) continue;

    // Apply edits as tags
    const tagMap = {
      'building': edit.type || bld.tags.type || 'yes',
      'name': edit.name ?? bld.tags.name,
      'building:levels': edit.levels ?? bld.tags.levels,
      'height': edit.height ?? bld.tags.height,
      'building:part': edit.roof ? 'yes' : null,
      'note': edit.note ?? bld.tags.note,
    };

    for (const [k, v] of Object.entries(tagMap)) {
      if (v === null || v === undefined || v === '') {
        const existing = wayEl.querySelector(`tag[k="${k}"]`);
        if (existing) wayEl.removeChild(existing);
        continue;
      }
      let tagEl = wayEl.querySelector(`tag[k="${k}"]`);
      if (!tagEl) {
        tagEl = doc.createElement('tag');
        tagEl.setAttribute('k', k);
        wayEl.appendChild(tagEl);
      }
      tagEl.setAttribute('v', String(v));
    }
  }

  // Add user layers as new ways/nodes
  let nextFakeId = -1;
  const userLayers = AppState.edits.userLayers;

  for (const layer of userLayers) {
    if (layer.kind === 'tree') {
      // Trees → natural=tree node
      const nodeEl = doc.createElement('node');
      const { lat, lon } = unproject(layer.cx, layer.cz);
      nodeEl.setAttribute('id', String(nextFakeId--));
      nodeEl.setAttribute('lat', lat.toFixed(7));
      nodeEl.setAttribute('lon', lon.toFixed(7));
      nodeEl.setAttribute('action', 'modify');
      const tagEl = doc.createElement('tag');
      tagEl.setAttribute('k', 'natural'); tagEl.setAttribute('v', 'tree');
      const specTag = doc.createElement('tag');
      specTag.setAttribute('k', 'species:wikidata'); specTag.setAttribute('v', layer.species || 'oak');
      nodeEl.append(tagEl, specTag);
      doc.querySelector('osm').appendChild(nodeEl);
      continue;
    }

    if (!layer.coords || layer.coords.length < 2) continue;

    const wayEl = doc.createElement('way');
    wayEl.setAttribute('id', String(nextFakeId--));
    wayEl.setAttribute('action', 'modify');

    // Create nodes for each coord
    for (const [x, z] of layer.coords) {
      const nid = nextFakeId--;
      const nodeEl = doc.createElement('node');
      const { lat, lon } = unproject(x, z);
      nodeEl.setAttribute('id', String(nid));
      nodeEl.setAttribute('lat', lat.toFixed(7));
      nodeEl.setAttribute('lon', lon.toFixed(7));
      nodeEl.setAttribute('action', 'modify');
      doc.querySelector('osm').appendChild(nodeEl);

      const ndEl = doc.createElement('nd');
      ndEl.setAttribute('ref', String(nid));
      wayEl.appendChild(ndEl);
    }

    // Tags by kind
    const tagDefs = {
      grass:     { landuse: 'grass' },
      pitch:     { leisure: 'pitch' },
      water:     { natural: 'water', water: 'pond' },
      road:      { highway: layer.roadType || 'service', name: layer.name || '' },
      path:      { highway: layer.pathType || 'footway' },
      sidewalk:  { footway: 'sidewalk', highway: 'footway' },
      terrain:   { barrier: layer.elevType === 'cliff' ? 'retaining_wall' : 'kerb', 'height': String(layer.elev || 1) },
    };
    const tags = tagDefs[layer.kind] || {};
    for (const [k, v] of Object.entries(tags)) {
      if (!v) continue;
      const t = doc.createElement('tag');
      t.setAttribute('k', k); t.setAttribute('v', v);
      wayEl.appendChild(t);
    }
    doc.querySelector('osm').appendChild(wayEl);
  }

  return new XMLSerializer().serializeToString(doc);
}
