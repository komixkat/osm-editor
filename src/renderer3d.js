/**
 * renderer3d.js — Three.js 3D viewport
 * Buildings extruded by floors, free-fly + orbit camera,
 * toggleable block grid, Minecraft-style WASD controls.
 */

import { AppState, EventBus, EV, getBuildingEdit } from './state.js';

// Three.js loaded from CDN as global (window.THREE)
let THREE;

// ─── SCENE STATE ──────────────────────────────────────────────────────────────
let renderer, scene, camera, orbitControls;
let _canvas3d = null;
let _animId   = null;
let _active   = false;

// Camera mode
let _cameraMode = 'fly'; // 'fly' | 'orbit'

// Fly camera state
const _fly = {
  yaw: -Math.PI / 2, pitch: 0,
  vel: { x: 0, y: 0, z: 0 },
  keys: {},
  speed: 50,
  sensitivity: 0.002,
  pointerLocked: false,
};

// Scene objects
let _buildingGroup = null;
let _groundGroup   = null;
let _gridHelper    = null;
let _blockGrid     = null;
let _axesHelper    = null;

const _meshById = new Map(); // osmId → mesh (for selection highlight)

// ─── INIT ──────────────────────────────────────────────────────────────────────
export async function initRenderer3D(canvasEl) {
  _canvas3d = canvasEl;

  // Wait for THREE to be available
  THREE = window.THREE;
  if (!THREE) throw new Error('Three.js not loaded');

  // Renderer
  renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0c0e14);
  scene.fog = new THREE.Fog(0x0c0e14, 500, 4000);

  // Camera
  camera = new THREE.PerspectiveCamera(70, canvasEl.width / canvasEl.height, 0.5, 8000);
  camera.position.set(0, 200, 0);
  camera.lookAt(0, 0, 0);

  // Lighting
  _setupLighting();

  // Orbit controls (lazy-loaded fallback)
  _setupOrbitControls();

  // Groups
  _buildingGroup = new THREE.Group();
  _groundGroup   = new THREE.Group();
  scene.add(_buildingGroup, _groundGroup);

  // Grid
  _setupGrid();

  // Events
  EventBus.on(EV.OSM_LOADED,   () => { if (_active) rebuild(); });
  EventBus.on(EV.REBUILD_3D,   () => { if (_active) rebuild(); });
  EventBus.on(EV.FEATURE_UPDATED, (d) => { if (_active) _updateBuildingMesh(d?.id); });

  _bindFlyControls();
}

function _setupLighting() {
  // Ambient
  const ambient = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambient);

  // Sun
  const sun = new THREE.DirectionalLight(0xffeedd, 1.2);
  sun.position.set(500, 800, 300);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far  = 3000;
  sun.shadow.camera.left = sun.shadow.camera.bottom = -1500;
  sun.shadow.camera.right = sun.shadow.camera.top   =  1500;
  scene.add(sun);

  // Fill
  const fill = new THREE.DirectionalLight(0xaaccff, 0.4);
  fill.position.set(-300, 400, -200);
  scene.add(fill);
}

function _setupOrbitControls() {
  // OrbitControls is loaded inline below via a minimal implementation
  // rather than a CDN import to avoid CORS issues with modules
  orbitControls = _createOrbitControls(camera, _canvas3d);
}

// ─── MINIMAL ORBIT CONTROLS ───────────────────────────────────────────────────
// A lightweight orbit implementation that doesn't require importing from three/examples
function _createOrbitControls(cam, domEl) {
  let isDown = false, lastX = 0, lastY = 0;
  let spherical = { theta: 0, phi: Math.PI / 4, radius: 400 };
  let target = new THREE.Vector3(0, 0, 0);

  function update() {
    const sin = Math.sin, cos = Math.cos;
    const phi = Math.max(0.01, Math.min(Math.PI - 0.01, spherical.phi));
    cam.position.set(
      target.x + spherical.radius * sin(phi) * cos(spherical.theta),
      target.y + spherical.radius * cos(phi),
      target.z + spherical.radius * sin(phi) * sin(spherical.theta)
    );
    cam.lookAt(target);
  }

  domEl.addEventListener('mousedown', e => { if (_cameraMode !== 'orbit') return; isDown = true; lastX = e.clientX; lastY = e.clientY; });
  domEl.addEventListener('mouseup',   () => { isDown = false; });
  domEl.addEventListener('mousemove', e => {
    if (!isDown || _cameraMode !== 'orbit') return;
    spherical.theta -= (e.clientX - lastX) * 0.005;
    spherical.phi   -= (e.clientY - lastY) * 0.005;
    lastX = e.clientX; lastY = e.clientY;
    update();
  });
  domEl.addEventListener('wheel', e => {
    if (_cameraMode !== 'orbit') return;
    spherical.radius = Math.max(10, Math.min(5000, spherical.radius * (e.deltaY > 0 ? 1.1 : 0.9)));
    update();
    e.preventDefault();
  }, { passive: false });

  return { update, spherical, target, _update: update };
}

// ─── GRID ─────────────────────────────────────────────────────────────────────
function _setupGrid() {
  // Large subtle world grid
  _gridHelper = new THREE.GridHelper(10000, 100, 0x223344, 0x1a2530);
  _gridHelper.position.y = 0.1;
  scene.add(_gridHelper);

  // Block grid (toggleable, shows Minecraft block boundaries)
  _blockGrid = _buildBlockGrid();
  _blockGrid.visible = false;
  scene.add(_blockGrid);

  // Axes
  _axesHelper = new THREE.AxesHelper(200);
  scene.add(_axesHelper);
}

function _buildBlockGrid() {
  const scale = AppState.ui.scale;
  const blockSize = scale; // 1 block = `scale` world units
  const range = 1000;
  const geo  = new THREE.BufferGeometry();
  const verts = [];

  for (let x = -range; x <= range; x += blockSize) {
    verts.push(x, 0.5, -range, x, 0.5, range);
  }
  for (let z = -range; z <= range; z += blockSize) {
    verts.push(-range, 0.5, z, range, 0.5, z);
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  const mat = new THREE.LineBasicMaterial({ color: 0x334455, opacity: 0.4, transparent: true });
  return new THREE.LineSegments(geo, mat);
}

export function toggleGrid(on) {
  if (_gridHelper) _gridHelper.visible = on;
}

export function toggleBlockGrid(on) {
  if (_blockGrid) _blockGrid.visible = on;
}

export function toggleAxes(on) {
  if (_axesHelper) _axesHelper.visible = on;
}

// ─── BUILD SCENE ──────────────────────────────────────────────────────────────
export function rebuild() {
  _meshById.clear();
  _buildingGroup.clear();
  _groundGroup.clear();

  if (!AppState.osm.buildings.length) return;

  _buildGround();
  _buildBuildings();
  _buildRoads();
  _buildUserLayers();
  _centerCamera();
}

function _buildGround() {
  const { minX, maxX, minZ, maxZ } = AppState.osm.bounds;
  const w = maxX - minX, d = maxZ - minZ;
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;

  const geo = new THREE.PlaneGeometry(w + 200, d + 200);
  const mat = new THREE.MeshLambertMaterial({ color: 0x1a2210 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(cx, 0, -cz); // note: OSM Z is north, Three.js Z is -north
  mesh.receiveShadow = true;
  _groundGroup.add(mesh);

  // Landuse coloured patches
  for (const lu of AppState.osm.landuse) {
    const color = _landuseColor(lu.tags.type);
    if (!color) continue;
    const shape = _coordsToShape(lu.coords);
    if (!shape) continue;
    const geo2 = new THREE.ShapeGeometry(shape);
    const mat2 = new THREE.MeshLambertMaterial({ color, transparent: true, opacity: 0.6 });
    const m = new THREE.Mesh(geo2, mat2);
    m.rotation.x = -Math.PI / 2;
    m.position.y = 0.3;
    _groundGroup.add(m);
  }
}

function _landuseColor(type) {
  const map = {
    grass: 0x2a6a20, park: 0x2a7a20, pitch: 0x1a8060,
    forest: 0x1a5020, water: 0x1a4090, farmland: 0x6a6020,
    residential: 0x3a3a30, commercial: 0x5a4020,
  };
  return map[type] ? new THREE.Color(map[type]) : null;
}

function _buildBuildings() {
  const floorH = AppState.ui.floorHeight;

  for (const bld of AppState.osm.buildings) {
    const edit = getBuildingEdit(bld.id);
    if (edit._deleted) continue;

    const levels = parseInt(edit.levels ?? bld.tags.levels ?? '1') || 1;
    const height = parseFloat(edit.height ?? bld.tags.height ?? '') || levels * floorH;

    const mesh = _extrudeBuilding(bld.coords, height, bld.id);
    if (mesh) {
      _buildingGroup.add(mesh);
      _meshById.set(bld.id, mesh);
    }
  }
}

function _extrudeBuilding(coords, height, id) {
  const shape = _coordsToShape(coords);
  if (!shape) return null;

  const extrudeSettings = {
    steps: 1, depth: height,
    bevelEnabled: false,
  };
  const geo = new THREE.ExtrudeGeometry(shape, extrudeSettings);

  const color = _buildingColor(id);
  const mat = new THREE.MeshLambertMaterial({ color });
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x000000, opacity: 0.3, transparent: true });

  const mesh  = new THREE.Mesh(geo, mat);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);

  const group = new THREE.Group();
  group.add(mesh, edges);
  group.rotation.x = -Math.PI / 2;
  group.userData.osmId = id;
  group.userData.selectable = true;

  return group;
}

function _buildingColor(osmId) {
  const bld  = AppState.osm.buildings.find(b => b.id === osmId);
  const edit = getBuildingEdit(osmId);
  const type = edit.type || bld?.tags.type || 'yes';
  const name = (edit.name ?? bld?.tags.name ?? '').toLowerCase();

  if (type === 'dormitory' || name.includes('hostel')) return new THREE.Color(0x8a3a18);
  if (name.match(/lab|institute|college|lecture|university/) || type === 'university') return new THREE.Color(0x1a3870);
  if (type === 'residential' || name.match(/house|quarter|residenc/)) return new THREE.Color(0x1e5a28);
  if (type === 'commercial') return new THREE.Color(0x7a4a10);
  if (name.match(/station|metro|rail/)) return new THREE.Color(0x601860);
  return new THREE.Color(0x2a2e3a);
}

function _coordsToShape(coords) {
  if (!coords || coords.length < 3) return null;
  const shape = new THREE.Shape();
  // Three.js ExtrudeGeometry uses X/Y for the shape cross-section.
  // Our world: x=East, z=North → shape X=world x, shape Y=-world z
  shape.moveTo(coords[0][0], -coords[0][1]);
  for (let i = 1; i < coords.length; i++) {
    shape.lineTo(coords[i][0], -coords[i][1]);
  }
  shape.closePath();
  return shape;
}

function _buildRoads() {
  const allRoads = [...AppState.osm.roads, ...AppState.edits.userLayers.filter(l => l.kind === 'road')];
  const roadColors = {
    motorway: 0xc07010, trunk: 0xb06010, primary: 0xa05010,
    secondary: 0x906020, tertiary: 0x805030, residential: 0x604020,
    service: 0x503818, unclassified: 0x503818,
  };

  for (const road of allRoads) {
    if (!road.coords || road.coords.length < 2) continue;
    const hw = road.tags?.highway || road.roadType || 'service';
    const color = new THREE.Color(roadColors[hw] || 0x503818);

    const points = road.coords.map(([x, z]) => new THREE.Vector3(x, 0.5, -z));
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    const mat = new THREE.LineBasicMaterial({ color });
    _groundGroup.add(new THREE.Line(geo, mat));
  }
}

function _buildUserLayers() {
  for (const layer of AppState.edits.userLayers) {
    if (layer.kind === 'road') continue; // already in _buildRoads

    if (layer.kind === 'tree') {
      _buildTree(layer);
      continue;
    }

    if (!layer.coords || layer.coords.length < 3) continue;

    if (['grass', 'pitch', 'water'].includes(layer.kind)) {
      const shape = _coordsToShape(layer.coords);
      if (!shape) continue;
      const geo = new THREE.ShapeGeometry(shape);
      const colors = { grass: 0x2a7a20, pitch: 0x1a8060, water: 0x1040a0 };
      const mat = new THREE.MeshLambertMaterial({ color: colors[layer.kind] || 0x333333, transparent: true, opacity: 0.7 });
      const m = new THREE.Mesh(geo, mat);
      m.rotation.x = -Math.PI / 2;
      m.position.y = 0.4;
      _groundGroup.add(m);
    }
  }
}

function _buildTree(layer) {
  const r = (layer.radius || 15) * 0.5;
  const h = r * 2.5;

  // Trunk
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(r * 0.1, r * 0.15, h * 0.4, 6),
    new THREE.MeshLambertMaterial({ color: 0x5a3010 })
  );
  trunk.position.set(layer.cx, h * 0.2, -layer.cz);

  // Canopy — use sphere for oak/palm, cone for pine, cylinders for bamboo
  let canopy;
  const colors = { oak: 0x2a6a20, palm: 0x3a8020, pine: 0x1a5020, bamboo: 0x408030 };
  const col = new THREE.Color(colors[layer.species] || 0x2a6a20);

  if (layer.species === 'pine') {
    canopy = new THREE.Mesh(new THREE.ConeGeometry(r, h, 6), new THREE.MeshLambertMaterial({ color: col }));
    canopy.position.set(layer.cx, h * 0.6, -layer.cz);
  } else if (layer.species === 'bamboo') {
    canopy = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.12, r * 0.12, h, 5), new THREE.MeshLambertMaterial({ color: col }));
    canopy.position.set(layer.cx, h / 2, -layer.cz);
  } else {
    canopy = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), new THREE.MeshLambertMaterial({ color: col }));
    canopy.position.set(layer.cx, h * 0.7, -layer.cz);
  }

  _groundGroup.add(trunk, canopy);
}

function _updateBuildingMesh(osmId) {
  if (!osmId || !_meshById.has(osmId)) return;
  const old = _meshById.get(osmId);
  _buildingGroup.remove(old);
  _meshById.delete(osmId);

  const bld = AppState.osm.buildings.find(b => b.id === osmId);
  if (!bld) return;
  const edit = getBuildingEdit(osmId);
  if (edit._deleted) return;

  const levels = parseInt(edit.levels ?? bld.tags.levels ?? '1') || 1;
  const height = parseFloat(edit.height ?? bld.tags.height ?? '') || levels * AppState.ui.floorHeight;
  const mesh = _extrudeBuilding(bld.coords, height, osmId);
  if (mesh) { _buildingGroup.add(mesh); _meshById.set(osmId, mesh); }
}

// ─── CAMERA ───────────────────────────────────────────────────────────────────
function _centerCamera() {
  const { minX, maxX, minZ, maxZ } = AppState.osm.bounds;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const sz = Math.max(maxX - minX, maxZ - minZ);

  if (_cameraMode === 'orbit') {
    orbitControls.target.set(cx, 0, -cz);
    orbitControls.spherical.radius = sz * 0.7;
    orbitControls._update();
  } else {
    camera.position.set(cx, sz * 0.4, -cz + sz * 0.5);
    camera.lookAt(cx, 0, -cz);
    _fly.yaw   = -Math.PI / 2;
    _fly.pitch = -0.3;
  }
}

export function setCameraMode(mode) {
  _cameraMode = mode;
  if (mode === 'orbit') {
    _fly.pointerLocked = false;
    document.exitPointerLock?.();
  }
}

export function getCameraMode() { return _cameraMode; }

// ─── FLY CONTROLS ─────────────────────────────────────────────────────────────
function _bindFlyControls() {
  document.addEventListener('keydown', e => { _fly.keys[e.code] = true; });
  document.addEventListener('keyup',   e => { _fly.keys[e.code] = false; });

  _canvas3d.addEventListener('click', () => {
    if (_cameraMode === 'fly' && _active) {
      _canvas3d.requestPointerLock();
    }
  });

  document.addEventListener('pointerlockchange', () => {
    _fly.pointerLocked = document.pointerLockElement === _canvas3d;
  });

  document.addEventListener('mousemove', e => {
    if (!_fly.pointerLocked || _cameraMode !== 'fly') return;
    _fly.yaw   -= e.movementX * _fly.sensitivity;
    _fly.pitch -= e.movementY * _fly.sensitivity;
    _fly.pitch  = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, _fly.pitch));
  });
}

function _updateFlyCamera(dt) {
  if (!_fly.pointerLocked) return;

  const speed = _fly.speed * (_fly.keys['ShiftLeft'] ? 4 : _fly.keys['ControlLeft'] ? 0.25 : 1);
  const forward = new THREE.Vector3(-Math.sin(_fly.yaw) * Math.cos(_fly.pitch), -Math.sin(_fly.pitch), -Math.cos(_fly.yaw) * Math.cos(_fly.pitch));
  const right   = new THREE.Vector3(Math.cos(_fly.yaw), 0, -Math.sin(_fly.yaw));
  const up      = new THREE.Vector3(0, 1, 0);

  const move = new THREE.Vector3();
  if (_fly.keys['KeyW'] || _fly.keys['ArrowUp'])    move.addScaledVector(forward,  1);
  if (_fly.keys['KeyS'] || _fly.keys['ArrowDown'])  move.addScaledVector(forward, -1);
  if (_fly.keys['KeyA'] || _fly.keys['ArrowLeft'])  move.addScaledVector(right,   -1);
  if (_fly.keys['KeyD'] || _fly.keys['ArrowRight']) move.addScaledVector(right,    1);
  if (_fly.keys['Space'])                            move.addScaledVector(up,       1);
  if (_fly.keys['ShiftLeft'] && !_fly.keys['KeyW']) move.addScaledVector(up,      -1);

  if (move.lengthSq() > 0) {
    move.normalize().multiplyScalar(speed * dt);
    camera.position.add(move);
  }

  // Apply look direction
  camera.rotation.order = 'YXZ';
  camera.rotation.y     = _fly.yaw;
  camera.rotation.x     = _fly.pitch;
}

// ─── SELECTION ────────────────────────────────────────────────────────────────
const _raycaster = new THREE.Raycaster();
const _mouse3d   = new THREE.Vector2();

export function hitTest3D(px, py) {
  const rect = _canvas3d.getBoundingClientRect();
  _mouse3d.x =  ((px - rect.left) / rect.width)  * 2 - 1;
  _mouse3d.y = -((py - rect.top)  / rect.height) * 2 + 1;
  _raycaster.setFromCamera(_mouse3d, camera);
  const hits = _raycaster.intersectObjects(_buildingGroup.children, true);
  if (!hits.length) return null;
  let obj = hits[0].object;
  while (obj && !obj.userData.osmId) obj = obj.parent;
  return obj?.userData.osmId ?? null;
}

export function highlightBuilding(osmId) {
  _meshById.forEach((group, id) => {
    group.children.forEach(child => {
      if (child.isMesh) {
        child.material.emissive?.set(id === osmId ? 0x334466 : 0x000000);
      }
    });
  });
}

// ─── RENDER LOOP ──────────────────────────────────────────────────────────────
let _lastTime = performance.now();

function _animate() {
  if (!_active) return;
  _animId = requestAnimationFrame(_animate);

  const now = performance.now();
  const dt  = Math.min((now - _lastTime) / 1000, 0.1);
  _lastTime = now;

  if (_cameraMode === 'fly') {
    _updateFlyCamera(dt);
  }

  renderer.render(scene, camera);
}

export function startRenderLoop() {
  if (_active) return;
  _active = true;
  _lastTime = performance.now();
  _animate();
}

export function stopRenderLoop() {
  _active = false;
  if (_animId) cancelAnimationFrame(_animId);
  _animId = null;
}

export function resizeRenderer(w, h) {
  if (!renderer) return;
  renderer.setSize(w, h, false);
  if (camera) {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}
