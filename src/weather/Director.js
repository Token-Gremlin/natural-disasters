import * as THREE from 'three';
import { U } from '../core/SharedUniforms.js';
import { Weather } from './Weather.js';

const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const easeInOut = t => t * t * (3 - 2 * t);
const easeOut = t => 1 - Math.pow(1 - t, 2.2);
const easeIn = t => t * t;

const sech = (v) => 1 / Math.cosh(THREE.MathUtils.clamp(v, -12, 12));

/**
 * CPU twin of solitonProfile() in OCEAN_SAMPLE_GLSL — see the comment there for
 * what the shape is and why. The two must agree: the shader draws the wave and
 * this is what the camera stands on, so any drift between them shows up as the
 * eye hovering above the water or sinking through it.
 */
function solitonProfile(x, w, steep) {
  const s = sech((x > 0 ? x * (1 + steep * 1.35) : x) / w);
  const d = sech((x - w * 1.6) / (w * 1.1));
  return s * s - d * d * 0.16 * steep;
}

/**
 * The full automatic show. Every act sets weather targets, queues camera
 * shots and can fire one-shot events (rogue waves, waterspouts, tsunamis...).
 */
function buildActs() {
  return [
    {
      name: 'DEAD CALM',
      desc: 'PRE-DAWN SWELL · BEAUFORT 2',
      duration: 26,
      weather: {
        windSpeed: 3.4, windAngle: 0.55, gustiness: 0.12, swellHs: 1.5, swellAngle: 0.9,
        swellPeriod: 12.5, spread: 0.55, amplitude: 1.0, choppiness: 1.05,
        rain: 0, turbidity: 1.2, mieG: 0.76, sunElevation: -0.035, sunAzimuth: 2.35,
        cloudCoverage: 0.30, cloudDensity: 0.42, cloudBottom: 900, cloudTop: 2500, cloudAnvil: 0,
        storm: 0, fog: 0.10, spray: 0.0, lightningRate: 0, sunIntensity: 20,
        starIntensity: 1.0, foamStrength: 0.5,
        waterScatter: V3(0.008, 0.039, 0.086), waterAbsorb: V3(0.002, 0.013, 0.032),
      },
      shots: [
        { type: 'skim', duration: 11, height: 1.9, speed: 7, dir: { x: 0.35, z: -0.94 }, fov: 34, shake: 0.5, lookAhead: 90, lookY: 5, minHeight: 1.1 },
        { type: 'orbit', duration: 15, radius0: 150, radius1: 96, height0: 42, height1: 13, angle0: 1.1, angleSpan: 0.7, fov: 40, shake: 0.6, lookY: 3, ease: easeInOut },
      ],
    },
    {
      name: 'SUNRISE',
      desc: 'THE WIND FINDS THE WATER',
      duration: 30,
      weather: {
        windSpeed: 9.5, windAngle: 0.62, gustiness: 0.25, swellHs: 2.0, swellPeriod: 11.5,
        spread: 0.72, amplitude: 1.0, choppiness: 1.25, sunElevation: 0.075, sunAzimuth: 2.3,
        turbidity: 1.6, cloudCoverage: 0.42, cloudDensity: 0.5, cloudBottom: 800, cloudTop: 3400,
        cloudAnvil: 0.12,
        fog: 0.16, spray: 0.05, sunIntensity: 22, starIntensity: 0.0, foamStrength: 0.8,
      },
      shots: [
        { type: 'dolly', duration: 14, from: V3(-120, 4.5, 130), to: V3(30, 9, 40), lookAt: V3(240, 22, -220), fov: 30, shake: 0.7, ease: easeInOut },
        { type: 'orbit', duration: 16, radius0: 70, radius1: 130, height0: 6, height1: 34, angle0: 3.4, angleSpan: -0.85, fov: 36, shake: 0.7, lookY: 5, ease: easeInOut },
      ],
    },
    {
      name: 'FRESH GALE',
      desc: 'BEAUFORT 8 · WHITECAPS EVERYWHERE',
      duration: 30,
      weather: {
        windSpeed: 19.0, windAngle: 0.75, gustiness: 0.42, swellHs: 3.4, swellPeriod: 10.5,
        spread: 0.82, amplitude: 1.05, choppiness: 1.5, sunElevation: 0.30, sunAzimuth: 2.15,
        turbidity: 2.6, mieG: 0.8, cloudCoverage: 0.62, cloudDensity: 0.72, cloudBottom: 650,
        cloudTop: 5200, cloudAnvil: 0.3, storm: 0.35, fog: 0.3, spray: 0.5, rain: 0.05, sunIntensity: 20,
        foamStrength: 1.15,
        waterScatter: V3(0.009, 0.039, 0.081), waterAbsorb: V3(0.003, 0.014, 0.032),
      },
      shots: [
        { type: 'skim', duration: 13, height: 3.0, speed: 22, dir: { x: -0.62, z: -0.78 }, fov: 44, shake: 1.5, lookAhead: 55, lookY: 6, minHeight: 1.8 },
        { type: 'crane', duration: 17, radius0: 90, radius1: 130, height0: 6, height1: 260, angle0: 0.4, angleSpan: 0.7, fov: 40, shake: 1.1, lookY0: 4, lookY1: -50, ease: easeInOut },
      ],
    },
    {
      name: 'SQUALL LINE',
      desc: 'FIRST STRIKE · TORRENTIAL RAIN',
      duration: 34,
      weather: {
        windSpeed: 25.0, windAngle: 0.95, gustiness: 0.6, swellHs: 5.0, swellPeriod: 11.0,
        spread: 0.9, amplitude: 1.0, choppiness: 1.6, sunElevation: 0.34, sunAzimuth: 2.0,
        turbidity: 5.5, mieG: 0.84, cloudCoverage: 0.72, cloudDensity: 0.95, cloudBottom: 520,
        cloudTop: 4800, cloudAnvil: 0.4, storm: 0.75, fog: 0.55, spray: 0.85, rain: 0.85,
        lightningRate: 0.35, sunIntensity: 16, foamStrength: 1.35,
        waterScatter: V3(0.007, 0.032, 0.066), waterAbsorb: V3(0.003, 0.012, 0.027),
      },
      shots: [
        { type: 'orbit', duration: 14, radius0: 180, radius1: 120, height0: 55, height1: 22, angle0: 2.2, angleSpan: 0.8, fov: 42, shake: 1.9, lookY: 8, ease: easeInOut },
        { type: 'skim', duration: 20, height: 4.5, speed: 30, dir: { x: 0.75, z: -0.66 }, fov: 52, shake: 2.4, lookAhead: 40, lookY: 12, minHeight: 2.4 },
      ],
      events: [{ at: 3, fn: (d) => d.lightningBurst(4) }, { at: 16, fn: (d) => d.lightningBurst(6) }],
    },
    {
      name: 'VIOLENT STORM',
      desc: 'BEAUFORT 11 · MOUNTAINOUS SEAS',
      duration: 36,
      weather: {
        windSpeed: 32.0, windAngle: 1.15, gustiness: 0.75, swellHs: 8.0, swellPeriod: 12.5,
        spread: 0.95, amplitude: 1.0, choppiness: 1.7, sunElevation: 0.26, sunAzimuth: 1.85,
        turbidity: 8.0, mieG: 0.86, cloudCoverage: 0.78, cloudDensity: 1.15, cloudBottom: 450,
        cloudTop: 5400, cloudAnvil: 0.7, storm: 1.0, fog: 0.8, spray: 1.3, rain: 1.0,
        lightningRate: 0.9, sunIntensity: 12, foamStrength: 1.6,
        waterScatter: V3(0.006, 0.026, 0.055), waterAbsorb: V3(0.003, 0.011, 0.023),
      },
      shots: [
        { type: 'skim', duration: 12, height: 6.0, speed: 34, dir: { x: -0.2, z: -0.98 }, fov: 58, shake: 3.2, lookAhead: 32, lookY: 16, minHeight: 3.0, roll: 0.03 },
        { type: 'orbit', duration: 12, radius0: 110, radius1: 78, height0: 12, height1: 5, angle0: 0.2, angleSpan: 1.5, fov: 46, shake: 3.0, lookY: 10 },
        { type: 'crane', duration: 12, radius0: 150, radius1: 200, height0: 8, height1: 420, angle0: 2.9, angleSpan: 0.5, fov: 38, shake: 2.2, lookY0: 6, lookY1: -90, ease: easeInOut },
      ],
      events: [
        { at: 2, fn: (d) => d.lightningBurst(8) },
        { at: 10, fn: (d) => d.lightningBurst(10) },
        { at: 22, fn: (d) => d.lightningBurst(12) },
      ],
    },
    {
      name: 'WATERSPOUT',
      desc: 'TORNADIC VORTEX · SEA TO CLOUD',
      duration: 34,
      weather: {
        windSpeed: 26.0, windAngle: 1.35, gustiness: 0.65, sunElevation: 0.26, sunAzimuth: 1.7,
        turbidity: 6.0, cloudCoverage: 0.70, cloudDensity: 1.0, cloudBottom: 1150, cloudTop: 5200,
        cloudAnvil: 0.85,
        storm: 1.0, fog: 0.45, spray: 1.4, rain: 0.55, lightningRate: 0.6, sunIntensity: 15,
      },
      // The column is over a kilometre tall and only tens of metres across, so
      // the camera has to stand well back for the whole thing to fit — and the
      // scale only reads if the sea and the cloud base are both in frame.
      shots: [
        // Wide enough that the whole column fits between the sea and the cloud
        // base. Keeping the horizon in frame is what gives it its height: a
        // funnel with nothing to be tall against is just a smudge.
        { type: 'orbit', duration: 16, radius0: 1650, radius1: 1050, height0: 95, height1: 65, angle0: 0.9, angleSpan: 0.7, fov: 40, shake: 1.4, lookY: 480, ease: easeInOut,
          center: { x: 0, z: -260 } },
        // then in under the base, looking up the length of the rope
        { type: 'orbit', duration: 18, radius0: 620, radius1: 330, height0: 35, height1: 95, angle0: 1.9, angleSpan: 1.1, fov: 58, shake: 2.4, lookY: 330,
          center: { x: 0, z: -260 } },
      ],
      events: [{ at: 0.1, fn: (d) => d.spawnWaterspout(0, -260, 30) }],
    },
    {
      name: 'ROGUE WAVE',
      desc: 'A 30 METRE WALL OUT OF NOWHERE',
      duration: 26,
      weather: {
        windSpeed: 30.0, windAngle: 1.3, sunElevation: 0.16, sunAzimuth: 1.55,
        turbidity: 7.5, cloudCoverage: 0.78, cloudDensity: 1.1, storm: 1.0, fog: 0.8,
        spray: 1.6, rain: 0.85, lightningRate: 0.7, sunIntensity: 11, foamStrength: 1.8,
      },
      shots: [
        { type: 'static', duration: 10, pos: V3(0, 7, 120), lookAt: V3(0, 22, -60), fov: 46, shake: 2.6, drift: 2.0 },
        { type: 'dolly', duration: 16, from: V3(60, 10, 140), to: V3(-30, 30, 20), lookFrom: V3(0, 18, -20), lookTo: V3(0, 34, -80), fov: 42, shake: 3.4, ease: easeInOut },
      ],
      events: [{ at: 4, fn: (d) => d.spawnRogue() }],
    },
    {
      name: 'HURRICANE EYE',
      desc: 'INSIDE THE STADIUM',
      duration: 40,
      weather: {
        windSpeed: 40.0, windAngle: 1.6, gustiness: 0.5, swellHs: 11.0, swellPeriod: 14.0,
        amplitude: 1.0, choppiness: 1.65, sunElevation: 0.55, sunAzimuth: 1.4,
        turbidity: 4.0, mieG: 0.82, cloudCoverage: 0.78, cloudDensity: 1.3, cloudBottom: 500,
        cloudTop: 6000, cloudAnvil: 1.0, storm: 1.0, fog: 0.5, spray: 1.8, rain: 0.5,
        lightningRate: 0.5, sunIntensity: 18, foamStrength: 1.9,
      },
      shots: [
        { type: 'dolly', duration: 18, from: V3(2600, 260, 1400), to: V3(420, 90, 220), lookFrom: V3(0, 200, 0), lookTo: V3(0, 900, 0), fov: 48, shake: 3.0, ease: easeInOut },
        { type: 'orbit', duration: 22, radius0: 300, radius1: 520, height0: 40, height1: 150, angle0: 0.0, angleSpan: 1.9, fov: 60, shake: 1.2, lookY: 800, ease: easeInOut },
      ],
      events: [{ at: 0.2, fn: (d) => d.spawnHurricane(0, 0) }],
    },
    {
      name: 'TSUNAMI',
      desc: 'A CONTINENT OF WATER IN MOTION',
      duration: 32,
      weather: {
        windSpeed: 21.0, windAngle: 1.2, sunElevation: 0.10, sunAzimuth: 1.2,
        turbidity: 5.0, cloudCoverage: 0.72, cloudDensity: 0.9, cloudTop: 6400, cloudAnvil: 0.4,
        storm: 0.7, fog: 0.6, spray: 1.2, rain: 0.35, lightningRate: 0.25, sunIntensity: 16,
        foamStrength: 2.0,
      },
      shots: [
        { type: 'static', duration: 9, pos: V3(0, 34, 620), lookAt: V3(0, 30, -200), fov: 34, shake: 1.6, drift: 3.0 },
        { type: 'chase', duration: 23, offset: { x: 260, y: 74, z: 340 }, fov: 44, shake: 2.8,
          follow: (t) => ({ x: 0, y: 20, z: 900 - 92 * t }) },
      ],
      events: [{ at: 2, fn: (d) => d.spawnTsunami() }],
    },
    {
      name: 'NIGHT LIGHTNING',
      desc: 'THE SEA LIT ONLY BY THE SKY',
      duration: 34,
      weather: {
        windSpeed: 26.0, windAngle: 0.9, sunElevation: -0.16, sunAzimuth: 0.9,
        turbidity: 6.0, mieG: 0.85, cloudCoverage: 0.78, cloudDensity: 1.05, cloudBottom: 520,
        cloudTop: 4900, cloudAnvil: 0.5, storm: 1.0, fog: 0.7, spray: 1.1, rain: 0.9,
        lightningRate: 1.6, sunIntensity: 22, starIntensity: 0.7, foamStrength: 1.5,
        waterScatter: V3(0.004, 0.017, 0.040), waterAbsorb: V3(0.002, 0.007, 0.017),
      },
      shots: [
        { type: 'skim', duration: 14, height: 3.6, speed: 24, dir: { x: 0.5, z: -0.86 }, fov: 50, shake: 2.6, lookAhead: 40, lookY: 14, minHeight: 2.2 },
        { type: 'orbit', duration: 20, radius0: 200, radius1: 120, height0: 60, height1: 16, angle0: 4.1, angleSpan: 1.1, fov: 44, shake: 2.0, lookY: 12, ease: easeInOut },
      ],
      events: [
        { at: 1, fn: (d) => d.lightningBurst(14) },
        { at: 9, fn: (d) => d.lightningBurst(16) },
        { at: 18, fn: (d) => d.lightningBurst(18) },
        { at: 26, fn: (d) => d.lightningBurst(20) },
      ],
    },
    {
      name: 'AFTERMATH',
      desc: 'GOLDEN HOUR OVER A SPENT OCEAN',
      duration: 30,
      weather: {
        windSpeed: 8.0, windAngle: 0.7, gustiness: 0.2, swellHs: 3.2, swellPeriod: 13.5,
        spread: 0.6, amplitude: 1.0, choppiness: 1.15, sunElevation: 0.055, sunAzimuth: 0.55,
        turbidity: 2.6, mieG: 0.8, cloudCoverage: 0.5, cloudDensity: 0.6, cloudBottom: 900,
        cloudTop: 5600, cloudAnvil: 0.2, storm: 0.15, fog: 0.28, spray: 0.15, rain: 0.0,
        lightningRate: 0.0, sunIntensity: 24, starIntensity: 0.2, foamStrength: 0.9,
        waterScatter: V3(0.011, 0.048, 0.098), waterAbsorb: V3(0.003, 0.017, 0.038),
      },
      shots: [
        { type: 'skim', duration: 13, height: 2.2, speed: 9, dir: { x: 0.92, z: 0.38 }, fov: 30, shake: 0.7, lookAhead: 120, lookY: 6, minHeight: 1.2 },
        { type: 'crane', duration: 17, radius0: 60, radius1: 140, height0: 3, height1: 190, angle0: 0.2, angleSpan: 0.5, fov: 34, shake: 0.6, lookY0: 3, lookY1: -30, ease: easeInOut },
      ],
    },
  ];
}

export class Director {
  constructor(app) {
    this.app = app;
    this.weather = new Weather(app);
    this.acts = buildActs();
    this.actIndex = -1;
    this.actTime = 0;
    this.shotIdx = 0;
    this.shotTime = 0;
    this.enabled = true;
    this.totalDuration = this.acts.reduce((a, b) => a + b.duration, 0);
    this.elapsed = 0;
    this._firedEvents = new Set();

    this._vortexSlots = [U.uVortex0, U.uVortex1, U.uVortex2, U.uVortex3];
    this._vortices = [];
    this._solitons = [];
    this._rogue = null;
    this._hurricane = null;
  }

  start() { this.gotoAct(0); }

  gotoAct(i) {
    // Jumping into an act mid-show has to leave the previous act's one-shots
    // behind, or a rogue wave and a waterspout turn up in the dead calm.
    this.clearEvents();
    this.actIndex = ((i % this.acts.length) + this.acts.length) % this.acts.length;
    const act = this.acts[this.actIndex];
    this.actTime = 0;
    this.shotIdx = -1;
    this._firedEvents.clear();
    this.weather.set(act.weather);
    this.nextShot();
    this.onAct?.(act, this.actIndex);
  }

  nextShot() {
    const act = this.acts[this.actIndex];
    this.shotIdx = (this.shotIdx + 1) % act.shots.length;
    const shot = { ...act.shots[this.shotIdx] };
    if (!shot.center) shot.center = { x: this.app.camera.position.x * 0.0, z: 0 };
    this.app.cine.playShot(shot);
    this.shotTime = 0;
  }

  // ------------------------------------------------------------- one shots
  lightningBurst(count) {
    const w = this.weather.state;
    this.app.lightning?.burst(count, {
      cloudBase: w.cloudBottom,
      radius: 1200 + w.storm * 4200,
      window: 3.5,
    });
  }

  spawnWaterspout(x, z, strength = 30) {
    this._vortices.push({ x, z, radius: 34, strength, life: 0, maxLife: 34, ramp: 3, spout: true });
    this.app.waterspout?.spawn(x, z, strength);
  }

  /** A vortex on the water with no funnel above it. */
  spawnWhirlpool(x, z, strength = 34, radius = 70) {
    this._vortices.push({ x, z, radius, strength, life: 0, maxLife: 40, ramp: 4 });
    this.app.cine.impulse(0.5);
  }

  /**
   * @param opts.x,z where the group forms. Defaults to just beyond the camera.
   * @param opts.angle travel direction in radians; defaults to downwind.
   */
  spawnRogue(opts = {}) {
    const ang = opts.angle ?? this.weather.state.windAngle;
    const cam = this.app.camera.position;
    const dx = Math.cos(ang), dz = Math.sin(ang);
    // Start it upwind of the viewer so it sweeps through frame rather than
    // appearing on top of them.
    const back = opts.distance ?? 400;
    this._rogue = {
      x: opts.x ?? cam.x - dx * back,
      z: opts.z ?? cam.z - dz * back,
      radius: opts.radius ?? 240,
      amp: 0, ampTarget: opts.height ?? 27,
      // One dominant crest, not a wave train. Fitting roughly a single
      // wavelength inside the group envelope is what makes it read as the one
      // that should not have been there rather than as a patch of chop; and at
      // 420 m the deep-water phase speed really is about 26 m/s, so the two
      // agree instead of the group sliding through its own carrier.
      dir: [dx, dz], wavelength: opts.wavelength ?? 420, phase: 0, life: 0, maxLife: 26,
      speed: opts.speed ?? 26,
    };
    this.app.cine.impulse(1.6);
  }

  /**
   * A solitary wave crossing the whole domain. Direction defaults to travelling
   * toward the camera, because a tsunami you are not in the path of is just a
   * line on the horizon.
   */
  spawnTsunami(opts = {}) {
    const cam = this.app.camera.position;
    let dx = opts.dirX, dz = opts.dirZ;
    if (dx === undefined || dz === undefined) {
      const len = Math.hypot(cam.x, cam.z) || 1;
      dx = cam.x / len; dz = cam.z / len;
    }
    const amp = opts.height ?? 34;
    this._solitons.push({
      dir: [dx, dz],
      // measured along the travel direction, so it has to start ahead of the eye
      dist: opts.distance ?? -1000,
      amp: 0, ampTarget: amp,
      width: opts.width ?? 150, steep: opts.steep ?? 1.2,
      // The lateral envelope is measured from the world origin, so a narrow
      // front only exists near 0,0 and vanishes once the camera flies away. A
      // real tsunami front is hundreds of kilometres wide; treating it as
      // effectively unbounded is both more correct and free of that trap.
      lateral: opts.lateral ?? 9000,
      speed: opts.speed ?? 105, life: 0, maxLife: 40,
    });
    this.app.cine.impulse(2.2);
  }

  spawnHurricane(x, z, strength = 26) {
    this._hurricane = { x, z, eye: 900, intensity: 0, target: strength, life: 0, maxLife: 60 };
  }

  hasEvents() {
    return this._solitons.length > 0 || this._vortices.length > 0
      || !!this._rogue || !!this._hurricane;
  }

  /**
   * CPU mirror of the analytic disaster displacement in OCEAN_SAMPLE_GLSL.
   * The FFT cascades live on the GPU and are not readable cheaply, but the
   * event fields are plain maths — enough for the camera to ride a passing
   * tsunami instead of being swallowed by it.
   */
  eventHeight(x, z) {
    let h = 0;

    for (const s of this._solitons) {
      if (s.amp <= 0.001) continue;
      const len = Math.hypot(s.dir[0], s.dir[1]) || 1;
      const dx = s.dir[0] / len, dz = s.dir[1] / len;
      const along = x * dx + z * dz - s.dist;
      const lat = x * -dz + z * dx;
      const latEnv = Math.exp(-(lat * lat) / (s.lateral * s.lateral + 1));
      h += s.amp * solitonProfile(along, Math.max(s.width, 1), s.steep) * latEnv;
    }

    const r = this._rogue;
    if (r && r.amp > 0.001) {
      const dx = x - r.x, dz = z - r.z;
      const R = Math.max(r.radius, 1);
      const env = Math.exp(-(dx * dx + dz * dz) / (R * R));
      // Only the envelope matters here; the carrier oscillates about zero and
      // chasing its exact phase would make the camera judder.
      h += env * r.amp * 0.8;
    }

    const hur = this._hurricane;
    if (hur && hur.intensity > 0.001) {
      const dx = x - hur.x, dz = z - hur.z;
      const eye = Math.max(hur.eye, 50);
      const xr = (Math.hypot(dx, dz) + 1e-3) / eye;
      const ring = Math.exp(-Math.pow((xr - 1.25) * 1.4, 2));
      h += ring * hur.intensity * 3.0 - Math.exp(-xr * xr * 1.6) * hur.intensity * 0.4;
    }

    for (const v of this._vortices) {
      if (!v.current) continue;
      const dx = x - v.x, dz = z - v.z;
      const xr = (Math.hypot(dx, dz) + 1e-3) / Math.max(v.radius, 1);
      h -= v.current / (1 + xr * xr * 2.2);
    }

    return h;
  }

  clearEvents() {
    this._vortices.length = 0;
    this._solitons.length = 0;
    this._rogue = null;
    this._hurricane = null;
    // The funnel outlives its ocean vortex, so without this a spout follows the
    // camera into the next act and stands in the middle of a calm sea.
    this.app.waterspout?.clear();
  }

  // ------------------------------------------------------------------ tick
  update(dt) {
    if (this.enabled) {
      const act = this.acts[this.actIndex] || this.acts[0];
      this.actTime += dt;
      this.shotTime += dt;
      this.elapsed += dt;

      if (act.events) {
        for (let i = 0; i < act.events.length; i++) {
          const e = act.events[i];
          if (!this._firedEvents.has(i) && this.actTime >= e.at) {
            this._firedEvents.add(i);
            e.fn(this);
          }
        }
      }

      const shot = this.app.cine.shot;
      if (shot && this.shotTime >= (shot.duration || 8)) this.nextShot();
      if (this.actTime >= act.duration) {
        this.clearEvents();
        this.gotoAct(this.actIndex + 1);
      }
    }

    this.weather.update(dt);
    this._updateFields(dt);
  }

  _updateFields(dt) {
    // ---- vortices
    for (let i = this._vortices.length - 1; i >= 0; i--) {
      const v = this._vortices[i];
      v.life += dt;
      if (v.life > v.maxLife) { this._vortices.splice(i, 1); continue; }
      const up = THREE.MathUtils.smoothstep(v.life, 0, v.ramp);
      const down = 1 - THREE.MathUtils.smoothstep(v.life, v.maxLife - 5, v.maxLife);
      v.current = v.strength * up * down;
      // drift with the wind
      const w = this.weather.state;
      v.x += Math.cos(w.windAngle) * w.windSpeed * 0.16 * dt;
      v.z += Math.sin(w.windAngle) * w.windSpeed * 0.16 * dt;
      // the funnel hangs over its vortex; the director owns the position
      if (v.spout) this.app.waterspout?.setPosition(v.x, v.z);
    }
    for (let i = 0; i < 4; i++) {
      const v = this._vortices[i];
      if (v) this._vortexSlots[i].value.set(v.x, v.z, v.radius, v.current || 0);
      else this._vortexSlots[i].value.set(0, 0, 1, 0);
    }

    // ---- solitons
    const solSlots = [[U.uSoliton0, U.uSoliton0b], [U.uSoliton1, U.uSoliton1b]];
    const cam = this.app.camera.position;
    for (let i = this._solitons.length - 1; i >= 0; i--) {
      const s = this._solitons[i];
      s.life += dt;
      s.dist += s.speed * dt;
      s.amp += (s.ampTarget - s.amp) * (1 - Math.exp(-dt * 0.8));
      // The instant the face reaches the eye is the beat the whole event is
      // built around. Without a kick there the wall just slides past, and the
      // camera rides up it as smoothly as an elevator.
      const along = cam.x * s.dir[0] + cam.z * s.dir[1] - s.dist;
      if (s.prevAlong > s.width * 0.6 && along <= s.width * 0.6) {
        this.app.cine.impulse(Math.min(3.2, 0.6 + s.amp * 0.07));
      }
      s.prevAlong = along;
      if (s.life > s.maxLife) { this._solitons.splice(i, 1); continue; }
    }
    for (let i = 0; i < 2; i++) {
      const s = this._solitons[i];
      if (s) {
        const fade = 1 - THREE.MathUtils.smoothstep(s.life, s.maxLife - 6, s.maxLife);
        solSlots[i][0].value.set(s.dir[0], s.dir[1], s.dist, s.amp * fade);
        solSlots[i][1].value.set(s.width, s.steep, s.lateral, s.speed);
      } else {
        solSlots[i][0].value.set(0, -1, 0, 0);
        solSlots[i][1].value.set(100, 0.5, 500, 20);
      }
    }

    // ---- rogue group
    if (this._rogue) {
      const r = this._rogue;
      r.life += dt;
      r.phase += dt * 1.6;
      r.x += r.dir[0] * r.speed * dt;
      r.z += r.dir[1] * r.speed * dt;
      const up = THREE.MathUtils.smoothstep(r.life, 0, 5);
      const down = 1 - THREE.MathUtils.smoothstep(r.life, r.maxLife - 6, r.maxLife);
      r.amp = r.ampTarget * up * down;
      // Same beat as the soliton: kick the camera as the group arrives.
      const reach = Math.hypot(cam.x - r.x, cam.z - r.z);
      if (r.prevReach > r.radius && reach <= r.radius) {
        this.app.cine.impulse(Math.min(2.8, 0.5 + r.amp * 0.06));
      }
      r.prevReach = reach;
      U.uRogue.value.set(r.x, r.z, r.radius, r.amp);
      U.uRogueB.value.set(r.dir[0], r.dir[1], r.wavelength, r.phase);
      if (r.life > r.maxLife) this._rogue = null;
    } else {
      U.uRogue.value.set(0, 0, 1, 0);
    }

    // ---- hurricane
    if (this._hurricane) {
      const h = this._hurricane;
      h.life += dt;
      const up = THREE.MathUtils.smoothstep(h.life, 0, 8);
      const down = 1 - THREE.MathUtils.smoothstep(h.life, h.maxLife - 6, h.maxLife);
      h.intensity = h.target * up * down;
      U.uHurricane.value.set(h.x, h.z, h.eye, h.intensity);
      if (h.life > h.maxLife) this._hurricane = null;
    } else {
      U.uHurricane.value.set(0, 0, 900, 0);
    }
  }
}

export function installDirector(app) {
  const director = new Director(app);
  app.director = director;
  app.weather = director.weather;
  // Scaled, not raw. On the raw clock a pause stops the ocean and the timer
  // but leaves the acts running and a tsunami crossing the map at sixty metres
  // a second, so the sea you unpause into is not the one you paused.
  app.beforeUpdate = (scaledDt) => director.update(scaledDt);
  director.start();
  return director;
}
