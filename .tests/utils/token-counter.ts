import { get_encoding, type Tiktoken } from 'tiktoken';

// text-embedding-3-small uses the cl100k_base tokenizer (same as GPT-4)
let encoder: Tiktoken | null = null;

function getEncoder(): Tiktoken {
  if (!encoder) {
    encoder = get_encoding('cl100k_base');
  }
  return encoder;
}

/**
 * Count exact tokens using tiktoken WASM (cl100k_base).
 * This is the tokenizer used by text-embedding-3-small.
 */
export function countTokens(text: string): number {
  const enc = getEncoder();
  return enc.encode(text).length;
}

/**
 * Fast character-based estimation: ~4 chars per token for English text.
 * Used in scenario tests where speed > precision.
 */
export function estimateTokensFast(text: string): number {
  return Math.ceil(text.length / 4);
}

// --- Pricing ---
// text-embedding-3-small: $0.02 per 1M tokens (source: OpenAI pricing page, 2024)
const PRICE_PER_TOKEN = 0.00000002;

export function tokensToUSD(tokens: number): number {
  return tokens * PRICE_PER_TOKEN;
}

export function formatCost(usd: number): string {
  if (usd < 0.001) return `$${usd.toFixed(8)}`;
  if (usd < 0.01) return `$${usd.toFixed(6)}`;
  return `$${usd.toFixed(4)}`;
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return `${tokens}`;
}

// --- Content size presets for testing ---
export const CONTENT_SIZES = {
  tiny: 'Short note about a fix.',
  small: 'A brief memory about a specific implementation detail in the caching layer.',
  medium: [
    'This is a medium-length memory describing an architectural decision about the dual Supabase setup.',
    'The VPS instance handles content and rankings while the cloud instance manages auth and user profiles.',
    'This separation was chosen for cost and performance reasons, with Redis caching bridging both.',
    'The content includes technical details about cache invalidation strategies and TTL policies.',
  ].join(' '),
  large: Array(10).fill(
    'Detailed memory entry describing a complex bug fix involving the Redis cache invalidation logic. '
    + 'The issue was traced through multiple service layers from the API route handler through the '
    + 'orchestrator singleton to the individual store adapters. The root cause was a race condition '
    + 'between concurrent price update requests from different regions. '
  ).join(''),
  xlarge: Array(40).fill(
    'Architectural decision record: The dual Supabase setup separates auth concerns from content data. '
    + 'Cloud Supabase handles authentication, user profiles, notifications, and audit logs. '
    + 'VPS Supabase handles games, reviews, articles, rankings, and price data. '
    + 'This decision reduces managed database costs while keeping auth on Supabase managed infrastructure. '
  ).join(''),
} as const;

// --- Query size presets ---
export const QUERY_SIZES = {
  short: 'redis cache bug',
  typical: 'last conversation session about SynaBun hooks',
  long: 'architecture decisions about dual Supabase setup and cache invalidation strategies for the pricing system',
} as const;
