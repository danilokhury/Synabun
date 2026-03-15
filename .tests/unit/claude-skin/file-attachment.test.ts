import { describe, it, expect } from 'vitest';

// ── Replicate the file-attachment logic from claude-chat.js ──

const TEXT_EXTENSIONS = new Set([
  'txt','md','js','ts','jsx','tsx','json','html','css','scss','less','xml','svg',
  'py','rb','go','rs','java','c','cpp','h','hpp','cs','php','sh','bash','zsh',
  'yml','yaml','toml','ini','cfg','conf','env','gitignore','dockerignore',
  'sql','graphql','proto','csv','tsv','log','diff','patch','vue','svelte',
  'mjs','cjs','mts','cts','astro','mdx','rst','tex','lua','r','swift','kt',
  'dockerfile','makefile','cmake','gradle','bat','ps1','fish',
]);

function isTextFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return TEXT_EXTENSIONS.has(ext) || !name.includes('.');
}

function buildPromptWithAttachments(userText: string, files: { name: string; content: string }[]): string {
  if (!files.length) return userText;
  let prompt = '';
  for (const f of files) prompt += `<file path="${f.name}">\n${f.content}\n</file>\n\n`;
  prompt += userText;
  return prompt;
}

describe('file attachment — text file detection', () => {
  it('accepts common code files', () => {
    expect(isTextFile('app.js')).toBe(true);
    expect(isTextFile('main.ts')).toBe(true);
    expect(isTextFile('style.css')).toBe(true);
    expect(isTextFile('page.html')).toBe(true);
    expect(isTextFile('data.json')).toBe(true);
    expect(isTextFile('script.py')).toBe(true);
    expect(isTextFile('lib.rs')).toBe(true);
    expect(isTextFile('main.go')).toBe(true);
  });

  it('accepts config/doc files', () => {
    expect(isTextFile('README.md')).toBe(true);
    expect(isTextFile('.env')).toBe(true);
    expect(isTextFile('config.yml')).toBe(true);
    expect(isTextFile('settings.toml')).toBe(true);
    expect(isTextFile('Dockerfile')).toBe(true);
    expect(isTextFile('Makefile')).toBe(true);
  });

  it('rejects binary files', () => {
    expect(isTextFile('photo.jpg')).toBe(false);
    expect(isTextFile('logo.png')).toBe(false);
    expect(isTextFile('archive.zip')).toBe(false);
    expect(isTextFile('video.mp4')).toBe(false);
    expect(isTextFile('music.mp3')).toBe(false);
    expect(isTextFile('doc.pdf')).toBe(false);
    expect(isTextFile('data.db')).toBe(false);
    expect(isTextFile('TwitterLogo.jpg')).toBe(false);
  });

  it('accepts extensionless files (Makefile-like)', () => {
    expect(isTextFile('Makefile')).toBe(true);
    expect(isTextFile('Dockerfile')).toBe(true);
    expect(isTextFile('README')).toBe(true);
  });

  it('is case-insensitive on extensions', () => {
    expect(isTextFile('App.JS')).toBe(true);
    expect(isTextFile('readme.MD')).toBe(true);
    expect(isTextFile('style.CSS')).toBe(true);
  });
});

describe('file attachment — prompt building', () => {
  it('returns plain text when no files attached', () => {
    expect(buildPromptWithAttachments('Hello', [])).toBe('Hello');
  });

  it('places files BEFORE user text', () => {
    const result = buildPromptWithAttachments('What is this?', [
      { name: 'app.js', content: 'const x = 1;' },
    ]);
    const fileIdx = result.indexOf('<file');
    const textIdx = result.indexOf('What is this?');
    expect(fileIdx).toBeLessThan(textIdx);
  });

  it('wraps files in <file> tags', () => {
    const result = buildPromptWithAttachments('analyze', [
      { name: 'foo.ts', content: 'export const a = 1;' },
    ]);
    expect(result).toContain('<file path="foo.ts">');
    expect(result).toContain('export const a = 1;');
    expect(result).toContain('</file>');
    expect(result).toContain('analyze');
  });

  it('handles multiple files', () => {
    const result = buildPromptWithAttachments('review', [
      { name: 'a.js', content: 'a' },
      { name: 'b.js', content: 'b' },
    ]);
    expect(result).toContain('<file path="a.js">');
    expect(result).toContain('<file path="b.js">');
    // User text comes last
    expect(result.endsWith('review')).toBe(true);
  });
});
