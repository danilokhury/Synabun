import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { buildRememberSchema } from '../src/tools/remember.js';

/**
 * `category` and `project` were `.optional()`, and category's description ended
 * with "If omitted, a project default is used." Hosts took the hint and sent
 * `{ content }` alone: everything landed in the fallback bucket at the default
 * importance, and the Claude Code stop hook — which keys off category — never
 * cleared, blocking the agent indefinitely.
 *
 * A JSON Schema `required` entry is enforcement. A description is only advice,
 * and the advice was already being ignored.
 */
describe('remember input schema', () => {
  const schema = buildRememberSchema();

  it('requires category and project', () => {
    expect(schema.category.isOptional()).toBe(false);
    expect(schema.project.isOptional()).toBe(false);
  });

  it('rejects a content-only call, naming both missing fields', () => {
    const result = z.object(schema).safeParse({ content: 'something worth keeping' });

    expect(result.success).toBe(false);
    if (result.success) return;
    const missing = result.error.issues.map((i) => i.path.join('.')).sort();
    expect(missing).toEqual(['category', 'project']);
  });

  it('rejects empty strings, not just absent keys', () => {
    const result = z.object(schema).safeParse({ content: 'x', category: '', project: '' });
    expect(result.success).toBe(false);
  });

  it('accepts a fully specified call', () => {
    const result = z.object(schema).safeParse({
      content: 'x',
      category: 'criticalpixel-bugs',
      project: 'criticalpixel',
      importance: 8,
      tags: ['a', 'b'],
    });
    expect(result.success).toBe(true);
  });

  it('keeps importance optional but still bounded', () => {
    expect(schema.importance.isOptional()).toBe(true);
    expect(z.object(schema).safeParse({ content: 'x', category: 'c', project: 'p', importance: 11 }).success).toBe(false);
    expect(z.object(schema).safeParse({ content: 'x', category: 'c', project: 'p', importance: 0 }).success).toBe(false);
  });

  it('no longer invites callers to omit the category', () => {
    expect(schema.category.description).not.toMatch(/if omitted/i);
    expect(schema.category.description).toMatch(/required/i);
    expect(schema.project.description).toMatch(/required/i);
  });
});
