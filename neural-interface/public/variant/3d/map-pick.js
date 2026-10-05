// ── Memory map picking ──
//
// Hover and click resolve against a screen-space grid of the visible points,
// rebuilt only when the camera settles (projecting ~24k points takes a couple
// of milliseconds). A lookup checks the 3×3 cells around the cursor: the
// nearest point wins, the one closer to the camera on a tie. No DOM, no three.

/**
 * Project a world point with a column-major view-projection matrix.
 * @returns {[number, number, number] | null} [x, y, clip w] in CSS px, or null when behind the camera
 */
export function projectPoint(m, x, y, z, width, height) {
  const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
  if (cw <= 1e-6) return null;
  const nx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / cw;
  const ny = (m[1] * x + m[5] * y + m[9] * z + m[13]) / cw;
  return [(nx * 0.5 + 0.5) * width, (0.5 - ny * 0.5) * height, cw];
}

/**
 * @param {Float32Array} positions  3n world coordinates
 * @param {Float32Array|null} vis    per-point visibility (0 = hidden, < 1 = dimmed)
 * @param {ArrayLike<number>} m      view-projection matrix (column-major, 16)
 */
export function buildPickGrid(positions, vis, n, m, width, height, cell = 32) {
  const cols = Math.max(1, Math.ceil(width / cell));
  const rows = Math.max(1, Math.ceil(height / cell));
  const heads = new Int32Array(cols * rows).fill(-1);
  const next = new Int32Array(n).fill(-1);
  const sx = new Float32Array(n), sy = new Float32Array(n), depth = new Float32Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (vis && !(vis[i] > 0)) continue;
    const x = positions[3 * i], y = positions[3 * i + 1], z = positions[3 * i + 2];
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (cw <= 1e-6) continue;
    const px = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / cw * 0.5 + 0.5) * width;
    const py = (0.5 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / cw * 0.5) * height;
    const gx = Math.floor(px / cell), gy = Math.floor(py / cell);
    if (gx < 0 || gy < 0 || gx >= cols || gy >= rows) continue;
    sx[i] = px; sy[i] = py; depth[i] = cw;
    const c = gy * cols + gx;
    next[i] = heads[c];
    heads[c] = i;
    count++;
  }
  return { cell, cols, rows, heads, next, sx, sy, depth, vis, count, width, height };
}

/**
 * Nearest visible point to (x, y) within maxDist px, or -1. Dimmed points count
 * as 1.5× farther, so a search hit beats the faded point beside it.
 */
export function pickNearest(grid, x, y, maxDist = 12) {
  if (!grid) return -1;
  const { cell, cols, rows, heads, next, sx, sy, depth, vis } = grid;
  const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
  let best = -1, bestD = maxDist * maxDist, bestDepth = Infinity;
  for (let oy = -1; oy <= 1; oy++) {
    const cy = gy + oy;
    if (cy < 0 || cy >= rows) continue;
    for (let ox = -1; ox <= 1; ox++) {
      const cx = gx + ox;
      if (cx < 0 || cx >= cols) continue;
      for (let i = heads[cy * cols + cx]; i >= 0; i = next[i]) {
        const dx = sx[i] - x, dy = sy[i] - y;
        let d = dx * dx + dy * dy;
        if (vis && vis[i] < 1) d *= 2.25;
        if (d > maxDist * maxDist) continue;
        if (best < 0 || d < bestD - 4 || (d <= bestD + 4 && depth[i] < bestDepth)) {
          best = i; bestD = d; bestDepth = depth[i];
        }
      }
    }
  }
  return best;
}

/** Indices whose screen position lies inside the viewport (from the last grid). */
export function onScreen(grid, margin = 0) {
  const out = [];
  if (!grid) return out;
  const { heads, next } = grid;
  for (let c = 0; c < heads.length; c++) {
    for (let i = heads[c]; i >= 0; i = next[i]) {
      if (grid.sx[i] >= margin && grid.sy[i] >= margin && grid.sx[i] <= grid.width - margin && grid.sy[i] <= grid.height - margin) out.push(i);
    }
  }
  return out;
}
