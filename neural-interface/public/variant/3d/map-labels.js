// ── Memory map labels ──
//
// One 2D canvas over the WebGL canvas. Which labels show depends on how big
// their island is on screen (semantic zoom): continents from far away,
// islands at mid range, region names once an island fills the view, and a few
// memory titles up close. Labels are placed greedily by priority and never
// overlap; they fade in and out. Clicks are hit-tested against what was drawn.

const FONT = "Inter, 'SF Pro Text', system-ui, sans-serif";
const FADE_MS = 120;

// On-screen island radius (px) at which each tier is shown.
const TIERS = {
  continent: [40, 900],
  island: [18, 1400],
  region: 260,
  memory: 320,
};

export function createLabelLayer(container) {
  const canvas = document.createElement('canvas');
  canvas.id = 'map-labels';
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2;';
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let W = 1, H = 1;

  let map = null;
  let islandCss = [];
  let islandShown = [];
  let titles = [];   // [{ i, text }]
  let pinned = [];   // [{ i, text, kind: 'selected' | 'search' }]
  let options = { visible: true, scale: 1 };
  const alphaOf = new Map(); // label key → current alpha
  let lastNow = 0;
  let hits = [];
  const widths = new Map();

  function resize(w, h) {
    W = w; H = h;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
  }

  function measure(font, text, spacing = 0) {
    const key = `${font}|${spacing}|${text}`;
    let w = widths.get(key);
    if (w === undefined) {
      ctx.font = font;
      w = ctx.measureText(text).width + spacing * Math.max(0, text.length - 1);
      if (widths.size > 4000) widths.clear();
      widths.set(key, w);
    }
    return w;
  }

  const project = (m, x, y, z) => {
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (cw <= 1e-6) return null;
    return [((m[0] * x + m[4] * y + m[8] * z + m[12]) / cw * 0.5 + 0.5) * W, (0.5 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / cw * 0.5) * H, cw];
  };

  /** Build this frame's candidates (in priority order) from the camera. */
  function candidates(view) {
    const out = [];
    if (!map) return out;
    // Out of its tier: still offered (hidden) while it fades, dropped once gone.
    const offer = (item, inTier) => {
      if (inTier) out.push(item);
      else if (alphaOf.has(item.key)) out.push({ ...item, hide: true });
    };
    const m = view.viewProj;
    const s = options.scale;
    const islandPx = new Float32Array(map.islands.length);
    map.islands.forEach((isl, k) => {
      const p = project(m, isl.x, isl.h, isl.z);
      if (!p) { islandPx[k] = 0; return; }
      islandPx[k] = isl.r * view.pxPerUnit(p[2]);
      const px = islandPx[k];
      const shownIsland = !!islandShown[k];
      offer({
        key: `i:${isl.name}`, type: 'island', name: isl.name, x: p[0], y: p[1] - 10, anchor: 'center',
        text: isl.name, sub: isl.count.toLocaleString(), font: `500 ${Math.round(12 * s)}px ${FONT}`,
        subFont: `400 ${Math.round(10 * s)}px ${FONT}`, color: islandCss[k] || 'rgba(230,235,245,0.9)',
        priority: 200 + Math.log10(isl.count + 1),
      }, shownIsland && px >= TIERS.island[0] && px <= TIERS.island[1]);
      if (Array.isArray(isl.regions)) {
        for (const g of isl.regions) {
          const q = project(m, g.x, isl.h * 0.5, g.z);
          if (!q) continue;
          offer({
            key: `r:${isl.name}:${g.label}`, type: 'region', name: isl.name, x: q[0], y: q[1], anchor: 'center',
            text: g.label, font: `italic 400 ${Math.round(11 * s)}px ${FONT}`, color: 'rgba(214,222,240,0.62)',
            priority: 100 + Math.log10(g.count + 1),
          }, shownIsland && px >= TIERS.region);
        }
      }
    });
    const islandsOfContinent = new Map();
    map.islands.forEach((isl, k) => {
      if (!islandsOfContinent.has(isl.continent)) islandsOfContinent.set(isl.continent, []);
      islandsOfContinent.get(isl.continent).push(k);
    });
    map.continents.forEach((c, ci) => {
      const members = islandsOfContinent.get(ci) || [];
      if (members.length < 2) return; // a one-island continent is just its island
      const p = project(m, c.x, 0, c.z);
      if (!p) return;
      const px = c.r * view.pxPerUnit(p[2]);
      const total = members.reduce((sum, k) => sum + map.islands[k].count, 0);
      offer({
        key: `c:${c.name}`, type: 'continent', name: c.name, x: p[0], y: p[1], anchor: 'center',
        text: c.name.toUpperCase(), spacing: 2.2 * s, font: `600 ${Math.round(13 * s)}px ${FONT}`,
        color: 'rgba(236,241,255,0.5)', priority: 300 + Math.log10(total + 1),
      }, members.some((k) => islandShown[k]) && px >= TIERS.continent[0] && px <= TIERS.continent[1]);
    });
    for (const t of titles) {
      const k = map.islandOf[t.i];
      const p = project(m, map.positions[3 * t.i], map.positions[3 * t.i + 1], map.positions[3 * t.i + 2]);
      if (!p) continue;
      offer({
        key: `m:${t.i}`, type: 'memory', index: t.i, x: p[0] + 9, y: p[1] + 4, anchor: 'left',
        text: t.text, font: `400 ${Math.round(11 * s)}px ${FONT}`, color: 'rgba(236,239,246,0.82)',
        priority: 10 + (t.score || 0),
      }, !!islandShown[k] && islandPx[k] >= TIERS.memory);
    }
    for (const t of pinned) {
      const p = project(m, map.positions[3 * t.i], map.positions[3 * t.i + 1], map.positions[3 * t.i + 2]);
      if (!p) continue;
      out.push({
        key: `p:${t.kind}:${t.i}`, type: 'memory', index: t.i, x: p[0] + 12, y: p[1] + 4, anchor: 'left',
        text: t.text, font: `${t.kind === 'selected' ? 600 : 500} ${Math.round(12 * s)}px ${FONT}`,
        color: t.kind === 'selected' ? 'rgba(255,255,255,0.98)' : 'rgba(255,236,190,0.95)',
        pill: t.kind === 'selected', priority: t.kind === 'selected' ? 10_000 : 5_000 - pinned.indexOf(t),
      });
    }
    out.sort((a, b) => b.priority - a.priority);
    return out;
  }

  /**
   * Draw one frame. `view` = { viewProj, pxPerUnit(depth) }.
   * @returns {boolean} true while any label is still fading
   */
  function draw(now, view) {
    const dt = lastNow ? Math.min(100, now - lastNow) : 16;
    lastNow = now;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    hits = [];
    if (!map || !options.visible || !view) {
      alphaOf.clear();
      return false;
    }
    const list = candidates(view);
    const placed = [];
    const shown = new Set();
    let busy = false;
    ctx.textBaseline = 'middle';
    for (const c of list) {
      const w = measure(c.font, c.text, c.spacing || 0) + (c.sub ? measure(c.subFont, c.sub) + 6 : 0);
      const h = parseInt(c.font.match(/(\d+)px/)[1], 10) + 4;
      const x0 = c.anchor === 'left' ? c.x : c.x - w / 2;
      const rect = [x0 - 3, c.y - h / 2 - 2, x0 + w + 3, c.y + h / 2 + 2];
      const inView = rect[2] > 0 && rect[0] < W && rect[3] > 0 && rect[1] < H;
      const free = !c.hide && inView && !placed.some((r) => rect[0] < r[2] && rect[2] > r[0] && rect[1] < r[3] && rect[3] > r[1]);
      const target = free ? 1 : 0;
      let a = alphaOf.get(c.key) ?? 0;
      if (free) placed.push(rect);
      a += Math.sign(target - a) * (dt / FADE_MS);
      a = Math.min(1, Math.max(0, a));
      if (a !== target) busy = true;
      if (a <= 0.01) { alphaOf.delete(c.key); continue; }
      alphaOf.set(c.key, a);
      shown.add(c.key);
      paint(c, x0, w, h, a);
      if (a > 0.5 && free) hits.push({ rect, item: c });
    }
    for (const key of alphaOf.keys()) if (!shown.has(key)) { alphaOf.delete(key); }
    return busy;
  }

  function paint(c, x0, w, h, a) {
    ctx.globalAlpha = a;
    if (c.pill) {
      ctx.fillStyle = 'rgba(12,14,20,0.78)';
      roundRect(x0 - 6, c.y - h / 2 - 1, w + 12, h + 2, 6);
      ctx.fill();
    }
    ctx.font = c.font;
    ctx.fillStyle = c.color;
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = c.pill ? 0 : 4;
    if ('letterSpacing' in ctx) ctx.letterSpacing = c.spacing ? `${c.spacing}px` : '0px';
    ctx.textAlign = 'left';
    ctx.fillText(c.text, x0, c.y);
    if (c.sub) {
      const tw = measure(c.font, c.text, c.spacing || 0);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
      ctx.font = c.subFont;
      ctx.fillStyle = 'rgba(200,206,220,0.45)';
      ctx.fillText(c.sub, x0 + tw + 6, c.y + 0.5);
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /** The label under (x, y) — pinned and bigger labels first. */
  function hitTest(x, y) {
    for (const h of hits) {
      const [x0, y0, x1, y1] = h.rect;
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return h.item;
    }
    return null;
  }

  return {
    canvas,
    resize,
    draw,
    hitTest,
    setMap(next, css, shown) { map = next; islandCss = css || []; islandShown = shown || []; titles = []; pinned = []; },
    setShown(shown) { islandShown = shown || []; },
    setColors(css) { islandCss = css || []; },
    setTitles(list) { titles = list || []; },
    setPinned(list) { pinned = list || []; },
    setOptions(next) { options = { ...options, ...next }; },
    get count() { return hits.length; },
  };
}
