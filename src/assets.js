import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import bottleUrl from '../assets/bottle.glb?url';
import fracturedUrl from '../assets/citrus-bottle-fractured.glb?url';
import { MODEL_SCALE } from './config.js';
import { buildVolumeTable } from './liquid.js';

const ANGLES = 48;

function loadGLB(url) {
  return new Promise((resolve, reject) => new GLTFLoader().load(url, resolve, undefined, reject));
}

// Стекло — замкнутая двустенная оболочка, собранная из колец по 96 вершин.
// Достаём кольца внутренней или внешней стенки и приводим к общей сетке углов.
function extractRings(geometry, inner) {
  const pos = geometry.attributes.position;
  const nor = geometry.attributes.normal;
  const byY = new Map();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const r = Math.hypot(x, z);
    if (r < 1e-4) continue;
    const nr = (nor.getX(i) * x + nor.getZ(i) * z) / r;
    if (inner ? nr > -0.05 : nr < 0.05) continue;
    const key = Math.round(y * 1000);
    let ring = byY.get(key);
    if (!ring) byY.set(key, (ring = { y, pts: [] }));
    ring.pts.push([Math.atan2(z, x), r]);
  }
  const rings = [];
  for (const ring of byY.values()) {
    if (ring.pts.length < 24) continue;
    ring.pts.sort((a, b) => a[0] - b[0]);
    const radii = new Float32Array(ANGLES);
    const pts = ring.pts;
    for (let k = 0; k < ANGLES; k++) {
      const a = -Math.PI + (k / ANGLES) * Math.PI * 2;
      // периодическая линейная интерполяция
      let j = pts.findIndex((p) => p[0] >= a);
      if (j < 0) j = 0;
      const p1 = pts[j];
      const p0 = pts[(j - 1 + pts.length) % pts.length];
      let a0 = p0[0], a1 = p1[0];
      if (a0 > a1) a0 -= Math.PI * 2;
      let aa = a;
      if (aa < a0) aa += Math.PI * 2;
      const t = a1 - a0 > 1e-6 ? (aa - a0) / (a1 - a0) : 0;
      radii[k] = p0[1] + (p1[1] - p0[1]) * THREE.MathUtils.clamp(t, 0, 1);
    }
    rings.push({ y: ring.y, radii });
  }
  rings.sort((a, b) => a.y - b.y);
  return rings;
}

function lerpRing(r0, r1, y) {
  const t = (y - r0.y) / (r1.y - r0.y);
  const radii = new Float32Array(ANGLES);
  for (let k = 0; k < ANGLES; k++) radii[k] = r0.radii[k] + (r1.radii[k] - r0.radii[k]) * t;
  return { y, radii };
}

// Профиль объёма жидкости: внутренняя стенка с отступом, закрытая снизу и под крышкой.
function buildLiquidProfile(innerRings) {
  const INSET = 0.013;
  const TOP = 1.8;
  const BOTTOM = 0.08;
  const rings = [];
  for (let i = 0; i < innerRings.length; i++) {
    const r = innerRings[i];
    if (r.y < 0.075) continue;
    if (r.y > TOP) {
      const prev = innerRings[i - 1];
      if (prev.y < TOP) rings.push(lerpRing(prev, r, TOP));
      break;
    }
    rings.push({ y: r.y, radii: r.radii });
  }
  const out = rings.map((r, i) => ({
    y: i === 0 ? Math.max(r.y, BOTTOM + 0.004) : r.y,
    radii: r.radii.map((v) => Math.max(0.02, v - INSET)),
  }));
  // длинную прямую стенку дробим, чтобы нормали и волны были мягче
  const dense = [];
  for (let i = 0; i < out.length; i++) {
    dense.push(out[i]);
    const next = out[i + 1];
    if (next && next.y - out[i].y > 0.2) {
      const n = Math.ceil((next.y - out[i].y) / 0.15);
      for (let k = 1; k < n; k++) dense.push(lerpRing(out[i], next, out[i].y + ((next.y - out[i].y) * k) / n));
    }
  }
  return { rings: dense, bottom: BOTTOM, top: dense[dense.length - 1].y };
}

function buildLiquidGeometry(profile) {
  const { rings, bottom, top } = profile;
  const verts = [];
  const idx = [];
  verts.push(0, bottom, 0);
  for (const ring of rings) {
    for (let k = 0; k < ANGLES; k++) {
      const a = -Math.PI + (k / ANGLES) * Math.PI * 2;
      verts.push(Math.cos(a) * ring.radii[k], ring.y, Math.sin(a) * ring.radii[k]);
    }
  }
  const topIndex = verts.length / 3;
  verts.push(0, top, 0);
  const ringStart = (i) => 1 + i * ANGLES;
  // дно (нормаль вниз)
  for (let k = 0; k < ANGLES; k++) {
    const a = ringStart(0) + k, b = ringStart(0) + ((k + 1) % ANGLES);
    idx.push(0, a, b);
  }
  for (let i = 0; i < rings.length - 1; i++) {
    for (let k = 0; k < ANGLES; k++) {
      const a = ringStart(i) + k;
      const b = ringStart(i) + ((k + 1) % ANGLES);
      const c = ringStart(i + 1) + k;
      const d = ringStart(i + 1) + ((k + 1) % ANGLES);
      idx.push(a, c, b, b, c, d);
    }
  }
  const last = rings.length - 1;
  for (let k = 0; k < ANGLES; k++) {
    const a = ringStart(last) + k, b = ringStart(last) + ((k + 1) % ANGLES);
    idx.push(topIndex, b, a);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // проверим ориентацию: нормаль на боковой стенке должна смотреть наружу
  const n = g.attributes.normal;
  const p = g.attributes.position;
  const probe = ringStart(Math.floor(rings.length / 2));
  if (n.getX(probe) * p.getX(probe) + n.getZ(probe) * p.getZ(probe) < 0) {
    const ix = g.index.array;
    for (let i = 0; i < ix.length; i += 3) {
      const t = ix[i + 1];
      ix[i + 1] = ix[i + 2];
      ix[i + 2] = t;
    }
    g.computeVertexNormals();
  }
  g.computeBoundingSphere();
  return g;
}

function profileRadius(profile, y, angle) {
  const rings = profile.rings;
  if (y < profile.bottom || y > profile.top) return -1;
  let i = 0;
  while (i < rings.length - 2 && rings[i + 1].y < y) i++;
  const r0 = rings[i], r1 = rings[Math.min(i + 1, rings.length - 1)];
  const t = r1.y > r0.y ? THREE.MathUtils.clamp((y - r0.y) / (r1.y - r0.y), 0, 1) : 0;
  const f = ((angle + Math.PI) / (Math.PI * 2)) * ANGLES;
  const k0 = Math.floor(f) % ANGLES, k1 = (k0 + 1) % ANGLES, ft = f - Math.floor(f);
  const ra = r0.radii[k0] + (r0.radii[k1] - r0.radii[k0]) * ft;
  const rb = r1.radii[k0] + (r1.radii[k1] - r1.radii[k0]) * ft;
  if (y < rings[0].y) return ra; // плоское дно
  return ra + (rb - ra) * t;
}

function sampleInterior(profile, count, rng = Math.random) {
  const out = new Float32Array(count * 3);
  let n = 0;
  let guard = 0;
  while (n < count && guard++ < count * 40) {
    const x = (rng() * 2 - 1) * 0.42;
    const z = (rng() * 2 - 1) * 0.42;
    const y = profile.bottom + rng() * (profile.top - profile.bottom);
    const r = profileRadius(profile, y, Math.atan2(z, x));
    if (r > 0 && Math.hypot(x, z) < r) {
      out[n * 3] = x;
      out[n * 3 + 1] = y;
      out[n * 3 + 2] = z;
      n++;
    }
  }
  return out.subarray(0, n * 3);
}

function hullPointsFromRings(rings, yMin, yMax, extra = [], step = 3) {
  const pts = [];
  for (const r of rings) {
    if (r.y < yMin - 1e-4 || r.y > yMax + 1e-4) continue;
    for (let k = 0; k < ANGLES; k += step) {
      const a = -Math.PI + (k / ANGLES) * Math.PI * 2;
      pts.push(Math.cos(a) * r.radii[k] * MODEL_SCALE, r.y * MODEL_SCALE, Math.sin(a) * r.radii[k] * MODEL_SCALE);
    }
  }
  for (const [y, rad] of extra) {
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      pts.push(Math.cos(a) * rad * MODEL_SCALE, y * MODEL_SCALE, Math.sin(a) * rad * MODEL_SCALE);
    }
  }
  return new Float32Array(pts);
}

function subsamplePoints(geometry, max, scale) {
  const pos = geometry.attributes.position;
  const stride = Math.max(1, Math.floor(pos.count / max));
  const pts = [];
  // крайние точки по осям обязательно, чтобы оболочка не «усохла»
  const ext = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (x < pos.getX(ext[0])) ext[0] = i;
    if (x > pos.getX(ext[1])) ext[1] = i;
    if (y < pos.getY(ext[2])) ext[2] = i;
    if (y > pos.getY(ext[3])) ext[3] = i;
    if (z < pos.getZ(ext[4])) ext[4] = i;
    if (z > pos.getZ(ext[5])) ext[5] = i;
  }
  const take = new Set(ext);
  for (let i = 0; i < pos.count; i += stride) take.add(i);
  for (const i of take) pts.push(pos.getX(i) * scale, pos.getY(i) * scale, pos.getZ(i) * scale);
  return new Float32Array(pts);
}

function tuneGlass(mat) {
  mat.side = THREE.FrontSide; // оболочка двустенная и замкнутая — задние грани не нужны
  const tint = mat.color.clone();
  mat.color.lerp(new THREE.Color(1, 1, 1), 0.45);
  mat.roughness = 0.04;
  mat.transmission = 1;
  mat.thickness = 0.08;
  mat.ior = 1.46;
  mat.attenuationColor = tint.lerp(new THREE.Color(1, 1, 1), 0.25);
  mat.attenuationDistance = 1.2;
  mat.specularIntensity = 1;
  mat.clearcoat = 0.35;
  mat.clearcoatRoughness = 0.05;
  mat.envMapIntensity = 1.35;
  // лёгкий френелевский ободок: силуэт стекла читается и на фоне стены, и в полёте
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
float glassRim = pow(1.0 - abs(dot(normal, normalize(vViewPosition))), 3.0);
totalEmissiveRadiance += vec3(0.85, 0.95, 0.92) * glassRim * 0.32;`,
    );
  };
  mat.customProgramCacheKey = () => 'glass-rim-v1';
  mat.needsUpdate = true;
  return mat;
}

export async function loadAssets() {
  const [bottle, fractured] = await Promise.all([loadGLB(bottleUrl), loadGLB(fracturedUrl)]);

  let glassMesh = null;
  let glassMaterial = null;
  const parts = []; // крышка и этикетка: { geometry, material }
  bottle.scene.updateMatrixWorld(true);
  bottle.scene.traverse((o) => {
    if (!o.isMesh) return;
    if (o.material.transmission > 0) {
      glassMesh = o;
      glassMaterial = o.material;
    } else {
      const g = o.geometry.clone();
      g.applyMatrix4(o.matrixWorld);
      parts.push({ geometry: g, material: o.material, name: o.name });
    }
  });
  if (!glassMesh) throw new Error('bottle.glb: не найдено стекло');
  tuneGlass(glassMaterial);
  for (const p of parts) {
    p.material.envMapIntensity = 0.8;
    p.material.side = THREE.FrontSide;
  }

  const glassGeometry = glassMesh.geometry;
  const innerRings = extractRings(glassGeometry, true);
  const outerRings = extractRings(glassGeometry, false);
  const profile = buildLiquidProfile(innerRings);
  const liquidGeometry = buildLiquidGeometry(profile);
  const samples = sampleInterior(profile, 7000);
  const volume = buildVolumeTable(samples);

  // Коллайдер бутылки: три выпуклые оболочки — корпус с плечиками, переход и горлышко с крышкой.
  const hulls = [
    hullPointsFromRings(outerRings, 0, 1.33),
    hullPointsFromRings(outerRings, 1.31, 1.45),
    hullPointsFromRings(outerRings, 1.43, 1.87, [
      [1.85, 0.169],
      [1.998, 0.165],
    ]),
  ];

  // Разбитая версия: осколки стекла, обрывки этикетки (держатся за свой осколок) и крышка.
  const shardMaterial = new THREE.MeshPhysicalMaterial({
    color: glassMaterial.color.clone().lerp(new THREE.Color(1, 1, 1), 0.2),
    metalness: 0,
    roughness: 0.06,
    transparent: true,
    opacity: 0.38,
    clearcoat: 1,
    clearcoatRoughness: 0.04,
    specularIntensity: 1,
    envMapIntensity: 1.8,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const pieces = [];
  const byGroup = new Map();
  fractured.scene.updateMatrixWorld(true);
  for (const node of fractured.scene.children) {
    const ud = node.userData || {};
    const type = ud.piece_type || (node.name.startsWith('Cap') ? 'cap' : 'glass');
    const meshes = [];
    node.traverse((o) => {
      if (o.isMesh) meshes.push(o);
    });
    if (!meshes.length) continue;
    const visuals = meshes.map((m) => ({
      geometry: m.geometry,
      material: type === 'glass' ? shardMaterial : m.material,
      // меши-примитивы внутри узла не смещены относительно узла
    }));
    for (const v of visuals) {
      if (v.material !== shardMaterial) v.material.envMapIntensity = 0.8;
    }
    const piece = {
      name: node.name,
      type,
      group: ud.physics_group || node.name,
      rest: node.position.clone(),
      visuals,
      hull: type === 'label' ? null : subsamplePoints(meshes[0].geometry, type === 'cap' ? 40 : 36, MODEL_SCALE),
      volume: ud.volume || 0.004,
      children: [],
    };
    pieces.push(piece);
    if (type === 'glass' || type === 'cap') byGroup.set(piece.group, piece);
  }
  // этикетки прикрепляем к осколку стекла той же физической группы
  const roots = [];
  for (const p of pieces) {
    if (p.type === 'label') {
      const host = byGroup.get(p.group);
      if (host) host.children.push(p);
      else roots.push({ ...p, hull: null });
    } else {
      roots.push(p);
    }
  }

  return {
    glassGeometry,
    glassMaterial,
    parts,
    liquidGeometry,
    profile,
    samples,
    volume,
    hulls,
    shardPieces: roots,
    shardMaterial,
  };
}
