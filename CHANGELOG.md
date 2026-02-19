# Changelog

All notable changes to SynaBun will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-02-16

### Added

**MCP Server**
- 9 MCP tools: `remember`, `recall`, `forget`, `reflect`, `memories`, `category_create`, `category_update`, `category_delete`, `category_list`
- Semantic search with cosine similarity, time decay (90-day half-life), project boost (1.2x), and access frequency scoring
- User-defined hierarchical categories with prescriptive routing descriptions
- Dynamic schema refresh — category changes propagate to AI tool schemas without server restart
- Multi-project support with automatic project detection from working directory
- Access tracking (fire-and-forget) for recall frequency boosting
- Importance shield — memories with importance 8+ are immune to time decay

**Neural Interface**
- Interactive 3D force-directed graph visualization (Three.js + ForceGraph3D)
- Memory detail panel with inline editing (content, tags, category)
- Semantic search bar
- Category sidebar with filtering, color management, and hierarchy editing
- Multi-connection support — switch between Qdrant instances at runtime
- Settings panel with masked API key display
- Graphics quality presets (Low, Medium, High, Ultra)
- Resizable, draggable, pinnable panels with localStorage persistence

**Onboarding**
- Guided setup wizard with dependency checks
- One-command setup (`npm start`) — installs deps, builds, launches, opens browser
- 11 embedding provider support (OpenAI, Google Gemini, Ollama, Mistral, Cohere, and more)
- Automatic `.mcp.json` generation for Claude Code registration
- CLAUDE.md memory instructions injection

**Claude Code Hooks**
- SessionStart hook — injects category tree, project detection, and behavioral rules
- UserPromptSubmit hook — nudges AI to check memory before responding to recall-worthy prompts

**Claude Code Skills**
- `/idea` skill — memory-powered brainstorming via multi-round recall with 5 query strategies (direct, adjacent, problem-space, solution-space, cross-domain), idea synthesis with memory provenance, and auto-save to `ideas` category

**Infrastructure**
- Docker Compose setup for local Qdrant with API key authentication
- Multi-connection registry (`connections.json`) for Qdrant instance management
- Cross-platform support: Windows, macOS, Linux, WSL
- Terminal UI (`tui.ts`) for interactive memory management
