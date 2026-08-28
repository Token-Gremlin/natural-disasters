import * as THREE from 'three';

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

function smoothNoise(t, seed) {
  const s = Math.sin(t * 1.13 + seed * 12.9898) * 0.5
          + Math.sin(t * 2.31 + seed * 78.233) * 0.28
          + Math.sin(t * 4.77 + seed * 43.512) * 0.14
          + Math.sin(t * 9.13 + seed * 19.371) * 0.07;
  return s / 0.99;
}

/**
 * Shot-based cinematic camera with procedural handheld motion, auto focus and
 * a manual free-fly override.
 */
export class CinematicCamera {
  constructor(aspect) {
    this.camera = new THREE.PerspectiveCamera(38, aspect, 0.25, 100000);
    this.camera.position.set(0, 14, 60);
    this.target = new THREE.Vector3(0, 2, 0);

    this.free = false;
    this.shot = null;
    this.shotTime = 0;
    this.shotIndex = 0;

    this.shake = 1.0;
    this.shakeBoost = 0;
    this.focusDistance = 60;
    this.focusTarget = 60;
    this.fovTarget = 38;
    this.roll = 0;
    this.rollTarget = 0;

    this._pos = new THREE.Vector3().copy(this.camera.position);
    this._look = new THREE.Vector3().copy(this.target);
    this._smoothPos = new THREE.Vector3().copy(this.camera.position);
    this._smoothLook = new THREE.Vector3().copy(this.target);
    this._first = true;

    // free-fly state
    this.keys = new Set();
    this.yaw = 0; this.pitch = 0;
    this.freeSpeed = 40;
    this.sensitivity = 0.0022;
    this.invertY = false;
    this._dragging = false;
    this._locked = false;
    this._vel = new THREE.Vector3();
    this._freePos = new THREE.Vector3().copy(this.camera.position);
    this._lastCamPos = new THREE.Vector3().copy(this.camera.position);
    this._touches = new Map();
    this._pinchDist = 0;
    // Zoom is a real focal-length change, not a dolly: pulling in on a storm on
    // the horizon has to bring it closer without walking the camera into it.
    this.freeFov = 55;
    this.minFov = 9;
    this.maxFov = 90;
    this.seaLevelFn = () => 0;
    // Analytic displacement from active disasters. Only free flight uses it —
    // the scripted shots are framed to be overtopped on purpose.
    this.eventFloorFn = () => 0;
    // Rough crest height of the current sea, so free flight rides over the
    // waves instead of being swamped by every one that passes.
    this.waveFloor = 0;
    this.onLockChange = null;
  }

  get pointerLocked() { return this._locked; }

  requestPointerLock() {
    const dom = this._dom;
    if (!dom || !dom.requestPointerLock) return;
    // Chrome hands back a promise and rejects it whenever the document cannot
    // hold the lock — an embedded frame, a window that is not frontmost, a
    // second request while one is pending. Losing the lock is survivable
    // (drag-look still works); an unhandled rejection in the console is not.
    try {
      const r = dom.requestPointerLock();
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch (_) { /* older API, throws synchronously */ }
  }

  attachInput(dom) {
    this._dom = dom;

    const look = (dx, dy) => {
      this.yaw -= dx * this.sensitivity;
      const s = this.invertY ? -1 : 1;
      this.pitch = THREE.MathUtils.clamp(this.pitch - dy * this.sensitivity * s, -1.52, 1.52);
    };

    // Pointer lock is what makes this feel like a game rather than a viewer:
    // the mouse never runs out of screen and there is no button to hold.
    document.addEventListener('pointerlockchange', () => {
      this._locked = document.pointerLockElement === dom;
      this.onLockChange?.(this._locked);
    });

    dom.addEventListener('pointerdown', (e) => {
      if (!this.free) return;
      if (e.pointerType === 'touch') {
        this._touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        return;
      }
      if (!this._locked) this.requestPointerLock();
      this._dragging = true;
      try { dom.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    });

    const endPointer = (e) => {
      this._touches.delete(e.pointerId);
      if (this._touches.size < 2) this._pinchDist = 0;
      this._dragging = false;
      try { dom.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    };
    dom.addEventListener('pointerup', endPointer);
    dom.addEventListener('pointercancel', endPointer);

    dom.addEventListener('pointermove', (e) => {
      if (!this.free) return;

      if (e.pointerType === 'touch') {
        const prev = this._touches.get(e.pointerId);
        if (!prev) return;
        this._touches.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (this._touches.size >= 2) {
          // two fingers: pinch to zoom
          const pts = [...this._touches.values()];
          const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
          if (this._pinchDist > 0) this.zoomBy(this._pinchDist / Math.max(d, 1));
          this._pinchDist = d;
        } else {
          look(e.clientX - prev.x, e.clientY - prev.y);
        }
        return;
      }

      // Locked pointers report movement even at the screen edge; unlocked ones
      // only count while a button is held, so the cursor stays usable for the UI.
      if (this._locked) look(e.movementX, e.movementY);
      else if (this._dragging) look(e.movementX, e.movementY);
    });

    // On the window rather than the canvas: the HUD covers a good third of the
    // screen, and a zoom that dies whenever the cursor happens to be resting
    // over a panel reads as a broken scroll wheel. Panels that genuinely have
    // somewhere to scroll keep their wheel.
    window.addEventListener('wheel', (e) => {
      if (!this.free) return;
      for (let n = e.target; n && n !== document.body; n = n.parentElement) {
        if (n.scrollHeight > n.clientHeight + 2) {
          const oy = getComputedStyle(n).overflowY;
          if (oy === 'auto' || oy === 'scroll') return;
        }
      }
      e.preventDefault();
      // Ctrl or Alt repurposes the wheel for movement speed, which is the other
      // thing you constantly want to adjust while flying.
      if (e.ctrlKey || e.altKey) {
        this.freeSpeed = THREE.MathUtils.clamp(this.freeSpeed * (e.deltaY > 0 ? 0.84 : 1.19), 0.5, 6000);
      } else {
        this.zoomBy(e.deltaY > 0 ? 1.11 : 1 / 1.11);
      }
    }, { passive: false });

    window.addEventListener('keydown', (e) => this.keys.add(e.code));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  /**
   * Temporarily raise the free camera to a vantage point. Riding a tsunami is
   * a poor way to watch one — the crest you are standing on is invisible. This
   * lifts the eye over the event so the wall reads as a wall, then decays back
   * to normal flight. Any manual climb above the target cancels it.
   */
  riseTo(y, hold = 6) {
    this._vantage = { y, hold };
    this._ceiling = null;
  }

  /**
   * The opposite, and just as necessary. Height is not the same as a good view:
   * a forty metre wall of water seen from a hundred metres up is a crease in a
   * blue sheet, because what makes it read is having to look *up* at it. This
   * brings the eye back down to the water for the duration of an event. Any
   * deliberate climb cancels it — the user always outranks the framing.
   */
  dropTo(y, hold = 6) {
    this._ceiling = { y, hold };
    this._vantage = null;
  }

  zoomBy(factor) {
    this.freeFov = THREE.MathUtils.clamp(this.freeFov * factor, this.minFov, this.maxFov);
    if (this.free) this.fovTarget = this.freeFov;
  }

  setZoom(fov) {
    this.freeFov = THREE.MathUtils.clamp(fov, this.minFov, this.maxFov);
    if (this.free) this.fovTarget = this.freeFov;
  }

  /**
   * Where the camera is pointing, projected onto the sea. Events spawn here so
   * they appear where the user is actually looking instead of at the origin.
   * Falls back to a point ahead on the horizon when the view is above level.
   */
  aimPoint(fallbackDist = 700) {
    const cam = this.camera;
    _v.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const p = cam.position;

    // Two passes against the event-displaced surface. Focusing on the flat sea
    // while a wave stands thirty metres away puts the subject far outside the
    // depth of field and dissolves the whole frame.
    let x = p.x, z = p.z, dist = fallbackDist, hitSea = false;
    for (let i = 0; i < 2; i++) {
      const sea = this.seaLevelFn(x, z) + this.eventFloorFn(x, z);
      const dy = p.y - sea;
      if (_v.y >= -0.02 || dy <= 0.5) { hitSea = false; break; }
      dist = Math.min(dy / -_v.y, 26000);
      x = p.x + _v.x * dist; z = p.z + _v.z * dist;
      hitSea = true;
    }
    if (hitSea) return { x, z, dist };

    const h = Math.hypot(_v.x, _v.z) || 1e-4;
    return {
      x: p.x + (_v.x / h) * fallbackDist,
      z: p.z + (_v.z / h) * fallbackDist,
      dist: fallbackDist,
    };
  }

  setFree(v) {
    this.free = v;
    if (v) {
      // Inherit the current framing so handing control over is a continuation
      // rather than a cut.
      const dir = _v.copy(this._smoothLook).sub(this.camera.position).normalize();
      this.yaw = Math.atan2(-dir.x, -dir.z);
      this.pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
      this._vel.set(0, 0, 0);
      this._freePos.copy(this.camera.position);
      this._lastCamPos.copy(this.camera.position);
      this._floor = undefined;
      this.freeFov = THREE.MathUtils.clamp(this.camera.fov, this.minFov, this.maxFov);
      this.fovTarget = this.freeFov;
    } else if (document.pointerLockElement) {
      document.exitPointerLock();
    }
    this._first = true;
  }

  playShot(shot) {
    this.shot = shot;
    this.shotTime = 0;
    this.shotIndex++;
    if (shot.fov) this.fovTarget = shot.fov;
    this.shake = shot.shake !== undefined ? shot.shake : 1.0;
    this.rollTarget = shot.roll || 0;
    if (shot.cut !== false) this._first = true;
  }

  _evalShot(t, out, look) {
    const s = this.shot;
    const e = s.ease ? s.ease(t) : t;
    const c = s.center || { x: 0, z: 0 };

    switch (s.type) {
      case 'orbit': {
        const ang = (s.angle0 || 0) + (s.angleSpan || Math.PI * 0.6) * e;
        const rad = THREE.MathUtils.lerp(s.radius0 ?? 120, s.radius1 ?? 90, e);
        const hgt = THREE.MathUtils.lerp(s.height0 ?? 25, s.height1 ?? 18, e);
        out.set(c.x + Math.cos(ang) * rad, hgt, c.z + Math.sin(ang) * rad);
        look.set(c.x + (s.lookOffset?.x || 0), (s.lookY ?? 4) , c.z + (s.lookOffset?.z || 0));
        break;
      }
      case 'dolly': {
        out.lerpVectors(s.from, s.to, e);
        if (s.lookFrom && s.lookTo) look.lerpVectors(s.lookFrom, s.lookTo, e);
        else look.copy(s.lookAt || this.target);
        break;
      }
      case 'crane': {
        const ang = (s.angle0 || 0) + (s.angleSpan || 0.4) * e;
        const rad = THREE.MathUtils.lerp(s.radius0 ?? 60, s.radius1 ?? 60, e);
        const hgt = THREE.MathUtils.lerp(s.height0 ?? 3, s.height1 ?? 220, Math.pow(e, s.heightEase ?? 1.7));
        out.set(c.x + Math.cos(ang) * rad, hgt, c.z + Math.sin(ang) * rad);
        look.set(c.x, THREE.MathUtils.lerp(s.lookY0 ?? 2, s.lookY1 ?? -30, e), c.z);
        break;
      }
      case 'skim': {
        const dir = s.dir || { x: 0, z: -1 };
        const speed = s.speed ?? 26;
        const d = speed * this.shotTime;
        out.set(c.x + dir.x * d, s.height ?? 2.4, c.z + dir.z * d);
        const la = s.lookAhead ?? 60;
        look.set(out.x + dir.x * la, (s.lookY ?? 3.0), out.z + dir.z * la);
        break;
      }
      case 'chase': {
        const p = s.follow ? s.follow(this.shotTime) : { x: 0, y: 0, z: 0 };
        const off = s.offset || { x: 0, y: 40, z: 120 };
        out.set(p.x + off.x, off.y, p.z + off.z);
        look.set(p.x, p.y || 0, p.z);
        break;
      }
      case 'static': {
        const drift = s.drift ?? 1.0;
        out.copy(s.pos);
        out.x += Math.sin(this.shotTime * 0.11) * drift;
        out.y += Math.sin(this.shotTime * 0.17 + 1.0) * drift * 0.35;
        look.copy(s.lookAt);
        break;
      }
      case 'underwater': {
        const dir = s.dir || { x: 0, z: -1 };
        const d = (s.speed ?? 5) * this.shotTime;
        out.set(c.x + dir.x * d, THREE.MathUtils.lerp(s.depth0 ?? -8, s.depth1 ?? -1.2, e), c.z + dir.z * d);
        look.set(out.x + dir.x * 30, THREE.MathUtils.lerp(s.lookY0 ?? -2, s.lookY1 ?? 22, e), out.z + dir.z * 30);
        break;
      }
      default:
        out.copy(this.camera.position);
        look.copy(this.target);
    }
  }

  update(dt, time) {
    const cam = this.camera;
    if (this.freeze) return;

    if (this.free) {
      // Adopt any position written from outside (teleports, dev tooling) so
      // flight continues from where it was put rather than snapping back.
      if (cam.position.distanceToSquared(this._lastCamPos) > 0.01) this._freePos.copy(cam.position);

      const k = this.keys;
      const sprint = (k.has('ShiftLeft') || k.has('ShiftRight')) ? 5 : 1;
      const crawl = (k.has('ControlLeft') || k.has('ControlRight')) ? 0.18 : 1;
      // Zooming in narrows what a given mouse movement covers, so scale both
      // look sensitivity and travel with the focal length or the camera becomes
      // unusable the moment you go telephoto.
      const zoomK = Math.tan(cam.fov * 0.5 * Math.PI / 180) / Math.tan(55 * 0.5 * Math.PI / 180);
      const speed = this.freeSpeed * sprint * crawl * THREE.MathUtils.clamp(zoomK, 0.12, 1.6);

      const cp = Math.cos(this.pitch);
      const fwd = _v.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
      const fwdCopy = fwd.clone();
      const right = new THREE.Vector3().crossVectors(fwdCopy, UP).normalize();

      const mv = new THREE.Vector3();
      if (k.has('KeyW') || k.has('ArrowUp')) mv.add(fwdCopy);
      if (k.has('KeyS') || k.has('ArrowDown')) mv.sub(fwdCopy);
      if (k.has('KeyD') || k.has('ArrowRight')) mv.add(right);
      if (k.has('KeyA') || k.has('ArrowLeft')) mv.sub(right);
      if (k.has('KeyE') || k.has('Space')) mv.add(UP);
      if (k.has('KeyQ')) mv.sub(UP);
      if (mv.lengthSq() > 0) mv.normalize().multiplyScalar(speed);

      // The shake is a render-time offset, so flight state is tracked
      // separately. Adding it to camera.position would integrate the noise into
      // a random walk and the camera would wander off on its own.
      const P = this._freePos;

      // Ease in and out of motion. Snapping between zero and full speed makes
      // even a well-framed shot look like a debug camera.
      const accel = 1 - Math.exp(-dt * (mv.lengthSq() > 0 ? 9 : 6));
      this._vel.lerp(mv, accel);
      P.addScaledVector(this._vel, dt);

      // Ride the surface. Rising with a passing tsunami is the whole point of
      // triggering one, and the descent afterwards has to happen too or the
      // camera is left stranded in mid-air once the wave has gone.
      let floor = this.seaLevelFn(P.x, P.z) + this.eventFloorFn(P.x, P.z) + 1.6 + this.waveFloor;

      const van = this._vantage;
      if (van) {
        van.hold -= dt;
        if (van.hold <= 0 || P.y > van.y + 40) this._vantage = null;
        else floor = Math.max(floor, van.y);
      }

      const ceil = this._ceiling;
      if (ceil) {
        ceil.hold -= dt;
        if (ceil.hold <= 0 || k.has('Space') || k.has('KeyE')) this._ceiling = null;
        else {
          const want = Math.max(ceil.y + floor, floor);
          if (P.y > want) P.y += (want - P.y) * (1 - Math.exp(-dt * 1.3));
        }
      }

      const prevFloor = this._floor ?? floor;
      // Only water the camera is actually sitting on can carry it back down;
      // otherwise flying high over a passing wave would yank the eye downward.
      const riding = P.y <= prevFloor + 3.0;
      // Asymmetric: climb quickly enough not to be overtaken by a rising crest,
      // sink back slowly so the descent reads as the sea dropping away.
      const rate = floor > prevFloor ? 6.0 : 1.2;
      this._floor = THREE.MathUtils.lerp(prevFloor, floor, 1 - Math.exp(-dt * rate));
      // A tsunami face arrives at sixty metres a second and lifts the water
      // under the eye faster than any smoothing can follow, so the eased floor
      // is backstopped by the surface itself. Without this the wall simply
      // closes over the camera and the shot ends inside the water.
      this._floor = Math.max(this._floor,
        this.seaLevelFn(P.x, P.z) + this.eventFloorFn(P.x, P.z) + 1.2);

      if (riding && this._floor < prevFloor && this._vel.y <= 0) {
        P.y = Math.max(this._floor, P.y + (this._floor - prevFloor));
      }
      if (P.y < this._floor) {
        P.y = this._floor;
        if (this._vel.y < 0) this._vel.y = 0;
      }

      const amp = this.shakeBoost * 0.5;
      cam.position.copy(P).add(_v.set(
        smoothNoise(time * 0.7, 7.0), smoothNoise(time * 0.9, 8.0), smoothNoise(time * 0.6, 9.0),
      ).multiplyScalar(amp));
      this.shakeBoost *= Math.exp(-dt * 1.6);

      _m.lookAt(cam.position, _v.copy(cam.position).add(fwdCopy), UP);
      cam.quaternion.setFromRotationMatrix(_m);

      // Focus on whatever the crosshair is over, so the depth of field agrees
      // with where the user is looking.
      const aim = this.aimPoint(900);
      this._smoothLook.set(aim.x, this.seaLevelFn(aim.x, aim.z), aim.z);
      this.focusTarget = THREE.MathUtils.clamp(aim.dist, 6, 20000);
      this.focusDistance += (this.focusTarget - this.focusDistance) * Math.min(1, dt * 2.2);

      cam.fov += (this.fovTarget - cam.fov) * Math.min(1, dt * 7);
      cam.updateProjectionMatrix();
      this._lastCamPos.copy(cam.position);
      return;
    }

    if (this.shot) {
      this.shotTime += dt;
      const t = THREE.MathUtils.clamp(this.shotTime / Math.max(this.shot.duration || 8, 0.01), 0, 1);
      this._evalShot(t, this._pos, this._look);
    }

    // smooth follow (critically damped-ish)
    const k = this._first ? 1.0 : Math.min(1, dt * (this.shot?.responsiveness ?? 4.0));
    if (this._first) { this._smoothPos.copy(this._pos); this._smoothLook.copy(this._look); this._first = false; }
    this._smoothPos.lerp(this._pos, k);
    this._smoothLook.lerp(this._look, Math.min(1, dt * (this.shot?.lookResponsiveness ?? 3.0)));

    // handheld
    const amp = this.shake * (0.16 + this.shakeBoost);
    const sx = smoothNoise(time * 0.9, 1.0) * amp;
    const sy = smoothNoise(time * 1.1, 2.0) * amp * 0.8;
    const sz = smoothNoise(time * 0.7, 3.0) * amp * 0.5;
    const rx = smoothNoise(time * 1.4, 4.0) * amp * 0.0022;
    const ry = smoothNoise(time * 1.2, 5.0) * amp * 0.0026;

    cam.position.copy(this._smoothPos).add(_v.set(sx, sy, sz));

    // keep the lens out of the water on surface shots
    if (!this.shot || this.shot.type !== 'underwater') {
      const minY = this.seaLevelFn(cam.position.x, cam.position.z) + (this.shot?.minHeight ?? 1.4);
      if (cam.position.y < minY) cam.position.y = minY;
    }

    _m.lookAt(cam.position, _v.copy(this._smoothLook).add(_v.clone().set(rx * 40, ry * 40, 0)), UP);
    _q.setFromRotationMatrix(_m);
    this.roll += (this.rollTarget + smoothNoise(time * 0.6, 6.0) * amp * 0.004 - this.roll) * Math.min(1, dt * 2);
    _q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), this.roll));
    cam.quaternion.copy(_q);

    // auto focus on the look target
    this.focusTarget = Math.max(2, cam.position.distanceTo(this._smoothLook));
    this.focusDistance += (this.focusTarget - this.focusDistance) * Math.min(1, dt * (this.shot?.focusSpeed ?? 1.6));

    cam.fov += (this.fovTarget - cam.fov) * Math.min(1, dt * 1.6);
    this.shakeBoost *= Math.exp(-dt * 1.6);
    cam.updateProjectionMatrix();
  }

  impulse(amount) { this.shakeBoost = Math.min(this.shakeBoost + amount, 4.0); }
}
