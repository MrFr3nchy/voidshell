/**
 * A two-tone volumetric aurora painted on the inside of a giant sphere.
 * FBM noise drifts over time; the palette lerps between a cool and a warm
 * pole so the void never reads as a flat black background. Uniforms are
 * exposed so a "world" module can retune the whole sky at runtime.
 */
export const nebulaVertex = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const nebulaFragment = /* glsl */ `
  precision highp float;
  varying vec3 vDir;

  uniform float uTime;
  uniform float uIntensity;
  uniform vec3 uColorCool;
  uniform vec3 uColorWarm;
  uniform vec3 uColorVoid;

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
      p *= 2.02;
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec3 dir = normalize(vDir);
    float t = uTime * 0.02;

    float n = fbm(dir * 2.4 + vec3(t, t * 0.6, -t));
    float n2 = fbm(dir * 5.0 - vec3(t * 0.4, t, t * 0.7));
    float clouds = pow(clamp(n * 0.7 + n2 * 0.5, 0.0, 1.0), 2.2);

    vec3 aurora = mix(uColorCool, uColorWarm, smoothstep(0.25, 0.85, clouds));
    vec3 col = mix(uColorVoid, aurora, clouds * uIntensity);

    float band = exp(-abs(dir.y) * 3.0) * 0.15 * uIntensity;
    col += aurora * band;

    float star = step(0.997, hash(floor(dir * 320.0)));
    col += vec3(star) * 0.6;

    gl_FragColor = vec4(col, 1.0);
  }
`;
