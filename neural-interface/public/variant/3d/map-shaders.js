// ── Memory map shaders ──
//
// Raw GLSL for the few layers the map draws. Colours are passed in sRGB and
// written out untouched (no colour-space chunk), so a category looks the same
// here as in the sidebar.

/** Point size in px at the reference distance for importance 1…10 is POINT_PX·(0.75 + 0.075·imp). */
export const POINT_PX = 5.2;
export const POINT_MIN_PX = 1.25;
export const POINT_MAX_PX = 12;

const pointSize = /* glsl */ `
  float pointPx(float size, float depth) {
    return clamp(uBasePx * size * pow(uRefDist / max(depth, 1.0), 0.6), ${POINT_MIN_PX.toFixed(2)}, ${POINT_MAX_PX.toFixed(1)});
  }
`;

// Every memory: one additive soft dot. Small (far) points fade so dense
// islands glow instead of blowing out to white.
export const pointsVertex = /* glsl */ `
  uniform float uMorph;
  uniform float uBasePx;
  uniform float uRefDist;
  uniform float uPixelRatio;
  uniform float uRecencyMix;
  attribute vec3 aFrom;
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aRecency;
  attribute float aVis;
  varying vec3 vColor;
  varying float vAlpha;
  ${pointSize}
  void main() {
    if (aVis < 0.001) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
    vec4 mv = modelViewMatrix * vec4(mix(aFrom, position, uMorph), 1.0);
    float px = pointPx(aSize, -mv.z);
    float rec = mix(1.0, aRecency, uRecencyMix);
    vColor = aColor * (0.5 + 0.4 * rec);
    // Far away points are tiny and overlap: keep them faint so a dense island
    // glows softly; up close each memory is a crisp star.
    vAlpha = aVis * (0.4 + 0.6 * rec) * mix(0.2, 0.95, smoothstep(1.25, 5.0, px));
    gl_PointSize = px * uPixelRatio;
    gl_Position = projectionMatrix * mv;
  }
`;

export const pointsFragment = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 d = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(d, d);
    if (r2 > 1.0) discard;
    float a = (smoothstep(1.0, 0.15, r2) * 0.55 + smoothstep(0.35, 0.0, r2) * 0.45) * vAlpha;
    gl_FragColor = vec4(vColor, a);
  }
`;

// Hovered, selected, multi-selected, neighbours and search hits: drawn on top
// with a ring. aKind: 0 hover · 1 selected · 2 multi · 3 neighbour · 4 search hit.
export const overlayVertex = /* glsl */ `
  uniform float uMorph;
  uniform float uBasePx;
  uniform float uRefDist;
  uniform float uPixelRatio;
  attribute vec3 aFrom;
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aKind;
  varying vec3 vColor;
  varying float vKind;
  ${pointSize}
  void main() {
    vec4 mv = modelViewMatrix * vec4(mix(aFrom, position, uMorph), 1.0);
    float px = pointPx(aSize, -mv.z);
    float grow = aKind < 0.5 ? 12.0 : aKind < 1.5 ? 14.0 : aKind < 2.5 ? 10.0 : 7.0;
    vColor = aColor;
    vKind = aKind;
    gl_PointSize = (max(px, 5.0) + grow) * uPixelRatio;
    gl_Position = projectionMatrix * mv;
  }
`;

export const overlayFragment = /* glsl */ `
  varying vec3 vColor;
  varying float vKind;
  void main() {
    vec2 d = gl_PointCoord * 2.0 - 1.0;
    float r = length(d);
    if (r > 1.0) discard;
    float core = smoothstep(0.42, 0.30, r);
    float ringIn = vKind > 2.5 ? 0.62 : 0.70;
    float ring = smoothstep(ringIn - 0.08, ringIn, r) * smoothstep(0.96, 0.88, r);
    vec3 ringColor = vKind < 1.5 ? vec3(1.0) : mix(vColor, vec3(1.0), 0.35);
    float ringAlpha = vKind < 0.5 ? 0.85 : vKind < 1.5 ? 1.0 : vKind < 2.5 ? 0.8 : vKind < 3.5 ? 0.45 : 0.6;
    vec3 col = mix(ringColor, mix(vColor, vec3(1.0), 0.25), core);
    float a = max(core * 0.95, ring * ringAlpha);
    if (a < 0.01) discard;
    gl_FragColor = vec4(col, a);
  }
`;

// Island haze: one camera-facing soft disc per island (instanced quad).
export const hazeVertex = /* glsl */ `
  attribute vec3 iCenter;
  attribute float iRadius;
  attribute vec3 iColor;
  attribute float iAlpha;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec4 mv = modelViewMatrix * vec4(iCenter, 1.0);
    float size = iRadius * 1.3;
    mv.xy += position.xy * size;
    vUv = position.xy;
    vColor = iColor;
    float depth = -mv.z;
    vAlpha = iAlpha * smoothstep(iRadius * 0.5, iRadius * 2.0, depth);
    // Faded out (camera at or inside the island): every vertex of the quad
    // agrees, so drop it rather than shade a near-invisible full-screen square.
    if (vAlpha < 0.002) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    gl_Position = projectionMatrix * mv;
  }
`;

export const hazeFragment = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float r2 = dot(vUv, vUv);
    if (r2 > 1.0) discard;
    float a = vAlpha * exp(-3.5 * r2);
    gl_FragColor = vec4(vColor, a);
  }
`;

// Chart grid and neighbour lines: plain coloured lines with per-vertex alpha.
export const lineVertex = /* glsl */ `
  uniform float uMorph;
  attribute vec3 aFrom;
  attribute vec4 aColor;
  varying vec4 vColor;
  void main() {
    vColor = aColor;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(mix(aFrom, position, uMorph), 1.0);
  }
`;

export const lineFragment = /* glsl */ `
  uniform float uOpacity;
  varying vec4 vColor;
  void main() {
    gl_FragColor = vec4(vColor.rgb, vColor.a * uOpacity);
  }
`;
