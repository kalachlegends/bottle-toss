import * as THREE from 'three';
import { GRAVITY, MODEL_SCALE } from './config.js';

// ---------------------------------------------------------------------------
// Таблица объёма. Поверхность жидкости — плоскость с нормалью N. Чтобы при наклоне
// жидкость не «исчезала» и не «прибавлялась», смещение плоскости d подбираем так,
// чтобы под ней оставалась заданная доля объёма. Для этого заранее разбрасываем
// точки внутри сосуда и для каждого угла наклона берём квантиль их проекций.
// Форма сосуда почти осесимметрична, поэтому таблица двумерная: (угол, доля).
// ---------------------------------------------------------------------------
export function buildVolumeTable(samples) {
  const n = samples.length / 3;
  const NT = 72;
  const NF = 41;
  const rx = new Float32Array(n);
  const ry = new Float32Array(n);
  let seed = 1234567;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < n; i++) {
    const x = samples[i * 3], y = samples[i * 3 + 1], z = samples[i * 3 + 2];
    rx[i] = Math.hypot(x, z) * Math.cos(rnd() * Math.PI * 2); // азимутальное усреднение
    ry[i] = y;
  }
  const table = new Float32Array(NT * NF);
  const proj = new Float32Array(n);
  for (let t = 0; t < NT; t++) {
    const th = (t / (NT - 1)) * Math.PI;
    const s = Math.sin(th), c = Math.cos(th);
    for (let i = 0; i < n; i++) proj[i] = rx[i] * s + ry[i] * c;
    proj.sort();
    for (let f = 0; f < NF; f++) {
      const q = (f / (NF - 1)) * (n - 1);
      const i0 = Math.floor(q);
      const i1 = Math.min(i0 + 1, n - 1);
      table[t * NF + f] = proj[i0] + (proj[i1] - proj[i0]) * (q - i0);
    }
  }
  // центр масс жидкости в вертикальной бутылке — для центробежного эффекта в полёте
  const ys = Float32Array.from(ry).sort();
  const comY = new Float32Array(NF);
  let acc = 0;
  let k = 0;
  for (let f = 0; f < NF; f++) {
    const upto = Math.max(1, Math.round((f / (NF - 1)) * n));
    while (k < upto) acc += ys[k++];
    comY[f] = acc / Math.max(1, k);
  }
  return {
    NT,
    NF,
    table,
    comY,
    lookup(cosTheta, fill) {
      const th = Math.acos(Math.min(1, Math.max(-1, cosTheta)));
      const ft = (th / Math.PI) * (NT - 1);
      const ff = Math.min(1, Math.max(0, fill)) * (NF - 1);
      const t0 = Math.min(NT - 2, Math.floor(ft));
      const f0 = Math.min(NF - 2, Math.floor(ff));
      const a = ft - t0, b = ff - f0;
      const v00 = table[t0 * NF + f0], v01 = table[t0 * NF + f0 + 1];
      const v10 = table[(t0 + 1) * NF + f0], v11 = table[(t0 + 1) * NF + f0 + 1];
      return (v00 * (1 - b) + v01 * b) * (1 - a) + (v10 * (1 - b) + v11 * b) * a;
    },
    restComY(fill) {
      return comY[Math.round(Math.min(1, Math.max(0, fill)) * (NF - 1))];
    },
  };
}

// ---------------------------------------------------------------------------
// Инерция жидкости. Нормаль поверхности N живёт в мировых координатах и тянется
// пружиной с затуханием к направлению «эффективной гравитации» в системе бутылки:
// g − a (ускорение сосуда) плюс центробежная составляющая от вращения.
// Поворот бутылки частично увлекает поверхность (вязкая связь), отсюда
// запаздывание и раскачка; в покое N выравнивается строго против гравитации.
// ---------------------------------------------------------------------------
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _g = new THREE.Vector3();
const _t = new THREE.Vector3();

export class LiquidSim {
  constructor() {
    this.n = new THREE.Vector3(0, 1, 0);
    this.nv = new THREE.Vector3();
    this.target = new THREE.Vector3(0, 1, 0);
    this.prevVel = new THREE.Vector3();
    this.acc = new THREE.Vector3();
    this.hasPrev = false;
    this.energy = 0;
    this.omega0 = 2 * Math.PI * 1.75;
    this.zeta = 0.1;
    this.coupling = 2.2;
  }

  reset() {
    this.n.set(0, 1, 0);
    this.nv.set(0, 0, 0);
    this.target.set(0, 1, 0);
    this.acc.set(0, 0, 0);
    this.hasPrev = false;
    this.energy = 0;
  }

  /**
   * @param dt шаг
   * @param linvel скорость сосуда (мир)
   * @param angvel угловая скорость (мир)
   * @param liquidOffset вектор от центра масс бутылки до центра масс жидкости (мир)
   */
  step(dt, linvel, angvel, liquidOffset) {
    if (this.hasPrev) {
      _v.subVectors(linvel, this.prevVel).divideScalar(dt);
    } else {
      _v.set(0, 0, 0);
    }
    this.prevVel.copy(linvel);
    this.hasPrev = true;
    if (_v.lengthSq() > 45 * 45) _v.setLength(45);
    this.acc.lerp(_v, 1 - Math.exp(-dt * 32));

    _g.set(0, -GRAVITY, 0).sub(this.acc);
    // центробежное ускорение в системе вращающегося сосуда: −ω×(ω×r)
    _w.crossVectors(angvel, liquidOffset);
    _t.crossVectors(angvel, _w);
    _g.sub(_t);
    const len = _g.length();
    if (len > 0.8) {
      _t.copy(_g).multiplyScalar(-1 / len);
      // при слабой эффективной гравитации цель меняем мягче
      const k = Math.min(1, (len - 0.8) / 3);
      this.target.lerp(_t, k).normalize();
    }

    const w0 = this.omega0;
    // пружина к цели
    _v.subVectors(this.target, this.n).multiplyScalar(w0 * w0);
    _v.addScaledVector(this.nv, -2 * this.zeta * w0);
    // вязкое увлечение вращением стенок
    _w.crossVectors(angvel, this.n).sub(this.nv).multiplyScalar(this.coupling);
    _v.add(_w);
    this.nv.addScaledVector(_v, dt);
    this.n.addScaledVector(this.nv, dt);
    if (this.n.lengthSq() < 1e-6) this.n.copy(this.target);
    this.n.normalize();
    this.nv.addScaledVector(this.n, -this.n.dot(this.nv));

    // не даём поверхности отклониться от цели больше чем на ~75°
    const c = this.n.dot(this.target);
    if (c < 0.26) {
      _t.copy(this.n).addScaledVector(this.target, 0.26 - c).normalize();
      this.n.copy(_t);
      this.nv.multiplyScalar(0.5);
    }
    const e = Math.min(1, this.nv.length() / 6 + this.n.angleTo(this.target) * 0.6);
    this.energy += (e - this.energy) * (1 - Math.exp(-dt * 6));
  }
}

// ---------------------------------------------------------------------------
// Материал жидкости: обычный PBR, но фрагменты выше плоскости отбрасываются,
// а задние грани (видимые через срез) рисуются как ровная поверхность с
// нормалью N — трюк из шейдера жидкости Half-Life: Alyx.
// ---------------------------------------------------------------------------
export function createLiquidMaterial() {
  const uniforms = {
    uPlaneN: { value: new THREE.Vector3(0, 1, 0) },
    uPlaneD: { value: 0 },
    uWaveAmp: { value: 0 },
    uWaveK: { value: 70 },
    uTime: { value: 0 },
    uPhase: { value: Math.random() * 10 },
    uSurface: { value: new THREE.Color(1, 1, 1) },
    uGlow: { value: 0.14 },
  };
  const mat = new THREE.MeshStandardMaterial({
    color: 0xff8800,
    roughness: 0.12,
    metalness: 0,
    side: THREE.DoubleSide,
    envMapIntensity: 0.9,
  });
  mat.userData.uniforms = uniforms;
  mat.customProgramCacheKey = () => 'liquid-v3';
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLiqWorld;')
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\nvLiqWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vLiqWorld;
uniform vec3 uPlaneN;
uniform float uPlaneD;
uniform float uWaveAmp;
uniform float uWaveK;
uniform float uTime;
uniform float uPhase;
uniform vec3 uSurface;
uniform float uGlow;
float liqWaveAt(vec3 p, vec3 t1, vec3 t2) {
  return uWaveAmp * (0.62 * sin(dot(p, t1) * uWaveK + uTime * 7.3 + uPhase)
       + 0.38 * sin(dot(p, t2) * uWaveK * 1.37 - uTime * 9.1 + uPhase * 1.7));
}`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
vec3 liqT1 = normalize(cross(uPlaneN, abs(uPlaneN.z) < 0.9 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0)));
vec3 liqT2 = cross(uPlaneN, liqT1);
float liqH = dot(vLiqWorld, uPlaneN) - uPlaneD;
if (liqH > liqWaveAt(vLiqWorld, liqT1, liqT2)) discard;
vec3 liqRd = normalize(vLiqWorld - cameraPosition);
float liqDen = dot(liqRd, uPlaneN);
float liqColumn = liqDen < -1e-3 ? liqH / liqDen : 1.0;
vec3 liqPs = vLiqWorld - liqRd * liqColumn;
float liqFoam = 1.0 - smoothstep(0.0, 0.01, liqColumn);
float liqMeniscus = 1.0 - smoothstep(0.0, 0.004, liqWaveAt(vLiqWorld, liqT1, liqT2) - liqH);`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
if (!gl_FrontFacing) {
  diffuseColor.rgb = mix(uSurface, vec3(1.0), liqFoam * 0.18);
} else {
  float liqDepth = clamp(-liqH / 0.11, 0.0, 1.0);
  diffuseColor.rgb *= mix(1.06, 0.7, liqDepth);
  diffuseColor.rgb = mix(diffuseColor.rgb, uSurface, liqMeniscus * 0.65);
}`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
if (!gl_FrontFacing) roughnessFactor = 0.32;`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
if (!gl_FrontFacing) {
  float e = 0.002;
  float h0 = liqWaveAt(liqPs, liqT1, liqT2);
  float hx = liqWaveAt(liqPs + liqT1 * e, liqT1, liqT2);
  float hy = liqWaveAt(liqPs + liqT2 * e, liqT1, liqT2);
  vec3 liqN = normalize(uPlaneN - liqT1 * (hx - h0) / e - liqT2 * (hy - h0) / e);
  normal = normalize((viewMatrix * vec4(liqN, 0.0)).xyz);
}`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
float liqFres = pow(1.0 - abs(dot(normal, normalize(vViewPosition))), 2.0);
totalEmissiveRadiance += diffuseColor.rgb * (gl_FrontFacing ? uGlow + liqFres * 0.22 : uGlow * 1.4);`,
      );
  };
  return mat;
}

const _o = new THREE.Vector3();
const _u = new THREE.Vector3();

/** Обновить плоскость жидкости по текущей (отрисовываемой) позе бутылки. */
export function updateLiquidUniforms(mat, object, sim, fill, volume, time) {
  const u = mat.userData.uniforms;
  object.matrixWorld.decompose(_o, _q, _s);
  _u.set(0, 1, 0).applyQuaternion(_q);
  const d = volume.lookup(sim.n.dot(_u), fill) * MODEL_SCALE;
  u.uPlaneN.value.copy(sim.n);
  u.uPlaneD.value = _o.dot(sim.n) + d;
  u.uWaveAmp.value = 0.0035 * sim.energy;
  u.uTime.value = time;
}
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
