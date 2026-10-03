import * as THREE from 'three';
import { TRAY } from './config.js';

const FONT = '"Manrope", "Nunito", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/**
 * Надписи только на «стекле» перед бутылками: подсказка до первого броска, потом счёт.
 * Плюс линия автоброска над полкой и кнопка звука.
 */
export class Hud {
  constructor(game) {
    this.game = game;
    this.score = 0;
    this.shown = -1;
    this.mode = 'hint';
    this.pulse = 0;
    this.lineHeat = 0;
    this.lineFlash = 0;

    this.canvas = document.createElement('canvas');
    this.canvas.width = 1024;
    this.canvas.height = 128;
    this.ctx = this.canvas.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 8;
    this.label = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 0.125),
      new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false, toneMapped: false, fog: false }),
    );
    this.label.renderOrder = 6;
    game.scene.add(this.label);

    const grad = document.createElement('canvas');
    grad.width = 256;
    grad.height = 4;
    const g = grad.getContext('2d');
    const lg = g.createLinearGradient(0, 0, 256, 0);
    lg.addColorStop(0, 'rgba(255,255,255,0)');
    lg.addColorStop(0.2, 'rgba(255,255,255,1)');
    lg.addColorStop(0.8, 'rgba(255,255,255,1)');
    lg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = lg;
    g.fillRect(0, 0, 256, 4);
    this.lineMat = new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(grad),
      color: 0xfff2d8,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });
    this.line = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.lineMat);
    this.line.renderOrder = 7;
    game.scene.add(this.line);

    this._buildMute();
    this.draw();
  }

  _buildMute() {
    const btn = document.createElement('button');
    btn.className = 'mute';
    btn.setAttribute('aria-label', 'Звук');
    const on =
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/><path d="M18 6.5a7.5 7.5 0 0 1 0 11"/></svg>';
    const off =
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>';
    const sync = () => {
      btn.innerHTML = this.game.sound.muted ? off : on;
      btn.classList.toggle('is-off', this.game.sound.muted);
    };
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.game.sound.unlock();
      this.game.sound.setMuted(!this.game.sound.muted);
      sync();
    });
    sync();
    document.body.appendChild(btn);
    this.muteBtn = btn;
  }

  layout(L) {
    const z = L.trayZ + TRAY.depth / 2 + 0.006;
    const h = Math.max(0.075 * (L.D / 1.6), Math.min(0.065, ((L.maxX - L.minX) * 0.6) / 8));
    const w = h * 8;
    this.label.scale.set(w, h / 0.125, 1);
    this.label.position.set(0, L.shelfY + TRAY.railHeight - h * 0.5, z);
    this.labelBase = this.label.scale.clone();
    const width = L.maxX - L.minX;
    this.line.scale.set(width * 0.92, 0.0032, 1);
    this.line.position.set((L.minX + L.maxX) / 2, L.releaseY, L.trayZ);
  }

  addScore(points) {
    this.score += points;
    this.mode = 'score';
    this.pulse = 1;
    this.draw();
  }

  firstThrow() {
    if (this.mode === 'hint') {
      this.mode = 'score';
      this.draw();
    }
  }

  draw() {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (this.mode === 'hint') {
      ctx.font = `600 64px ${FONT}`;
      ctx.fillStyle = 'rgba(245,250,248,0.82)';
      ctx.fillText('смахни бутылку вверх  ↑', W / 2, H / 2 + 4);
      this.tex.needsUpdate = true;
      return;
    }
    // значок мишени + число
    const text = String(this.score);
    ctx.font = `700 92px ${FONT}`;
    const tw = ctx.measureText(text).width;
    const r = 30;
    const total = r * 2 + 22 + tw;
    const x0 = W / 2 - total / 2;
    ctx.lineWidth = 7;
    ctx.strokeStyle = 'rgba(245,250,248,0.85)';
    ctx.beginPath();
    ctx.arc(x0 + r, H / 2, r - 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(245,250,248,0.85)';
    ctx.beginPath();
    ctx.arc(x0 + r, H / 2, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.textAlign = 'left';
    ctx.fillText(text, x0 + r * 2 + 22, H / 2 + 6);
    this.tex.needsUpdate = true;
  }

  update(dt, holding, upSpeed, autoUp) {
    // текстура для подсказки обновляется один раз
    if (this.shown !== this.mode) {
      this.shown = this.mode;
      this.tex.needsUpdate = true;
    }
    if (this.pulse > 0) {
      this.pulse = Math.max(0, this.pulse - dt * 3);
      const s = 1 + 0.18 * Math.sin(this.pulse * Math.PI) * this.pulse;
      this.label.scale.set(this.labelBase.x * s, this.labelBase.y * s, 1);
    }
    const heat = holding ? THREE.MathUtils.clamp(upSpeed / autoUp, 0, 1) : 0;
    this.lineHeat += (heat - this.lineHeat) * (1 - Math.exp(-dt * 14));
    this.lineFlash = Math.max(0, this.lineFlash - dt * 2.5);
    const target = (holding ? 0.22 + 0.55 * this.lineHeat : 0) + this.lineFlash * 0.8;
    this.lineMat.opacity += (target - this.lineMat.opacity) * (1 - Math.exp(-dt * 12));
    this.line.visible = this.lineMat.opacity > 0.005;
  }

  flashLine() {
    this.lineFlash = 1;
  }
}
