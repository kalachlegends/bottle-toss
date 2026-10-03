import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { GRAVITY, PHYS_DT } from './config.js';

export { RAPIER };

/**
 * Обёртка над миром Rapier: владельцы коллайдеров, снимки скоростей до шага
 * (по ним считается сила удара) и обход контактов.
 */
export class Physics {
  static async create() {
    await RAPIER.init();
    return new Physics();
  }

  constructor() {
    this.world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
    this.world.timestep = PHYS_DT;
    const ip = this.world.integrationParameters;
    ip.numSolverIterations = 8;
    this.owners = new Map();
    this._n = new THREE.Vector3();
    this._p = new THREE.Vector3();
  }

  own(collider, owner) {
    this.owners.set(collider.handle, owner);
  }

  removeBody(body) {
    if (!body) return;
    const n = body.numColliders();
    for (let i = 0; i < n; i++) this.owners.delete(body.collider(i).handle);
    this.world.removeRigidBody(body);
  }

  step() {
    this.world.step();
  }

  /**
   * Обойти реальные (решаемые) контакты коллайдера.
   * cb(otherCollider, normal от collider к other, точка контакта)
   */
  forEachContact(collider, cb) {
    const world = this.world;
    const n = this._n;
    const p = this._p;
    world.contactPairsWith(collider, (other) => {
      world.contactPair(collider, other, (manifold, flipped) => {
        const count = manifold.numSolverContacts();
        if (count === 0) return;
        const mn = manifold.normal();
        n.set(mn.x, mn.y, mn.z);
        if (flipped) n.negate();
        p.set(0, 0, 0);
        for (let i = 0; i < count; i++) {
          const sp = manifold.solverContactPoint(i);
          p.x += sp.x;
          p.y += sp.y;
          p.z += sp.z;
        }
        p.multiplyScalar(1 / count);
        cb(other, n, p);
      });
    });
  }
}

/** Снимок скорости тела до шага — чтобы оценить скорость сближения при ударе. */
export class VelocitySnapshot {
  constructor() {
    this.v = new THREE.Vector3();
    this.w = new THREE.Vector3();
    this.com = new THREE.Vector3();
  }

  capture(body) {
    const v = body.linvel();
    const w = body.angvel();
    const c = body.worldCom();
    this.v.set(v.x, v.y, v.z);
    this.w.set(w.x, w.y, w.z);
    this.com.set(c.x, c.y, c.z);
  }

  clear() {
    this.v.set(0, 0, 0);
    this.w.set(0, 0, 0);
  }

  at(point, out) {
    // v + ω × (p − com)
    const rx = point.x - this.com.x, ry = point.y - this.com.y, rz = point.z - this.com.z;
    const w = this.w;
    return out.set(
      this.v.x + w.y * rz - w.z * ry,
      this.v.y + w.z * rx - w.x * rz,
      this.v.z + w.x * ry - w.y * rx,
    );
  }
}

/** Интерполяция позы между шагами физики для плавной отрисовки на любых герцовках. */
export class PoseTrack {
  constructor() {
    this.p0 = new THREE.Vector3();
    this.p1 = new THREE.Vector3();
    this.q0 = new THREE.Quaternion();
    this.q1 = new THREE.Quaternion();
  }

  reset(body) {
    const t = body.translation();
    const r = body.rotation();
    this.p1.set(t.x, t.y, t.z);
    this.q1.set(r.x, r.y, r.z, r.w);
    this.p0.copy(this.p1);
    this.q0.copy(this.q1);
  }

  push(body) {
    this.p0.copy(this.p1);
    this.q0.copy(this.q1);
    const t = body.translation();
    const r = body.rotation();
    this.p1.set(t.x, t.y, t.z);
    this.q1.set(r.x, r.y, r.z, r.w);
  }

  apply(obj, alpha) {
    obj.position.lerpVectors(this.p0, this.p1, alpha);
    obj.quaternion.slerpQuaternions(this.q0, this.q1, alpha);
  }
}
