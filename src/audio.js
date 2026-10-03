// Процедурные звуки на WebAudio: никаких сторонних файлов и лицензий.
// Контекст создаётся только после первого действия игрока.

function rand(a, b) {
  return a + Math.random() * (b - a);
}

export class Sound {
  constructor() {
    this.ctx = null;
    this.muted = false;
    try {
      this.muted = localStorage.getItem('bottle-toss-muted') === '1';
    } catch {
      /* приватный режим */
    }
    this.last = {};
    this.voices = 0;
    this.maxVoices = 22;
  }

  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC({ latencyHint: 'interactive' });
      this.ctx = ctx;
      this.comp = ctx.createDynamicsCompressor();
      this.comp.threshold.value = -16;
      this.comp.knee.value = 12;
      this.comp.ratio.value = 4;
      this.comp.attack.value = 0.004;
      this.comp.release.value = 0.2;
      // мягкий срез верхов — без резкого «стекла по нервам»
      this.tone = ctx.createBiquadFilter();
      this.tone.type = 'lowpass';
      this.tone.frequency.value = 9500;
      this.tone.Q.value = 0.5;
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.85;
      this.comp.connect(this.tone);
      this.tone.connect(this.master);
      this.master.connect(ctx.destination);
      // общий буфер шума
      const len = ctx.sampleRate * 1.5;
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      let b = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b = 0.97 * b + 0.03 * w; // немного «розовее» белого
        d[i] = w * 0.6 + b * 2.2;
      }
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  setMuted(m) {
    this.muted = m;
    try {
      localStorage.setItem('bottle-toss-muted', m ? '1' : '0');
    } catch {
      /* ignore */
    }
    if (this.ctx) {
      const g = this.master.gain;
      g.cancelScheduledValues(this.ctx.currentTime);
      g.setTargetAtTime(m ? 0 : 0.85, this.ctx.currentTime, 0.04);
    }
  }

  _ok(kind, minGap) {
    if (!this.ctx || this.muted || this.ctx.state !== 'running') return false;
    if (this.voices >= this.maxVoices) return false;
    const t = this.ctx.currentTime;
    if (this.last[kind] !== undefined && t - this.last[kind] < minGap) return false;
    this.last[kind] = t;
    return true;
  }

  _voice(node, dur) {
    this.voices++;
    setTimeout(() => {
      this.voices--;
      try {
        node.disconnect();
      } catch {
        /* ignore */
      }
    }, (dur + 0.1) * 1000);
  }

  _ping(t, freq, gain, decay, dest) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.0025);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    o.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + decay + 0.02);
  }

  _noise(t, dur, gain, type, freq, q, dest, freqEnd) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + Math.min(0.012, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(dest);
    src.start(t, Math.random() * 1.0, dur + 0.05);
  }

  _bus(gain) {
    const g = this.ctx.createGain();
    g.gain.value = gain;
    g.connect(this.comp);
    return g;
  }

  /** Звон стекла о стекло. intensity 0..1 */
  clink(intensity, pitch = 1) {
    if (intensity < 0.03 || !this._ok('clink', 0.045)) return;
    const t = this.ctx.currentTime + 0.002;
    const bus = this._bus(0.06 + 0.32 * Math.min(1, intensity));
    const f0 = rand(1150, 1450) * pitch;
    const ratios = [1, 2.76, 5.4, 8.93];
    const amps = [1, 0.42, 0.2, 0.07];
    const dec = 0.18 + 0.4 * Math.min(1, intensity);
    for (let i = 0; i < ratios.length; i++) this._ping(t, f0 * ratios[i] * rand(0.995, 1.005), amps[i], dec / (1 + i * 0.9), bus);
    this._noise(t, 0.015, 0.25, 'bandpass', 4200, 1.2, bus);
    this._voice(bus, dec);
  }

  /** Глухой стук о пол/полку. */
  knock(intensity) {
    if (intensity < 0.04 || !this._ok('knock', 0.06)) return;
    const t = this.ctx.currentTime + 0.002;
    const bus = this._bus(0.08 + 0.3 * Math.min(1, intensity));
    this._noise(t, 0.08, 0.7, 'lowpass', 900, 0.7, bus);
    this._ping(t, rand(780, 900), 0.35, 0.12, bus);
    this._ping(t, rand(1900, 2150), 0.12, 0.08, bus);
    this._voice(bus, 0.2);
  }

  /** Бросок: короткий «вжух», громкость от скорости. */
  whoosh(intensity) {
    if (!this._ok('whoosh', 0.08)) return;
    const t = this.ctx.currentTime + 0.002;
    const k = Math.min(1, intensity);
    const bus = this._bus(0.05 + 0.2 * k);
    this._noise(t, 0.32, 1, 'bandpass', 320, 1.4, bus, 1300 + 900 * k);
    this._voice(bus, 0.35);
  }

  /** Удар о деревянную мишень. */
  thud(intensity) {
    if (!this._ok('thud', 0.05)) return;
    const t = this.ctx.currentTime + 0.002;
    const k = Math.min(1, intensity);
    const bus = this._bus(0.12 + 0.4 * k);
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(190, t);
    o.frequency.exponentialRampToValueAtTime(85, t + 0.14);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.9, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    o.connect(g);
    g.connect(bus);
    o.start(t);
    o.stop(t + 0.3);
    this._noise(t, 0.07, 0.5, 'bandpass', 520, 1.6, bus);
    this._ping(t, 340, 0.18, 0.18, bus);
    this._voice(bus, 0.32);
  }

  /** Бьющееся стекло: шумовой «хруст» + россыпь коротких звонов. */
  shatter(intensity) {
    if (!this._ok('shatter', 0.09)) return;
    const t = this.ctx.currentTime + 0.002;
    const k = Math.min(1, intensity);
    const bus = this._bus(0.18 + 0.32 * k);
    this._noise(t, 0.22, 0.9, 'highpass', 2600, 0.6, bus);
    this._noise(t, 0.09, 0.6, 'bandpass', 1500, 0.9, bus);
    this._ping(t, rand(130, 160), 0.3, 0.09, bus);
    const n = 9 + Math.floor(k * 6);
    for (let i = 0; i < n; i++) {
      const dt = Math.pow(Math.random(), 1.7) * 0.42;
      const f = rand(2400, 6200);
      this._ping(t + dt, f, rand(0.08, 0.22) * (1 - dt), rand(0.04, 0.14), bus);
    }
    this._voice(bus, 0.6);
  }

  /** Всплеск сока. */
  splash(intensity) {
    if (!this._ok('splash', 0.1)) return;
    const t = this.ctx.currentTime + 0.01;
    const bus = this._bus(0.08 + 0.18 * Math.min(1, intensity));
    this._noise(t, 0.38, 1, 'lowpass', 2600, 0.8, bus, 380);
    this._voice(bus, 0.42);
  }

  /** Мелкий осколок о пол. */
  tinkle(intensity) {
    if (!this._ok('tinkle', 0.035)) return;
    const t = this.ctx.currentTime + 0.002;
    const bus = this._bus(0.03 + 0.1 * Math.min(1, intensity));
    this._ping(t, rand(3200, 6400), 1, rand(0.04, 0.09), bus);
    this._voice(bus, 0.12);
  }

  /** Тихий колокольчик за попадание в центр. */
  chime() {
    if (!this._ok('chime', 0.25)) return;
    const t = this.ctx.currentTime + 0.05;
    const bus = this._bus(0.07);
    this._ping(t, 880, 1, 0.9, bus);
    this._ping(t + 0.07, 1318.5, 0.7, 0.8, bus);
    this._ping(t + 0.14, 1760, 0.4, 0.7, bus);
    this._voice(bus, 1.0);
  }
}
