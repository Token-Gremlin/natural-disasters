import * as THREE from 'three';

/**
 * Sandbox mode: the demo as a playable toy.
 *
 * The director drives a fixed show; this hands the same machinery to the user.
 * Everything here is a thin shell over the existing weather targets and the
 * director's one-shot spawners — no new simulation, just a way to aim it.
 *
 * The two rules that make it feel like a game rather than a settings dialog:
 * events land where the camera is pointing, and every one of them kicks the
 * camera. A disaster that appears silently behind you is indistinguishable
 * from nothing happening at all.
 */

// ---------------------------------------------------------------- conditions
// Each preset is a complete sky and sea, so switching between them can never
// leave a stale storm sitting under a clear sun.
export const CONDITIONS = {
  clear: {
    label: 'CLEAR DAY',
    desc: 'BEAUFORT 3 · UNLIMITED VISIBILITY',
    w: {
      windSpeed: 5.0, gustiness: 0.15, swellHs: 1.1, swellPeriod: 11.0, choppiness: 1.1,
      amplitude: 1.0, spread: 0.6, rain: 0, storm: 0, fog: 0, spray: 0, lightningRate: 0,
      // Not noon. An overhead sun flattens the sea into a single sheet of
      // glare; forty degrees is where the swell gets a lit side and a dark one.
      turbidity: 2.0, sunElevation: 0.66, sunAzimuth: 1.9, sunIntensity: 26,
      cloudCoverage: 0.12, cloudDensity: 0.35, cloudBottom: 1400, cloudTop: 3000,
      cloudAnvil: 0.0, foamStrength: 0.7, starIntensity: 0,
    },
  },
  trade: {
    label: 'TRADE WIND',
    desc: 'BEAUFORT 5 · SCATTERED CUMULUS',
    w: {
      windSpeed: 10.5, gustiness: 0.3, swellHs: 2.2, swellPeriod: 10.5, choppiness: 1.25,
      amplitude: 1.0, spread: 0.7, rain: 0, storm: 0.1, fog: 0.05, spray: 0.15, lightningRate: 0,
      turbidity: 3.0, sunElevation: 0.72, sunAzimuth: 2.1, sunIntensity: 24,
      cloudCoverage: 0.38, cloudDensity: 0.55, cloudBottom: 1100, cloudTop: 3800,
      cloudAnvil: 0.15, foamStrength: 0.95, starIntensity: 0,
    },
  },
  golden: {
    label: 'GOLDEN HOUR',
    desc: 'LOW SUN · LONG SWELL',
    w: {
      windSpeed: 7.5, gustiness: 0.2, swellHs: 2.8, swellPeriod: 13.5, choppiness: 1.15,
      amplitude: 1.0, spread: 0.5, rain: 0, storm: 0.05, fog: 0.12, spray: 0.1, lightningRate: 0,
      turbidity: 4.5, sunElevation: 0.055, sunAzimuth: 1.35, sunIntensity: 20,
      cloudCoverage: 0.34, cloudDensity: 0.6, cloudBottom: 1300, cloudTop: 5200,
      cloudAnvil: 0.3, foamStrength: 0.9, starIntensity: 0.2,
    },
  },
  overcast: {
    label: 'OVERCAST',
    desc: 'CLOSED DECK · FLAT LIGHT',
    w: {
      windSpeed: 12.0, gustiness: 0.35, swellHs: 3.0, swellPeriod: 10.0, choppiness: 1.3,
      amplitude: 1.0, spread: 0.8, rain: 0.12, storm: 0.3, fog: 0.3, spray: 0.3, lightningRate: 0,
      turbidity: 5.0, sunElevation: 0.42, sunAzimuth: 2.4, sunIntensity: 18,
      cloudCoverage: 0.68, cloudDensity: 0.9, cloudBottom: 700, cloudTop: 3400,
      cloudAnvil: 0.2, foamStrength: 1.0, starIntensity: 0,
    },
  },
  squall: {
    label: 'SQUALL',
    desc: 'BEAUFORT 9 · DRIVING RAIN',
    w: {
      windSpeed: 21.0, gustiness: 0.55, swellHs: 5.0, swellPeriod: 9.5, choppiness: 1.35,
      amplitude: 1.0, spread: 0.85, rain: 0.8, storm: 0.75, fog: 0.5, spray: 0.9,
      lightningRate: 0.35, turbidity: 6.0, sunElevation: 0.3, sunAzimuth: 1.8, sunIntensity: 16,
      cloudCoverage: 0.7, cloudDensity: 1.0, cloudBottom: 800, cloudTop: 5200,
      cloudAnvil: 0.5, foamStrength: 1.4, starIntensity: 0,
    },
  },
  storm: {
    label: 'VIOLENT STORM',
    desc: 'BEAUFORT 11 · MOUNTAINOUS SEA',
    w: {
      windSpeed: 30.0, gustiness: 0.7, swellHs: 9.0, swellPeriod: 12.0, choppiness: 1.4,
      amplitude: 1.0, spread: 0.9, rain: 1.0, storm: 1.0, fog: 0.6, spray: 1.4,
      lightningRate: 0.8, turbidity: 6.5, sunElevation: 0.2, sunAzimuth: 1.6, sunIntensity: 14,
      cloudCoverage: 0.74, cloudDensity: 1.1, cloudBottom: 620, cloudTop: 5600,
      cloudAnvil: 0.75, foamStrength: 1.8, starIntensity: 0,
    },
  },
  night: {
    label: 'NIGHT STORM',
    desc: 'NO MOON · LIGHTNING ONLY',
    w: {
      windSpeed: 26.0, gustiness: 0.65, swellHs: 7.5, swellPeriod: 11.5, choppiness: 1.35,
      amplitude: 1.0, spread: 0.9, rain: 0.85, storm: 1.0, fog: 0.5, spray: 1.1,
      lightningRate: 1.4, turbidity: 5.5, sunElevation: -0.22, sunAzimuth: 1.5, sunIntensity: 9,
      cloudCoverage: 0.72, cloudDensity: 1.05, cloudBottom: 700, cloudTop: 5000,
      cloudAnvil: 0.6, foamStrength: 1.5, starIntensity: 1.0,
    },
  },
};

const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function sbSlider(min, max, step, value, fmt, onChange) {
  const wrap = el('div', 'sb-slider');
  const inp = document.createElement('input');
  inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = value;
  const val = el('span', 'sb-val', fmt(+value));
  inp.addEventListener('input', () => { val.textContent = fmt(+inp.value); onChange(+inp.value); });
  wrap.appendChild(inp); wrap.appendChild(val);
  wrap.set = (v) => { inp.value = v; val.textContent = fmt(+v); };
  return wrap;
}

export class Sandbox {
  constructor(app) {
    this.app = app;
    this.active = false;
    this.rainOn = false;
    this._banner = null;
    this._build();
  }

  // ------------------------------------------------------------------ events
  /**
   * Every action funnels through here so the feedback is never forgotten: a
   * kick in the camera, a name on screen, and where relevant a vantage point
   * high enough to actually see what was just summoned.
   */
  fire(name, fn, opts = {}) {
    fn();
    if (opts.shake) this.app.cine.impulse(opts.shake);
    if (opts.rise) {
      const y = this.app.weather.state.seaLevel + opts.rise;
      if (this.app.camera.position.y < y) this.app.cine.riseTo(y, opts.hold ?? 12);
    }
    // Above this the user is clearly flying a survey and does not want to be
    // dragged back down to the surface for a camera angle.
    if (opts.drop && this.app.camera.position.y < 400) {
      this.app.cine.dropTo(opts.drop, opts.hold ?? 12);
    }
    if (opts.zoomOut && this.app.cine.freeFov < opts.zoomOut) this.app.cine.setZoom(opts.zoomOut);
    this.flash(name);
    this._syncSliders();
    this._syncButtons();
  }

  /**
   * Merge a preset's sky under an event without discarding what the user has
   * set. Firing a hurricane into a pre-dawn calm leaves the sun below the
   * horizon under total overcast; the scene goes black, auto-exposure lifts it
   * to a flat white sheet, and the storm is invisible.
   */
  _baseSky(key, extra) {
    const base = { ...CONDITIONS[key].w };
    // Sun position is the user's shot; only rescue it if it cannot work.
    if (this.app.weather.target.sunElevation > 0.12) {
      base.sunElevation = this.app.weather.target.sunElevation;
      base.sunAzimuth = this.app.weather.target.sunAzimuth;
    }
    this.app.weather.set({ ...base, ...extra });
    this.condition = null;
  }

  flash(text) {
    const b = this._banner;
    if (!b) return;
    b.textContent = text;
    b.classList.remove('show');
    // force reflow so the animation restarts on a repeated press
    void b.offsetWidth;
    b.classList.add('show');
    clearTimeout(this._bannerT);
    this._bannerT = setTimeout(() => b.classList.remove('show'), 1800);
  }

  /**
   * Sea point under the crosshair, clamped to a range that suits the event
   * being placed. The clamp is not a safety rail, it is the framing: aiming
   * near the horizon from a hundred metres up puts the crosshair a kilometre
   * and a half out, and an eighty metre whirlpool dropped there is four pixels
   * of texture. Each caller passes the distance band its event reads at.
   */
  aim(min = 260, max = 4000) {
    const a = this.app.cine.aimPoint(900);
    const cam = this.app.camera.position;
    let dx = a.x - cam.x, dz = a.z - cam.z;
    const d = Math.hypot(dx, dz) || 1;
    const t = THREE.MathUtils.clamp(d, min, max);
    return { x: cam.x + (dx / d) * t, z: cam.z + (dz / d) * t, dist: t };
  }

  applyCondition(key, immediate = false) {
    const c = CONDITIONS[key];
    if (!c) return;
    this.app.weather.set(c.w, immediate);
    this.rainOn = c.w.rain > 0.05;
    this.condition = key;
    this.flash(c.label);
    this._syncButtons();
    this._syncSliders();
  }

  lightning() {
    const w = this.app.weather;
    // A bolt needs a deck to come out of. Firing one under a clear sky just
    // draws a glowing stick in mid-air, so give it cloud first.
    if (w.state.cloudCoverage < 0.3) {
      w.set({ cloudCoverage: 0.55, cloudDensity: 0.9, cloudAnvil: 0.5, storm: 0.45 });
      this.condition = null;
    }
    this.fire('LIGHTNING', () => this.app.director.lightningBurst(8), { shake: 0.9 });
  }

  toggleRain() {
    const w = this.app.weather;
    const on = !this.rainOn;
    this.rainOn = on;
    this.fire(on ? 'RAIN' : 'RAIN OFF', () => {
      if (!on) { w.set({ rain: 0.0 }); return; }
      // Rain needs a deck over it and haze under it, so raise whichever of
      // those the current sky is short of — without pulling any of them down,
      // which would quietly undo a storm the user had already built.
      w.set({
        rain: 0.85,
        fog: Math.max(w.target.fog, 0.35),
        cloudCoverage: Math.max(w.target.cloudCoverage, 0.62),
        cloudDensity: Math.max(w.target.cloudDensity, 0.95),
        cloudBottom: Math.min(w.target.cloudBottom, 900),
      });
      this.condition = null;
    }, { shake: on ? 0.3 : 0 });
  }

  waterspout() {
    const a = this.aim(340, 1100);
    // A spout hangs from a cloud base; without one there is nothing to hang it
    // from and the funnel ends in empty sky.
    if (this.app.weather.target.cloudCoverage < 0.5) this._baseSky('squall');
    // The funnel is over a kilometre tall; a 40° lens at sea level cannot hold
    // it, so widen out to take in the whole column.
    this.fire('WATERSPOUT', () => this.app.director.spawnWaterspout(a.x, a.z, 32),
      { shake: 1.0, rise: 70, hold: 22, zoomOut: 62 });
  }

  whirlpool() {
    // A maelstrom is a hole in the sea, and a hole is only legible from close
    // enough to look down into it and high enough to see past its near rim.
    const a = this.aim(150, 420);
    this._baseSky('overcast', { windSpeed: 15, swellHs: 4.0, spray: 0.5, foamStrength: 1.5 });
    this.fire('MAELSTROM', () => this.app.director.spawnWhirlpool(a.x, a.z, 42, 110),
      { shake: 0.9, rise: 65, hold: 22, zoomOut: 56 });
  }

  hurricane() {
    // The eye is nearly two kilometres across, so this is the one event that
    // has to be placed far out and looked at whole.
    const a = this.aim(1600, 3200);
    this._baseSky('storm', {
      windSpeed: 36, gustiness: 0.85, spray: 1.9, cloudCoverage: 0.76, cloudDensity: 1.2,
      cloudAnvil: 1.0, cloudBottom: 520, cloudTop: 6400, lightningRate: 1.0, swellHs: 12.0,
      turbidity: 7.0, fog: 0.65, foamStrength: 2.0,
    });
    this.rainOn = true;
    // High enough to read the eyewall as a ring rather than as more big waves,
    // low enough to stay under the deck — the cloud only has presence while
    // there is sky between the eye and the base of it.
    this.fire('HURRICANE', () => this.app.director.spawnHurricane(a.x, a.z, 32),
      { shake: 1.8, rise: 120, hold: 30, zoomOut: 68 });
  }

  rogue() {
    const cam = this.app.camera;
    // Send it straight at the viewer along the look axis.
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const angle = Math.atan2(f.z, f.x) + Math.PI;
    // Rogue waves are a heavy-sea phenomenon — they are the tail of the
    // distribution, not a bolt from nowhere. On a glassy sea one crest with
    // nothing around it reads as a bug; in a gale it reads as the one that
    // should not have been there.
    if (this.app.weather.target.windSpeed < 16) {
      this._baseSky('squall', { rain: this.rainOn ? 0.8 : 0.15, fog: 0.35 });
    }
    // Same reasoning as the tsunami: a thirty metre wave needs an eye below it.
    this.fire('ROGUE WAVE', () => this.app.director.spawnRogue({ angle, distance: 560, height: 30 }),
      { shake: 2.0, drop: 9, hold: 18, zoomOut: 50 });
  }

  tsunami() {
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(this.app.camera.quaternion);
    const h = Math.hypot(f.x, f.z) || 1;
    // Travels back toward the camera, so it enters frame from where you are
    // looking and passes over you. Measured along the travel direction from
    // where the camera actually is rather than from the world origin, so it
    // always takes the same ten seconds to arrive however far the user has
    // flown from the middle of the map.
    const cam = this.app.camera.position;
    const along = (-f.x / h) * cam.x + (-f.z / h) * cam.z;
    // Watched from the water, and that is not a compromise: a tsunami is a
    // horizontal event. The height only means anything measured against an eye
    // that has to look up at it, so the shot is from sea level with the wall
    // filling the frame, not from a helicopter where it flattens into a seam.
    // Riding up the face afterwards comes free — the camera floor tracks the
    // same analytic height the shader draws.
    this.fire('TSUNAMI', () => this.app.director.spawnTsunami({
      dirX: -f.x / h, dirZ: -f.z / h,
      height: 42, width: 150, steep: 1.35, speed: 62, distance: along - 640,
    }), { shake: 2.4, drop: 12, hold: 26, zoomOut: 52 });
  }

  calm() {
    this.app.director.clearEvents();
    this.applyCondition('clear');
  }

  // --------------------------------------------------------------------- UI
  _build() {
    const root = el('div', 'sb');
    root.id = 'sandbox';

    // ---- crosshair
    const cross = el('div', 'sb-cross');
    cross.innerHTML = '<i></i><i></i>';
    root.appendChild(cross);

    // ---- action banner
    this._banner = el('div', 'sb-banner');
    root.appendChild(this._banner);

    // ---- left: conditions + sliders
    const left = el('div', 'sb-left');
    left.appendChild(el('h4', null, 'CONDITIONS'));
    const condRow = el('div', 'sb-grid');
    this._condBtns = {};
    for (const key of Object.keys(CONDITIONS)) {
      const b = el('button', 'sb-btn', CONDITIONS[key].label);
      b.addEventListener('click', () => this.applyCondition(key));
      this._condBtns[key] = b;
      condRow.appendChild(b);
    }
    left.appendChild(condRow);

    left.appendChild(el('h4', null, 'SKY'));
    const w = this.app.weather;
    const mk = (label, key, min, max, step, fmt, map) => {
      const s = sbSlider(min, max, step, map ? map.to(w.target[key]) : w.target[key], fmt,
        (v) => {
          w.target[key] = map ? map.from(v) : v;
          // The sky is no longer the preset once a slider has been moved, and
          // leaving the button lit says otherwise.
          if (this.condition) { this.condition = null; this._syncButtons(); }
          if (key === 'rain') { this.rainOn = v > 0.05; this._syncButtons(); }
        });
      const r = el('div', 'sb-row');
      r.appendChild(el('label', null, label));
      r.appendChild(s);
      left.appendChild(r);
      (this._sliders ||= {})[key] = { s, map };
      return s;
    };
    const f1 = (v) => v.toFixed(1);
    const f2 = (v) => v.toFixed(2);
    const fInt = (v) => v.toFixed(0);

    // Sun elevation reads far better as an angle than as a sine.
    mk('sun °', 'sunElevation', -12, 90, 0.5, fInt, {
      to: (v) => Math.asin(THREE.MathUtils.clamp(v, -1, 1)) * 180 / Math.PI,
      from: (v) => Math.sin(v * Math.PI / 180),
    });
    mk('sun dir', 'sunAzimuth', -3.14, 3.14, 0.02, f2);
    mk('cloud', 'cloudCoverage', 0, 1, 0.01, f2);
    mk('density', 'cloudDensity', 0, 1.6, 0.01, f2);
    mk('base m', 'cloudBottom', 300, 3000, 10, fInt);
    mk('anvil', 'cloudAnvil', 0, 1, 0.01, f2);
    mk('haze', 'turbidity', 1, 12, 0.1, f1);

    left.appendChild(el('h4', null, 'SEA'));
    mk('wind m/s', 'windSpeed', 0, 45, 0.5, f1);
    mk('wind dir', 'windAngle', -3.14, 3.14, 0.02, f2);
    mk('swell m', 'swellHs', 0, 16, 0.1, f1);
    mk('period s', 'swellPeriod', 5, 18, 0.1, f1);
    mk('chop', 'choppiness', 0, 2.0, 0.02, f2);
    mk('rain', 'rain', 0, 1, 0.01, f2);
    mk('spray', 'spray', 0, 2, 0.02, f2);

    left.appendChild(el('h4', null, 'CAMERA'));
    const spd = sbSlider(2, 600, 1, this.app.cine.freeSpeed, fInt, (v) => { this.app.cine.freeSpeed = v; });
    const spdRow = el('div', 'sb-row');
    spdRow.appendChild(el('label', null, 'speed'));
    spdRow.appendChild(spd);
    left.appendChild(spdRow);
    this._speedSlider = spd;

    const zoom = sbSlider(9, 90, 1, 55, fInt, (v) => this.app.cine.setZoom(v));
    const zoomRow = el('div', 'sb-row');
    zoomRow.appendChild(el('label', null, 'zoom fov'));
    zoomRow.appendChild(zoom);
    left.appendChild(zoomRow);
    this._zoomSlider = zoom;

    root.appendChild(left);

    // ---- bottom dock: the disasters
    const dock = el('div', 'sb-dock');
    const actions = [
      ['1', 'LIGHTNING', () => this.lightning()],
      ['2', 'RAIN', () => this.toggleRain()],
      ['3', 'WATERSPOUT', () => this.waterspout()],
      ['4', 'MAELSTROM', () => this.whirlpool()],
      ['5', 'HURRICANE', () => this.hurricane()],
      ['6', 'ROGUE WAVE', () => this.rogue()],
      ['7', 'TSUNAMI', () => this.tsunami()],
      ['0', 'CALM ALL', () => this.calm()],
    ];
    this._actionBtns = {};
    for (const [key, label, fn] of actions) {
      const b = el('button', 'sb-act');
      b.appendChild(el('kbd', null, key));
      b.appendChild(el('span', null, label));
      b.addEventListener('click', fn);
      this._actionBtns[label] = b;
      dock.appendChild(b);
    }
    root.appendChild(dock);

    // ---- help
    const help = el('div', 'sb-help');
    help.innerHTML = 'WASD move · SPACE/Q up-down · SHIFT sprint · CTRL slow<br>'
      + 'MOUSE look (click to capture, ESC to release) · WHEEL zoom · CTRL+WHEEL speed<br>'
      + '1-7 events · 0 calm · TAB settings · C cinematic mode';
    root.appendChild(help);

    document.body.appendChild(root);
    this.root = root;

    window.addEventListener('keydown', (e) => {
      if (!this.active || e.target.tagName === 'INPUT') return;
      const map = {
        Digit1: () => this.lightning(), Digit2: () => this.toggleRain(),
        Digit3: () => this.waterspout(), Digit4: () => this.whirlpool(),
        Digit5: () => this.hurricane(), Digit6: () => this.rogue(),
        Digit7: () => this.tsunami(), Digit0: () => this.calm(),
      };
      if (map[e.code]) { map[e.code](); e.preventDefault(); }
    });
  }

  _syncButtons() {
    for (const k of Object.keys(this._condBtns)) {
      this._condBtns[k].classList.toggle('active', k === this.condition);
    }
    this._actionBtns.RAIN?.classList.toggle('active', this.rainOn);
  }

  /** Pull the sliders back in line after a preset or an event moved the state. */
  _syncSliders() {
    const t = this.app.weather.target;
    for (const key of Object.keys(this._sliders || {})) {
      const { s, map } = this._sliders[key];
      s.set(map ? map.to(t[key]) : t[key]);
    }
  }

  setActive(on) {
    this.active = on;
    this.root.classList.toggle('on', on);
    document.body.classList.toggle('sandbox', on);
    if (on) {
      this.app.director.enabled = false;
      this.app.cine.setFree(true);
      document.body.classList.remove('cine');
      // Hand over a known-good sea rather than whatever frame of the show the
      // user happened to interrupt — which may be a pre-dawn calm that makes
      // every disaster button look broken.
      if (!this._entered) {
        this._entered = true;
        this.applyCondition('trade');
        // The show is shot on long lenses. Flying one is like driving through a
        // letterbox, so open up to something you can steer with.
        this.app.cine.setZoom(60);
      }
      this._syncSliders();
      this._syncButtons();
      this._zoomSlider.set(this.app.cine.freeFov);
      this._speedSlider.set(this.app.cine.freeSpeed);
    } else {
      this.app.cine.setFree(false);
      this.app.director.enabled = true;
      document.body.classList.add('cine');
    }
  }

  /** Keep the zoom readout honest when the user scrolls instead of dragging. */
  tick() {
    if (!this.active) return;
    const fov = Math.round(this.app.cine.freeFov);
    if (fov !== this._lastFov) { this._lastFov = fov; this._zoomSlider.set(fov); }
    const sp = Math.round(this.app.cine.freeSpeed);
    if (sp !== this._lastSpeed) { this._lastSpeed = sp; this._speedSlider.set(sp); }
  }
}
