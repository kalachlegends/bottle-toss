import * as THREE from 'three';
import { THROW, BOTTLE_HEIGHT, HOLD, GRAVITY } from './config.js';

const _ray = new THREE.Ray();
const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _plane = new THREE.Plane();
const _ndc = new THREE.Vector2();

/** Расстояние между лучом и отрезком [a,b]. */
function raySegmentDistance(ray, a, b) {
  return Math.sqrt(ray.distanceSqToSegment(a, b));
}

/**
 * Мышь и палец: захват бутылки, перетаскивание, бросок.
 * Скорость жеста считаем по последним ~90 мс движения (с учётом coalesced-событий),
 * нормируем на размер экрана — так бросок одинаково ощущается на телефоне и мониторе.
 */
export class Input {
  constructor(game, dom) {
    this.game = game;
    this.dom = dom;
    this.active = null;
    this.holdTarget = new THREE.Vector3();
    this.upSpeed = 0;
    this.stats = { throws: 0, autoThrows: 0, drops: 0 };
    dom.addEventListener('pointerdown', (e) => this.onDown(e));
    dom.addEventListener('pointermove', (e) => this.onMove(e));
    dom.addEventListener('pointerup', (e) => this.onUp(e));
    dom.addEventListener('pointercancel', (e) => this.onUp(e, true));
    dom.addEventListener('lostpointercapture', (e) => {
      if (this.active && e.pointerId === this.active.id) this.onUp(e, true);
    });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get norm() {
    return Math.min(window.innerHeight, window.innerWidth * 1.4);
  }

  _toNdc(x, y, out) {
    const r = this.dom.getBoundingClientRect();
    return out.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
  }

  _rayFrom(x, y) {
    const cam = this.game.camera;
    this._toNdc(x, y, _ndc);
    _ray.origin.setFromMatrixPosition(cam.matrixWorld);
    _ray.direction.set(_ndc.x, _ndc.y, 0.5).unproject(cam).sub(_ray.origin).normalize();
    return _ray;
  }

  _pointOnPlaneZ(x, y, z, out) {
    const ray = this._rayFrom(x, y);
    _plane.set(_v.set(0, 0, 1), -z);
    return ray.intersectPlane(_plane, out);
  }

  onDown(e) {
    this.game.sound.unlock();
    if (this.active) return;
    if (e.button !== undefined && e.button > 0) return;
    const tray = this.game.tray;
    const ray = this._rayFrom(e.clientX, e.clientY);
    let best = null;
    let bestD = e.pointerType === 'touch' ? 0.115 : 0.095;
    for (const b of tray.live) {
      if (b.state !== 'tray' || !b.body || b.broken) continue;
      const root = b.visual.root;
      _a.set(0, -0.035, 0).applyQuaternion(root.quaternion).add(root.position);
      _b.set(0, BOTTLE_HEIGHT, 0).applyQuaternion(root.quaternion).add(root.position);
      const d = raySegmentDistance(ray, _a, _b);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    if (!best) return;
    const t = best.body.translation();
    const hit = this._pointOnPlaneZ(e.clientX, e.clientY, t.z, new THREE.Vector3());
    if (!hit) return;
    const offset = hit.sub(_v.set(t.x, t.y, t.z));
    offset.x = THREE.MathUtils.clamp(offset.x, -0.05, 0.05);
    offset.y = THREE.MathUtils.clamp(offset.y, 0.01, BOTTLE_HEIGHT * 0.85);
    offset.z = 0;
    best.grab();
    this.active = {
      id: e.pointerId,
      bottle: best,
      offset,
      z: t.z,
      samples: [],
      x: e.clientX,
      y: e.clientY,
    };
    this._sample(e.timeStamp, e.clientX, e.clientY);
    this._updateTarget();
    try {
      this.dom.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    e.preventDefault();
  }

  _sample(t, x, y) {
    const s = this.active.samples;
    s.push({ t, x, y });
    while (s.length > 2 && t - s[0].t > 160) s.shift();
    this.active.x = x;
    this.active.y = y;
  }

  /** Скорость жеста в «экранах в секунду»: x — вправо, y — вверх. */
  gestureVelocity(windowMs = 90) {
    const s = this.active.samples;
    if (s.length < 2) return { x: 0, y: 0, rise: 0 };
    const last = s[s.length - 1];
    let first = s[0];
    for (let i = s.length - 2; i >= 0; i--) {
      first = s[i];
      if (last.t - s[i].t >= windowMs) break;
    }
    const dt = Math.max(12, last.t - first.t) / 1000;
    const n = this.norm;
    // подъём за последние 120 мс — защита от случайного броска при медленном движении
    let riseFrom = s[0];
    for (let i = s.length - 1; i >= 0; i--) {
      if (last.t - s[i].t > 120) break;
      riseFrom = s[i];
    }
    return {
      x: (last.x - first.x) / dt / n,
      y: -(last.y - first.y) / dt / n,
      rise: -(last.y - riseFrom.y) / n,
    };
  }

  onMove(e) {
    const a = this.active;
    if (!a || e.pointerId !== a.id) return;
    const list = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    if (list && list.length) for (const c of list) this._sample(c.timeStamp, c.clientX, c.clientY);
    else this._sample(e.timeStamp, e.clientX, e.clientY);
    this._updateTarget();
    // автоматический бросок: палец пересёк линию над полкой и продолжает быстро идти вверх
    const v = this.gestureVelocity(70);
    this.upSpeed = Math.max(0, v.y);
    const pointer = this._pointOnPlaneZ(a.x, a.y, a.z, _v);
    if (pointer && pointer.y > this.game.tray.releaseY && v.y > THROW.autoUp && Math.abs(v.x) < v.y * THROW.maxSideRatio && v.rise > THROW.minRise) {
      this.stats.autoThrows++;
      this.game.hud.flashLine();
      this._throw(v);
    }
  }

  onUp(e, cancelled = false) {
    const a = this.active;
    if (!a || e.pointerId !== a.id) return;
    if (!cancelled) this._sample(e.timeStamp, e.clientX, e.clientY);
    const v = this.gestureVelocity(90);
    const fast = v.y > THROW.minUp && Math.abs(v.x) < v.y * THROW.maxSideRatio && v.rise > THROW.minRise;
    if (!cancelled && fast) this._throw(v);
    else this._drop();
  }

  _end() {
    const a = this.active;
    this.active = null;
    this.upSpeed = 0;
    if (a) {
      try {
        this.dom.releasePointerCapture(a.id);
      } catch {
        /* ignore */
      }
    }
  }

  _drop() {
    const b = this.active.bottle;
    this._end();
    if (b.state === 'held' && b.body) {
      b.dropToTray();
      this.stats.drops++;
    }
  }

  /** Бутылка разбилась в руке или экран поменял размер. */
  cancel(silent = false) {
    if (!this.active) return;
    const b = this.active.bottle;
    this._end();
    if (!silent && b.state === 'held' && b.body) b.dropToTray();
  }

  _updateTarget() {
    const a = this.active;
    if (!a) return;
    const tray = this.game.tray;
    const p = this._pointOnPlaneZ(a.x, a.y, a.z, _v);
    if (!p) return;
    const t = this.holdTarget.copy(p).sub(a.offset);
    t.z = a.z;
    t.x = THREE.MathUtils.clamp(t.x, tray.minX + 0.08, tray.maxX - 0.08);
    // захват точки не выше линии броска — выше бутылку «не переносим», её можно только бросить
    const maxY = tray.releaseY - a.offset.y;
    t.y = THREE.MathUtils.clamp(t.y, tray.shelfY + HOLD.lift, Math.max(tray.shelfY + HOLD.lift, maxY));
  }

  update() {
    if (this.active) {
      this._updateTarget();
      // если палец замер — скорость гаснет
      const s = this.active.samples;
      const now = performance.now();
      if (s.length && now - s[s.length - 1].t > 60) this.upSpeed *= 0.8;
    }
  }

  // ---------------------------------------------------------------------------
  // Бросок
  // ---------------------------------------------------------------------------

  _throw(v) {
    const a = this.active;
    const b = a.bottle;
    this._end();
    if (b.state !== 'held' || !b.body) return;
    const launch = b.kp.clone();
    const game = this.game;
    const mag = Math.hypot(v.x, v.y);
    const power = THREE.MathUtils.clamp((mag - THROW.gestureMin) / (THROW.gestureMax - THROW.gestureMin), 0, 1);
    let speed = THROW.speedMin + (THROW.speedMax - THROW.speedMin) * Math.pow(power, 0.92);

    // направление: продолжаем линию свайпа на экране до высоты мишеней и
    // смотрим, куда она указывает в глубине сцены
    let yaw = this._aimYaw(a, v, launch);
    const elev = THREE.MathUtils.degToRad(THROW.elevationDeg);

    // мягкий автоприцел: если бросок почти попадает — чуть доводим
    const center = _a.copy(launch);
    center.y += BOTTLE_HEIGHT * 0.5;
    let bestScore = Infinity;
    let fix = null;
    for (const tg of game.targets) {
      const tp = tg.body.translation();
      const tv = tg.body.linvel();
      // упреждение для движущейся мишени: одна итерация по времени полёта
      let px = tp.x, py = tp.y, pz = tp.z;
      for (let it = 0; it < 2; it++) {
        const dx = px - center.x, dz = pz - center.z;
        const dist = Math.hypot(dx, dz);
        const tFlight = dist / Math.max(1, speed * Math.cos(elev));
        px = tp.x + tv.x * tFlight;
        py = tp.y + tv.y * tFlight;
        pz = tp.z + tv.z * tFlight;
      }
      const dx = px - center.x, dz = pz - center.z;
      const d = Math.hypot(dx, dz);
      const h = py - center.y;
      const denom = 2 * Math.cos(elev) ** 2 * (d * Math.tan(elev) - h);
      if (denom <= 0) continue;
      const need = Math.sqrt((GRAVITY * d * d) / denom);
      const needYaw = Math.atan2(dx, -dz);
      const dyaw = Math.abs(needYaw - yaw);
      const ds = Math.abs(need - speed) / need;
      if (dyaw < THREE.MathUtils.degToRad(THROW.assistYawDeg) && ds < THROW.assistSpeed) {
        const score = dyaw / THREE.MathUtils.degToRad(THROW.assistYawDeg) + ds / THROW.assistSpeed;
        if (score < bestScore) {
          bestScore = score;
          fix = { need, needYaw };
        }
      }
    }
    if (fix) {
      const k = THROW.assistBlend;
      speed += (fix.need - speed) * k;
      yaw += (fix.needYaw - yaw) * k;
    }

    const ch = Math.cos(elev) * speed;
    const vel = new THREE.Vector3(Math.sin(yaw) * ch, Math.sin(elev) * speed, -Math.cos(yaw) * ch);
    // вращение «через верх» вперёд + немного закрутки от бокового движения
    const spin = (THROW.spinBase + THROW.spinPerPower * power) * (0.85 + Math.random() * 0.3);
    const right = _b.set(Math.cos(yaw), 0, Math.sin(yaw));
    const ang = new THREE.Vector3().copy(right).multiplyScalar(-spin);
    ang.y += -v.x * 1.2;
    ang.z += b.leanVel * 0.3;
    b.launch(vel, ang);
    this.stats.throws++;
    this.lastThrow = { speed, yaw, power, assisted: !!fix, gesture: { ...v } };
    game.onThrow(b, speed, power);
  }

  _aimYaw(a, v, launch) {
    const cam = this.game.camera;
    // экранное направление свайпа (y вниз)
    const len = Math.hypot(v.x, v.y) || 1;
    const dx = v.x / len, dy = -v.y / len;
    // экранная высота «линии мишеней»
    _v.set(0, 2.25, -8).project(cam);
    const rect = this.dom.getBoundingClientRect();
    const aimY = rect.top + (1 - (_v.y + 1) / 2) * rect.height;
    let t = dy < -0.05 ? (aimY - a.y) / dy : 0;
    if (!(t > 0)) t = rect.height * 0.5;
    const sx = a.x + dx * t;
    const sy = a.y + dy * t;
    const p = this._pointOnPlaneZ(sx, sy, -8, _v);
    let yaw = 0;
    if (p) yaw = Math.atan2(p.x - launch.x, -(p.z - launch.z));
    const lim = THREE.MathUtils.degToRad(THROW.yawMaxDeg);
    return THREE.MathUtils.clamp(yaw, -lim, lim);
  }
}
