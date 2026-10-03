import * as THREE from 'three';
import { GROUPS, TARGET } from './config.js';
import { RAPIER, VelocitySnapshot, PoseTrack } from './physics.js';
import { ROOM, woodTexture } from './env.js';

const RING_COLORS = ['#e7ddc8', '#c27457', '#e7ddc8', '#6f8f84', '#d9a944'];
const RING_EDGES = [1.0, 0.8, 0.6, 0.42, 0.22];

function faceTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const ctx = c.getContext('2d');
  const cx = 256, cy = 256, R = 252;
  for (let i = 0; i < RING_EDGES.length; i++) {
    ctx.beginPath();
    ctx.arc(cx, cy, RING_EDGES[i] * R, 0, Math.PI * 2);
    ctx.fillStyle = RING_COLORS[i];
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(40,36,32,0.35)';
  ctx.lineWidth = 3;
  for (const e of RING_EDGES) {
    ctx.beginPath();
    ctx.arc(cx, cy, e * R - 1.5, 0, Math.PI * 2);
    ctx.stroke();
  }
  // потёртость краски и волокна дерева под ней
  ctx.globalAlpha = 0.06;
  for (let k = 0; k < 160; k++) {
    ctx.strokeStyle = Math.random() > 0.5 ? '#000' : '#fff';
    ctx.lineWidth = 1 + Math.random() * 2;
    const y = Math.random() * 512;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(170, y + (Math.random() - 0.5) * 10, 340, y + (Math.random() - 0.5) * 10, 512, y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  const img = ctx.getImageData(0, 0, 512, 512);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 10;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Трубка верёвки: вершины пересчитываются каждый кадр без аллокаций. */
class RopeMesh extends THREE.Mesh {
  constructor(material, segments = 14, sides = 5, radius = 0.0075) {
    const g = new THREE.BufferGeometry();
    const vcount = (segments + 1) * sides;
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vcount * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(vcount * 3), 3));
    const idx = [];
    for (let i = 0; i < segments; i++) {
      for (let k = 0; k < sides; k++) {
        const a = i * sides + k, b = i * sides + ((k + 1) % sides);
        const c = (i + 1) * sides + k, d = (i + 1) * sides + ((k + 1) % sides);
        idx.push(a, b, c, b, d, c);
      }
    }
    g.setIndex(idx);
    super(g, material);
    this.segments = segments;
    this.sides = sides;
    this.radius = radius;
    this.frustumCulled = false;
    this.castShadow = true;
    this._pts = Array.from({ length: segments + 1 }, () => new THREE.Vector3());
  }

  update(a, b, length) {
    const d = a.distanceTo(b);
    const sag = d < length ? 0.5 * Math.sqrt(Math.max(0, length * length - d * d)) : 0;
    const pts = this._pts;
    const n = this.segments;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      pts[i].lerpVectors(a, b, t);
      pts[i].y -= sag * 4 * t * (1 - t);
    }
    const pos = this.geometry.attributes.position;
    const nor = this.geometry.attributes.normal;
    const tan = _t, side = _s, up = _u;
    for (let i = 0; i <= n; i++) {
      const p0 = pts[Math.max(0, i - 1)], p1 = pts[Math.min(n, i + 1)];
      tan.subVectors(p1, p0).normalize();
      side.set(1, 0, 0);
      if (Math.abs(tan.x) > 0.9) side.set(0, 0, 1);
      up.crossVectors(tan, side).normalize();
      side.crossVectors(up, tan).normalize();
      for (let k = 0; k < this.sides; k++) {
        const ang = (k / this.sides) * Math.PI * 2;
        const cx = Math.cos(ang), sy = Math.sin(ang);
        const nx = side.x * cx + up.x * sy, ny = side.y * cx + up.y * sy, nz = side.z * cx + up.z * sy;
        const j = i * this.sides + k;
        pos.setXYZ(j, pts[i].x + nx * this.radius, pts[i].y + ny * this.radius, pts[i].z + nz * this.radius);
        nor.setXYZ(j, nx, ny, nz);
      }
    }
    pos.needsUpdate = true;
    nor.needsUpdate = true;
  }
}
const _t = new THREE.Vector3();
const _s = new THREE.Vector3();
const _u = new THREE.Vector3();

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class Target {
  constructor(game, cfg, shared) {
    this.game = game;
    this.cfg = cfg;
    this.kind = 'target';
    this.tier = cfg.tier;
    this.radius = cfg.radius;
    this.flash = 0;
    this.pre = new VelocitySnapshot();
    this.pose = new PoseTrack();
    this.time = Math.random() * 10;

    const { world } = game.physics;
    const R = cfg.radius;
    const th = TARGET.thickness;
    const anchorPos = new THREE.Vector3(cfg.x, cfg.beamY - 0.06, cfg.z);
    this.anchorBase = anchorPos.clone();
    // каретка стартует в своей фазе — без рывка на первом шаге
    const startX = cfg.moving ? cfg.x + Math.sin((this.time / cfg.moving.period) * Math.PI * 2) * cfg.moving.amp : cfg.x;
    anchorPos.x = startX;
    const bodyX = startX;
    this.anchorBody = world.createRigidBody(
      (cfg.moving ? RAPIER.RigidBodyDesc.kinematicPositionBased() : RAPIER.RigidBodyDesc.fixed()).setTranslation(
        anchorPos.x,
        anchorPos.y,
        anchorPos.z,
      ),
    );

    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(bodyX, cfg.y, cfg.z)
        .setLinearDamping(TARGET.linearDamping)
        .setAngularDamping(TARGET.angularDamping)
        .setCanSleep(false),
    );
    const s = Math.SQRT1_2;
    const col = world.createCollider(
      RAPIER.ColliderDesc.cylinder(th / 2, R)
        .setRotation({ x: s, y: 0, z: 0, w: s })
        .setMass(TARGET.mass * (R / 0.42) ** 2)
        .setFriction(0.5)
        .setRestitution(0.2)
        .setCollisionGroups(GROUPS.target),
      this.body,
    );
    game.physics.own(col, { kind: 'target', obj: this });
    this.collider = col;

    // две верёвки: бифилярный подвес даёт и маятник, и восстанавливающее кручение
    this.ropes = [];
    // точки крепления на ободе под ±50° от вертикали: широкий бифиляр держит кручение
    const ax = R * Math.sin((50 * Math.PI) / 180);
    const ay = R * Math.cos((50 * Math.PI) / 180);
    for (const sgn of [-1, 1]) {
      const local1 = { x: sgn * ax * 1.06, y: 0, z: 0 };
      const local2 = { x: sgn * ax, y: ay, z: 0 };
      const w1 = new THREE.Vector3(anchorPos.x + local1.x, anchorPos.y, anchorPos.z);
      const w2 = new THREE.Vector3(bodyX + local2.x, cfg.y + local2.y, cfg.z);
      const length = w1.distanceTo(w2);
      const joint = world.createImpulseJoint(RAPIER.JointData.rope(length, local1, local2), this.anchorBody, this.body, true);
      const mesh = new RopeMesh(shared.ropeMat);
      game.scene.add(mesh);
      this.ropes.push({ local1: new THREE.Vector3(local1.x, local1.y, local1.z), local2: new THREE.Vector3(local2.x, local2.y, local2.z), length, joint, mesh });
    }

    // визуал мишени
    this.obj = new THREE.Group();
    const geo = new THREE.CylinderGeometry(R, R, th, 72, 1);
    geo.rotateX(Math.PI / 2);
    this.faceMat = shared.faceMat.clone();
    this.faceMat.emissive = new THREE.Color(0xffe2b0);
    this.faceMat.emissiveIntensity = 0;
    const disc = new THREE.Mesh(geo, [shared.edgeMat, this.faceMat, shared.backMat]);
    disc.castShadow = true;
    disc.receiveShadow = true;
    this.obj.add(disc);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(R, 0.011, 8, 72), shared.metalMat);
    rim.position.z = th / 2;
    rim.castShadow = true;
    this.obj.add(rim);
    for (const r of this.ropes) {
      const eye = new THREE.Mesh(shared.eyeGeo, shared.metalMat);
      eye.position.copy(r.local2);
      eye.rotation.y = Math.PI / 2;
      this.obj.add(eye);
    }
    this.stainLayer = new THREE.Group();
    this.stainLayer.position.z = th / 2 + 0.003;
    this.obj.add(this.stainLayer);
    game.scene.add(this.obj);

    // каретка или крюки на балке
    this.anchorObj = new THREE.Group();
    if (cfg.moving) {
      const cart = new THREE.Mesh(new THREE.BoxGeometry(R * 1.2, 0.1, 0.16), shared.metalMat);
      cart.position.y = 0.04;
      cart.castShadow = true;
      this.anchorObj.add(cart);
      for (const sx of [-1, 1]) {
        const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.18, 16), shared.metalMat);
        wheel.rotation.x = Math.PI / 2;
        wheel.position.set(sx * R * 0.4, 0.1, 0);
        this.anchorObj.add(wheel);
      }
    } else {
      for (const r of this.ropes) {
        const hook = new THREE.Mesh(shared.eyeGeo, shared.metalMat);
        hook.position.copy(r.local1).setY(0.02);
        hook.rotation.y = Math.PI / 2;
        this.anchorObj.add(hook);
      }
    }
    this.anchorObj.position.copy(anchorPos);
    game.scene.add(this.anchorObj);

    this.pose.reset(this.body);
    this.anchorPrev = anchorPos.clone();
    this.anchorCurr = anchorPos.clone();
  }

  prePhysics(dt) {
    this.pre.capture(this.body);
    if (this.cfg.moving) {
      this.time += dt;
      const m = this.cfg.moving;
      const x = this.anchorBase.x + Math.sin((this.time / m.period) * Math.PI * 2) * m.amp;
      this.anchorPrev.copy(this.anchorCurr);
      this.anchorCurr.set(x, this.anchorBase.y, this.anchorBase.z);
      this.anchorBody.setNextKinematicTranslation({ x, y: this.anchorBase.y, z: this.anchorBase.z });
    }
  }

  postPhysics() {
    this.pose.push(this.body);
  }

  velAt(p, out) {
    return this.pre.at(p, out);
  }

  hit(points) {
    this.flash = 1;
  }

  render(alpha, dt) {
    this.pose.apply(this.obj, alpha);
    if (this.cfg.moving) this.anchorObj.position.lerpVectors(this.anchorPrev, this.anchorCurr, alpha);
    this.obj.updateMatrixWorld();
    for (const r of this.ropes) {
      _a.copy(r.local1).add(this.anchorObj.position);
      _b.copy(r.local2).applyMatrix4(this.obj.matrixWorld);
      r.mesh.update(_a, _b, r.length);
    }
    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt * 3.2);
      this.faceMat.emissiveIntensity = this.flash * this.flash * 0.35;
    }
  }

  /** Очки по кольцу: ближе к центру — больше. */
  scoreAt(worldPoint) {
    _a.copy(worldPoint);
    this.obj.worldToLocal(_a);
    const r = Math.hypot(_a.x, _a.y) / this.radius;
    const ring = r < RING_EDGES[4] ? 2 : r < RING_EDGES[3] ? 1 : 0;
    return { points: this.tier + ring, bullseye: ring === 2, local: _a.clone() };
  }
}

export function createTargets(game) {
  const shared = {
    faceMat: new THREE.MeshStandardMaterial({ map: faceTexture(), roughness: 0.78, envMapIntensity: 0.4 }),
    edgeMat: new THREE.MeshStandardMaterial({ map: woodTexture('#7a5c44'), roughness: 0.8, envMapIntensity: 0.3 }),
    backMat: new THREE.MeshStandardMaterial({ map: woodTexture('#8a6a4f'), roughness: 0.85, envMapIntensity: 0.3 }),
    metalMat: new THREE.MeshStandardMaterial({ color: 0x3b3a37, metalness: 0.6, roughness: 0.45, envMapIntensity: 0.6 }),
    ropeMat: new THREE.MeshStandardMaterial({ color: 0xc9b38c, roughness: 0.95, envMapIntensity: 0.2 }),
    eyeGeo: new THREE.TorusGeometry(0.018, 0.005, 6, 16),
  };

  const cfgs = [
    { x: -1.55, y: 1.98, z: -5.8, radius: 0.36, beamY: 3.72, tier: 1 },
    { x: -0.05, y: 2.22, z: -8.1, radius: 0.42, beamY: 4.05, tier: 2, moving: { amp: 1.15, period: 7.8 } },
    { x: 2.35, y: 2.55, z: -10.4, radius: 0.5, beamY: 4.42, tier: 3 },
  ];

  // балки через всю сцену на глубине каждой мишени — заодно хороший ориентир глубины
  const beamMat = new THREE.MeshStandardMaterial({ map: woodTexture('#4d3d32'), roughness: 0.8, envMapIntensity: 0.3 });
  const rodMat = new THREE.MeshLambertMaterial({ color: 0x2c3233 });
  const { world } = game.physics;
  const fixed = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  for (const c of cfgs) {
    const len = ROOM.halfWidth * 2;
    const beam = new THREE.Mesh(new THREE.BoxGeometry(len, 0.12, 0.14), beamMat);
    beam.position.set(0, c.beamY + 0.06, c.z);
    beam.castShadow = true;
    beam.receiveShadow = true;
    game.scene.add(beam);
    for (const sx of [-1, 1]) {
      const top = ROOM.height;
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, top - c.beamY - 0.12, 8), rodMat);
      rod.position.set(sx * (ROOM.halfWidth - 1.4), (top + c.beamY + 0.12) / 2, c.z);
      game.scene.add(rod);
    }
    const col = world.createCollider(
      RAPIER.ColliderDesc.cuboid(len / 2, 0.06, 0.07)
        .setTranslation(0, c.beamY + 0.06, c.z)
        .setCollisionGroups(GROUPS.static)
        .setRestitution(0.2),
      fixed,
    );
    game.physics.own(col, { kind: 'static', surface: 'beam' });
  }

  return cfgs.map((c) => new Target(game, c, shared));
}
