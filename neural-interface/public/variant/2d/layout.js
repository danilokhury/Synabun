// ═══════════════════════════════════════════
// SynaBun Neural Interface — 2D Orbital Layout
// Computes hierarchical orbital positions:
//   Parent categories in a ring → child categories orbit parents →
//   memory cards orbit their category in concentric rings
// Two-pass layout: compute radii first, then place with proper spacing
// ═══════════════════════════════════════════

import { gfx } from './gfx.js';
import { state } from '../../shared/state.js';
import { KEYS } from '../../shared/constants.js';
import { storage } from '../../shared/storage.js';

// ═══════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════

export const CARD_W = 180;
export const CARD_H = 80;

// ═══════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════

/**
 * Compute orbital layout for all visible nodes.
 * Uses a two-pass approach: first compute radii, then re-place with proper spacing.
 * @param {Array}  nodes             state.allNodes (filtered by activeCategories)
 * @param {Object} categoryMetadata  state.categoryMetadata
 * @param {Set}    activeCategories  state.activeCategories
 * @returns {{ regions: CategoryRegion[], cards: CardPosition[] }}
 */
export function computeLayout(nodes, categoryMetadata, activeCategories) {
  // ── 1. Group nodes by category hierarchy ──
  const tree = _buildCategoryTree(nodes, categoryMetadata, activeCategories);

  // ── 2. Pass 1: Temporary placement + compute radii ──
  _layoutParents(tree);
  for (const parent of tree) {
    _layoutChildren(parent);
  }

  // Layout cards (this sets region.radius for each region)
  const allCards = [];
  for (const parent of tree) {
    if (parent.memories.length > 0) {
      const cards = _layoutCards(parent, parent.memories, true);
      allCards.push(...cards);
    }
    for (const child of parent.children) {
      if (child.memories.length > 0) {
        const cards = _layoutCards(child, child.memories, false);
        allCards.push(...cards);
      }
    }
  }

  // ── 3. Pass 2: Re-position using actual radii ──
  // Snapshot old positions before re-layout
  const oldPositions = new Map();
  for (const parent of tree) {
    oldPositions.set(parent.name, { cx: parent.cx, cy: parent.cy });
    for (const child of parent.children) {
      oldPositions.set(child.name, { cx: child.cx, cy: child.cy });
    }
  }

  // Re-position children with actual radii (still orbiting old parent positions)
  for (const parent of tree) {
    _reLayoutChildren(parent);
  }

  // Re-position parents in a properly-spaced ring using actual cluster radii
  _reLayoutParentsWithRadii(tree);

  // Cascade parent ring movement to children — they must orbit the NEW parent center
  for (const parent of tree) {
    const old = oldPositions.get(parent.name);
    if (!old) continue;
    const dx = parent.cx - old.cx;
    const dy = parent.cy - old.cy;
    if (dx === 0 && dy === 0) continue;
    for (const child of parent.children) {
      child.cx += dx;
      child.cy += dy;
    }
  }

  // Propagate position deltas to cards
  _propagateDeltas(tree, allCards, oldPositions);

  // ── 4. Collision avoidance ──
  const preCollision = new Map();
  const allRegions = flattenRegions(tree);
  for (const r of allRegions) {
    preCollision.set(r.name, { cx: r.cx, cy: r.cy });
  }

  _resolveCollisions(tree);

  // Propagate collision deltas to cards
  _propagateDeltas(tree, allCards, preCollision);

  // ── 5. Restore saved positions (overrides computed ones) ──
  _restoreSavedPositions(tree, allCards);

  return { regions: tree, cards: allCards };
}

/**
 * Clear all saved positions and force a fresh orbital layout on next compute.
 */
export function resetLayout() {
  try { storage.removeItem(KEYS.NODE_POS_2D); } catch (_) {}
}

/**
 * Get the flat list of all regions (parents + children) from a tree.
 * @param {Array} tree  The top-level regions from computeLayout
 * @returns {Array}
 */
export function flattenRegions(tree) {
  const flat = [];
  for (const parent of tree) {
    flat.push(parent);
    for (const child of parent.children) {
      flat.push(child);
    }
  }
  return flat;
}


// ═══════════════════════════════════════════
// INTERNAL: Build category tree
// ═══════════════════════════════════════════

function _buildCategoryTree(nodes, categoryMetadata, activeCategories) {
  // Map: parentName → { name, cx, cy, radius, color, children[], memories[], isParent }
  const parentMap = new Map();
  const childMap = new Map(); // childName → { name, cx, cy, radius, color, memories[], parentName }

  // Discover parent/child structure from metadata
  for (const [name, meta] of Object.entries(categoryMetadata)) {
    if (!activeCategories.has(name)) continue;

    if (meta.is_parent) {
      if (!parentMap.has(name)) {
        parentMap.set(name, {
          name,
          cx: 0, cy: 0,
          radius: 0,
          color: meta.color || '#888',
          logoUrl: meta.logo || null,
          description: meta.description || '',
          children: [],
          memories: [],
          isParent: true,
        });
      }
    } else if (meta.parent) {
      // Ensure parent exists
      if (!parentMap.has(meta.parent)) {
        const parentMeta = categoryMetadata[meta.parent] || {};
        parentMap.set(meta.parent, {
          name: meta.parent,
          cx: 0, cy: 0,
          radius: 0,
          color: parentMeta.color || '#888',
          logoUrl: parentMeta.logo || null,
          description: parentMeta.description || '',
          children: [],
          memories: [],
          isParent: true,
        });
      }
      const child = {
        name,
        cx: 0, cy: 0,
        radius: 0,
        color: meta.color || '#888',
        logoUrl: meta.logo || null,
        description: meta.description || '',
        memories: [],
        parentName: meta.parent,
        isParent: false,
      };
      childMap.set(name, child);
      parentMap.get(meta.parent).children.push(child);
    } else {
      // Standalone category (no parent, not is_parent) — treat as its own parent
      if (!parentMap.has(name)) {
        parentMap.set(name, {
          name,
          cx: 0, cy: 0,
          radius: 0,
          color: meta.color || '#888',
          logoUrl: meta.logo || null,
          description: meta.description || '',
          children: [],
          memories: [],
          isParent: true,
        });
      }
    }
  }

  // Assign each node to its category
  for (const node of nodes) {
    const cat = node.payload?.category;
    if (!cat || !activeCategories.has(cat)) continue;

    if (childMap.has(cat)) {
      childMap.get(cat).memories.push(node);
    } else if (parentMap.has(cat)) {
      parentMap.get(cat).memories.push(node);
    } else {
      // Unknown category — create standalone parent
      const meta = categoryMetadata[cat] || {};
      const parent = {
        name: cat,
        cx: 0, cy: 0,
        radius: 0,
        color: meta.color || '#888',
        logoUrl: meta.logo || null,
        description: meta.description || '',
        children: [],
        memories: [node],
        isParent: true,
      };
      parentMap.set(cat, parent);
    }
  }

  // Filter out empty parents (no memories anywhere in tree)
  const tree = [];
  for (const parent of parentMap.values()) {
    const totalMemories = parent.memories.length +
      parent.children.reduce((sum, c) => sum + c.memories.length, 0);
    if (totalMemories > 0) {
      // Also filter out empty children
      parent.children = parent.children.filter(c => c.memories.length > 0);
      tree.push(parent);
    }
  }

  return tree;
}


// ═══════════════════════════════════════════
// INTERNAL: Pass 1 — Temporary placement
// ═══════════════════════════════════════════

function _layoutParents(tree) {
  const n = tree.length;
  if (n === 0) return;
  if (n === 1) {
    tree[0].cx = 0;
    tree[0].cy = 0;
    return;
  }

  // Temporary tight ring — will be replaced in pass 2
  const baseRadius = gfx.parentOrbitRadius + n * 80;

  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i) / n - Math.PI / 2; // start at top
    tree[i].cx = Math.cos(angle) * baseRadius;
    tree[i].cy = Math.sin(angle) * baseRadius;
  }
}

function _layoutChildren(parent) {
  const children = parent.children;
  const n = children.length;
  if (n === 0) return;

  // Temporary placement — will be replaced after radii are known
  const orbitRadius = gfx.childOrbitGap + n * 30;

  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i) / n;
    children[i].cx = parent.cx + Math.cos(angle) * orbitRadius;
    children[i].cy = parent.cy + Math.sin(angle) * orbitRadius;
  }
}


// ═══════════════════════════════════════════
// INTERNAL: Label exclusion zone
// ═══════════════════════════════════════════

/**
 * Compute the minimum orbital radius so no card can overlap the category label.
 * Uses Minkowski sum of label bounding box + card bounding box + margin,
 * then takes the diagonal — guarantees no overlap at ANY angle on the ring.
 *
 * Must mirror the label sizes in graph.js _drawCategoryLabel().
 */
function _computeLabelExclusionRadius(region, isParent) {
  const name = region.name;
  const mul = state.labelSizeMultiplier || 1;
  const MARGIN = 35; // breathing room between label edge and nearest card edge
  const hasLogo = !!region.logoUrl;

  let halfLabelW, halfLabelH;

  if (isParent) {
    const fontSize = 38 * mul;
    if (hasLogo) {
      // Logo only — no name pill (matches graph.js parent label with logo)
      const logoH = 64 * mul;
      const logoAspect = 3; // conservative estimate for wide logos
      const logoW = logoH * logoAspect;
      const countH = fontSize * 0.45 + 10;
      const totalH = logoH + 6 + countH;
      halfLabelW = logoW / 2;
      halfLabelH = totalH / 2;
    } else {
      // Text only — name text + count
      const textW = name.length * fontSize * 0.65;
      const countH = fontSize * 0.45 + 10;
      const totalH = fontSize + 4 + countH;
      halfLabelW = textW / 2;
      halfLabelH = totalH / 2;
    }
  } else {
    const fontSize = 22 * mul;
    if (hasLogo) {
      // Logo only — no name text (matches graph.js child label with logo)
      const logoH = 32 * mul;
      const logoAspect = 3;
      const logoW = logoH * logoAspect;
      const countH = fontSize * 0.5 + 8;
      const totalH = logoH + 4 + countH;
      halfLabelW = logoW / 2;
      halfLabelH = totalH / 2;
    } else {
      // Text only — name text + count
      const textW = name.length * fontSize * 0.65;
      const countH = fontSize * 0.5 + 8;
      const totalH = fontSize + 4 + countH;
      halfLabelW = textW / 2;
      halfLabelH = totalH / 2;
    }
  }

  // Minkowski sum diagonal: guarantees no card at any ring angle can touch the label
  const expandedW = halfLabelW + CARD_W / 2 + MARGIN;
  const expandedH = halfLabelH + CARD_H / 2 + MARGIN;
  return Math.ceil(Math.sqrt(expandedW * expandedW + expandedH * expandedH));
}


// ═══════════════════════════════════════════
// INTERNAL: Card orbital layout
// ═══════════════════════════════════════════

function _layoutCards(region, memories, isParent) {
  // Sort by importance descending (most important = innermost ring)
  const sorted = [...memories].sort((a, b) => {
    const impA = a.payload?.importance || 5;
    const impB = b.payload?.importance || 5;
    if (impB !== impA) return impB - impA;
    // Secondary: alphabetical content for stability
    const cA = (a.payload?.content || '').slice(0, 30);
    const cB = (b.payload?.content || '').slice(0, 30);
    return cA.localeCompare(cB);
  });

  const cards = [];
  const gap = gfx.cardGap;
  const ringGap = CARD_H + 20;
  // Dynamic inner radius based on actual label dimensions — no card can touch the label
  const innerRadius = _computeLabelExclusionRadius(region, isParent);

  let placed = 0;
  let ringIndex = 0;

  while (placed < sorted.length) {
    const ringRadius = innerRadius + ringIndex * ringGap;
    const circumference = 2 * Math.PI * ringRadius;
    const cardsInRing = Math.max(1, Math.floor(circumference / (CARD_W + gap)));
    const actualCount = Math.min(cardsInRing, sorted.length - placed);

    for (let i = 0; i < actualCount; i++) {
      const angle = (2 * Math.PI * i) / actualCount;
      const node = sorted[placed + i];
      const card = {
        node,
        x: region.cx + Math.cos(angle) * ringRadius,
        y: region.cy + Math.sin(angle) * ringRadius,
        pinned: false,
      };
      cards.push(card);
    }

    placed += actualCount;
    ringIndex++;
  }

  // Update region radius to encompass all rings
  region.radius = innerRadius + Math.max(0, ringIndex - 1) * ringGap + CARD_H;

  return cards;
}


// ═══════════════════════════════════════════
// INTERNAL: Pass 2 — Re-position with actual radii
// ═══════════════════════════════════════════

/**
 * Re-position children using their actual radii so they don't overlap each other.
 */
function _reLayoutChildren(parent) {
  const children = parent.children;
  const n = children.length;
  if (n === 0) return;

  // Determine orbit radius based on actual sizes
  const maxChildRadius = Math.max(...children.map(c => c.radius || 60));
  const parentRadius = parent.radius || 60;

  // Orbit = parent region edge + child region edge + gap
  const orbitRadius = parentRadius + maxChildRadius + 80;

  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i) / n;
    children[i].cx = parent.cx + Math.cos(angle) * orbitRadius;
    children[i].cy = parent.cy + Math.sin(angle) * orbitRadius;
  }
}

/**
 * Re-position parents in a ring using their effective cluster radii
 * so adjacent parents have proper spacing.
 */
function _reLayoutParentsWithRadii(tree) {
  const n = tree.length;
  if (n === 0) return;
  if (n === 1) {
    tree[0].cx = 0;
    tree[0].cy = 0;
    return;
  }

  // Calculate effective radius for each parent (includes child orbits)
  const effectiveRadii = tree.map(parent => {
    let maxExtent = parent.radius || 100;
    for (const child of parent.children) {
      const distFromParent = Math.sqrt(
        (child.cx - parent.cx) ** 2 + (child.cy - parent.cy) ** 2
      );
      const childExtent = distFromParent + (child.radius || 60);
      maxExtent = Math.max(maxExtent, childExtent);
    }
    return maxExtent;
  });

  // Ring radius: ensure adjacent clusters don't overlap
  // Sum of all effective diameters + gaps, divided by 2*PI
  const minGap = 120;
  const totalDiameter = effectiveRadii.reduce((sum, r) => sum + r * 2, 0);
  const totalGap = n * minGap;
  const ringRadius = Math.max(
    (totalDiameter + totalGap) / (2 * Math.PI),
    gfx.parentOrbitRadius
  );

  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i) / n - Math.PI / 2; // start at top
    tree[i].cx = Math.cos(angle) * ringRadius;
    tree[i].cy = Math.sin(angle) * ringRadius;
  }
}


// ═══════════════════════════════════════════
// INTERNAL: Delta propagation
// ═══════════════════════════════════════════

/**
 * After regions are moved (re-layout or collision), propagate
 * the position deltas to their cards.
 */
function _propagateDeltas(tree, allCards, oldPositions) {
  // Build delta map: category name → { dx, dy }
  const deltas = new Map();
  for (const parent of tree) {
    const old = oldPositions.get(parent.name);
    if (old) deltas.set(parent.name, { dx: parent.cx - old.cx, dy: parent.cy - old.cy });
    for (const child of parent.children) {
      const oldC = oldPositions.get(child.name);
      if (oldC) deltas.set(child.name, { dx: child.cx - oldC.cx, dy: child.cy - oldC.cy });
    }
  }

  for (const card of allCards) {
    const cat = card.node.payload?.category;
    const delta = deltas.get(cat);
    if (delta) {
      card.x += delta.dx;
      card.y += delta.dy;
    }
  }
}


// ═══════════════════════════════════════════
// INTERNAL: Collision avoidance
// ═══════════════════════════════════════════

function _resolveCollisions(tree) {
  const allRegions = flattenRegions(tree);
  if (allRegions.length < 2) return;

  // 6 passes with 80px padding, resolves cross-parent collisions
  for (let pass = 0; pass < 6; pass++) {
    for (let i = 0; i < allRegions.length; i++) {
      for (let j = i + 1; j < allRegions.length; j++) {
        const a = allRegions[i];
        const b = allRegions[j];

        // Skip parent-child pairs (children orbit their parent deliberately)
        if (a.isParent && !b.isParent && b.parentName === a.name) continue;
        if (b.isParent && !a.isParent && a.parentName === b.name) continue;

        const dx = b.cx - a.cx;
        const dy = b.cy - a.cy;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const minDist = (a.radius || 100) + (b.radius || 100) + 80;

        if (dist < minDist) {
          const push = (minDist - dist) / 2;
          const nx = dx / dist;
          const ny = dy / dist;

          a.cx -= nx * push;
          a.cy -= ny * push;
          b.cx += nx * push;
          b.cy += ny * push;

          // If a parent moved, cascade to its children
          if (a.isParent) _moveChildrenBy(a, -nx * push, -ny * push);
          if (b.isParent) _moveChildrenBy(b, nx * push, ny * push);
        }
      }
    }
  }
}

function _moveChildrenBy(parent, dx, dy) {
  if (!parent.children) return;
  for (const child of parent.children) {
    child.cx += dx;
    child.cy += dy;
  }
}


// ═══════════════════════════════════════════
// INTERNAL: Position persistence
// ═══════════════════════════════════════════

function _restoreSavedPositions(tree, cards) {
  let saved;
  try {
    saved = JSON.parse(storage.getItem(KEYS.NODE_POS_2D) || '{}');
  } catch { return; }
  if (!saved || typeof saved !== 'object') return;

  // Restore category positions
  const allRegions = flattenRegions(tree);
  for (const region of allRegions) {
    const key = `_cat_${region.name}`;
    const pos = saved[key];
    if (pos && pos.x != null && pos.y != null) {
      region.cx = pos.x;
      region.cy = pos.y;
    }
  }

  // Restore card positions
  for (const card of cards) {
    const pos = saved[card.node.id];
    if (pos && pos.x != null && pos.y != null) {
      card.x = pos.x;
      card.y = pos.y;
      card.pinned = pos.pinned || false;
    }
  }
}
