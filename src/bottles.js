import * as THREE from 'three';
import {
  MODEL_SCALE,
  BOTTLE_HEIGHT,
  BOTTLE,
  HOLD,
  TRAY,
  BREAK,
  GROUPS,
  LIQUID_COLORS,
} from './config.js';
import { RAPIER, VelocitySnapshot, PoseTrack } from './physics.js';
import { LiquidSim, createLiquidMaterial, updateLiquidUniforms } from './liquid.js';

let nextId = 1;
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3();
const _fw = new THREE.Vector3();
const _va = new THREE.Vector3();
const _vb = new THREE.Vector3();
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const Y_AXIS = new THREE.Vector3(0, 1, 0);

function blobTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(0,0,0,0.55)');
  g.addColorStop(0.55, 'rgba(0,0,0,0.25)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

class BottleVisual {
  constructor(assets, blobMat) {
    this.root = new THREE.Object3D();
    this.model = new THREE.Object3D();
    this.model.scale.setScalar(MODEL_SCALE);
    this.root.add(this.model);
    this.liquidMat = createLiquidMaterial();
    this.liquid = new THREE.Mesh(assets.liquidGeometry, this.liquidMat);
    this.glass = new THREE.Mesh(assets.glassGeometry, assets.glassMaterial);
    this.glass.castShadow = true;
    this.model.add(this.liquid, this.glass);
    for (const p of assets.parts) {
      const m = new THREE.Mesh(p.geometry, p.material);
      m.castShadow = true;
      this.model.add(m);
    }
    this.blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), blobMat);
    this.blob.rotation.x = -Math.PI / 2;
    this.blob.renderOrder = 1;
  }

  setColor(c) {
    this.liquidMat.color.set(c.color);
    this.liquidMat.userData.uniforms.uSurface.value.set(c.color).lerp(new THREE.Color(c.surface), 0.55);
  }
}

export class Bottle {
  constructor(game, visual, colorIndex, fill) {
    this.id = nextId++;
    this.kind = 'bottle';
    this.game = game;
    this.visual = visual;
    this.colorIndex = colorIndex;
    this.color = LIQUID_COLORS[colorIndex];
    this.liquidColor = new THREE.Color(this.color.color);
    this.fill = fill;
    this.state = 'tray';
    this.slot = -1;
    this.homeX = 0;
    this.homeVel = 0;
    this.sim = new LiquidSim();
    this.pre = new VelocitySnapshot();
    this.pose = new PoseTrack();
    this.broken = false;
    this.dead = false;
    this.age = 0;
    this.restTime = 0;
    this.fade = 0;
    this.scored = false;
    this.kp = new THREE.Vector3(); // кинематическая поза в руке
    this.kv = new THREE.Vector3();
    this.holdVel = new THREE.Vector3();
    this.lean = 0;
    this.leanVel = 0;
    this.pushNx = 0; // x-нормаль контакта с соседом на прошлом шаге (для удерживаемой)
    const comY = game.assets.volume.restComY(fill) * MODEL_SCALE;
    // центробежный эффект слегка усилен — так жидкость в полёте лучше «прижимается» к дну
    this.liquidOffsetLocal = new THREE.Vector3(0, (comY - BOTTLE.comY) * 2.5, 0);
    this.liquidOffset = new THREE.Vector3();
    visual.setColor(this.color);
  }

  createBody(x, y, z, quat) {
    const { world } = this.game.physics;
    const m = BOTTLE.mass;
    const r = 0.065, h = BOTTLE_HEIGHT;
    const ixx = (m * (3 * r * r + h * h)) / 12;
    const iyy = 0.5 * m * r * r;
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y, z)
      .setAdditionalMassProperties(m, { x: 0, y: BOTTLE.comY, z: 0 }, { x: ixx, y: iyy, z: ixx }, { x: 0, y: 0, z: 0, w: 1 })
      .setLinearDamping(0.25)
      .setAngularDamping(0.7);
    if (quat) desc.setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w });
    this.body = world.createRigidBody(desc);
    this.colliders = this.game.assets.hulls.map((pts) => {
      const cd = RAPIER.ColliderDesc.convexHull(pts)
        .setDensity(0)
        .setFriction(BOTTLE.friction)
        .setRestitution(BOTTLE.restitution)
        .setCollisionGroups(GROUPS.tray);
      const c = world.createCollider(cd, this.body);
      this.game.physics.own(c, { kind: 'bottle', obj: this });
      return c;
    });
    this.pose.reset(this.body);
    this.pre.capture(this.body);
  }

  setGroups(g) {
    for (const c of this.colliders) c.setCollisionGroups(g);
  }

  // --- переходы состояний --------------------------------------------------

  grab() {
    this.state = 'held';
    const t = this.body.translation();
    this.kp.set(t.x, t.y, t.z);
    this.kv.set(0, 0, 0);
    this.holdVel.set(0, 0, 0);
    const r = this.body.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    _up.set(0, 1, 0).applyQuaternion(_q);
    this.lean = Math.atan2(-_up.x, _up.y);
    this.leanVel = 0;
    this.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    this.setGroups(GROUPS.held);
  }

  dropToTray() {
    this.state = 'tray';
    this.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    _v.copy(this.kv);
    if (_v.length() > 1.2) _v.setLength(1.2);
    this.body.setLinvel(_v, true);
    this.body.setAngvel({ x: 0, y: 0, z: this.leanVel * 0.5 }, true);
    this.setGroups(GROUPS.tray);
    this.homeX = this.kp.x;
    this.homeVel = 0;
  }

  launch(vel, angvel) {
    this.state = 'thrown';
    this.age = 0;
    this.restTime = 0;
    this.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    this.body.setLinearDamping(0.015);
    this.body.setAngularDamping(0.04);
    this.body.enableCcd(true);
    this.body.setLinvel(vel, true);
    this.body.setAngvel(angvel, true);
    this.setGroups(GROUPS.thrown);
  }

  setLoose() {
    // упала с полки — дальше живёт как брошенная
    this.state = 'thrown';
    this.age = 0;
    this.body.setLinearDamping(0.015);
    this.body.setAngularDamping(0.05);
    this.body.enableCcd(true);
    this.setGroups(GROUPS.thrown);
  }

  // --- шаг физики ----------------------------------------------------------

  prePhysics(dt, tray, holdTarget) {
    if (!this.body) return;
    if (this.state === 'held') {
      this._stepHeld(dt, tray, holdTarget);
      return;
    }
    this.pre.capture(this.body);
    if (this.state === 'tray') this._stepTray(dt, tray);
  }

  _stepHeld(dt, tray, target) {
    const p = this.kp;
    _v.subVectors(target, p).multiplyScalar(1 - Math.exp(-HOLD.follow * dt));
    const maxStep = HOLD.maxSpeed * dt;
    if (_v.length() > maxStep) _v.setLength(maxStep);
    _p.copy(p).add(_v);
    this.kv.copy(_v).multiplyScalar(1 / dt);
    this.holdVel.lerp(this.kv, 1 - Math.exp(-dt * 18));
    // верх отстаёт от движения, как у бутылки, которую держат за дно
    let leanTarget = THREE.MathUtils.clamp(this.holdVel.x * HOLD.leanPerSpeed, -HOLD.leanMax, HOLD.leanMax);
    // упираемся в соседа — бутылка в руке наклоняется к нему и давит верхом, сосед кренится
    if (this.pushNx !== 0 && this.holdVel.x * this.pushNx > 0.02) {
      leanTarget = -Math.sign(this.pushNx) * HOLD.pushLean;
    }
    this.pushNx = 0;
    const prevLean = this.lean;
    this.lean += (leanTarget - this.lean) * (1 - Math.exp(-dt * 14));
    this.leanVel = (this.lean - prevLean) / dt;
    _q.setFromAxisAngle(Z_AXIS, this.lean);
    this.body.setNextKinematicTranslation(_p);
    this.body.setNextKinematicRotation(_q);
    // скорость, с которой рука реально двигает бутылку в этом шаге
    this.pre.v.copy(this.kv);
    this.pre.w.set(0, 0, this.leanVel);
    this.pre.com.set(0, BOTTLE.comY, 0).applyQuaternion(_q).add(_p);
    p.copy(_p);
  }

  _stepTray(dt, tray) {
    const body = this.body;
    const t = body.translation();
    if (t.y < tray.shelfY - 0.12 || Math.abs(t.z - tray.z) > tray.depth * 0.5 + 0.12 || t.x < tray.minX - 1.2) {
      tray.lose(this);
      return;
    }
    // плавный подъезд «дома» к слоту
    const slotX = tray.slotX(this.slot);
    const dx = slotX - this.homeX;
    const want = Math.sign(dx) * Math.min(TRAY.arriveSpeed, Math.abs(dx) * 3.2 + 0.02);
    this.homeVel += (want - this.homeVel) * (1 - Math.exp(-dt * 6));
    if (Math.abs(dx) < 0.0005) this.homeVel = 0;
    this.homeX += this.homeVel * dt;
    if ((slotX - this.homeX) * dx < 0) {
      this.homeX = slotX;
      this.homeVel = 0;
    }

    const v = body.linvel();
    const m = BOTTLE.mass;
    const ex = this.homeX - t.x;
    const ez = tray.z - t.z;
    const lim = 1.7;
    const vdx = THREE.MathUtils.clamp(this.homeVel + ex * BOTTLE.homeGain, -lim, lim);
    const vdz = THREE.MathUtils.clamp(ez * BOTTLE.homeGain, -BOTTLE.homeMaxSpeed, BOTTLE.homeMaxSpeed);
    let jx = m * (vdx - v.x) * BOTTLE.homeImpulseGain;
    let jz = m * (vdz - v.z) * BOTTLE.homeImpulseGain;
    const jmax = BOTTLE.homeMaxForce * dt;
    const jl = Math.hypot(jx, jz);
    if (jl > jmax) {
      jx *= jmax / jl;
      jz *= jmax / jl;
    }
    // толкаем у самого дна, чтобы возврат не опрокидывал бутылку
    if (jl > 1e-7) body.applyImpulseAtPoint({ x: jx, y: 0, z: jz }, { x: t.x, y: t.y + 0.025, z: t.z }, true);
    const err = Math.hypot(ex, ez);
    if (err > 0.0005 && err < 0.03 && Math.abs(this.homeVel) < 0.01 && Math.hypot(v.x, v.z) < 0.08 && t.y < tray.shelfY + 0.01) {
      const k = Math.min(1, dt * 4);
      body.setTranslation({ x: t.x + ex * k, y: t.y, z: t.z + ez * k }, false);
    }

    // мягкое выпрямление и разворот этикеткой к игроку
    const r = body.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    _up.set(0, 1, 0).applyQuaternion(_q);
    _w.crossVectors(_up, Y_AXIS);
    const s = _w.length();
    const angle = Math.atan2(s, _up.y);
    const av = body.angvel();
    let tx = 0, ty = 0, tz = 0;
    if (s > 1e-5) {
      const k = (BOTTLE.uprightK * angle) / s;
      tx = _w.x * k;
      tz = _w.z * k;
    }
    tx -= BOTTLE.uprightD * av.x;
    tz -= BOTTLE.uprightD * av.z;
    _fw.set(0, 0, 1).applyQuaternion(_q);
    const yawErr = Math.atan2(_fw.x, _fw.z);
    if (angle < 0.6) ty = -BOTTLE.yawK * yawErr - BOTTLE.yawD * av.y;
    const tl = Math.hypot(tx, tz);
    if (tl > BOTTLE.uprightMax) {
      tx *= BOTTLE.uprightMax / tl;
      tz *= BOTTLE.uprightMax / tl;
    }
    body.applyTorqueImpulse({ x: tx * dt, y: ty * dt, z: tz * dt }, true);
  }

  postPhysics(dt) {
    if (!this.body) return;
    this.pose.push(this.body);
    const lv = this.state === 'held' ? this.kv : this.body.linvel();
    const av = this.state === 'held' ? this.pre.w : this.body.angvel();
    _va.set(lv.x, lv.y, lv.z);
    _vb.set(av.x, av.y, av.z);
    this.liquidOffset.copy(this.liquidOffsetLocal).applyQuaternion(this.pose.q1);
    this.sim.step(dt, _va, _vb, this.liquidOffset);
  }

  speed() {
    const v = this.body.linvel();
    return Math.hypot(v.x, v.y, v.z);
  }

  render(alpha, time, tray) {
    const root = this.visual.root;
    this.pose.apply(root, alpha);
    if (this.fade > 0) root.scale.setScalar(Math.max(0.001, 1 - this.fade * this.fade));
    root.updateMatrixWorld();
    updateLiquidUniforms(this.visual.liquidMat, root, this.sim, this.fill, this.game.assets.volume, time);
    const blob = this.visual.blob;
    const h = root.position.y - tray.shelfY;
    if ((this.state === 'tray' || this.state === 'held') && h > -0.05 && h < 0.4 && Math.abs(root.position.z - tray.z) < 0.25) {
      blob.visible = true;
      const k = 1 - THREE.MathUtils.clamp(h / 0.35, 0, 1);
      blob.position.set(root.position.x, tray.shelfY + 0.0012, root.position.z);
      blob.scale.setScalar(0.17 + 0.08 * (1 - k));
      blob.material.opacity = 0.9 * k;
    } else {
      blob.visible = false;
    }
  }
}

/** Полка с бутылками внизу экрана: слоты, подвоз справа, сдвиг на свободные места. */
export class Tray {
  constructor(game, assets) {
    this.game = game;
    this.assets = assets;
    this.slots = [];
    this.live = [];
    this.pool = [];
    this.shelfY = 1;
    this.z = -1.5;
    this.depth = TRAY.depth;
    this.minX = -1;
    this.maxX = 1;
    this.spawnX = 1.5;
    this.releaseY = 1.5;
    this.shiftCooldown = 0;
    this.spawnCooldown = 0.3;
    this.recentColors = [];
    this.blobMat = new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false, color: 0x000000 });
    this.blobMat.opacity = 1;
    this.colliders = [];
    this.group = new THREE.Group();
    game.scene.add(this.group);
    this._buildVisuals();
  }

  _buildVisuals() {
    this.plateMat = new THREE.MeshPhysicalMaterial({
      color: 0xdff2ec,
      roughness: 0.08,
      metalness: 0,
      transparent: true,
      opacity: 0.2,
      clearcoat: 1,
      clearcoatRoughness: 0.05,
      envMapIntensity: 1.4,
      depthWrite: false,
    });
    this.edgeMat = new THREE.MeshBasicMaterial({ color: 0xeaf6f1, transparent: true, opacity: 0.55, depthWrite: false });
    this.plate = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.plateMat);
    this.plate.receiveShadow = true;
    this.plate.renderOrder = 2;
    this.rail = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.plateMat);
    this.rail.renderOrder = 3;
    this.edgeTop = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.edgeMat);
    this.edgeFront = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.edgeMat);
    this.edgeTop.renderOrder = this.edgeFront.renderOrder = 4;
    this.group.add(this.plate, this.rail, this.edgeTop, this.edgeFront);
  }

  slotX(i) {
    return this.slots[i] ? this.slots[i].x : this.spawnX;
  }

  /** Пересчитать полку под новый размер экрана. */
  layout(L) {
    const { world } = this.game.physics;
    this.shelfY = L.shelfY;
    this.z = L.trayZ;
    this.minX = L.minX;
    this.maxX = L.maxX;
    this.spawnX = L.spawnX;
    this.releaseY = L.releaseY;
    const n = L.slotXs.length;
    const old = this.slots;
    this.slots = L.slotXs.map((x) => ({ x, bottle: null }));
    // перекладываем бутылки в новые слоты слева направо
    const keep = old.map((s) => s.bottle).filter((b) => b && !b.broken);
    keep.sort((a, b) => a.slot - b.slot);
    for (const b of keep) {
      const idx = this.slots.findIndex((s) => !s.bottle);
      if (idx < 0 || b.state === 'thrown') {
        if (b.state !== 'thrown') this.retire(b);
        continue;
      }
      this.slots[idx].bottle = b;
      b.slot = idx;
      if (b.state === 'held') this.game.input.cancel(false);
      b.body.setTranslation({ x: this.slots[idx].x, y: this.shelfY + 0.001, z: this.z }, true);
      b.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      b.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      b.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      b.homeX = this.slots[idx].x;
      b.homeVel = 0;
      b.pose.reset(b.body);
    }

    // физика полки: плита, передний и задний бортики (с запасом за правый край — для подвоза)
    if (!this.body) this.body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    for (const c of this.colliders) {
      this.game.physics.owners.delete(c.handle);
      world.removeCollider(c, false);
    }
    this.colliders = [];
    const left = this.minX - 0.6;
    const right = this.spawnX + 0.6;
    const cx = (left + right) / 2;
    const hw = (right - left) / 2;
    const th = TRAY.shelfThickness;
    const add = (hx, hy, hz, x, y, z, surface) => {
      const c = world.createCollider(
        RAPIER.ColliderDesc.cuboid(hx, hy, hz)
          .setTranslation(x, y, z)
          .setFriction(BOTTLE.shelfFriction)
          .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Max)
          .setRestitution(0.1)
          .setCollisionGroups(GROUPS.shelf),
        this.body,
      );
      this.game.physics.own(c, { kind: 'static', surface });
      this.colliders.push(c);
    };
    add(hw, th / 2, this.depth / 2, cx, this.shelfY - th / 2, this.z, 'shelf');
    add(hw, TRAY.railHeight / 2, 0.004, cx, this.shelfY + TRAY.railHeight / 2, this.z + this.depth / 2, 'shelf');
    add(hw, 0.03, 0.004, cx, this.shelfY + 0.03, this.z - this.depth / 2, 'shelf');

    // визуал
    this.plate.scale.set(hw * 2, th, this.depth);
    this.plate.position.set(cx, this.shelfY - th / 2, this.z);
    this.rail.scale.set(hw * 2, TRAY.railHeight, 0.008);
    this.rail.position.set(cx, this.shelfY + TRAY.railHeight / 2, this.z + this.depth / 2);
    this.edgeTop.scale.set(hw * 2, 0.0025, 0.0025);
    this.edgeTop.position.set(cx, this.shelfY + TRAY.railHeight, this.z + this.depth / 2 + 0.004);
    this.edgeFront.scale.set(hw * 2, 0.002, 0.002);
    this.edgeFront.position.set(cx, this.shelfY - th, this.z + this.depth / 2 + 0.002);

    this.game.droplets.surfaces = [
      { y: this.shelfY, minX: left, maxX: right, minZ: this.z - this.depth / 2, maxZ: this.z + this.depth / 2 },
    ];
    this.spawnCooldown = Math.min(this.spawnCooldown, 0.1);
  }

  _pickColor() {
    const avoid = new Set(this.recentColors);
    const options = LIQUID_COLORS.map((_, i) => i).filter((i) => !avoid.has(i));
    const c = options[Math.floor(Math.random() * options.length)];
    this.recentColors.push(c);
    if (this.recentColors.length > 3) this.recentColors.shift();
    return c;
  }

  _acquireVisual() {
    const v = this.pool.pop() || new BottleVisual(this.assets, this.blobMat.clone());
    v.root.scale.setScalar(1);
    v.root.visible = true;
    this.game.scene.add(v.root);
    this.game.scene.add(v.blob);
    return v;
  }

  spawn(slotIndex) {
    const visual = this._acquireVisual();
    const b = new Bottle(this.game, visual, this._pickColor(), 0.46 + Math.random() * 0.24);
    b.createBody(this.spawnX, this.shelfY + 0.002, this.z);
    b.slot = slotIndex;
    b.homeX = this.spawnX;
    b.homeVel = -TRAY.arriveSpeed * 0.6;
    this.slots[slotIndex].bottle = b;
    this.live.push(b);
    b.pose.apply(visual.root, 1);
    return b;
  }

  freeSlot(b) {
    if (b.slot >= 0 && this.slots[b.slot] && this.slots[b.slot].bottle === b) this.slots[b.slot].bottle = null;
    b.slot = -1;
  }

  lose(b) {
    this.freeSlot(b);
    b.setLoose();
  }

  /** Убрать бутылку из мира (без осколков). */
  retire(b) {
    if (b.dead) return;
    b.dead = true;
    this.freeSlot(b);
    if (b.body) {
      this.game.physics.removeBody(b.body);
      b.body = null;
    }
    const v = b.visual;
    v.root.visible = false;
    v.blob.visible = false;
    this.game.scene.remove(v.root);
    this.game.scene.remove(v.blob);
    this.pool.push(v);
    const i = this.live.indexOf(b);
    if (i >= 0) this.live.splice(i, 1);
  }

  update(dt) {
    this.shiftCooldown -= dt;
    this.spawnCooldown -= dt;
    const n = this.slots.length;
    for (let i = 0; i < n; i++) {
      if (this.slots[i].bottle) continue;
      let j = i + 1;
      while (j < n && !this.slots[j].bottle) j++;
      if (j < n) {
        const b = this.slots[j].bottle;
        if (b.state === 'tray' && this.shiftCooldown <= 0) {
          this.slots[i].bottle = b;
          this.slots[j].bottle = null;
          b.slot = i;
          this.shiftCooldown = 0.09;
        }
        i = j; // за удерживаемую бутылку не сдвигаем
        continue;
      }
      if (this.spawnCooldown <= 0 && this._spawnClear()) {
        this.spawn(i);
        this.spawnCooldown = TRAY.spawnStagger;
      }
      break;
    }

    // брошенные: таймер жизни, плавное исчезновение
    for (let k = this.live.length - 1; k >= 0; k--) {
      const b = this.live[k];
      if (b.state !== 'thrown' || b.dead) continue;
      b.age += dt;
      if (b.fade > 0) {
        b.fade += dt / 0.45;
        if (b.fade >= 1) this.retire(b);
        continue;
      }
      if (!b.body) continue;
      const t = b.body.translation();
      if (t.y < -3 || Math.abs(t.x) > 15 || t.z < -20 || t.z > 4) {
        this.retire(b);
        continue;
      }
      const sp = b.speed();
      b.restTime = sp < 0.25 ? b.restTime + dt : 0;
      if (b.restTime > 1.1 || b.age > 8) {
        b.fade = 0.0001;
        b.pose.p0.copy(b.pose.p1);
        b.pose.q0.copy(b.pose.q1);
        this.game.physics.removeBody(b.body);
        b.body = null;
      }
    }
  }

  _spawnClear() {
    for (const b of this.live) {
      if (!b.body || b.state === 'thrown') continue;
      const t = b.body.translation();
      if (Math.abs(t.x - this.spawnX) < 0.2) return false;
    }
    return true;
  }

  heldBottle() {
    return this.live.find((b) => b.state === 'held') || null;
  }
}

export { _va as tmpVa, _vb as tmpVb };
export const BREAK_LIMITS = BREAK;
