import { z } from 'zod';
import * as ni from '../services/neural-interface.js';
import { text } from './response.js';

// ── browser_navigate ──

export const browserNavigateSchema = {
  url: z.string().describe('The URL to navigate to.'),
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session or creates a new one.'),
};

export const browserNavigateDescription =
  'Navigate the browser to a URL. If no browser session exists, one is created automatically.';

export async function handleBrowserNavigate(args: { url: string; sessionId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId, { url: args.url, headless: false });
  if ('error' in resolved) return text(resolved.error);

  const result = await ni.navigate(resolved.sessionId, args.url);
  if (result.error) return text(`Navigation failed: ${result.error}`);

  return text(`Navigated to ${result.url} — "${result.title}"`);
}

// ── browser_go_back ──

export const browserGoBackSchema = {
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};

export const browserGoBackDescription = 'Go back to the previous page in browser history.';

export async function handleBrowserGoBack(args: { sessionId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId);
  if ('error' in resolved) return text(resolved.error);

  const result = await ni.goBack(resolved.sessionId);
  if (result.error) return text(`Go back failed: ${result.error}`);

  return text(`Went back to ${result.url} — "${result.title}"`);
}

// ── browser_go_forward ──

export const browserGoForwardSchema = {
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};

export const browserGoForwardDescription = 'Go forward to the next page in browser history.';

export async function handleBrowserGoForward(args: { sessionId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId);
  if ('error' in resolved) return text(resolved.error);

  const result = await ni.goForward(resolved.sessionId);
  if (result.error) return text(`Go forward failed: ${result.error}`);

  return text(`Went forward to ${result.url} — "${result.title}"`);
}

// ── browser_reload ──

export const browserReloadSchema = {
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};

export const browserReloadDescription = 'Reload the current page. Useful after making changes or when content is stale.';

export async function handleBrowserReload(args: { sessionId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId);
  if ('error' in resolved) return text(resolved.error);

  const result = await ni.reload(resolved.sessionId);
  if (result.error) return text(`Reload failed: ${result.error}`);

  return text(`Reloaded — now at ${result.url} "${result.title}"`);
}
