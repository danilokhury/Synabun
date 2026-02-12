import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { config as dotenvConfig } from 'dotenv';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from parent directory
dotenvConfig({ path: resolve(__dirname, '..', '.env') });

const app = express();
app.use(express.json());

const PORT = process.env.NEURAL_PORT || 3344;
const QDRANT_URL = process.env.QDRANT_MEMORY_URL || 'http://localhost:6333';
const QDRANT_KEY = process.env.QDRANT_MEMORY_API_KEY || 'claude-memory-local-key';
const COLLECTION = process.env.QDRANT_MEMORY_COLLECTION || 'claude_memory';
const OPENAI_KEY = process.env.OPENAI_EMBEDDING_API_KEY || process.env.OPENAI_API_KEY || '';
const EMBEDDING_BASE_URL = process.env.EMBEDDING_BASE_URL || 'https://api.openai.com/v1';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
const EMBEDDING_DIMS = parseInt(process.env.EMBEDDING_DIMENSIONS || '1536', 10);
const PROJECT_ROOT = resolve(__dirname, '..');

// --- Category Constants ---

const CATEGORIES_PATH = resolve(__dirname, '..', 'mcp-server', 'data', 'custom-categories.json');
const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

function loadCategories() {
  try {
    const raw = readFileSync(CATEGORIES_PATH, 'utf-8');
    const data = JSON.parse(raw);
    if (data.version === 1 && Array.isArray(data.categories)) {
      return data.categories;
    }
    return [];
  } catch {
    return [];
  }
}

function saveCategories(categories) {
  const dir = resolve(CATEGORIES_PATH, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CATEGORIES_PATH, JSON.stringify({ version: 1, categories }, null, 2), 'utf-8');
}

// --- .env Helpers ---

const ENV_PATH = resolve(__dirname, '..', '.env');

function parseEnvFile(filePath) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const vars = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      vars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
    return vars;
  } catch {
    return {};
  }
}

function writeEnvFile(filePath, vars) {
  const lines = Object.entries(vars).map(([k, v]) => `${k}=${v}`);
  writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
}

function maskKey(value) {
  if (!value) return '';
  if (value.length <= 4) return '****';
  return '*'.repeat(value.length - 4) + value.slice(-4);
}

// Redirect to onboarding if setup not complete
app.get('/', (req, res, next) => {
  const vars = parseEnvFile(ENV_PATH);
  if (vars.SETUP_COMPLETE === 'true') return next();
  const hasKey = vars.QDRANT_MEMORY_API_KEY && vars.QDRANT_MEMORY_API_KEY !== 'claude-memory-local-key';
  const hasEmbed = !!vars.OPENAI_EMBEDDING_API_KEY;
  if (hasKey && hasEmbed) return next();
  res.redirect('/onboarding.html');
});

app.use(express.static(join(__dirname, 'public')));

// --- Helpers ---

function qdrantHeaders() {
  return {
    'Content-Type': 'application/json',
    'api-key': QDRANT_KEY,
  };
}

async function qdrantFetch(path, options = {}) {
  const url = `${QDRANT_URL}/collections/${COLLECTION}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: { ...qdrantHeaders(), ...(options.headers || {}) },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Qdrant ${res.status}: ${text}`);
  }
  return res.json();
}

function cosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

async function getEmbedding(text) {
  const res = await fetch(`${EMBEDDING_BASE_URL}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text,
      dimensions: EMBEDDING_DIMS,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Embedding API ${res.status}: ${errText}`);
  }
  const data = await res.json();
  return data.data[0].embedding;
}

// --- Routes ---

// GET /api/memories — All memories with pre-computed graph edges
app.get('/api/memories', async (req, res) => {
  try {
    const allPoints = [];
    let offset = null;

    // Paginated scroll to get all points
    do {
      const body = {
        limit: 100,
        with_payload: true,
        with_vector: true,
      };
      if (offset) body.offset = offset;

      const result = await qdrantFetch('/points/scroll', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      allPoints.push(...result.result.points);
      offset = result.result.next_page_offset ?? null;
    } while (offset);

    // Build nodes
    const nodes = allPoints.map(p => ({
      id: p.id,
      payload: p.payload,
      vector: p.vector,
    }));

    // Build links via cosine similarity + shared tags + related_memory_ids
    const links = [];
    const SIM_THRESHOLD = 0.65;

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];

        // Cosine similarity
        let strength = 0;
        if (a.vector && b.vector) {
          const sim = cosineSimilarity(a.vector, b.vector);
          if (sim > SIM_THRESHOLD) {
            strength = Math.max(strength, (sim - SIM_THRESHOLD) / (1 - SIM_THRESHOLD));
          }
        }

        // Shared tags bonus
        if (a.payload.tags && b.payload.tags) {
          const shared = a.payload.tags.filter(t => b.payload.tags.includes(t));
          if (shared.length > 0) {
            strength = Math.max(strength, 0.3 + shared.length * 0.15);
          }
        }

        // Same category bonus
        if (a.payload.category === b.payload.category) {
          strength = Math.max(strength, 0.2);
        }

        if (strength > 0.1) {
          links.push({
            source: a.id,
            target: b.id,
            strength: Math.min(strength, 1),
          });
        }
      }

      // Explicit related_memory_ids
      if (nodes[i].payload.related_memory_ids) {
        for (const relId of nodes[i].payload.related_memory_ids) {
          const exists = links.some(
            l => (l.source === nodes[i].id && l.target === relId) ||
                 (l.source === relId && l.target === nodes[i].id)
          );
          if (!exists && nodes.some(n => n.id === relId)) {
            links.push({
              source: nodes[i].id,
              target: relId,
              strength: 0.9,
            });
          }
        }
      }
    }

    // Strip vectors from response (too large for client)
    const clientNodes = nodes.map(({ vector, ...rest }) => rest);

    res.json({ nodes: clientNodes, links, totalVectors: allPoints.length });
  } catch (err) {
    console.error('GET /api/memories error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/search — Semantic vector search
app.post('/api/search', async (req, res) => {
  try {
    const { query, limit = 10 } = req.body;
    if (!query) return res.status(400).json({ error: 'query required' });

    const embedding = await getEmbedding(query);

    const result = await qdrantFetch('/points/search', {
      method: 'POST',
      body: JSON.stringify({
        vector: embedding,
        limit,
        with_payload: true,
        score_threshold: 0.3,
      }),
    });

    res.json({
      results: result.result.map(r => ({
        id: r.id,
        score: r.score,
        payload: r.payload,
      })),
      query,
    });
  } catch (err) {
    console.error('POST /api/search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats — Collection count
app.get('/api/stats', async (req, res) => {
  try {
    const result = await fetch(`${QDRANT_URL}/collections/${COLLECTION}`, {
      headers: qdrantHeaders(),
    });
    const data = await result.json();
    res.json({
      count: data.result.points_count,
      vectors: data.result.vectors_count,
      status: data.result.status,
    });
  } catch (err) {
    console.error('GET /api/stats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/memory/:id — Single memory detail
app.get('/api/memory/:id', async (req, res) => {
  try {
    const result = await qdrantFetch('/points', {
      method: 'POST',
      body: JSON.stringify({
        ids: [req.params.id],
        with_payload: true,
      }),
    });

    if (!result.result || result.result.length === 0) {
      return res.status(404).json({ error: 'Memory not found' });
    }

    res.json(result.result[0]);
  } catch (err) {
    console.error('GET /api/memory/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/memory/:id — Update a memory's payload fields (category, tags, content)
app.patch('/api/memory/:id', async (req, res) => {
  try {
    const { category, tags, content } = req.body;
    if (!category && tags === undefined && content === undefined) {
      return res.status(400).json({ error: 'category, tags, or content is required' });
    }

    const payload = { updated_at: new Date().toISOString() };

    if (category) {
      const categories = loadCategories();
      if (!categories.some(c => c.name === category)) {
        return res.status(400).json({ error: `Unknown category "${category}".` });
      }
      payload.category = category;
    }

    if (tags !== undefined) {
      if (!Array.isArray(tags)) {
        return res.status(400).json({ error: 'tags must be an array of strings' });
      }
      // Sanitize: lowercase, trim, deduplicate, remove empties
      const clean = [...new Set(tags.map(t => String(t).trim().toLowerCase()).filter(Boolean))];
      payload.tags = clean;
    }

    if (content !== undefined) {
      if (typeof content !== 'string' || !content.trim()) {
        return res.status(400).json({ error: 'content must be a non-empty string' });
      }
      payload.content = content;
    }

    await qdrantFetch('/points/payload', {
      method: 'POST',
      body: JSON.stringify({
        payload,
        points: [req.params.id],
      }),
    });

    res.json({ ok: true, id: req.params.id, ...payload });
  } catch (err) {
    console.error('PATCH /api/memory/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/categories — All categories with clustering and colors
app.get('/api/categories', (req, res) => {
  try {
    const categories = loadCategories();

    // Build category tree for clustering
    const parents = categories.filter(c => !c.parent);
    const tree = {};

    parents.forEach(parent => {
      tree[parent.name] = {
        ...parent,
        children: categories.filter(c => c.parent === parent.name)
      };
    });

    // Return both flat list and tree
    res.json({
      categories: categories, // Full data with parent and color
      tree: tree,
      flat: categories.map(c => ({
        name: c.name,
        description: c.description,
        parent: c.parent,
        color: c.color
      })),
    });
  } catch (err) {
    console.error('GET /api/categories error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/categories — Create a category with optional parent and color
app.post('/api/categories', (req, res) => {
  try {
    const { name, description, parent, color, is_parent } = req.body;
    if (!name || !description) {
      return res.status(400).json({ error: 'name and description are required' });
    }
    if (name.length < 2 || name.length > 30) {
      return res.status(400).json({ error: `Name must be 2-30 characters. Got ${name.length}.` });
    }
    if (!NAME_PATTERN.test(name)) {
      return res.status(400).json({ error: 'Name must be lowercase, start with a letter, only letters/digits/hyphens.' });
    }
    // Validate color format if provided
    if (color && !/^#[0-9a-f]{6}$/i.test(color)) {
      return res.status(400).json({ error: 'Invalid color format. Use hex: #rrggbb' });
    }
    const categories = loadCategories();
    if (categories.some(c => c.name === name)) {
      return res.status(400).json({ error: `Category "${name}" already exists.` });
    }

    const newCategory = {
      name,
      description,
      created_at: new Date().toISOString()
    };
    if (parent) newCategory.parent = parent;
    if (color) newCategory.color = color;
    if (is_parent) newCategory.is_parent = true;

    categories.push(newCategory);
    saveCategories(categories);
    res.json({
      categories: categories,
      message: `Created "${name}"` + (parent ? ` under "${parent}"` : '') + (color ? ` with color ${color}` : '')
    });
  } catch (err) {
    console.error('POST /api/categories error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/categories/:name — Update a category
app.put('/api/categories/:name', async (req, res) => {
  try {
    const oldName = req.params.name;
    const { new_name, description, parent, color, is_parent } = req.body;

    const categories = loadCategories();
    let catIndex = categories.findIndex(c => c.name === oldName);

    // Auto-create category if it exists in memories but not in the JSON file
    if (catIndex === -1) {
      categories.push({
        name: oldName,
        description: oldName,
        created_at: new Date().toISOString(),
      });
      catIndex = categories.length - 1;
    }

    // Validate new_name if provided
    if (new_name) {
      if (new_name.length < 2 || new_name.length > 30) {
        return res.status(400).json({ error: `Name must be 2-30 characters. Got ${new_name.length}.` });
      }
      if (!NAME_PATTERN.test(new_name)) {
        return res.status(400).json({ error: 'Name must be lowercase, start with a letter, only letters/digits/hyphens.' });
      }
      if (new_name !== oldName && categories.some(c => c.name === new_name)) {
        return res.status(400).json({ error: `Category "${new_name}" already exists.` });
      }
    }

    // Validate parent if provided
    if (parent !== undefined && parent !== '' && parent !== oldName) {
      if (!categories.some(c => c.name === parent)) {
        return res.status(400).json({ error: `Parent category "${parent}" does not exist.` });
      }

      // Check for circular dependency
      let currentParent = parent;
      while (currentParent) {
        if (currentParent === (new_name || oldName)) {
          return res.status(400).json({ error: `Cannot set parent to "${parent}": would create circular dependency.` });
        }
        const parentCat = categories.find(c => c.name === currentParent);
        currentParent = parentCat?.parent || '';
      }
    }

    // Validate color format if provided
    if (color !== undefined && color !== '' && !/^#[0-9a-f]{6}$/i.test(color)) {
      return res.status(400).json({ error: 'Invalid color format. Use hex: #rrggbb' });
    }

    const cat = categories[catIndex];

    // If renaming, update all children that reference this category as parent AND update memories in Qdrant
    if (new_name && new_name !== oldName) {
      categories.forEach(c => {
        if (c.parent === oldName) {
          c.parent = new_name;
        }
      });
      cat.name = new_name;

      // Update all memories in Qdrant that use the old category name
      try {
        // First, find all points with the old category
        const scrollBody = {
          limit: 100,
          with_payload: true,
          filter: { must: [{ key: 'category', match: { value: oldName } }] }
        };

        const scrollResult = await qdrantFetch('/points/scroll', {
          method: 'POST',
          body: JSON.stringify(scrollBody),
        });

        const matchingPoints = scrollResult.result.points || [];
        if (matchingPoints.length > 0) {
          const pointIds = matchingPoints.map(p => p.id);
          // Update all matching points with the new category name
          await qdrantFetch('/points/payload', {
            method: 'POST',
            body: JSON.stringify({
              payload: { category: new_name, updated_at: new Date().toISOString() },
              points: pointIds,
            }),
          });
          console.log(`✓ Updated ${matchingPoints.length} memories from "${oldName}" to "${new_name}"`);
        }
      } catch (err) {
        console.error('Error updating memories during category rename:', err.message);
        // Don't fail the request, just log the error
      }
    }

    // Update other fields
    if (description !== undefined) cat.description = description;
    if (parent !== undefined) {
      if (parent === '') {
        delete cat.parent;
      } else {
        cat.parent = parent;
      }
    }
    if (color !== undefined) {
      if (color === '') {
        delete cat.color;
      } else {
        cat.color = color;
      }
    }
    if (is_parent !== undefined) {
      if (is_parent) {
        cat.is_parent = true;
      } else {
        delete cat.is_parent;
      }
    }

    saveCategories(categories);

    const changes = [];
    if (description !== undefined) changes.push(`description updated`);
    if (parent !== undefined) changes.push(`parent: ${parent === '' ? 'none' : parent}`);
    if (color !== undefined) changes.push(`color: ${color === '' ? 'auto' : color}`);

    res.json({
      categories: categories,
      message: `Updated "${oldName}"${new_name ? ` → "${new_name}"` : ''}: ${changes.join(', ')}`
    });
  } catch (err) {
    console.error('PUT /api/categories error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/memory/:id — Delete a memory from Qdrant
app.delete('/api/memory/:id', async (req, res) => {
  try {
    const id = req.params.id;

    // Delete the point directly from Qdrant
    const url = `${QDRANT_URL}/collections/${COLLECTION}/points/delete`;
    const qdrantRes = await fetch(url, {
      method: 'POST',
      headers: qdrantHeaders(),
      body: JSON.stringify({ points: [id] }),
    });

    if (!qdrantRes.ok) {
      const text = await qdrantRes.text();
      console.error('Qdrant delete error:', qdrantRes.status, text);
      return res.status(500).json({ error: `Qdrant error: ${qdrantRes.status}` });
    }

    res.json({ ok: true, id });
  } catch (err) {
    console.error('DELETE /api/memory/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/categories/:name — Update a category's description
app.patch('/api/categories/:name', (req, res) => {
  try {
    const { name } = req.params;
    const { description } = req.body;
    if (!description || !description.trim()) {
      return res.status(400).json({ error: 'description is required' });
    }

    const categories = loadCategories();
    const cat = categories.find(c => c.name === name);
    if (!cat) {
      return res.status(404).json({ error: `Category "${name}" not found.` });
    }

    cat.description = description.trim();
    saveCategories(categories);

    res.json({
      categories: categories.map(c => ({ name: c.name, description: c.description })),
    });
  } catch (err) {
    console.error('PATCH /api/categories/:name error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/categories/:name — Delete a category (handles both child categories and memories)
app.delete('/api/categories/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const reassignTo = req.query.reassign_to;
    const { reassign_children_to } = req.body || {};

    const categories = loadCategories();
    if (!categories.some(c => c.name === name)) {
      return res.status(404).json({ error: `Category "${name}" not found.` });
    }

    // Check if this is a parent category with children
    const children = categories.filter(c => c.parent === name);
    if (children.length > 0 && reassign_children_to === undefined) {
      return res.status(400).json({
        error: `Cannot delete parent category "${name}": it has ${children.length} child categor${children.length === 1 ? 'y' : 'ies'} (${children.map(c => c.name).join(', ')}).\n\nProvide reassign_children_to in request body to specify a new parent for them, or use empty string "" to make them top-level categories.`,
        children: children.map(c => c.name)
      });
    }

    // Validate reassign_children_to if provided
    if (reassign_children_to !== undefined && reassign_children_to !== '' && !categories.some(c => c.name === reassign_children_to)) {
      return res.status(400).json({ error: `Invalid reassign_children_to: category "${reassign_children_to}" does not exist.` });
    }

    // Handle children reassignment
    let childrenMsg = '';
    if (children.length > 0) {
      children.forEach(child => {
        if (reassign_children_to === '') {
          delete child.parent;
        } else {
          child.parent = reassign_children_to;
        }
      });

      if (reassign_children_to === '') {
        childrenMsg = ` ${children.length} child categor${children.length === 1 ? 'y' : 'ies'} made top-level.`;
      } else {
        childrenMsg = ` ${children.length} child categor${children.length === 1 ? 'y' : 'ies'} reassigned to "${reassign_children_to}".`;
      }
    }

    // Check Qdrant for memories using this category
    const scrollBody = { limit: 100, with_payload: true, filter: { must: [{ key: 'category', match: { value: name } }] } };
    const scrollResult = await qdrantFetch('/points/scroll', { method: 'POST', body: JSON.stringify(scrollBody) });
    const matchingPoints = scrollResult.result.points || [];

    if (matchingPoints.length > 0 && !reassignTo) {
      return res.status(409).json({
        error: `${matchingPoints.length} memories use this category. Provide reassign_to to move them.`,
        count: matchingPoints.length,
      });
    }

    // Reassign memories if needed
    if (matchingPoints.length > 0 && reassignTo) {
      const allNames = new Set(categories.map(c => c.name));
      allNames.delete(name);
      if (!allNames.has(reassignTo)) {
        return res.status(400).json({ error: `Reassign target "${reassignTo}" is not a valid category.` });
      }

      const pointIds = matchingPoints.map(p => p.id);
      await qdrantFetch('/points/payload', {
        method: 'POST',
        body: JSON.stringify({
          payload: { category: reassignTo },
          points: pointIds,
        }),
      });
    }

    // Remove from categories file
    const updated = categories.filter(c => c.name !== name);
    saveCategories(updated);

    let message = `Deleted "${name}".`;
    if (childrenMsg) message += childrenMsg;
    if (matchingPoints.length > 0) message += ` ${matchingPoints.length} memor${matchingPoints.length === 1 ? 'y' : 'ies'} reassigned to "${reassignTo}".`;

    res.json({
      categories: updated,
      message,
      reassigned: matchingPoints.length,
    });
  } catch (err) {
    console.error('DELETE /api/categories/:name error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/settings — Current config with masked keys
app.get('/api/settings', (req, res) => {
  try {
    const vars = parseEnvFile(ENV_PATH);
    const qdrantUrl = vars.QDRANT_MEMORY_URL || 'http://localhost:6333';
    const qdrantApiKey = vars.QDRANT_MEMORY_API_KEY || '';
    const collection = vars.QDRANT_MEMORY_COLLECTION || 'claude_memory';
    const openaiApiKey = vars.OPENAI_EMBEDDING_API_KEY || '';

    res.json({
      qdrantUrl,
      qdrantApiKey: maskKey(qdrantApiKey),
      qdrantApiKeySet: !!qdrantApiKey,
      collection,
      openaiApiKey: maskKey(openaiApiKey),
      openaiApiKeySet: !!openaiApiKey,
    });
  } catch (err) {
    console.error('GET /api/settings error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/settings — Save updated values to .env
app.put('/api/settings', (req, res) => {
  try {
    const { qdrantUrl, qdrantApiKey, collection, openaiApiKey } = req.body;
    const vars = parseEnvFile(ENV_PATH);

    if (qdrantUrl) vars.QDRANT_MEMORY_URL = qdrantUrl;
    if (qdrantApiKey) vars.QDRANT_MEMORY_API_KEY = qdrantApiKey;
    if (collection) vars.QDRANT_MEMORY_COLLECTION = collection;
    if (openaiApiKey) vars.OPENAI_EMBEDDING_API_KEY = openaiApiKey;

    // Remove defaults to keep .env clean
    if (vars.QDRANT_MEMORY_URL === 'http://localhost:6333') delete vars.QDRANT_MEMORY_URL;
    if (vars.QDRANT_MEMORY_COLLECTION === 'claude_memory') delete vars.QDRANT_MEMORY_COLLECTION;

    writeEnvFile(ENV_PATH, vars);
    res.json({ ok: true, message: 'Settings saved. Restart the server for changes to take effect.' });
  } catch (err) {
    console.error('PUT /api/settings error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Setup / Onboarding Routes ---

// GET /api/setup/status — Check what's configured
app.get('/api/setup/status', async (req, res) => {
  try {
    const vars = parseEnvFile(ENV_PATH);
    const setupComplete = vars.SETUP_COMPLETE === 'true';
    const hasQdrantKey = !!vars.QDRANT_MEMORY_API_KEY && vars.QDRANT_MEMORY_API_KEY !== 'claude-memory-local-key';
    const hasEmbeddingKey = !!vars.OPENAI_EMBEDDING_API_KEY;

    let dockerRunning = false;
    try {
      const qdrantRes = await fetch(`${QDRANT_URL}/collections`, {
        headers: { 'api-key': vars.QDRANT_MEMORY_API_KEY || QDRANT_KEY },
      });
      dockerRunning = qdrantRes.ok;
    } catch {}

    const mcpBuilt = existsSync(resolve(PROJECT_ROOT, 'mcp-server', 'dist', 'index.js'));

    res.json({
      setupComplete,
      hasQdrantKey,
      hasEmbeddingKey,
      dockerRunning,
      mcpBuilt,
      projectDir: PROJECT_ROOT,
      platform: process.platform,
    });
  } catch (err) {
    console.error('GET /api/setup/status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/setup/save-config — Write config to .env
app.post('/api/setup/save-config', (req, res) => {
  try {
    const { qdrantApiKey, collectionName, embeddingApiKey, embeddingBaseUrl, embeddingModel, embeddingDimensions } = req.body;
    const vars = parseEnvFile(ENV_PATH);

    if (qdrantApiKey) vars.QDRANT_MEMORY_API_KEY = qdrantApiKey;
    if (collectionName) vars.QDRANT_MEMORY_COLLECTION = collectionName;
    if (embeddingApiKey) vars.OPENAI_EMBEDDING_API_KEY = embeddingApiKey;
    if (embeddingBaseUrl) vars.EMBEDDING_BASE_URL = embeddingBaseUrl;
    if (embeddingModel) vars.EMBEDDING_MODEL = embeddingModel;
    if (embeddingDimensions) vars.EMBEDDING_DIMENSIONS = String(embeddingDimensions);

    // Clean up defaults
    if (vars.EMBEDDING_BASE_URL === 'https://api.openai.com/v1') delete vars.EMBEDDING_BASE_URL;
    if (vars.EMBEDDING_MODEL === 'text-embedding-3-small') delete vars.EMBEDDING_MODEL;
    if (vars.EMBEDDING_DIMENSIONS === '1536') delete vars.EMBEDDING_DIMENSIONS;
    if (vars.QDRANT_MEMORY_COLLECTION === 'claude_memory') delete vars.QDRANT_MEMORY_COLLECTION;

    writeEnvFile(ENV_PATH, vars);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/setup/save-config error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/setup/docker — Start Docker containers
app.post('/api/setup/docker', async (req, res) => {
  try {
    // Re-read .env so docker-compose picks up the new API key
    const vars = parseEnvFile(ENV_PATH);

    const { stdout, stderr } = await execAsync('docker compose up -d', {
      cwd: PROJECT_ROOT,
      timeout: 60000,
      env: { ...process.env, ...vars },
    });

    // Wait for Qdrant to be ready (up to 30s)
    const apiKey = vars.QDRANT_MEMORY_API_KEY || QDRANT_KEY;
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        const ping = await fetch(`${QDRANT_URL}/collections`, {
          headers: { 'api-key': apiKey },
        });
        if (ping.ok) { ready = true; break; }
      } catch {}
      await new Promise(r => setTimeout(r, 1000));
    }

    res.json({ ok: true, output: stdout + (stderr || ''), ready });
  } catch (err) {
    console.error('POST /api/setup/docker error:', err.message);
    res.status(500).json({ error: err.message, output: err.stderr || '' });
  }
});

// POST /api/setup/create-collection — Create Qdrant collection
app.post('/api/setup/create-collection', async (req, res) => {
  try {
    const vars = parseEnvFile(ENV_PATH);
    const apiKey = vars.QDRANT_MEMORY_API_KEY || QDRANT_KEY;
    const collection = vars.QDRANT_MEMORY_COLLECTION || 'claude_memory';
    const dims = parseInt(vars.EMBEDDING_DIMENSIONS || '1536', 10);

    // Check if collection already exists
    const checkRes = await fetch(`${QDRANT_URL}/collections/${collection}`, {
      headers: { 'api-key': apiKey },
    });
    if (checkRes.ok) {
      return res.json({ ok: true, message: 'Collection already exists', existed: true });
    }

    // Create collection
    const createRes = await fetch(`${QDRANT_URL}/collections/${collection}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify({
        vectors: { size: dims, distance: 'Cosine' },
      }),
    });

    if (!createRes.ok) {
      const text = await createRes.text();
      throw new Error(`Qdrant ${createRes.status}: ${text}`);
    }

    res.json({ ok: true, message: `Collection "${collection}" created (${dims}d vectors)`, existed: false });
  } catch (err) {
    console.error('POST /api/setup/create-collection error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/setup/build — Build the MCP server
app.post('/api/setup/build', async (req, res) => {
  try {
    const mcpDir = resolve(PROJECT_ROOT, 'mcp-server');
    const { stdout, stderr } = await execAsync('npm install && npm run build', {
      cwd: mcpDir,
      timeout: 120000,
    });
    res.json({ ok: true, output: stdout + (stderr || '') });
  } catch (err) {
    console.error('POST /api/setup/build error:', err.message);
    res.status(500).json({ error: err.message, output: err.stdout || '' });
  }
});

// GET /api/setup/test-qdrant — Ping Qdrant
app.get('/api/setup/test-qdrant', async (req, res) => {
  try {
    const vars = parseEnvFile(ENV_PATH);
    const apiKey = vars.QDRANT_MEMORY_API_KEY || QDRANT_KEY;
    const ping = await fetch(`${QDRANT_URL}/collections`, {
      headers: { 'api-key': apiKey },
    });
    res.json({ ok: ping.ok });
  } catch {
    res.json({ ok: false });
  }
});

// POST /api/setup/write-mcp-json — Generate .mcp.json in target directory
app.post('/api/setup/write-mcp-json', (req, res) => {
  try {
    const { targetDir } = req.body;
    if (!targetDir) return res.status(400).json({ error: 'targetDir required' });

    const mcpIndexPath = resolve(PROJECT_ROOT, 'mcp-server', 'dist', 'index.js').replace(/\\/g, '/');
    const envPath = resolve(PROJECT_ROOT, '.env').replace(/\\/g, '/');

    const mcpEntry = {
      command: 'node',
      args: [mcpIndexPath],
      env: { DOTENV_PATH: envPath },
    };

    const targetPath = resolve(targetDir, '.mcp.json');
    let existing = {};
    try {
      existing = JSON.parse(readFileSync(targetPath, 'utf-8'));
    } catch {}

    if (!existing.mcpServers) existing.mcpServers = {};
    existing.mcpServers.SynaBun = mcpEntry;

    writeFileSync(targetPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
    res.json({ ok: true, path: targetPath });
  } catch (err) {
    console.error('POST /api/setup/write-mcp-json error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/setup/write-instructions — Append memory instructions to markdown file
app.post('/api/setup/write-instructions', (req, res) => {
  try {
    const { targetDir, fileName, content } = req.body;
    if (!targetDir || !fileName || !content) {
      return res.status(400).json({ error: 'targetDir, fileName, and content required' });
    }

    const targetPath = resolve(targetDir, fileName);
    let existing = '';
    try { existing = readFileSync(targetPath, 'utf-8'); } catch {}

    // Check if memory instructions already exist
    if (existing.includes('## Persistent Memory System') || existing.includes('## Memory MCP')) {
      return res.json({ ok: true, path: targetPath, skipped: true, message: 'Memory instructions already present' });
    }

    const separator = existing.length > 0 ? '\n\n---\n\n' : '';
    writeFileSync(targetPath, existing + separator + content + '\n', 'utf-8');
    res.json({ ok: true, path: targetPath, skipped: false });
  } catch (err) {
    console.error('POST /api/setup/write-instructions error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/setup/complete — Mark setup as done
app.post('/api/setup/complete', (req, res) => {
  try {
    const vars = parseEnvFile(ENV_PATH);
    vars.SETUP_COMPLETE = 'true';
    writeEnvFile(ENV_PATH, vars);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/setup/complete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Start ---
app.listen(PORT, () => {
  console.log(`\n  Neural Memory Interface`);
  console.log(`  ──────────────────────`);
  console.log(`  Server:  http://localhost:${PORT}`);
  console.log(`  Qdrant:  ${QDRANT_URL}`);
  console.log(`  Collection: ${COLLECTION}`);
  console.log(`  OpenAI:  ${OPENAI_KEY ? 'configured' : 'MISSING'}\n`);
});
