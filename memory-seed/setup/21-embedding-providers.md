---
category: setup
tags: [embeddings, local, transformers-js, all-minilm, model]
importance: 8
project: synabun
source: self-discovered
subcategory: config
related_files:
  - mcp-server/src/services/local-embeddings.ts
  - mcp-server/src/config.ts
---

# SynaBun Local Embeddings — Transformers.js

SynaBun uses local embeddings via Transformers.js. The embeddings service (`mcp-server/src/services/local-embeddings.ts`) runs the model entirely in-process — no external API calls, no API keys required.

## Embedding Model

| Property | Value |
|----------|-------|
| Library | Transformers.js (@huggingface/transformers) |
| Model | all-MiniLM-L6-v2 |
| Dimensions | 384 |
| Runtime | Local (Node.js, in-process) |
| Download size | ~23 MB (cached after first run) |

## How It Works

- On first use, the model is downloaded from Hugging Face and cached locally
- Subsequent runs load the model from cache — no network required
- Embeddings are computed synchronously in the Node.js process
- No API keys, no rate limits, no external dependencies

## Configuration

No configuration needed. The embedding model and dimensions are fixed:

- **Model:** `Xenova/all-MiniLM-L6-v2` (384 dimensions)
- **Similarity metric:** Cosine distance (computed in application code)

## CRITICAL WARNING — Model Changes Are Breaking

Changing the embedding model makes ALL existing vectors incompatible. Cosine similarity between vectors from different models is meaningless. You must either:

1. Re-embed the entire database (delete and recreate all memories)
2. Start with a fresh database file

There is no migration path that preserves existing memories across model changes.
