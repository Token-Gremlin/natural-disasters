/**
 * Per-pass GPU timing via EXT_disjoint_timer_query_webgl2.
 *
 * Queries are asynchronous, so each zone keeps a small ring of in-flight
 * queries and results land a few frames late. That is fine for profiling and
 * costs nothing when the extension is missing (most browsers disable it unless
 * the user opted in), in which case we fall back to CPU wall-clock per zone.
 */
export class GpuProfiler {
  constructor(renderer) {
    this.renderer = renderer;
    this.gl = renderer.getContext();
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.zones = new Map();
    this.enabled = false;
    this.cpuFallback = !this.ext;
    this._active = null;
    this._order = [];
  }

  _zone(name) {
    let z = this.zones.get(name);
    if (!z) {
      z = { name, pending: [], ms: 0, ema: 0, cpuMs: 0 };
      this.zones.set(name, z);
      this._order.push(name);
    }
    return z;
  }

  begin(name) {
    if (!this.enabled) return;
    const z = this._zone(name);
    if (this.cpuFallback) { z._t0 = performance.now(); return; }
    if (this._active) return;      // GL allows only one query at a time
    const gl = this.gl;
    const q = gl.createQuery();
    gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this._active = { z, q };
  }

  end(name) {
    if (!this.enabled) return;
    const z = this._zone(name);
    if (this.cpuFallback) {
      // force the driver to catch up so the number means something
      this.gl.finish();
      z.cpuMs = performance.now() - z._t0;
      z.ema = z.ema ? z.ema * 0.9 + z.cpuMs * 0.1 : z.cpuMs;
      return;
    }
    if (!this._active || this._active.z !== z) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    z.pending.push(this._active.q);
    this._active = null;
  }

  /** Call once per frame after all zones have been submitted. */
  collect() {
    if (!this.enabled || this.cpuFallback) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    for (const z of this.zones.values()) {
      while (z.pending.length) {
        const q = z.pending[0];
        if (disjoint) { gl.deleteQuery(q); z.pending.shift(); continue; }
        if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
        const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
        gl.deleteQuery(q);
        z.pending.shift();
        z.ms = ns / 1e6;
        z.ema = z.ema ? z.ema * 0.85 + z.ms * 0.15 : z.ms;
      }
      // never let a stall grow unbounded
      while (z.pending.length > 8) gl.deleteQuery(z.pending.shift());
    }
  }

  report() {
    const out = [];
    for (const name of this._order) {
      const z = this.zones.get(name);
      out.push({ name, ms: +(z.ema || z.ms || z.cpuMs).toFixed(3) });
    }
    out.sort((a, b) => b.ms - a.ms);
    return { mode: this.cpuFallback ? 'cpu-finish' : 'gpu-timer', zones: out };
  }

  reset() { for (const z of this.zones.values()) { z.ema = 0; z.ms = 0; } }
}
