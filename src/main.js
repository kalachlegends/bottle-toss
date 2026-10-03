import * as THREE from 'three';
import { PHYS_DT, MAX_SUBSTEPS, CAMERA, TRAY, BREAK, BOTTLE_HEIGHT, MODEL_SCALE, THROW } from './config.js';
import { Physics } from './physics.js';
import { loadAssets } from './assets.js';
import { createEnvironment } from './env.js';
import { createTargets } from './targets.js';
import { Tray } from './bottles.js';
import { ShardSystem, DropletSystem, StainSystem } from './fx.js';
import { Sound } from './audio.js';
import { Hud } from './hud.js';
import { Input } from './input.js';

const _va = new THREE.Vector3();
const _vb = new THREE.Vector3();
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _c = new THREE.Color();

function detectQuality() {
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && Math.min(screen.width, screen.height) < 900);
  return {
    mobile,
    maxPixelRatio: mobile ? 2 : 2,
    pixelRatio: Math.min(window.devicePixelRatio || 1, mobile ? 1.75 : 2),
    minPixelRatio: mobile ? 0.8 : 1,
    shadowSize: mobile ? 1024 : 2048,
    transmissionScale: mobile ? 0.5 : 0.75,
  };
}

class Game {
  async init() {
    this.quality = detectQuality();
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(this.quality.pixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.transmissionResolutionScale = this.quality.transmissionScale;
    document.getElementById('app').appendChild(renderer.domElement);
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, 60);

    this.physics = await Physics.create();
    this.assets = await loadAssets();
    this.env = createEnvironment({ scene: this.scene, renderer, physics: this.physics, quality: this.quality });

    this.sound = new Sound();
    this.droplets = new DropletSystem(this);
    this.shards = new ShardSystem(this, this.assets);
    this.stains = new StainSystem(this);
    this.targets = createTargets(this);
    this.tray = new Tray(this, this.assets);
    this.hud = new Hud(this);
    this.input = new Input(this, renderer.domElement);

    this.pairCooldown = new Map();
    this.time = 0;
    this.acc = 0;
    this.stepCount = 0;
    this.stats = { breaks: 0, hits: 0, bullseyes: 0, maxSubsteps: 0 };
    this.frameTimes = [];
    this.perf = { avg: 16, lastAdjust: 0 };

    this.layout();
    window.addEventListener('resize', () => this.layout());
    const unlock = () => this.sound.unlock();
    window.addEventListener('pointerup', unlock, { passive: true });
    window.addEventListener('touchend', unlock, { passive: true });
    document.fonts?.ready.then(() => this.hud.draw());
    window.visualViewport?.addEventListener('resize', () => this.layout());

    // прогреваем шейдеры (в том числе осколков, капель и пятен), чтобы первое разбивание не подтормаживало
    const warm = new THREE.Group();
    for (const piece of this.assets.shardPieces) {
      for (const p of [piece, ...piece.children]) for (const v of p.visuals) warm.add(new THREE.Mesh(v.geometry, v.material));
    }
    warm.add(new THREE.Mesh(new THREE.PlaneGeometry(), this.stains.items[0].mesh.material));
    this.scene.add(warm);
    renderer.compile(this.scene, this.camera);
    this.scene.remove(warm);

    this.last = performance.now();
    renderer.setAnimationLoop(() => this.frame());
    document.body.classList.add('ready');
  }

  layout() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w === this._lw && h === this._lh) return;
    this._lw = w;
    this._lh = h;
    this.renderer.setSize(w, h);
    const aspect = w / h;
    const portrait = aspect < 1;
    const cam = this.camera;
    let vfov = CAMERA.baseVFov;
    const minH = THREE.MathUtils.degToRad(portrait ? CAMERA.minHFovPortrait : CAMERA.minHFovLandscape);
    const hOf = (v) => 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(v) / 2) * aspect);
    if (hOf(vfov) < minH) vfov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(minH / 2) / aspect));
    vfov = Math.min(vfov, CAMERA.maxVFov);
    cam.fov = vfov;
    cam.aspect = aspect;
    cam.position.set(0, CAMERA.y, 0);
    cam.lookAt(0, portrait ? THREE.MathUtils.lerp(CAMERA.lookYPortrait, CAMERA.lookY, THREE.MathUtils.clamp((aspect - 0.45) / 0.55, 0, 1)) : CAMERA.lookY, CAMERA.lookZ);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();

    // дистанция до полки: бутылка не выше заданной доли экрана и все слоты влезают по ширине
    const tanV = Math.tan(THREE.MathUtils.degToRad(vfov) / 2);
    const tanH = tanV * aspect;
    const nSlots = portrait ? TRAY.slotsPortrait : TRAY.slotsLandscape;
    const needW = nSlots * TRAY.minSpacing + 0.1;
    const dH = BOTTLE_HEIGHT / (2 * TRAY.bottleScreenFraction * tanV);
    const dW = needW / (2 * tanH);
    const D = Math.max(dH, dW);
    const trayZ = -D;

    // высота полки: дно бутылок на заданной высоте экрана
    const origin = cam.position;
    const dir = new THREE.Vector3(0, TRAY.shelfNdcY, 0.5).unproject(cam).sub(origin).normalize();
    const t = (trayZ - origin.z) / dir.z;
    const shelfY = origin.y + dir.y * t;
    const halfW = D * tanH;
    // по краям оставляем поля, остальное — слоты
    const usable = halfW * 2 * (portrait ? 0.94 : 0.78);
    const spacing = THREE.MathUtils.clamp(usable / nSlots, TRAY.minSpacing, TRAY.maxSpacing);
    const slotXs = [];
    for (let i = 0; i < nSlots; i++) slotXs.push((i - (nSlots - 1) / 2) * spacing);
    const L = {
      trayZ,
      shelfY,
      slotXs,
      minX: -halfW,
      maxX: halfW,
      spawnX: halfW + 0.22,
      releaseY: shelfY + BOTTLE_HEIGHT + TRAY.releaseAboveBottle,
      D,
    };
    this.L = L;
    this.tray.layout(L);
    this.hud.layout(L);
  }

  onThrow(bottle, speed, power) {
    this.tray.freeSlot(bottle);
    this.sound.whoosh(0.3 + power * 0.7);
    this.hud.firstThrow();
  }

  // -------------------------------------------------------------------------

  frame() {
    const now = performance.now();
    let dt = (now - this.last) / 1000;
    this.last = now;
    if (dt > 0.1) dt = 0.1; // вкладка была неактивна
    this._trackPerf(dt);

    this.input.update();
    this.acc += dt;
    let steps = 0;
    while (this.acc >= PHYS_DT && steps < MAX_SUBSTEPS) {
      this.step(PHYS_DT);
      this.acc -= PHYS_DT;
      steps++;
    }
    if (steps === MAX_SUBSTEPS) this.acc = 0;
    this.stats.maxSubsteps = Math.max(this.stats.maxSubsteps, steps);
    const alpha = this.acc / PHYS_DT;

    this.time += dt;
    this.tray.update(dt);
    for (const b of this.tray.live) b.render(alpha, this.time, this.tray);
    for (const t of this.targets) t.render(alpha, dt);
    this.shards.render(alpha, dt);
    this.droplets.update(dt);
    this.stains.update(dt);
    this.hud.update(dt, !!this.input.active, this.input.upSpeed, THROW.autoUp);
    this.renderer.render(this.scene, this.camera);
  }

  step(dt) {
    const tray = this.tray;
    const holdTarget = this.input.holdTarget;
    for (const b of tray.live) b.prePhysics(dt, tray, holdTarget);
    for (const t of this.targets) t.prePhysics(dt);
    this.physics.step();
    this.stepCount++;
    for (const b of tray.live) b.postPhysics(dt);
    for (const t of this.targets) t.postPhysics();
    this.shards.postPhysics();
    this.processImpacts();
  }

  /**
   * Сила удара = скорость сближения в точке контакта (с учётом вращения),
   * взятая по скоростям ДО шага. Покоящийся контакт даёт ~0, новый удар — полную скорость.
   */
  processImpacts() {
    const physics = this.physics;
    const impacts = this._impacts || (this._impacts = new Map());
    impacts.clear();
    for (const b of this.tray.live) {
      if (!b.body || b.broken || b.dead) continue;
      for (const c of b.colliders) {
        physics.forEachContact(c, (other, n, p) => {
          const owner = physics.owners.get(other.handle);
          if (!owner || owner.obj === b) return;
          b.pre.at(p, _va);
          let key;
          if (owner.kind === 'bottle') {
            owner.obj.pre.at(p, _vb);
            if (b.state === 'held' && Math.abs(n.x) > 0.5) b.pushNx = n.x;
            key = b.id < owner.obj.id ? `${b.id}:${owner.obj.id}` : `${owner.obj.id}:${b.id}`;
          } else if (owner.kind === 'target') {
            owner.obj.velAt(p, _vb);
            key = `${b.id}:t${this.targets.indexOf(owner.obj)}`;
          } else {
            _vb.set(0, 0, 0);
            key = `${b.id}:s:${owner.surface}`;
          }
          const closing = _va.sub(_vb).dot(n);
          const prev = impacts.get(key);
          if (!prev || closing > prev.closing) {
            impacts.set(key, { a: b, owner, closing, p: p.clone(), n: n.clone(), key });
          }
        });
      }
    }
    if (!impacts.size) return;

    const toBreak = new Map();
    const now = this.time;
    const cool = (key, gap) => {
      const t = this.pairCooldown.get(key);
      if (t !== undefined && now - t < gap) return false;
      this.pairCooldown.set(key, now);
      return true;
    };
    for (const imp of impacts.values()) {
      const { a, owner, closing } = imp;
      if (closing <= 0.05) continue;
      if (owner.kind === 'bottle') {
        const o = owner.obj;
        if (closing > BREAK.bottleBottle) {
          if (!toBreak.has(a)) toBreak.set(a, imp);
          if (!toBreak.has(o)) toBreak.set(o, imp);
        } else if (closing > 0.12 && cool(imp.key, 0.12)) {
          this.sound.clink(closing / 1.9, 0.9 + ((a.id * 7 + o.id * 13) % 10) / 40);
        }
      } else if (owner.kind === 'target') {
        const tg = owner.obj;
        if (a.state === 'thrown' && !a.scored && closing > 0.6) {
          a.scored = true;
          const s = tg.scoreAt(imp.p);
          tg.hit();
          this.hud.addScore(s.points);
          this.stats.hits++;
          if (s.bullseye) {
            this.stats.bullseyes++;
            this.sound.chime();
          }
          imp.local = s.local;
          imp.target = tg;
        }
        if (cool(imp.key, 0.15)) this.sound.thud(closing / 7);
        if (closing > BREAK.bottleTarget && a.state === 'thrown') {
          imp.target = tg;
          if (!imp.local) imp.local = tg.scoreAt(imp.p).local;
          toBreak.set(a, imp);
        }
      } else {
        const limit = a.state === 'thrown' ? BREAK.bottleStatic : 99;
        if (closing > limit) {
          toBreak.set(a, imp);
        } else if (closing > 0.22 && cool(imp.key, 0.14)) {
          if (owner.surface === 'shelf') this.sound.clink(closing / 3, 0.75);
          else this.sound.knock(closing / 4);
        }
      }
    }
    for (const [b, imp] of toBreak) this.breakBottle(b, imp);

    if (this.pairCooldown.size > 200) {
      for (const [k, t] of this.pairCooldown) if (now - t > 1) this.pairCooldown.delete(k);
    }
  }

  breakBottle(b, imp) {
    if (b.broken || b.dead || !b.body) return; // защита от двойного разрушения
    b.broken = true;
    this.stats.breaks++;
    const body = b.body;
    const tr = body.translation();
    const rot = body.rotation();
    const pose = { position: new THREE.Vector3(tr.x, tr.y, tr.z), quaternion: new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w) };
    const post = body.linvel();
    const vel = new THREE.Vector3(post.x, post.y, post.z);
    if (b.state === 'held') vel.copy(b.kv);
    else vel.lerp(b.pre.v, 0.55);
    const angvel = b.pre.w.clone();
    const com = body.worldCom();
    const comV = new THREE.Vector3(com.x, com.y, com.z);
    const impactSpeed = Math.max(imp.closing, 0);
    this.shards.spawn(pose, vel, angvel, comV, imp.p, impactSpeed);
    this._splash(b, pose, vel, imp);
    if (imp.target && imp.local) {
      const sz = 0.2 + Math.random() * 0.1;
      this.stains.add(imp.target, imp.local, b.liquidColor, sz);
      if (Math.random() < 0.7) {
        const l2 = imp.local.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.18, (Math.random() - 0.7) * 0.2, 0));
        this.stains.add(imp.target, l2, b.liquidColor, sz * 0.55);
      }
    }
    const k = Math.min(1, impactSpeed / 7);
    this.sound.shatter(0.35 + k * 0.65);
    this.sound.splash(0.4 + k * 0.6);
    if (b.state === 'held') this.input.cancel(true);
    this.tray.retire(b);
  }

  /** Сок разлетается из того объёма, где он был в момент удара. */
  _splash(b, pose, vel, imp) {
    const samples = this.assets.samples;
    const count = samples.length / 3;
    const n = b.sim.n;
    const u = b.visual.liquidMat.userData.uniforms;
    const D = u.uPlaneD.value;
    const amount = Math.round(26 + 46 * b.fill);
    let emitted = 0;
    let guard = 0;
    _c.copy(b.liquidColor);
    while (emitted < amount && guard++ < amount * 6) {
      const i = Math.floor(Math.random() * count);
      _p.set(samples[i * 3], samples[i * 3 + 1], samples[i * 3 + 2]).multiplyScalar(MODEL_SCALE).applyQuaternion(pose.quaternion).add(pose.position);
      if (_p.dot(n) > D) continue;
      _va.subVectors(_p, imp.p);
      const d = Math.max(0.02, _va.length());
      _va.multiplyScalar(1 / d);
      const burst = Math.min(3.2, imp.closing * 0.28 + 0.5) * (0.4 + Math.random());
      _vb.copy(vel).multiplyScalar(0.55 + Math.random() * 0.3).addScaledVector(_va, burst);
      _vb.x += (Math.random() - 0.5) * 1.2;
      _vb.y += Math.random() * 1.4;
      _vb.z += (Math.random() - 0.5) * 1.2;
      this.droplets.emit(_p, _vb, 0.004 + Math.random() * 0.011, _c);
      emitted++;
    }
  }

  _trackPerf(dt) {
    // динамическое разрешение: держим плавность на слабых устройствах
    const p = this.perf;
    p.avg += (dt * 1000 - p.avg) * 0.05;
    p.lastAdjust += dt;
    if (p.lastAdjust < 2) return;
    const r = this.renderer;
    const pr = r.getPixelRatio();
    if (p.avg > 24 && pr > this.quality.minPixelRatio) {
      r.setPixelRatio(Math.max(this.quality.minPixelRatio, pr - 0.2));
      p.lastAdjust = 0;
    } else if (p.avg < 15 && pr < this.quality.pixelRatio && p.lastAdjust > 6) {
      r.setPixelRatio(Math.min(this.quality.pixelRatio, pr + 0.1));
      p.lastAdjust = 0;
    }
  }
}

const game = new Game();
window.__game = game;
game.init().catch((err) => {
  console.error(err);
  const el = document.getElementById('err');
  if (el) {
    el.textContent = 'Не удалось запустить WebGL-сцену: ' + (err && err.message ? err.message : err);
    el.style.display = 'block';
  }
});
