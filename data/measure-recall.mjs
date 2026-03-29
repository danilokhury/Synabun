/**
 * Measure recall token counts for various query scenarios.
 * Uses the compiled MCP server recall function directly.
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const MCP_DIST = resolve(import.meta.dirname, '..', 'mcp-server', 'dist');

// Dynamic import from compiled MCP dist
const { handleRecall } = await import(pathToFileURL(resolve(MCP_DIST, 'tools', 'recall.js')).href);

const CHAR_PER_TOKEN = 3.7;

const tests = [
  {
    name: 'Test 1: Boot recall (project-scoped, recency_boost)',
    args: { query: 'recent sessions, ongoing work, known issues, decisions', project: 'synabun', recency_boost: true },
  },
  {
    name: 'Test 2: Narrow technical query',
    args: { query: 'browser session tab management multi-tab' },
  },
  {
    name: 'Test 3: Category-filtered (development)',
    args: { query: 'architecture decisions and patterns', category: 'development' },
  },
  {
    name: 'Test 4: High-importance only (min 8)',
    args: { query: 'critical bugs, architecture decisions, important features', min_importance: 8 },
  },
  {
    name: 'Test 5: Cross-project (no project filter)',
    args: { query: 'performance optimization caching database redis' },
  },
  {
    name: 'Test 6: Obscure/minimal-match query',
    args: { query: 'quantum entanglement photosynthesis unrelated topic' },
  },
];

console.log('=== Recall Token Count Measurement ===\n');
console.log('Settings: limit=20, minImportance=5, minScore=0.25, maxChars=0, sessions=always, recencyBoost=true\n');

const results = [];

for (const test of tests) {
  const start = Date.now();
  const result = await handleRecall(test.args);
  const elapsed = Date.now() - start;

  const text = result.content[0].text;
  const chars = text.length;
  const tokens = Math.round(chars / CHAR_PER_TOKEN);

  // Count memories and session chunks
  const memoryMatch = text.match(/Found (\d+) memories/);
  const sessionMatch = text.match(/and (\d+) session chunks/);
  const memories = memoryMatch ? parseInt(memoryMatch[1]) : 0;
  const sessions = sessionMatch ? parseInt(sessionMatch[1]) : 0;

  results.push({ name: test.name, chars, tokens, memories, sessions, elapsed });

  console.log(`${test.name}`);
  console.log(`  Chars: ${chars.toLocaleString()} | Tokens: ~${tokens.toLocaleString()} | Memories: ${memories} | Sessions: ${sessions} | Time: ${elapsed}ms`);
  console.log();
}

console.log('\n=== Summary Table ===\n');
console.log('| Test | Chars | Tokens | Memories | Sessions | ms |');
console.log('|------|-------|--------|----------|----------|------|');
for (const r of results) {
  console.log(`| ${r.name.replace(/^Test \d+: /, '')} | ${r.chars.toLocaleString()} | ~${r.tokens.toLocaleString()} | ${r.memories} | ${r.sessions} | ${r.elapsed} |`);
}

const avgChars = Math.round(results.reduce((s, r) => s + r.chars, 0) / results.length);
const avgTokens = Math.round(avgChars / CHAR_PER_TOKEN);
const minTokens = Math.min(...results.map(r => r.tokens));
const maxTokens = Math.max(...results.map(r => r.tokens));

console.log();
console.log(`Min tokens: ~${minTokens.toLocaleString()}`);
console.log(`Max tokens: ~${maxTokens.toLocaleString()}`);
console.log(`Avg tokens: ~${avgTokens.toLocaleString()}`);
console.log(`Avg chars:  ${avgChars.toLocaleString()}`);
