import * as THREE from 'three';
import { GROUPS, MODEL_SCALE, SHARDS, GRAVITY } from './config.js';
import { RAPIER, PoseTrack } from './physics.js';

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _p = new THREE.Vector3();
const _r = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _c = new THREE.Color();

function rand(a, b) {
  return a + Math.random() * (b - a);
}

/**
 * Разбитая бутылка: на месте целой появляются осколки из citrus-bottle-fractured.glb
 * в той же позе, со скоростью бутылки (с учётом вращения) и разлётом от точки удара.
 */
export class ShardSystem {
  constructor(game, assets) {
    this.game = game;
    this.pieces = assets.shardPieces;
    this.pools = this.pieces.map(() => []);
    this.sets = [];
    this.totalSpawned = 0;
    this._hullDescs = this.pieces.map((p) => p.hull);
  }

  _makeVisual(i) {
    const piece = this.pieces[i];
    const root = new THREE.Object3D();
    const add = (pc, offset) => {
      const holder = new THREE.Object3D();
      holder.scale.setScalar(MODEL_SCALE);
      if (offset) holder.position.copy(offset);
      for (const v of pc.visuals) {
        const m = new THREE.Mesh(v.geometry, v.material);
        m.castShadow = pc.type !== 'glass';
        holder.add(m);
      }
      root.add(holder);
    };
    add(piece, null);
    for (const ch of piece.children) {
      add(ch, ch.rest.clone().sub(piece.rest).multiplyScalar(MODEL_SCALE));
    }
    return root;
  }

  _acquire(i) {
    const pool = this.pools[i];
    const obj = pool.length ? pool.pop() : this._makeVisual(i);
    obj.scale.setScalar(1);
    obj.visible = true;
    this.game.scene.add(obj);
    return obj;
  }

  /**
   * @param pose {position: Vector3, quaternion: Quaternion}
   * @param vel линейная скорость для наследования
   * @param angvel угловая скорость (мир)
   * @param com центр масс бутылки (мир)
   * @param impactPoint точка удара (мир)
   * @param impactSpeed скорость сближения
   */
  spawn(pose, vel, angvel, com, impactPoint, impactSpeed) {
    const { world } = this.game.physics;
    const set = { items: [], age: 0, fast: false };
    // держим ограниченное число наборов осколков
    while (this.sets.length >= SHARDS.maxSets) this._removeSet(this.sets.shift());
    const burst = Math.min(SHARDS.burstMax, impactSpeed * SHARDS.burst + 0.6);
    for (let i = 0; i < this.pieces.length; i++) {
      const piece = this.pieces[i];
      _r.copy(piece.rest).multiplyScalar(MODEL_SCALE).applyQuaternion(pose.quaternion);
      _p.copy(pose.position).add(_r);
      // скорость точки твёрдого тела + разлёт от точки удара
      _w.subVectors(_p, com);
      _v.crossVectors(angvel, _w).add(vel);
      _w.subVectors(_p, impactPoint);
      const dist = Math.max(0.02, _w.length());
      _w.multiplyScalar(1 / dist);
      const falloff = 1 / (1 + dist * 6);
      _v.addScaledVector(_w, burst * (0.55 + falloff) * rand(0.6, 1.2));
      _v.x += rand(-0.35, 0.35);
      _v.y += rand(0, 0.6);
      _v.z += rand(-0.35, 0.35);

      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(_p.x, _p.y, _p.z)
          .setRotation({ x: pose.quaternion.x, y: pose.quaternion.y, z: pose.quaternion.z, w: pose.quaternion.w })
          .setLinvel(_v.x, _v.y, _v.z)
          .setAngvel({ x: angvel.x + rand(-9, 9), y: angvel.y + rand(-9, 9), z: angvel.z + rand(-9, 9) })
          .setLinearDamping(0.08)
          .setAngularDamping(0.6),
      );
      let desc = piece.hull ? RAPIER.ColliderDesc.convexHull(piece.hull) : null;
      if (!desc) desc = RAPIER.ColliderDesc.cuboid(0.012, 0.012, 0.004);
      desc
        .setMass(piece.type === 'cap' ? 0.03 : 0.012)
        .setFriction(0.5)
        .setRestitution(0.25)
        .setCollisionGroups(GROUPS.shard);
      const col = world.createCollider(desc, body);
      this.game.physics.own(col, { kind: 'shard' });
      const obj = this._acquire(i);
      const pose2 = new PoseTrack();
      pose2.reset(body);
      pose2.apply(obj, 1);
      set.items.push({
        i,
        body,
        obj,
        pose: pose2,
        life: rand(SHARDS.lifeMin, SHARDS.lifeMax) * (piece.type === 'cap' ? 1.3 : 1),
        fade: 0,
      });
      this.totalSpawned++;
    }
    this.sets.push(set);
  }

  _removeItem(it) {
    if (it.body) {
      this.game.physics.removeBody(it.body);
      it.body = null;
    }
    it.obj.visible = false;
    this.game.scene.remove(it.obj);
    this.pools[it.i].push(it.obj);
  }

  _removeSet(set) {
    for (const it of set.items) this._removeItem(it);
    set.items.length = 0;
  }

  postPhysics() {
    for (const set of this.sets) for (const it of set.items) if (it.body) it.pose.push(it.body);
  }

  get activeBodies() {
    let n = 0;
    for (const s of this.sets) n += s.items.length;
    return n;
  }

  render(alpha, dt) {
    for (let s = this.sets.length - 1; s >= 0; s--) {
      const set = this.sets[s];
      set.age += dt;
      for (let k = set.items.length - 1; k >= 0; k--) {
        const it = set.items[k];
        it.pose.apply(it.obj, alpha);
        it.life -= dt;
        // упавшие за пределы — сразу убираем
        if (it.obj.position.y < -2) it.life = Math.min(it.life, 0);
        if (it.life <= 0) {
          it.fade += dt / SHARDS.fade;
          const sc = Math.max(0, 1 - it.fade);
          it.obj.scale.setScalar(sc * sc * (3 - 2 * sc));
          if (it.fade >= 1) {
            this._removeItem(it);
            set.items.splice(k, 1);
          }
        }
      }
      if (!set.items.length) this.sets.splice(s, 1);
    }
  }

  clear() {
    for (const s of this.sets) this._removeSet(s);
    this.sets.length = 0;
  }
}

/**
 * Капли и лужицы: дешёвая частичная система на одном InstancedMesh.
 * Капли летят по баллистике, на полу и полке превращаются в плоские кляксы и тают.
 */
export class DropletSystem {
  constructor(game, count = 420) {
    this.game = game;
    this.count = count;
    const geo = new THREE.IcosahedronGeometry(1, 1);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.15, metalness: 0, envMapIntensity: 0.9 });
    this.mesh = new THREE.InstancedMesh(geo, mat, count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    game.scene.add(this.mesh);
    this.parts = Array.from({ length: count }, () => ({
      alive: false,
      p: new THREE.Vector3(),
      v: new THREE.Vector3(),
      size: 0,
      life: 0,
      flat: false,
      color: new THREE.Color(),
      rot: 0,
    }));
    this.cursor = 0;
    this.surfaces = []; // {y, minX, maxX, minZ, maxZ}
  }

  emit(p, v, size, color) {
    const d = this.parts[this.cursor];
    this.cursor = (this.cursor + 1) % this.count;
    d.alive = true;
    d.p.copy(p);
    d.v.copy(v);
    d.size = size;
    d.life = rand(2.2, 3.4);
    d.flat = false;
    d.color.copy(color);
    d.rot = Math.random() * Math.PI;
  }

  update(dt) {
    let n = 0;
    const mesh = this.mesh;
    for (const d of this.parts) {
      if (!d.alive) continue;
      d.life -= dt;
      if (d.life <= 0) {
        d.alive = false;
        continue;
      }
      if (!d.flat) {
        d.v.y -= GRAVITY * dt;
        d.v.multiplyScalar(1 - 0.6 * dt);
        const prevY = d.p.y;
        d.p.addScaledVector(d.v, dt);
        let floorY = 0;
        for (const s of this.surfaces) {
          if (d.p.x > s.minX && d.p.x < s.maxX && d.p.z > s.minZ && d.p.z < s.maxZ && prevY >= s.y) floorY = Math.max(floorY, s.y);
        }
        if (d.p.y <= floorY + 0.002) {
          d.p.y = floorY + 0.0015;
          d.flat = true;
          d.life = Math.min(d.life, rand(1.2, 2.2));
        }
      }
      const fade = Math.min(1, d.life / 0.6);
      let sx, sy;
      if (d.flat) {
        sx = d.size * 1.7 * fade;
        sy = d.size * 0.12;
      } else {
        sx = d.size * fade;
        sy = d.size * fade * 1.15;
      }
      _q.setFromAxisAngle(_v.set(0, 1, 0), d.rot);
      _m.compose(d.p, _q, _w.set(sx, sy, sx));
      mesh.setMatrixAt(n, _m);
      mesh.setColorAt(n, d.color);
      n++;
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  clear() {
    for (const d of this.parts) d.alive = false;
  }
}

function splatTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  const blob = (x, y, r) => {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  };
  blob(64, 64, 26);
  for (let i = 0; i < 9; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = 18 + Math.random() * 16;
    blob(64 + Math.cos(a) * d, 64 + Math.sin(a) * d, 8 + Math.random() * 9);
  }
  for (let i = 0; i < 14; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = 40 + Math.random() * 20;
    blob(64 + Math.cos(a) * d, 64 + Math.sin(a) * d, 1.5 + Math.random() * 3.5);
  }
  const t = new THREE.CanvasTexture(c);
  return t;
}

/** Пятна сока на мишенях — показывают, куда пришёлся удар, и медленно сходят. */
export class StainSystem {
  constructor(game, count = 18) {
    this.game = game;
    const tex = splatTexture();
    const geo = new THREE.PlaneGeometry(1, 1);
    this.items = Array.from({ length: count }, () => {
      const mat = new THREE.MeshStandardMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        roughness: 0.35,
        envMapIntensity: 0.6,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      });
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      return { mesh: m, life: 0, max: 1 };
    });
    this.cursor = 0;
  }

  add(target, localPoint, color, size) {
    const it = this.items[this.cursor];
    this.cursor = (this.cursor + 1) % this.items.length;
    it.mesh.removeFromParent();
    target.stainLayer.add(it.mesh);
    // пятно не вылезает за край диска
    const r = Math.hypot(localPoint.x, localPoint.y);
    const maxR = target.radius - size * 0.35;
    const k = r > maxR ? maxR / r : 1;
    it.mesh.position.set(localPoint.x * k, localPoint.y * k, 0);
    it.mesh.rotation.z = Math.random() * Math.PI * 2;
    it.mesh.scale.setScalar(size);
    it.mesh.material.color.copy(color);
    it.mesh.material.opacity = 0.85;
    it.mesh.visible = true;
    it.life = it.max = 9 + Math.random() * 3;
  }

  update(dt) {
    for (const it of this.items) {
      if (!it.mesh.visible) continue;
      it.life -= dt;
      it.mesh.material.opacity = 0.85 * Math.min(1, it.life / 2.5);
      if (it.life <= 0) {
        it.mesh.visible = false;
        it.mesh.removeFromParent();
      }
    }
  }
}

export { _c as tmpColor };
