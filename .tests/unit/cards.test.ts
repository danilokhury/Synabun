import { describe, it, expect, vi } from 'vitest';
import { setNiState, setNiError } from '../mocks/neural-interface.mock.js';
import * as ni from '../../mcp-server/src/services/neural-interface.js';
import {
  handleCardList,
  handleCardOpen,
  handleCardClose,
  handleCardUpdate,
  handleCardScreenshot,
} from '@mcp/tools/card-tools.js';

describe('card_list', () => {
  it('returns empty message with viewport when no cards open', async () => {
    const res = await handleCardList();
    const text = res.content[0].text;
    expect(text).toContain('No memory cards are currently open.');
    expect(text).toContain('Viewport:');
  });

  it('includes card descriptions when cards exist', async () => {
    setNiState({
      cards: [{
        memoryId: 'mem-uuid-1',
        panelId: 'panel-1',
        left: '100px',
        top: '200px',
        width: '400px',
        height: '300px',
        isCompact: false,
        isPinned: false,
        category: 'architecture',
        contentPreview: 'Test memory content',
      }],
    });

    const res = await handleCardList();
    const text = res.content[0].text;
    expect(text).toContain('Open cards: 1');
    expect(text).toContain('mem-uuid-1');
    expect(text).toContain('architecture');
    expect(text).toContain('Test memory content');
  });

  it('forwards NI error on list failure', async () => {
    setNiError('Card service unavailable');
    const res = await handleCardList();
    expect(res.content[0].text).toBe('Failed to read cards: Card service unavailable');
  });
});

describe('card_open', () => {
  it('opens a card successfully', async () => {
    const res = await handleCardOpen({ memoryId: 'mem-uuid-1' });
    expect(res.content[0].text).toContain('Card opened');
    expect(res.content[0].text).toContain('mem-uuid-1');
  });

  it('indicates when card was already open', async () => {
    vi.mocked(ni.openCard).mockResolvedValueOnce({
      result: { memoryId: 'mem-uuid-1', left: 100, top: 200, alreadyOpen: true },
    });

    const res = await handleCardOpen({ memoryId: 'mem-uuid-1' });
    expect(res.content[0].text).toContain('already open, brought to front');
  });

  it('forwards NI error on open failure', async () => {
    setNiError('Memory not found');
    const res = await handleCardOpen({ memoryId: 'bad-uuid' });
    expect(res.content[0].text).toBe('Failed to open card: Memory not found');
  });
});

describe('card_close', () => {
  it('closes a specific card by memoryId', async () => {
    const res = await handleCardClose({ memoryId: 'mem-uuid-1' });
    expect(res.content[0].text).toBe('Card closed: mem-uuid-1');
  });

  it('closes all cards when no memoryId provided', async () => {
    const res = await handleCardClose({});
    expect(res.content[0].text).toBe('All cards closed.');
  });

  it('forwards NI error on close failure', async () => {
    setNiError('Close operation failed');
    const res = await handleCardClose({ memoryId: 'mem-uuid-1' });
    expect(res.content[0].text).toBe('Failed to close card: Close operation failed');
  });
});

describe('card_update', () => {
  it('returns error when no update fields provided', async () => {
    const res = await handleCardUpdate({ memoryId: 'mem-uuid-1' });
    expect(res.content[0].text).toContain('No update fields provided');
  });

  it('updates position and includes it in response', async () => {
    vi.mocked(ni.updateCard).mockResolvedValueOnce({
      result: { memoryId: 'mem-uuid-1', left: 500, top: 300 },
    });

    const res = await handleCardUpdate({ memoryId: 'mem-uuid-1', left: 500, top: 300 });
    const text = res.content[0].text;
    expect(text).toContain('Card updated: mem-uuid-1');
    expect(text).toContain('pos:');
    expect(text).toContain('500');
  });

  it('shows compact state when compact toggle applied', async () => {
    vi.mocked(ni.updateCard).mockResolvedValueOnce({
      result: { memoryId: 'mem-uuid-1', isCompact: true },
    });

    const res = await handleCardUpdate({ memoryId: 'mem-uuid-1', compact: true });
    expect(res.content[0].text).toContain('compact');
  });

  it('shows expanded state when compact is false', async () => {
    vi.mocked(ni.updateCard).mockResolvedValueOnce({
      result: { memoryId: 'mem-uuid-1', isCompact: false },
    });

    const res = await handleCardUpdate({ memoryId: 'mem-uuid-1', compact: false });
    expect(res.content[0].text).toContain('expanded');
  });

  it('forwards NI error on update failure', async () => {
    setNiError('Card not found');
    const res = await handleCardUpdate({ memoryId: 'bad-uuid', left: 100 });
    expect(res.content[0].text).toBe('Failed to update card: Card not found');
  });
});

describe('card_screenshot', () => {
  it('returns image content block on success', async () => {
    const res = await handleCardScreenshot();
    expect(res.content).toHaveLength(1);
    expect(res.content[0].type).toBe('image');
    expect((res.content[0] as { data: string }).data).toBe('base64cardsscreenshot');
  });

  it('returns text error on NI failure', async () => {
    setNiError('No Neural Interface available');
    const res = await handleCardScreenshot();
    expect(res.content).toHaveLength(1);
    expect(res.content[0].type).toBe('text');
    expect(res.content[0].text).toBe('Screenshot failed: No Neural Interface available');
  });
});
