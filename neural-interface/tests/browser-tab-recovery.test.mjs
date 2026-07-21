import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BrowserPageFailureDisposition,
  BrowserOperationTimeoutError,
  classifyBrowserPageError,
  isIgnorablePlaywrightLifecycleError,
  isRecoverableBrowserPageError,
  withBrowserOperationDeadline,
} from '../lib/browser-tab-recovery.js';

test('browser operation deadline rejects before the MCP transport can wedge', async () => {
  await assert.rejects(
    withBrowserOperationDeadline(new Promise(() => {}), 5, 'browser_evaluate'),
    (error) => error instanceof BrowserOperationTimeoutError
      && error.code === 'SYNABUN_BROWSER_OPERATION_TIMEOUT'
      && error.operation === 'browser_evaluate'
      && /browser_evaluate did not respond within 5ms/.test(error.message),
  );
});

test('browser operation deadline preserves successful values', async () => {
  assert.equal(await withBrowserOperationDeadline(Promise.resolve(2), 50, 'probe'), 2);
});

test('deadline cleans up resources that resolve after the caller timed out', async () => {
  let resolveResource;
  const pending = new Promise((resolve) => { resolveResource = resolve; });
  const cleaned = [];
  await assert.rejects(
    withBrowserOperationDeadline(pending, 5, 'late resource', {
      onLateResolve: (resource) => cleaned.push(resource),
    }),
    BrowserOperationTimeoutError,
  );
  resolveResource('orphan');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(cleaned, ['orphan']);
});

test('page failures distinguish liveness probes from immediate replacement', () => {
  for (const message of [
    'page.goto: Timeout 15000ms exceeded',
    'page.reload: net::ERR_ABORTED; maybe frame was detached?',
    'Execution context was destroyed, most likely because of a navigation',
  ]) {
    assert.equal(
      classifyBrowserPageError(new Error(message)),
      BrowserPageFailureDisposition.PROBE,
      message,
    );
  }
  assert.equal(
    classifyBrowserPageError(new Error('Target page, context or browser has been closed')),
    BrowserPageFailureDisposition.REPLACE,
  );
  assert.equal(isRecoverableBrowserPageError(new Error('page.goto: Timeout 15000ms exceeded')), true);
});

test('ordinary navigation and policy failures do not replace a healthy page', () => {
  for (const message of [
    'net::ERR_ABORTED',
    'net::ERR_BLOCKED_BY_CLIENT',
    'net::ERR_FAILED',
    'Invalid URL',
  ]) {
    assert.equal(
      classifyBrowserPageError(new Error(message)),
      BrowserPageFailureDisposition.NONE,
      message,
    );
  }
});

test('only verified stale Playwright lifecycle failures are ignorable', () => {
  assert.equal(isIgnorablePlaywrightLifecycleError({
    method: 'Page.handleJavaScriptDialog',
    message: 'Protocol error (Page.handleJavaScriptDialog): Not attached to an active page',
  }), true);
  assert.equal(isIgnorablePlaywrightLifecycleError(
    new Error('Protocol error (Page.handleJavaScriptDialog): No dialog is showing'),
  ), true);
  assert.equal(isIgnorablePlaywrightLifecycleError(new Error('Frame has been detached')), true);
  assert.equal(isIgnorablePlaywrightLifecycleError({
    method: 'Runtime.evaluate',
    message: 'Not attached to an active page',
  }), false);
  assert.equal(isIgnorablePlaywrightLifecycleError(new Error('Unexpected application error')), false);
});
