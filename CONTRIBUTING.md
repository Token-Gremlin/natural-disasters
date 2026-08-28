# Contributing to ABYSSAL

Thanks for taking an interest. This is a graphics project, which makes
contributing a little different from a typical web repository: most changes are
judged by looking at pixels, and a change that is correct on paper can still be
wrong on screen. This document explains how to work with that.

## Getting set up

```bash
git clone https://github.com/Token-Gremlin/natural-disasters.git
cd natural-disasters
npm install
npm run dev
```

You need Node 20.19+ (or 22.12+) and a browser with WebGL2. A discrete GPU makes iteration much
less painful, but the `potato` and `low` presets are there for a reason — if you
only have integrated graphics, develop at `?preset=low`.

## Ground rules for this codebase

**No external assets, ever.** No textures, no meshes, no HDRIs, no lookup tables
shipped as files, no fonts beyond system stacks. Everything is generated at
runtime. This is the central constraint of the project and a pull request that
adds a binary asset will not be merged. If you need a texture, bake it in
`src/gfx/ProceduralTextures.js`.

**No new runtime dependencies without discussion.** Three.js is the only one.
Open an issue before adding a second.

**Global state lives in `SharedUniforms.js`.** If two systems need to agree on
something — sun direction, wind, sea level, cloud coverage — it belongs there,
shared by reference so nobody can read a stale copy. Do not pass values around
by copying them into local uniform objects.

**Shader loops need dynamic bounds when they are long.** GLSL compilers unroll
loops with constant bounds. A raymarch with `const int steps = 256` produces a
shader that takes minutes to compile on some drivers, or fails outright. Drive
the loop from a uniform.

**Comments explain why, not what.** The existing comments in the shaders record
the reasoning behind non-obvious constants and the artefacts they were chosen to
avoid. That history is genuinely useful when someone later wonders whether a
magic number can be changed. Keep writing them in that style, and do not add
comments that restate the code.

## Verifying a rendering change

Before opening a pull request:

1. **Look at it in at least three conditions.** Clear day, golden hour and a
   violent storm exercise very different parts of the pipeline. A change that
   improves the storm often ruins the calm.
2. **Check it at three scales.** Just above the water, a few hundred metres up,
   and a kilometre up. Grazing angles and distant footprints are where aliasing
   lives.
3. **Check the frame time.** Add `?profile=1` and note the per-pass breakdown
   before and after. Include the numbers in the pull request.
4. **Boot with a clean cache.** Shader compile failures often only show on the
   first load.

The harness in `tools/` automates most of this:

```bash
node tools/sb.mjs --tag before --look sky,sea,high --nohud
# make your change
node tools/sb.mjs --tag after  --look sky,sea,high --nohud
node tools/diff.mjs tools/shots/before-sea.png tools/shots/after-sea.png
```

`npm test` runs the pure-logic checks — currently the adaptive quality loop,
which is easy to break in ways that only show up on hardware slower than yours.
CI runs it too.

`node tools/smoke.mjs` boots the app and fails on any console error or shader
compile problem. CI cannot run the GPU, so that one is on you.

## Pull requests

- Branch from `main`.
- Keep a pull request to one coherent change. A shading fix and a refactor of
  the camera are two pull requests.
- Describe what the change looks like, not only what it does. Before and after
  screenshots are the most useful thing you can include.
- Say what you measured. "No measurable frame time change at `high`" is a
  complete answer; silence is not.
- Match the surrounding style. Two-space indent, semicolons, single quotes,
  ES modules. There is no linter — read the neighbouring file.

## Reporting bugs

Open an issue with:

- Browser, operating system and GPU (the HUD shows the detected renderer, and
  `chrome://gpu` has the rest).
- The quality preset, and whether it reproduces with `?adaptive=0`.
- A screenshot or a short capture. Visual bugs are very hard to describe in
  words and very easy to show.
- The full console output if anything was logged.

## Ideas that would be welcome

- WebGPU compute path for the FFT and the cloud march.
- Backlit cloud rims and crepuscular rays.
- Softer spray and rain sprites — the quad edges are still visible up close.
- Better shore interaction: the ocean is currently unbounded and infinitely deep.
- Buoyancy and floating objects.
- Mobile-viable preset, if you think you can make the cloud march fit.

## Code of Conduct

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
