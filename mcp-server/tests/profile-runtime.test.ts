import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ProfileRuntime } from '../src/services/profiles.js';

function fakeTool(enabled = true): RegisteredTool {
  return { enabled } as RegisteredTool;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ProfileRuntime', () => {
  it('keeps active state and registered tool references isolated per MCP server', () => {
    const first = new ProfileRuntime('full', { catalogMode: 'profiled' });
    const second = new ProfileRuntime('full', { catalogMode: 'profiled' });
    const firstBrowser = fakeTool();
    const secondBrowser = fakeTool();
    first.setToolGroup('browser', [firstBrowser]);
    second.setToolGroup('browser', [secondBrowser]);

    const result = first.applyProfile('core');

    expect(result.changed).toBe(true);
    expect(first.getActiveProfile().profile).toBe('core');
    expect(firstBrowser.enabled).toBe(false);
    expect(second.getActiveProfile().profile).toBe('full');
    expect(secondBrowser.enabled).toBe(true);
  });

  it('delays and coalesces profile notifications until after the switch caller returns', async () => {
    vi.useFakeTimers();
    const runtime = new ProfileRuntime('full', { catalogMode: 'profiled' });
    const notify = vi.fn();
    runtime.setOnProfileChanged(notify);

    runtime.scheduleProfileChangedNotification(150);
    runtime.scheduleProfileChangedNotification(150);

    expect(notify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(149);
    expect(notify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('treats an idempotent profile application as unchanged', () => {
    const runtime = new ProfileRuntime('core', { catalogMode: 'profiled' });
    const git = fakeTool();
    runtime.setToolGroup('git', [git]);

    const result = runtime.applyProfile('core');

    expect(result.changed).toBe(false);
    expect(result.enabled).toEqual([]);
    expect(result.disabled).toEqual([]);
    expect(git.enabled).toBe(true);
  });

  it('keeps the complete tool catalog advertised for deferred Codex runtimes', () => {
    const runtime = new ProfileRuntime('core', { catalogMode: 'deferred' });
    const git = fakeTool(false);
    const browser = fakeTool(false);
    const leonardo = fakeTool(false);
    runtime.setToolGroup('git', [git]);
    runtime.setToolGroup('browser', [browser]);
    runtime.setToolGroup('leonardo', [leonardo]);

    const initial = runtime.applyProfile('core');

    expect(initial.catalogMode).toBe('deferred');
    expect(initial.changed).toBe(false);
    expect(runtime.getActiveProfile()).toMatchObject({ profile: 'core' });
    expect(git.enabled).toBe(true);
    expect(browser.enabled).toBe(true);
    expect(leonardo.enabled).toBe(true);

    const switched = runtime.applyProfile('leonardoai');
    expect(switched.changed).toBe(true);
    expect(switched.enabled).toContain('leonardo');
    expect(switched.disabled).toContain('git');
    expect(git.enabled).toBe(true);
    expect(browser.enabled).toBe(true);
    expect(leonardo.enabled).toBe(true);
  });
});
