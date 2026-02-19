---
category: setup
tags: [embeddings, providers, openai, gemini, ollama, mistral, model-migration, breaking-change]
importance: 8
project: synabun
source: self-discovered
subcategory: config
related_files:
  - mcp-server/src/services/embeddings.ts
  - mcp-server/src/config.ts
  - .env.example
---

# SynaBun Embedding Providers — 11 Supported Providers

SynaBun supports any OpenAI-compatible embedding API. The embeddings service (`mcp-server/src/services/embeddings.ts`, 29 lines) uses a lazy-initialized OpenAI client singleton.

## Supported Providers & Default Models

| # | Provider | Model | Dimensions |
|---|----------|-------|------------|
| 1 | OpenAI | text-embedding-3-small | 1536 |
| 2 | Google Gemini | text-embedding-004 | 768 |
| 3 | Ollama | nomic-embed-text | 768 |
| 4 | Mistral | mistral-embed | 1024 |
| 5 | Cohere | embed-english-v3.0 | 1024 |
| 6 | Voyage AI | voyage-2 | 1024 |
| 7 | Together AI | m2-bert-80M-8k-retrieval | 768 |
| 8 | Fireworks | nomic-embed-text-v1.5 | 768 |
| 9 | Azure OpenAI | Custom endpoint | Varies |
| 10 | AWS Bedrock | Via gateway | Varies |
| 11 | Custom | Any endpoint | Varies |

## Configuration (env vars)

- `OPENAI_EMBEDDING_API_KEY`: API key for the chosen provider (REQUIRED)
- `EMBEDDING_BASE_URL`: Provider's API endpoint (default: `https://api.openai.com/v1`)
- `EMBEDDING_MODEL`: Model name (default: `text-embedding-3-small`)
- `EMBEDDING_DIMENSIONS`: Vector dimensions (default: 1536)

## CRITICAL WARNING — Model Migration is Breaking

Changing the embedding model (even same provider, different model) makes ALL existing vectors incompatible. Cosine similarity between vectors from different models is meaningless. You must either:

1. Re-embed the entire collection (delete and recreate all memories)
2. Start with a fresh collection

There is no migration path that preserves existing memories across model changes.
