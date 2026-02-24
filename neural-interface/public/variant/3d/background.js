// ═══════════════════════════════════════════
// SynaBun Neural Interface — 3D Background
// Floor effects, deep-grid theme, sky dome,
// star fields, pillars, horizon glow
// ═══════════════════════════════════════════

import { gfx } from './gfx.js';

// ── Module state ──
let bgGrid = null;
let bgGridPillars = null;
let bgWorldParticles = null;
let bgGridFloor2 = null;
let bgSkyDome = null;
let _cloudPlanes = [];
let bgSkyParticles = null;
let _origControlsUpdate = null;

let floorMesh = null;
let floorParticles = null;

export const FLOOR_Y = -200;

// ═══════════════════════════════════════════
// FLOOR EFFECTS — Selectable floor styles
// ═══════════════════════════════════════════

function removeFloor(scene) {
  if (floorMesh) {
    scene.remove(floorMesh);
    floorMesh.geometry.dispose();
    floorMesh.material.dispose();
    floorMesh = null;
  }
  if (floorParticles) {
    scene.remove(floorParticles);
    floorParticles.geometry.dispose();
    floorParticles.material.dispose();
    floorParticles = null;
  }
}

// ── Floor: Grid ──
function addFloorGrid(scene) {
  const gridSize = 8000;
  const gridGeo = new THREE.PlaneGeometry(gridSize, gridSize, 1, 1);
  gridGeo.rotateX(-Math.PI / 2);

  const gridMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uCamY: { value: 300 },
    },
    vertexShader: `
      varying vec3 vWorldPos;
      void main() {
        vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vWorldPos;
      uniform float uTime;
      uniform float uCamY;

      float softLine(float coord, float spacing, float sharpness) {
        float d = abs(mod(coord + spacing * 0.5, spacing) - spacing * 0.5);
        // Combine gaussian glow with screen-space AA to kill edge aliasing
        float fw = fwidth(coord / spacing) * spacing * 1.5;
        float aa = 1.0 - smoothstep(0.0, max(fw, 0.5), d);
        float glow = exp(-d * d * sharpness);
        return max(aa * 0.6, glow);
      }

      void main() {
        float distFromCenter = length(vWorldPos.xz);
        float fade = 1.0 - smoothstep(1200.0, 3800.0, distFromCenter);

        // Sharpness decreases with distance — lines get softer/wider further out
        float sharpness = mix(1.2, 0.15, smoothstep(0.0, 2500.0, distFromCenter));

        float lx = softLine(vWorldPos.x, 200.0, sharpness);
        float lz = softLine(vWorldPos.z, 200.0, sharpness);
        float grid = max(lx, lz);

        float dot = lx * lz;
        float pulse = sin(uTime * 2.0 + vWorldPos.x * 0.04 + vWorldPos.z * 0.03) * 0.5 + 0.5;
        float dotGlow = dot * (0.08 + pulse * 0.08);

        vec3 col = vec3(1.0);
        float alpha = (grid * 0.045 + dotGlow) * fade;

        float camFade = smoothstep(0.0, 10.0, abs(uCamY - ${FLOOR_Y}.0));
        alpha *= 0.4 + camFade * 0.6;

        if (alpha < 0.002) discard;
        gl_FragColor = vec4(col, alpha);
      }
    `,
  });

  floorMesh = new THREE.Mesh(gridGeo, gridMat);
  floorMesh.position.y = FLOOR_Y;
  floorMesh.renderOrder = -10;
  scene.add(floorMesh);
}

// ── Floor: Dot Field with proximity glow ──
function addFloorDots(scene) {
  const spacing = 40;
  const extent = 3200;
  const count = Math.pow(Math.floor(extent * 2 / spacing) + 1, 2);
  const positions = new Float32Array(count * 3);
  const phases = new Float32Array(count);
  let idx = 0;

  for (let x = -extent; x <= extent; x += spacing) {
    for (let z = -extent; z <= extent; z += spacing) {
      positions[idx * 3] = x + (Math.random() - 0.5) * 6;
      positions[idx * 3 + 1] = FLOOR_Y;
      positions[idx * 3 + 2] = z + (Math.random() - 0.5) * 6;
      phases[idx] = Math.random() * Math.PI * 2;
      idx++;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions.slice(0, idx * 3), 3));
  geo.setAttribute('aPhase', new THREE.Float32BufferAttribute(phases.slice(0, idx), 1));

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uCamPos: { value: new THREE.Vector3(0, 300, 0) },
    },
    vertexShader: `
      attribute float aPhase;
      varying float vAlpha;
      varying float vProximity;
      varying float vWave;
      uniform float uTime;
      uniform vec3 uCamPos;
      void main() {
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        float distFromCenter = length(worldPos.xz);
        float fade = 1.0 - smoothstep(1500.0, 3200.0, distFromCenter);

        // Proximity glow — wide, strong falloff around camera xz
        float camDist = length(worldPos.xz - uCamPos.xz);
        vProximity = exp(-camDist * camDist * 0.0000008);

        // Ripple wave expanding outward from camera
        float wave = sin(camDist * 0.015 - uTime * 2.5) * 0.5 + 0.5;
        wave *= exp(-camDist * 0.0008);
        vWave = wave;

        float twinkle = 0.5 + 0.5 * sin(uTime * 2.0 + aPhase * 6.28);
        vAlpha = fade * (0.15 + twinkle * 0.1 + vProximity * 0.55 + wave * 0.2);

        vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
        float size = (3.0 + vProximity * 8.0 + wave * 3.0) * (300.0 / max(-mvPos.z, 1.0));
        gl_PointSize = size;
        gl_Position = projectionMatrix * mvPos;
      }
    `,
    fragmentShader: `
      varying float vAlpha;
      varying float vProximity;
      varying float vWave;
      void main() {
        float dist = length(gl_PointCoord - vec2(0.5));
        if (dist > 0.5) discard;
        float core = exp(-dist * dist * 16.0);
        float glow = exp(-dist * dist * 4.0) * 0.5;
        float alpha = (core + glow) * vAlpha;
        vec3 baseCol = vec3(0.55, 0.62, 0.95);
        vec3 hotCol = vec3(0.85, 0.9, 1.0);
        vec3 col = mix(baseCol, hotCol, vProximity * 0.8 + vWave * 0.3);
        gl_FragColor = vec4(col, alpha);
      }
    `,
  });

  floorParticles = new THREE.Points(geo, mat);
  floorParticles.renderOrder = -10;
  scene.add(floorParticles);
}

// ── Floor: Hex Grid ──
function addFloorHex(scene) {
  const gridSize = 8000;
  const gridGeo = new THREE.PlaneGeometry(gridSize, gridSize, 1, 1);
  gridGeo.rotateX(-Math.PI / 2);

  const hexMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uCamY: { value: 300 },
    },
    vertexShader: `
      varying vec3 vWorldPos;
      void main() {
        vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vWorldPos;
      uniform float uTime;
      uniform float uCamY;

      // Hex distance field — returns distance to nearest hex edge
      float hexDist(vec2 p) {
        p = abs(p);
        return max(dot(p, normalize(vec2(1.0, 1.732))), p.x);
      }

      vec4 hexCoords(vec2 uv) {
        vec2 r = vec2(1.0, 1.732);
        vec2 h = r * 0.5;
        vec2 a = mod(uv, r) - h;
        vec2 b = mod(uv - h, r) - h;
        vec2 gv = length(a) < length(b) ? a : b;
        vec2 id = uv - gv;
        return vec4(gv, id);
      }

      void main() {
        float distFromCenter = length(vWorldPos.xz);
        float fade = 1.0 - smoothstep(1500.0, 3800.0, distFromCenter);

        float scale = 220.0;
        vec2 uv = vWorldPos.xz / scale;
        vec4 hc = hexCoords(uv);

        // Thin crisp edge — slightly thicker than 1px for clean reads at distance
        float d = 0.5 - hexDist(hc.xy);
        float fw = fwidth(d);
        float edge = 1.0 - smoothstep(fw * 0.3, fw * 1.8, d);

        vec3 col = vec3(0.7, 0.75, 0.95);
        float alpha = edge * 0.07 * fade;

        float camFade = smoothstep(0.0, 10.0, abs(uCamY - ${FLOOR_Y}.0));
        alpha *= 0.4 + camFade * 0.6;

        if (alpha < 0.002) discard;
        gl_FragColor = vec4(col, alpha);
      }
    `,
  });

  floorMesh = new THREE.Mesh(gridGeo, hexMat);
  floorMesh.position.y = FLOOR_Y;
  floorMesh.renderOrder = -10;
  scene.add(floorMesh);
}

// ── Floor: Concentric Ripples ──
function addFloorRipples(scene) {
  const gridSize = 8000;
  const gridGeo = new THREE.PlaneGeometry(gridSize, gridSize, 1, 1);
  gridGeo.rotateX(-Math.PI / 2);

  const rippleMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uCamY: { value: 300 },
    },
    vertexShader: `
      varying vec3 vWorldPos;
      void main() {
        vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vWorldPos;
      uniform float uTime;
      uniform float uCamY;

      void main() {
        float distFromCenter = length(vWorldPos.xz);
        float fade = 1.0 - smoothstep(1200.0, 3800.0, distFromCenter);

        // Concentric rings expanding outward
        float ringSpacing = 80.0;
        float scrollDist = distFromCenter - uTime * 15.0;
        float ring = abs(mod(scrollDist, ringSpacing) - ringSpacing * 0.5);
        float ringLine = exp(-ring * ring * 0.08);

        // Static rings for structure
        float staticRing = abs(mod(distFromCenter, ringSpacing * 2.5) - ringSpacing * 1.25);
        float staticLine = exp(-staticRing * staticRing * 0.04);

        // Radial spokes — very subtle
        float angle = atan(vWorldPos.z, vWorldPos.x);
        float spoke = exp(-pow(mod(angle + 3.1416, 0.3927) - 0.19635, 2.0) * 600.0);
        float spokeFade = smoothstep(0.0, 400.0, distFromCenter) * 0.3;

        vec3 col = vec3(1.0);
        float alpha = (ringLine * 0.06 + staticLine * 0.03 + spoke * spokeFade * 0.04) * fade;

        float camFade = smoothstep(0.0, 10.0, abs(uCamY - ${FLOOR_Y}.0));
        alpha *= 0.4 + camFade * 0.6;

        if (alpha < 0.002) discard;
        gl_FragColor = vec4(col, alpha);
      }
    `,
  });

  floorMesh = new THREE.Mesh(gridGeo, rippleMat);
  floorMesh.position.y = FLOOR_Y;
  floorMesh.renderOrder = -10;
  scene.add(floorMesh);
}

// ── Floor: Ground Fog Particles ──
function addFloorFog(scene) {
  const count = 3000;
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const alphas = new Float32Array(count);
  const phases = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.random() * 3000;
    positions[i * 3] = Math.cos(angle) * radius;
    positions[i * 3 + 1] = FLOOR_Y + Math.random() * 60;
    positions[i * 3 + 2] = Math.sin(angle) * radius;
    sizes[i] = 8 + Math.random() * 25;
    alphas[i] = 0.01 + Math.random() * 0.04;
    phases[i] = Math.random() * Math.PI * 2;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('aSize', new THREE.Float32BufferAttribute(sizes, 1));
  geo.setAttribute('aAlpha', new THREE.Float32BufferAttribute(alphas, 1));
  geo.setAttribute('aPhase', new THREE.Float32BufferAttribute(phases, 1));

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 } },
    vertexShader: `
      attribute float aSize;
      attribute float aAlpha;
      attribute float aPhase;
      varying float vAlpha;
      uniform float uTime;
      void main() {
        vec3 pos = position;
        float t = uTime * 0.15 + aPhase;
        pos.x += sin(t * 0.7 + aPhase * 3.0) * 8.0;
        pos.z += cos(t * 0.5 + aPhase * 2.0) * 8.0;
        pos.y += sin(t) * 3.0;

        vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
        float camDist = length(mvPos.xyz);
        float distFade = 1.0 - smoothstep(500.0, 3000.0, camDist);
        float breathe = 0.6 + 0.4 * sin(uTime * 0.4 + aPhase * 6.28);

        vAlpha = aAlpha * distFade * breathe;
        gl_PointSize = aSize * (400.0 / max(-mvPos.z, 1.0));
        gl_Position = projectionMatrix * mvPos;
      }
    `,
    fragmentShader: `
      varying float vAlpha;
      void main() {
        float dist = length(gl_PointCoord - vec2(0.5));
        if (dist > 0.5) discard;
        float soft = exp(-dist * dist * 8.0);
        gl_FragColor = vec4(0.75, 0.78, 0.88, soft * vAlpha);
      }
    `,
  });

  floorParticles = new THREE.Points(geo, mat);
  floorParticles.renderOrder = -10;
  scene.add(floorParticles);
}

// ── Floor dispatcher ──
export function applyFloorStyle(style, graph) {
  if (!graph) return;
  const scene = graph.scene();
  removeFloor(scene);
  switch (style) {
    case 'grid':    addFloorGrid(scene);    break;
    case 'dots':    addFloorDots(scene);    break;
    case 'hex':     addFloorHex(scene);     break;
    case 'ripples': addFloorRipples(scene); break;
    case 'fog':     addFloorFog(scene);     break;
    case 'none':    break;
  }
}

// ═══════════════════════════════════════════
// BACKGROUND — Deep Grid theme
// Perspective grid floor + world-space particles + vertical pillars
// Gives true spatial depth and grounding
// ═══════════════════════════════════════════
function addBackgroundDeepGrid(graph) {
  const scene = graph.scene();

  // Floor is now handled by applyFloorStyle() — separate system

  // ── Layer B: Vertical Accent Pillars ──
  // Muted grey-blue, very subtle
  const pillarCount = 90;
  const pillarPositions = new Float32Array(pillarCount * 6);
  const pillarAlphas = new Float32Array(pillarCount * 2);
  const pillarPhases = new Float32Array(pillarCount * 2);
  const pillarSpacing = 70;
  const pillarSpread = 2000;

  for (let i = 0; i < pillarCount; i++) {
    const gx = (Math.floor(Math.random() * (pillarSpread / pillarSpacing) * 2) - pillarSpread / pillarSpacing) * pillarSpacing;
    const gz = (Math.floor(Math.random() * (pillarSpread / pillarSpacing) * 2) - pillarSpread / pillarSpacing) * pillarSpacing;
    const height = 30 + Math.random() * 120;

    pillarPositions[i * 6]     = gx;
    pillarPositions[i * 6 + 1] = FLOOR_Y;
    pillarPositions[i * 6 + 2] = gz;
    pillarPositions[i * 6 + 3] = gx;
    pillarPositions[i * 6 + 4] = FLOOR_Y + height;
    pillarPositions[i * 6 + 5] = gz;

    const a = 0.04 + Math.random() * 0.08;
    const ph = Math.random() * Math.PI * 2;
    pillarAlphas[i * 2] = a * 0.2;
    pillarAlphas[i * 2 + 1] = a;
    pillarPhases[i * 2] = ph;
    pillarPhases[i * 2 + 1] = ph;
  }

  const pillarGeo = new THREE.BufferGeometry();
  pillarGeo.setAttribute('position', new THREE.Float32BufferAttribute(pillarPositions, 3));
  pillarGeo.setAttribute('aAlpha', new THREE.Float32BufferAttribute(pillarAlphas, 1));
  pillarGeo.setAttribute('aPhase', new THREE.Float32BufferAttribute(pillarPhases, 1));

  const pillarMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 } },
    vertexShader: `
      attribute float aAlpha;
      attribute float aPhase;
      varying float vAlpha;
      uniform float uTime;
      void main() {
        vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
        float camDist = length(mvPos.xyz);
        float distFade = 1.0 - smoothstep(300.0, 1500.0, camDist);
        vAlpha = aAlpha * (0.6 + 0.4 * sin(uTime * 0.3 + aPhase * 6.28)) * distFade;
        gl_Position = projectionMatrix * mvPos;
      }
    `,
    fragmentShader: `
      varying float vAlpha;
      void main() {
        if (vAlpha < 0.003) discard;
        gl_FragColor = vec4(0.50, 0.56, 0.75, vAlpha);
      }
    `,
  });

  bgGridPillars = new THREE.LineSegments(pillarGeo, pillarMat);
  bgGridPillars.renderOrder = -9;
  scene.add(bgGridPillars);

  // ── Layer C: World-Space Floating Particles ──
  // Muted blue-grey dots — NOT camera-attached (real parallax)
  const pCount = Math.max(200, gfx.bgParticleCount || 2000);
  const pPositions = new Float32Array(pCount * 3);
  const pSizes = new Float32Array(pCount);
  const pAlphas = new Float32Array(pCount);
  const pColors = new Float32Array(pCount * 3);
  const pPhases = new Float32Array(pCount);

  for (let i = 0; i < pCount; i++) {
    const angle = Math.random() * Math.PI * 2;
    const radius = 50 + Math.random() * 2800;
    const height = FLOOR_Y + 10 + Math.random() * 600;

    pPositions[i * 3]     = Math.cos(angle) * radius;
    pPositions[i * 3 + 1] = height;
    pPositions[i * 3 + 2] = Math.sin(angle) * radius;

    const distNorm = radius / 2800;
    pSizes[i] = (1.0 - distNorm * 0.5) * (1.2 + Math.random() * 2.0);
    pAlphas[i] = (1.0 - distNorm * 0.6) * (0.03 + Math.random() * 0.09);

    // Muted blue-grey palette (matching website rgba(130,145,195))
    const v = Math.random();
    // Base: desaturated blue-grey with slight variation
    pColors[i * 3]     = 0.45 + (Math.random() - 0.5) * 0.12;
    pColors[i * 3 + 1] = 0.50 + (Math.random() - 0.5) * 0.12;
    pColors[i * 3 + 2] = 0.68 + (Math.random() - 0.5) * 0.12;
    // 15% chance of slightly warmer accent
    if (v > 0.85) {
      pColors[i * 3]     = 0.58 + Math.random() * 0.08;
      pColors[i * 3 + 1] = 0.55 + Math.random() * 0.06;
      pColors[i * 3 + 2] = 0.72 + Math.random() * 0.08;
    }

    pPhases[i] = Math.random() * Math.PI * 2;
  }

  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute('position', new THREE.Float32BufferAttribute(pPositions, 3));
  pGeo.setAttribute('aSize', new THREE.Float32BufferAttribute(pSizes, 1));
  pGeo.setAttribute('aAlpha', new THREE.Float32BufferAttribute(pAlphas, 1));
  pGeo.setAttribute('aColor', new THREE.Float32BufferAttribute(pColors, 3));
  pGeo.setAttribute('aPhase', new THREE.Float32BufferAttribute(pPhases, 1));

  const pMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uIntensity: { value: gfx.bgIntensity } },
    vertexShader: `
      attribute float aSize;
      attribute float aAlpha;
      attribute vec3 aColor;
      attribute float aPhase;
      varying float vAlpha;
      varying vec3 vColor;
      uniform float uTime;
      uniform float uIntensity;
      void main() {
        vColor = aColor;
        vec3 pos = position;
        float t = uTime * 0.08 + aPhase;
        pos.y += sin(t) * 6.0;
        pos.x += cos(t * 0.7 + aPhase * 3.0) * 3.0;
        pos.z += sin(t * 0.5 + aPhase * 2.0) * 3.0;

        vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
        float camDist = length(mvPos.xyz);
        float distFade = 1.0 - smoothstep(200.0, 2800.0, camDist);

        vAlpha = aAlpha * (0.5 + 0.5 * sin(uTime * 0.4 + aPhase * 6.28)) * distFade * uIntensity;
        gl_PointSize = aSize * (400.0 / max(-mvPos.z, 1.0));
        gl_Position = projectionMatrix * mvPos;
      }
    `,
    fragmentShader: `
      varying float vAlpha;
      varying vec3 vColor;
      void main() {
        float dist = length(gl_PointCoord - vec2(0.5));
        if (dist > 0.5) discard;
        float core = smoothstep(0.5, 0.0, dist);
        float glow = smoothstep(0.5, 0.15, dist);
        float alpha = (core * 0.6 + glow * 0.4) * vAlpha;
        gl_FragColor = vec4(vColor * (0.7 + core * 0.3), alpha);
      }
    `,
  });

  bgWorldParticles = new THREE.Points(pGeo, pMat);
  bgWorldParticles.renderOrder = -8;
  scene.add(bgWorldParticles);

  // ── Layer D: Horizon Glow ──
  // Cylindrical band at the grid edge creating a soft horizon line
  const horizGeo = new THREE.CylinderGeometry(3800, 3800, 800, 64, 1, true);
  const horizMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 } },
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vWorldPos;
      void main() {
        vUv = uv;
        vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec2 vUv;
      varying vec3 vWorldPos;
      uniform float uTime;
      void main() {
        // Wide, soft gaussian-like glow centered at lower-mid height
        float center = 0.3;
        float spread = 0.4; // very wide spread
        float yFade = exp(-pow((vUv.y - center) / spread, 2.0));

        // Muted blue-grey glow
        vec3 col = vec3(0.22, 0.28, 0.42);

        // Very subtle shimmer
        float shimmer = 0.9 + 0.1 * sin(vUv.x * 20.0 + uTime * 0.15);

        float alpha = yFade * 0.025 * shimmer;
        gl_FragColor = vec4(col, alpha);
      }
    `,
  });

  bgGridFloor2 = new THREE.Mesh(horizGeo, horizMat);
  bgGridFloor2.position.y = FLOOR_Y + 20;
  bgGridFloor2.renderOrder = -7;
  scene.add(bgGridFloor2);

  // ── Layer E: Sky gradient sphere — atmospheric perspective ──
  // Inverted sphere behind everything: zenith=black, horizon=faint warm-purple
  const skyGradGeo = new THREE.SphereGeometry(30000, 24, 16);
  const skyGradMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    vertexShader: `
      varying vec3 vWorldPos;
      void main() {
        vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vWorldPos;
      void main() {
        // Normalized height: 0 at bottom, 1 at top
        float h = normalize(vWorldPos).y;
        // Zenith (h=1): pure black
        vec3 zenith  = vec3(0.003, 0.003, 0.004);
        // Mid-sky (h~0.4): barely-there dark grey
        vec3 midSky  = vec3(0.01, 0.01, 0.012);
        // Horizon (h=0): subtle dark grey
        vec3 horizon = vec3(0.022, 0.02, 0.022);
        // Below horizon: black
        vec3 below   = vec3(0.002, 0.002, 0.002);

        vec3 col;
        if (h > 0.4) {
          col = mix(midSky, zenith, smoothstep(0.4, 1.0, h));
        } else if (h > 0.0) {
          col = mix(horizon, midSky, smoothstep(0.0, 0.4, h));
        } else {
          col = mix(below, horizon, smoothstep(-0.3, 0.0, h));
        }
        gl_FragColor = vec4(col, 0.95);
      }
    `,
  });
  bgSkyDome = new THREE.Mesh(skyGradGeo, skyGradMat);
  bgSkyDome.renderOrder = -10;
  scene.add(bgSkyDome);
  _cloudPlanes = [];

  // ── Layer F: World-space parallax star field ──
  // 3 shells at increasing radii with color temperature variation
  // NOT camera-attached — real parallax as camera orbits
  const shells = [
    { start: 0,    count: 600,  rMin: 3500,  rMax: 5000,  sMin: 3.0, sMax: 6.0,  aMin: 0.20, aMax: 0.50, col: [0.78, 0.74, 0.68] },  // near: warm white-gold
    { start: 600,  count: 1000, rMin: 6000,  rMax: 10000, sMin: 4.0, sMax: 8.0,  aMin: 0.15, aMax: 0.35, col: [0.62, 0.66, 0.80] },  // mid: neutral blue-white
    { start: 1600, count: 1400, rMin: 14000, rMax: 25000, sMin: 6.0, sMax: 14.0, aMin: 0.10, aMax: 0.25, col: [0.48, 0.50, 0.75] },  // far: cool blue-violet
  ];
  const spCount = 3000;
  const spPositions = new Float32Array(spCount * 3);
  const spSizes = new Float32Array(spCount);
  const spAlphas = new Float32Array(spCount);
  const spColors = new Float32Array(spCount * 3);
  const spPhases = new Float32Array(spCount);

  for (const shell of shells) {
    for (let i = 0; i < shell.count; i++) {
      const idx = shell.start + i;
      // Fibonacci sphere, upper hemisphere bias
      const y = 1 - (i / shell.count) * 1.5; // range 1 to -0.5
      const xyRadius = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = Math.PI * (1 + Math.sqrt(5)) * i;
      const r = shell.rMin + Math.random() * (shell.rMax - shell.rMin);

      spPositions[idx * 3]     = Math.cos(theta) * xyRadius * r;
      spPositions[idx * 3 + 1] = y * r;
      spPositions[idx * 3 + 2] = Math.sin(theta) * xyRadius * r;

      spSizes[idx] = shell.sMin + Math.random() * (shell.sMax - shell.sMin);
      spAlphas[idx] = shell.aMin + Math.random() * (shell.aMax - shell.aMin);
      // Color with slight per-star variation
      spColors[idx * 3]     = shell.col[0] + (Math.random() - 0.5) * 0.08;
      spColors[idx * 3 + 1] = shell.col[1] + (Math.random() - 0.5) * 0.08;
      spColors[idx * 3 + 2] = shell.col[2] + (Math.random() - 0.5) * 0.08;
      spPhases[idx] = Math.random() * Math.PI * 2;
    }
  }

  const spGeo = new THREE.BufferGeometry();
  spGeo.setAttribute('position', new THREE.Float32BufferAttribute(spPositions, 3));
  spGeo.setAttribute('aSize', new THREE.Float32BufferAttribute(spSizes, 1));
  spGeo.setAttribute('aAlpha', new THREE.Float32BufferAttribute(spAlphas, 1));
  spGeo.setAttribute('aColor', new THREE.Float32BufferAttribute(spColors, 3));
  spGeo.setAttribute('aPhase', new THREE.Float32BufferAttribute(spPhases, 1));

  const spMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 } },
    vertexShader: `
      attribute float aSize;
      attribute float aAlpha;
      attribute vec3 aColor;
      attribute float aPhase;
      varying float vAlpha;
      varying vec3 vColor;
      uniform float uTime;
      void main() {
        vColor = aColor;
        // Differential Y-axis rotation: near stars drift faster than far stars
        float r = length(position);
        float rotSpeed = mix(0.003, 0.0008, smoothstep(3500.0, 25000.0, r));
        float angle = uTime * rotSpeed;
        float cs = cos(angle);
        float sn = sin(angle);
        vec3 rotPos = vec3(
          position.x * cs - position.z * sn,
          position.y,
          position.x * sn + position.z * cs
        );
        vec4 mvPos = modelViewMatrix * vec4(rotPos, 1.0);
        vAlpha = aAlpha * (0.3 + 0.7 * sin(uTime * 0.6 + aPhase * 6.28));
        // Perspective size with floor so distant stars stay visible
        gl_PointSize = max(1.0, aSize * (3000.0 / max(-mvPos.z, 1.0)));
        gl_Position = projectionMatrix * mvPos;
      }
    `,
    fragmentShader: `
      varying float vAlpha;
      varying vec3 vColor;
      void main() {
        float dist = length(gl_PointCoord - vec2(0.5));
        if (dist > 0.5) discard;
        float core = exp(-dist * dist * 80.0);
        float glow = exp(-dist * dist * 12.0) * 0.2;
        gl_FragColor = vec4(vColor, (core + glow) * vAlpha);
      }
    `,
  });

  bgSkyParticles = new THREE.Points(spGeo, spMat);
  bgSkyParticles.renderOrder = -6;
  scene.add(bgSkyParticles);

  // ── Scene fog for atmospheric depth ──
  scene.fog = new THREE.FogExp2(0x000000, 0.00012);

  // ── Camera constraints & orbit polish ──
  const controls = graph.controls();
  if (controls) {
    // Zoom limit: keep camera inside the sky dome
    controls.maxDistance = 2800;
    controls.minDistance = 30;

    // Enable damping for smooth, polished orbit feel
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    // Smoother zoom
    controls.zoomSpeed = 0.8;

    // Smoother rotation
    controls.rotateSpeed = 0.6;

    // Smoother pan
    controls.panSpeed = 0.6;

    // Don't auto-rotate
    controls.autoRotate = false;

    // Floor + ceiling constraint via update override
    _origControlsUpdate = controls.update.bind(controls);
    controls.update = function() {
      _origControlsUpdate();
      const cam = graph.camera();
      if (cam.position.y < FLOOR_Y + 15) cam.position.y = FLOOR_Y + 15;
      if (cam.position.y > 2500) cam.position.y = 2500;
    };
  }
}

// ═══════════════════════════════════════════
// BACKGROUND — Cleanup
// ═══════════════════════════════════════════
function removeBackground(graph) {
  const scene = graph.scene();
  // Remove deep-grid objects (floor is managed separately by removeFloor)
  if (bgGridPillars) { scene.remove(bgGridPillars); bgGridPillars.geometry.dispose(); bgGridPillars.material.dispose(); bgGridPillars = null; }
  if (bgWorldParticles) { scene.remove(bgWorldParticles); bgWorldParticles.geometry.dispose(); bgWorldParticles.material.dispose(); bgWorldParticles = null; }
  if (bgGridFloor2) { scene.remove(bgGridFloor2); bgGridFloor2.geometry.dispose(); bgGridFloor2.material.dispose(); bgGridFloor2 = null; }
  if (bgSkyDome) {
    scene.remove(bgSkyDome);
    if (bgSkyDome.isGroup) {
      bgSkyDome.children.forEach(c => { c.geometry.dispose(); c.material.dispose(); });
    } else {
      bgSkyDome.geometry.dispose(); bgSkyDome.material.dispose();
    }
    bgSkyDome = null; _cloudPlanes = [];
  }
  if (bgSkyParticles) { scene.remove(bgSkyParticles); bgSkyParticles.geometry.dispose(); bgSkyParticles.material.dispose(); bgSkyParticles = null; }
  // Restore original controls if overridden
  const controls = graph.controls();
  if (controls && _origControlsUpdate) {
    controls.update = _origControlsUpdate;
    _origControlsUpdate = null;
    controls.maxDistance = Infinity;
    controls.minDistance = 0;
  }
  // Clear scene fog
  scene.fog = null;
}

// ═══════════════════════════════════════════
// BACKGROUND — Dispatcher
// Calls the right background builder based on theme
// ═══════════════════════════════════════════
export function applyBgTheme(graph, bloomPass) {
  if (!graph) return;
  removeBackground(graph);
  addBackgroundDeepGrid(graph);
  graph.backgroundColor('#000000');
  if (bloomPass) {
    bloomPass.strength = 0.2;
    bloomPass.threshold = 0.5;
    bloomPass.radius = 0.3;
  }
  applyFloorStyle(gfx.floorStyle || 'grid', graph);
}

// ═══════════════════════════════════════════
// ANIMATION — Per-frame background updates
// Called from the main animate() loop
// ═══════════════════════════════════════════
export function animateBackground(time, graph) {
  // ── Floor effect (independent of bg theme) ──
  if (floorMesh && floorMesh.material.uniforms) {
    if (floorMesh.material.uniforms.uTime) floorMesh.material.uniforms.uTime.value = time;
    if (floorMesh.material.uniforms.uCamY && graph) floorMesh.material.uniforms.uCamY.value = graph.camera().position.y;
  }
  if (floorParticles && floorParticles.material.uniforms) {
    if (floorParticles.material.uniforms.uTime) floorParticles.material.uniforms.uTime.value = time;
    if (floorParticles.material.uniforms.uCamPos && graph) floorParticles.material.uniforms.uCamPos.value.copy(graph.camera().position);
  }

  // ── Background — Deep Grid theme (world-space, real depth) ──
  if (bgGridPillars) {
    bgGridPillars.material.uniforms.uTime.value = time;
  }
  if (bgWorldParticles) {
    bgWorldParticles.material.uniforms.uTime.value = time;
    bgWorldParticles.material.uniforms.uIntensity.value = gfx.bgIntensity;
  }
  if (bgGridFloor2) {
    bgGridFloor2.material.uniforms.uTime.value = time;
  }
  // Layer F: world-space stars (no camera-attach — real parallax)
  if (bgSkyParticles) {
    bgSkyParticles.material.uniforms.uTime.value = time;
  }
}
