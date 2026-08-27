/**
 * Shading for a station's primary body — real terrain and a day/night
 * terminator instead of a flat `MeshBasicMaterial` sphere. Shares its noise
 * function with the nebula shader by convention rather than by import: a
 * module this small isn't worth a shared GLSL chunk, and the two are free to
 * drift apart if one ever needs to.
 *
 * `uSeed` exists so two stations of the same kind don't render identically —
 * it's folded into the noise lookup, not the geometry, so the sphere itself
 * stays a plain, cheap `SphereGeometry`.
 */
export const planetVertex = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  void main() {
    vNormal = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const NOISE = /* glsl */ `
  float hash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float noise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash(i + vec3(0,0,0)), hash(i + vec3(1,0,0)), f.x),
          mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
      mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
          mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y),
      f.z);
  }
  float fbm(vec3 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) {
      v += a * noise(p);
      p *= 2.03;
      a *= 0.5;
    }
    return v;
  }
`;

const HEADER = /* glsl */ `
  precision highp float;
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  uniform float uTime;
  uniform float uSeed;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform vec3 uColorAccent;
  uniform vec3 uLightDir;
`;

/**
 * A terminator and a rim glow, shared by every station kind.
 *
 * There are no THREE.Lights in this scene at all — every body shades itself.
 * uLightDir is picked per-station at spawn time to favour whichever side the
 * camera was on when it was founded, but a fixed direction still means the
 * far side goes dark sometime. The floor here is a deliberate ambient fill
 * rather than true night — this is a station meant to be looked at, not a
 * photometrically honest planet, so it stays readable even facing away
 * from its light.
 */
const LIGHTING = /* glsl */ `
  float lit = dot(n, normalize(uLightDir));
  float wrap = smoothstep(-0.35, 0.5, lit);
  vec3 col = mix(base * 0.48, base * (0.75 + 0.85 * max(lit, 0.0)), wrap);

  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  float fres = pow(1.0 - max(dot(n, viewDir), 0.0), 2.4);
  col += uColorAccent * fres * 0.4;

  gl_FragColor = vec4(col, 1.0);
`;

/** Rocky or icy: mottled terrain plus higher-frequency ridge detail. */
export const rockFragment = /* glsl */ `
  ${HEADER}
  ${NOISE}
  void main() {
    vec3 n = normalize(vNormal);
    float terrain = fbm(n * 2.6 + uSeed);
    float ridges = fbm(n * 6.5 + uSeed * 1.7);
    vec3 base = mix(uColorA, uColorB, smoothstep(0.32, 0.72, terrain));
    base = mix(base, uColorAccent, smoothstep(0.58, 0.88, ridges) * 0.35);
    ${LIGHTING}
  }
`;

/** Gas giant: banded, warped by low-frequency noise so it doesn't read as stripes. */
export const giantFragment = /* glsl */ `
  ${HEADER}
  ${NOISE}
  void main() {
    vec3 n = normalize(vNormal);
    float warp = fbm(n * 1.4 + uSeed) * 0.6;
    float band = sin((n.y + warp) * 9.0 + uTime * 0.05) * 0.5 + 0.5;
    float turb = fbm(n * 3.2 - uSeed);
    vec3 base = mix(uColorA, uColorB, smoothstep(0.2, 0.8, band));
    base = mix(base, uColorAccent, smoothstep(0.6, 0.95, turb) * 0.3);
    ${LIGHTING}
  }
`;
