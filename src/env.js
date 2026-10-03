import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GROUPS } from './config.js';
import { RAPIER } from './physics.js';

export const ROOM = {
  backZ: -13,
  halfWidth: 6.5,
  height: 7.6,
  frontZ: 2,
};

export const PALETTE = {
  wallTop: '#5d6c70',
  wallBottom: '#4c5a5f',
  wainscot: '#3e4a4f',
  floor: '#5f554d',
  floorDark: '#5c5047',
  beam: '#4a3b31',
  bg: 0x4d5a5f,
};

function canvasTexture(w, h, draw, { repeat = [1, 1], srgb = true, aniso = 8 } = {}) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  draw(ctx, w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = aniso;
  return t;
}

function noise(ctx, w, h, amount, alpha) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * amount;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
    d[i + 3] = Math.max(d[i + 3], alpha);
  }
  ctx.putImageData(img, 0, 0);
}

function wallTexture() {
  return canvasTexture(
    1024,
    512,
    (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, PALETTE.wallTop);
      g.addColorStop(1, PALETTE.wallBottom);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      // широкие вертикальные панели с едва заметными швами
      for (let x = 0; x < w; x += 128) {
        ctx.fillStyle = 'rgba(0,0,0,0.07)';
        ctx.fillRect(x, 0, 2, h);
        ctx.fillStyle = 'rgba(255,255,255,0.035)';
        ctx.fillRect(x + 2, 0, 2, h);
      }
      noise(ctx, w, h, 7, 255);
    },
    { repeat: [3, 1] },
  );
}

function wainscotTexture() {
  return canvasTexture(
    512,
    128,
    (ctx, w, h) => {
      ctx.fillStyle = PALETTE.wainscot;
      ctx.fillRect(0, 0, w, h);
      for (let x = 0; x < w; x += 64) {
        ctx.fillStyle = 'rgba(0,0,0,0.12)';
        ctx.fillRect(x, 0, 3, h);
        ctx.fillStyle = 'rgba(255,255,255,0.05)';
        ctx.fillRect(x + 3, 0, 2, h);
      }
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(0, 0, w, 4);
      noise(ctx, w, h, 8, 255);
    },
    { repeat: [6, 1] },
  );
}

function floorTexture() {
  return canvasTexture(
    1024,
    1024,
    (ctx, w, h) => {
      ctx.fillStyle = PALETTE.floor;
      ctx.fillRect(0, 0, w, h);
      // доски идут в глубину сцены — так перспектива читается лучше
      const boards = 8;
      const bw = w / boards;
      for (let i = 0; i < boards; i++) {
        let y = -Math.random() * 400;
        while (y < h) {
          const len = 260 + Math.random() * 380;
          const shade = (Math.random() - 0.5) * 2;
          ctx.fillStyle = shade > 0 ? `rgba(255,240,220,${shade * 0.035})` : `rgba(0,0,0,${-shade * 0.05})`;
          ctx.fillRect(i * bw, y, bw, len);
          ctx.fillStyle = 'rgba(0,0,0,0.22)';
          ctx.fillRect(i * bw, y, bw, 2);
          y += len;
        }
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(i * bw, 0, 2, h);
        ctx.fillStyle = 'rgba(255,255,255,0.04)';
        ctx.fillRect(i * bw + 2, 0, 2, h);
      }
      // волокна
      ctx.globalAlpha = 0.05;
      for (let k = 0; k < 900; k++) {
        ctx.strokeStyle = Math.random() > 0.5 ? '#000' : '#fff';
        const x = Math.random() * w;
        const y = Math.random() * h;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + (Math.random() - 0.5) * 3, y + 40 + Math.random() * 120);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      noise(ctx, w, h, 6, 255);
    },
    { repeat: [3.2, 4] },
  );
}

export function woodTexture(base = '#8a6a4f') {
  return canvasTexture(
    256,
    256,
    (ctx, w, h) => {
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 0.09;
      for (let k = 0; k < 140; k++) {
        ctx.strokeStyle = Math.random() > 0.5 ? '#000' : '#fff';
        ctx.lineWidth = 1 + Math.random() * 2;
        const y = Math.random() * h;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.bezierCurveTo(w * 0.3, y + (Math.random() - 0.5) * 8, w * 0.7, y + (Math.random() - 0.5) * 8, w, y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      noise(ctx, w, h, 10, 255);
    },
    { repeat: [1, 1] },
  );
}

export function createEnvironment({ scene, renderer, physics, quality }) {
  scene.background = new THREE.Color(PALETTE.bg);
  scene.fog = new THREE.Fog(PALETTE.bg, 16, 42);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTex;
  scene.environmentIntensity = 0.5;
  pmrem.dispose();

  const hemi = new THREE.HemisphereLight(0xf3ede4, 0x3a332d, 1.15);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff0dc, 2.1);
  sun.position.set(-3.5, 8, 3);
  sun.target.position.set(0.5, 0, -6.5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(quality.shadowSize, quality.shadowSize);
  const sc = sun.shadow.camera;
  sc.left = -6.5;
  sc.right = 6.5;
  sc.top = 7.5;
  sc.bottom = -7.5;
  sc.near = 1;
  sc.far = 26;
  sun.shadow.radius = 5;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  sun.shadow.intensity = 0.62;
  scene.add(sun, sun.target);

  // контровой свет сзади — подсвечивает кромки стекла
  const rim = new THREE.DirectionalLight(0xd6e6ff, 0.9);
  rim.position.set(1.5, 5, -12);
  rim.target.position.set(0, 1, 0);
  scene.add(rim, rim.target);

  const { backZ, halfWidth, height, frontZ } = ROOM;
  const depth = frontZ - backZ;

  const floorMat = new THREE.MeshStandardMaterial({ map: floorTexture(), roughness: 0.82, metalness: 0, envMapIntensity: 0.35 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(halfWidth * 2, depth), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, (frontZ + backZ) / 2);
  floor.receiveShadow = true;
  scene.add(floor);

  const wallTex = wallTexture();
  const wallMat = new THREE.MeshLambertMaterial({ map: wallTex });
  const back = new THREE.Mesh(new THREE.PlaneGeometry(halfWidth * 2, height), wallMat);
  back.position.set(0, height / 2, backZ);
  back.receiveShadow = true;
  scene.add(back);

  const sideTex = wallTex.clone();
  sideTex.repeat.set(4, 1);
  sideTex.needsUpdate = true;
  const sideMat = new THREE.MeshLambertMaterial({ map: sideTex, color: 0xe4e4e4 });
  for (const s of [-1, 1]) {
    const side = new THREE.Mesh(new THREE.PlaneGeometry(depth, height), sideMat);
    side.rotation.y = -s * Math.PI / 2;
    side.position.set(s * halfWidth, height / 2, (frontZ + backZ) / 2);
    scene.add(side);
  }

  const ceilMat = new THREE.MeshBasicMaterial({ color: 0x55625f });
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(halfWidth * 2, depth), ceilMat);
  ceil.rotation.x = Math.PI / 2;
  ceil.position.set(0, height, (frontZ + backZ) / 2);
  scene.add(ceil);

  // нижние панели и плинтусы
  const wainMat = new THREE.MeshLambertMaterial({ map: wainscotTexture() });
  const wain = new THREE.Mesh(new THREE.BoxGeometry(halfWidth * 2, 1.05, 0.04), wainMat);
  wain.position.set(0, 0.525, backZ + 0.02);
  wain.receiveShadow = true;
  scene.add(wain);
  const trimMat = new THREE.MeshLambertMaterial({ color: 0x2f3739 });
  const trim = new THREE.Mesh(new THREE.BoxGeometry(halfWidth * 2, 0.05, 0.07), trimMat);
  trim.position.set(0, 1.06, backZ + 0.035);
  scene.add(trim);
  for (const s of [-1, 1]) {
    const sw = new THREE.Mesh(new THREE.BoxGeometry(0.04, 1.05, depth), wainMat.clone());
    sw.material.map = sw.material.map.clone();
    sw.material.map.repeat.set(8, 1);
    sw.material.map.needsUpdate = true;
    sw.position.set(s * (halfWidth - 0.02), 0.525, (frontZ + backZ) / 2);
    scene.add(sw);
  }

  // мягкое световое пятно на стене — центр композиции
  const glowTex = canvasTexture(256, 256, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(255,240,220,0.22)');
    g.addColorStop(1, 'rgba(255,240,220,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(11, 5.5),
    new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, depthWrite: false, fog: false }),
  );
  glow.position.set(0.3, 2.6, backZ + 0.05);
  scene.add(glow);

  // физика: пол, стены, потолок
  const world = physics.world;
  const fixed = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const mk = (hx, hy, hz, x, y, z, friction = 0.6, restitution = 0.15) => {
    const c = world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz)
        .setTranslation(x, y, z)
        .setFriction(friction)
        .setRestitution(restitution)
        .setCollisionGroups(GROUPS.static),
      fixed,
    );
    physics.own(c, { kind: 'static', surface: 'room' });
    return c;
  };
  mk(halfWidth + 2, 0.5, depth / 2 + 4, 0, -0.5, (frontZ + backZ) / 2, 0.65, 0.18);
  mk(halfWidth + 2, height, 0.5, 0, height / 2, backZ - 0.5, 0.4, 0.2);
  mk(0.5, height, depth / 2 + 4, -halfWidth - 0.5, height / 2, (frontZ + backZ) / 2, 0.4, 0.2);
  mk(0.5, height, depth / 2 + 4, halfWidth + 0.5, height / 2, (frontZ + backZ) / 2, 0.4, 0.2);
  mk(halfWidth + 2, 0.5, depth / 2 + 4, 0, height + 0.5, (frontZ + backZ) / 2, 0.4, 0.2);

  return { sun, hemi, rim, envTex, fixedBody: fixed };
}
