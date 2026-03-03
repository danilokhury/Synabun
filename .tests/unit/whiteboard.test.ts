import { describe, it, expect, vi } from 'vitest';
import { setNiState, setNiError } from '../mocks/neural-interface.mock.js';
import * as ni from '../../mcp-server/src/services/neural-interface.js';
import {
  handleWhiteboardRead,
  handleWhiteboardAdd,
  handleWhiteboardUpdate,
  handleWhiteboardRemove,
  handleWhiteboardScreenshot,
} from '@mcp/tools/whiteboard-tools.js';

describe('whiteboard_read', () => {
  it('returns empty message with viewport when whiteboard is empty', async () => {
    const res = await handleWhiteboardRead();
    const text = res.content[0].text;
    expect(text).toContain('Whiteboard is empty');
    expect(text).toContain('Viewport: 1920x1080');
  });

  it('includes element descriptions when elements exist', async () => {
    setNiState({
      whiteboardElements: [
        { id: 'el-1', type: 'text', x: 100, y: 200, content: 'Hello world' },
        { id: 'el-2', type: 'shape', x: 300, y: 400, width: 160, height: 100, shape: 'rect' },
      ],
    });

    const res = await handleWhiteboardRead();
    const text = res.content[0].text;
    expect(text).toContain('2 element(s)');
    expect(text).toContain('[el-1] TEXT');
    expect(text).toContain('Hello world');
    expect(text).toContain('[el-2] SHAPE:rect');
  });

  it('forwards NI error on read failure', async () => {
    setNiError('Whiteboard service unavailable');
    const res = await handleWhiteboardRead();
    expect(res.content[0].text).toBe('Failed to read whiteboard: Whiteboard service unavailable');
  });
});

describe('whiteboard_add', () => {
  it('adds elements and returns IDs', async () => {
    const res = await handleWhiteboardAdd({
      elements: [
        { type: 'text', x: 100, y: 100, content: 'Test' },
        { type: 'shape', x: 300, y: 300, shape: 'rect' },
      ],
    });

    const text = res.content[0].text;
    expect(text).toContain('Added 2 element(s):');
    expect(text).toContain('el-0');
    expect(text).toContain('el-1');
  });

  it('forwards NI error on add failure', async () => {
    setNiError('Canvas full');
    const res = await handleWhiteboardAdd({ elements: [{ type: 'text', x: 0, y: 0 }] });
    expect(res.content[0].text).toBe('Failed to add elements: Canvas full');
  });
});

describe('whiteboard_update', () => {
  it('updates an element and returns description', async () => {
    const res = await handleWhiteboardUpdate({
      id: 'el-1',
      updates: { content: 'Updated text', x: 200, y: 300 },
    });

    const text = res.content[0].text;
    expect(text).toContain('Updated:');
    expect(text).toContain('[el-1] TEXT');
  });

  it('forwards NI error on update failure', async () => {
    setNiError('Element not found');
    const res = await handleWhiteboardUpdate({ id: 'el-missing', updates: { x: 0 } });
    expect(res.content[0].text).toBe('Failed to update element: Element not found');
  });
});

describe('whiteboard_remove', () => {
  it('removes a specific element by ID', async () => {
    const res = await handleWhiteboardRemove({ id: 'el-1' });
    expect(res.content[0].text).toContain('Removed text element el-1');
  });

  it('clears the entire whiteboard when no ID provided', async () => {
    const res = await handleWhiteboardRemove({});
    expect(res.content[0].text).toBe('Whiteboard cleared.');
  });

  it('forwards NI error on remove failure', async () => {
    setNiError('Permission denied');
    const res = await handleWhiteboardRemove({ id: 'el-1' });
    expect(res.content[0].text).toBe('Failed to remove element: Permission denied');
  });

  it('forwards NI error on clear failure', async () => {
    setNiError('Clear operation timed out');
    const res = await handleWhiteboardRemove({});
    expect(res.content[0].text).toBe('Failed to clear whiteboard: Clear operation timed out');
  });
});

describe('whiteboard_screenshot', () => {
  it('returns image content block on success', async () => {
    const res = await handleWhiteboardScreenshot();
    expect(res.content).toHaveLength(1);
    expect(res.content[0].type).toBe('image');
    expect((res.content[0] as { data: string }).data).toBe('base64whiteboardscreenshot');
  });

  it('returns text error on NI failure', async () => {
    setNiError('No browser open for screenshot');
    const res = await handleWhiteboardScreenshot();
    expect(res.content).toHaveLength(1);
    expect(res.content[0].type).toBe('text');
    expect(res.content[0].text).toBe('Screenshot failed: No browser open for screenshot');
  });
});
