import * as THREE from 'three';

/**
 * One uniform object graph shared by reference across every material in the
 * scene. Update once per frame in App.update(), everything follows.
 */
export const U = {
  uTime: { value: 0 },
  uDt: { value: 1 / 60 },
  uFrame: { value: 0 },
  uResolution: { value: new THREE.Vector2(1, 1) },
  uInvResolution: { value: new THREE.Vector2(1, 1) },
  uCamPos: { value: new THREE.Vector3() },
  uPrevCamPos: { value: new THREE.Vector3() },
  uViewProj: { value: new THREE.Matrix4() },
  uPrevViewProj: { value: new THREE.Matrix4() },
  uInvViewProj: { value: new THREE.Matrix4() },
  uViewProjNJ: { value: new THREE.Matrix4() },
  uPrevViewProjNJ: { value: new THREE.Matrix4() },
  uInvViewProjNJ: { value: new THREE.Matrix4() },
  uJitter: { value: new THREE.Vector2() },
  uPrevJitter: { value: new THREE.Vector2() },
  uNear: { value: 0.1 },
  uFar: { value: 120000 },

  // ---- lighting / atmosphere
  uSunDir: { value: new THREE.Vector3(0.3, 0.4, -0.86) },
  uSunColor: { value: new THREE.Vector3(1, 0.96, 0.9) },
  uSunIntensity: { value: 22.0 },
  uMoonDir: { value: new THREE.Vector3(-0.3, 0.5, 0.8) },
  uAtmoTurbidity: { value: 1.0 },
  uAtmoMieG: { value: 0.78 },
  uAtmoGroundAlbedo: { value: new THREE.Vector3(0.06, 0.09, 0.12) },
  uAmbientColor: { value: new THREE.Vector3(0.1, 0.2, 0.35) },

  // ---- weather
  uWindDir: { value: new THREE.Vector2(1, 0) },
  uWindSpeed: { value: 8.0 },
  uGustiness: { value: 0.3 },
  uRain: { value: 0.0 },
  uFogDensity: { value: 0.0 },
  uSprayAmount: { value: 0.0 },
  uWhitecapCoverage: { value: 0.0 },
  uStormFactor: { value: 0.0 },
  uSeaLevel: { value: 0.0 },

  // NOTE: every vec4 below uses .w as an intensity/strength that must read 0
  // when idle — THREE.Vector4's default w is 1, so pass it explicitly.

  // ---- lightning: xyz = world pos, w = intensity (0 when idle)
  uLightning0: { value: new THREE.Vector4(0, 0, 0, 0) },
  uLightning1: { value: new THREE.Vector4(0, 0, 0, 0) },
  uLightningColor: { value: new THREE.Vector3(0.75, 0.85, 1.0) },
  uAmbientFlash: { value: 0.0 },

  // ---- disaster fields (xy = centre, z = radius, w = strength)
  uVortex0: { value: new THREE.Vector4(0, 0, 0, 0) },
  uVortex1: { value: new THREE.Vector4(0, 0, 0, 0) },
  uVortex2: { value: new THREE.Vector4(0, 0, 0, 0) },
  uVortex3: { value: new THREE.Vector4(0, 0, 0, 0) },
  // soliton: xy = direction, z = distance travelled, w = amplitude
  uSoliton0: { value: new THREE.Vector4(0, 0, 0, 0) },
  uSoliton0b: { value: new THREE.Vector4(0, 0, 0, 0) },   // width, steepness, breakFactor, speed
  uSoliton1: { value: new THREE.Vector4(0, 0, 0, 0) },
  uSoliton1b: { value: new THREE.Vector4(0, 0, 0, 0) },
  // rogue wave group: xy = centre, z = radius, w = amplitude
  uRogue: { value: new THREE.Vector4(0, 0, 0, 0) },
  uRogueB: { value: new THREE.Vector4(0, 0, 0, 0) },      // dirx, dirz, wavelength, phase
  // hurricane: xy = centre, z = eyeRadius, w = intensity
  uHurricane: { value: new THREE.Vector4(0, 0, 0, 0) },

  // ---- procedural textures
  uFoamTex: { value: null },
  uRippleTex: { value: null },
  uCurlTex: { value: null },

  // ---- environment
  uEnvMap: { value: null },
  uEnvMaxLod: { value: 6.0 },
  uEnvWidth: { value: 256 },

  uExposure: { value: 1.0 },
  uEarthCurvature: { value: 1.0 },
};

/**
 * @param {THREE.PerspectiveCamera} camera camera with the TAA jitter already applied
 * @param {THREE.Matrix4} projNoJitter clean projection matrix (for velocity)
 */
export function updateFrameUniforms(camera, projNoJitter, dt, time, frame) {
  U.uTime.value = time;
  U.uDt.value = dt;
  U.uFrame.value = frame;
  U.uPrevViewProj.value.copy(U.uViewProj.value);
  U.uPrevViewProjNJ.value.copy(U.uViewProjNJ.value);
  U.uPrevCamPos.value.copy(U.uCamPos.value);
  camera.updateMatrixWorld();
  U.uViewProj.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  U.uInvViewProj.value.copy(U.uViewProj.value).invert();
  U.uViewProjNJ.value.multiplyMatrices(projNoJitter, camera.matrixWorldInverse);
  U.uInvViewProjNJ.value.copy(U.uViewProjNJ.value).invert();
  U.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
  U.uNear.value = camera.near;
  U.uFar.value = camera.far;
}
