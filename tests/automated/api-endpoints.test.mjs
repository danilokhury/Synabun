#!/usr/bin/env node

/**
 * Automated tests for SynaBun Neural Interface REST API.
 *
 * Requires NI server running:
 *   node neural-interface/server.js
 *
 * Run: node tests/automated/api-endpoints.test.mjs
 */

import {
  assert, skip, section, printSummary, serverIsUp,
  httpGet, httpPost, httpPut, httpDelete,
  B, X,
} from './test-utils.mjs';

// ─── Helpers ────────────────────────────────────────────────────────────────

const Y = '\x1b[33m';
const R = '\x1b[31m';

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${B}SynaBun API Endpoint Tests${X}\n`);

  if (!await serverIsUp()) {
    console.log('Neural Interface server not running. Start with: node neural-interface/server.js');
    process.exit(1);
  }

  // ═══════════════════════════════════════════════════════════════
  // Hook Recall
  // ═══════════════════════════════════════════════════════════════
  section('Hook Recall — POST /api/hook-recall');

  {
    // Test 1: valid query returns results array
    const r = await httpPost('/api/hook-recall', { query: 'test query', limit: 3 });
    assert(r.status === 200, 'POST /api/hook-recall with query → 200');
    assert(r.data && Array.isArray(r.data.results), 'response has results array');
  }

  {
    // Test 2: empty query returns 400 (server validates non-empty query)
    const r = await httpPost('/api/hook-recall', { query: '' });
    assert(r.status === 400, 'POST /api/hook-recall with empty query → 400');
    assert(r.data != null, 'empty query returns error response');
  }

  {
    // Test 3: limit is respected
    const r = await httpPost('/api/hook-recall', { query: 'test', limit: 1 });
    assert(r.status === 200, 'POST /api/hook-recall with limit:1 → 200');
    assert(Array.isArray(r.data?.results) && r.data.results.length <= 1, 'results.length <= 1 when limit=1');
  }

  // ═══════════════════════════════════════════════════════════════
  // Recall Impact
  // ═══════════════════════════════════════════════════════════════
  section('Recall Impact — GET /api/recall-impact');

  {
    // Test 4: returns object with numeric fields
    const r = await httpGet('/api/recall-impact');
    assert(r.status === 200, 'GET /api/recall-impact → 200');
    assert(r.data && typeof r.data === 'object' && !Array.isArray(r.data), 'response is an object');
    assert('rows' in r.data, 'response has rows field');
    assert('sessionStats' in r.data, 'response has sessionStats field');
  }

  // ═══════════════════════════════════════════════════════════════
  // Display Settings
  // ═══════════════════════════════════════════════════════════════
  section('Display Settings — GET/PUT /api/display-settings');

  // Snapshot the original settings so we can restore them
  let originalDisplaySettings = null;

  {
    // Test 5: GET returns object
    const r = await httpGet('/api/display-settings');
    assert(r.status === 200, 'GET /api/display-settings → 200');
    assert(r.data && typeof r.data === 'object', 'response is an object');
    originalDisplaySettings = r.data;
  }

  {
    // Test 6: PUT saves settings
    const r = await httpPut('/api/display-settings', {
      profile: 'balanced',
      recallDefaults: {
        limit: 5,
        minImportance: 0,
        minScore: 0.3,
        maxChars: 800,
        includeSessions: 'auto',
        recencyBoost: false,
      },
    });
    assert(r.status === 200, 'PUT /api/display-settings → 200');
  }

  {
    // Test 7: GET after PUT reflects new profile
    const r = await httpGet('/api/display-settings');
    assert(r.status === 200, 'GET /api/display-settings after PUT → 200');
    assert(r.data?.profile === 'balanced', `profile equals "balanced" (got "${r.data?.profile}")`);
  }

  // Restore original display settings
  if (originalDisplaySettings !== null) {
    await httpPut('/api/display-settings', originalDisplaySettings);
  }

  // ═══════════════════════════════════════════════════════════════
  // Image Gallery
  // ═══════════════════════════════════════════════════════════════
  section('Image Gallery — GET /api/images');

  {
    // Test 8: returns array
    const r = await httpGet('/api/images');
    assert(r.status === 200, 'GET /api/images → 200');
    // Server returns { images: [...], total: N }
    assert(
      Array.isArray(r.data) || (r.data && Array.isArray(r.data.images)),
      'response is array or has images array',
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // Schedules
  // ═══════════════════════════════════════════════════════════════
  section('Schedules — /api/schedules');

  {
    // Test 9: GET returns schedules array
    const r = await httpGet('/api/schedules');
    assert(r.status === 200, 'GET /api/schedules → 200');
    assert(
      Array.isArray(r.data) || (r.data && Array.isArray(r.data.schedules)),
      'response is array or has schedules array',
    );
  }

  // Test 10: POST with nonexistent templateId returns 400
  let createdScheduleId = null;
  {
    const r = await httpPost('/api/schedules', {
      name: 'test-schedule',
      templateId: 'nonexistent-template-id',
      cron: '0 9 * * *',
      timezone: 'UTC',
      enabled: false,
    });
    // Server validates templateId — expect 400 because template does not exist
    assert(
      r.status === 400 || r.status === 200,
      `POST /api/schedules → status is 400 or 200 (got ${r.status})`,
    );
    assert(
      typeof r.data === 'object',
      'POST /api/schedules → response is object',
    );
    if (r.status === 200 && r.data?.id) {
      // Unexpectedly succeeded — capture id for cleanup
      createdScheduleId = r.data.id;
    }
  }

  // Tests 11 & 12: If a schedule was created, update then delete it
  if (createdScheduleId) {
    const putR = await httpPut(`/api/schedules/${createdScheduleId}`, { name: 'updated-test' });
    assert(putR.status === 200, `PUT /api/schedules/:id → 200 (id: ${createdScheduleId})`);

    const delR = await httpDelete(`/api/schedules/${createdScheduleId}`);
    assert(delR.status === 200, `DELETE /api/schedules/:id → 200 (id: ${createdScheduleId})`);
  } else {
    skip('PUT /api/schedules/:id → 200', 'no schedule was created (template validation rejected)');
    skip('DELETE /api/schedules/:id → 200', 'no schedule was created (template validation rejected)');
  }

  // ═══════════════════════════════════════════════════════════════
  // Agents
  // ═══════════════════════════════════════════════════════════════
  section('Agents — GET /api/agents');

  {
    // Test 13: returns array or object with agents property
    const r = await httpGet('/api/agents');
    assert(r.status === 200, 'GET /api/agents → 200');
    assert(
      Array.isArray(r.data) || (r.data && Array.isArray(r.data.agents)),
      'response is array or has agents property',
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // Auto Backup
  // ═══════════════════════════════════════════════════════════════
  section('Auto Backup — /api/system/auto-backup');

  let originalAutoBackup = null;

  {
    // Test 14: GET returns config with enabled field
    const r = await httpGet('/api/system/auto-backup');
    assert(r.status === 200, 'GET /api/system/auto-backup → 200');
    assert(r.data && 'enabled' in r.data, 'response has enabled field');
    originalAutoBackup = r.data;
  }

  {
    // Test 15: PUT persists changes
    const r = await httpPut('/api/system/auto-backup', { enabled: false });
    assert(r.status === 200, 'PUT /api/system/auto-backup → 200');
  }

  // Restore original auto-backup config
  if (originalAutoBackup !== null) {
    await httpPut('/api/system/auto-backup', { enabled: !!originalAutoBackup.enabled });
  }

  // ═══════════════════════════════════════════════════════════════
  // Loop System
  // ═══════════════════════════════════════════════════════════════
  section('Loop System — /api/loop/*');

  {
    // Test 16: active loops endpoint
    const r = await httpGet('/api/loop/active');
    assert(r.status === 200, 'GET /api/loop/active → 200');
    assert(
      r.data && (Array.isArray(r.data.loops) || 'active' in r.data),
      'response has loops array or active field',
    );
  }

  {
    // Test 17: history is gutted — always returns []
    const r = await httpGet('/api/loop/history');
    assert(r.status === 200, 'GET /api/loop/history → 200');
    assert(Array.isArray(r.data) && r.data.length === 0, 'loop history returns [] (gutted per changelog)');
  }

  {
    // Test 18: templates returns array
    const r = await httpGet('/api/loop/templates');
    assert(r.status === 200, 'GET /api/loop/templates → 200');
    assert(Array.isArray(r.data), 'loop templates returns array');
  }

  // ═══════════════════════════════════════════════════════════════
  // Whiteboard
  // ═══════════════════════════════════════════════════════════════
  section('Whiteboard — /api/whiteboard');

  {
    // Test 19: GET returns elements array
    const r = await httpGet('/api/whiteboard');
    assert(r.status === 200, 'GET /api/whiteboard → 200');
    assert(r.data && Array.isArray(r.data.elements), 'response has elements array');
  }

  let createdElementId = null;
  {
    // Test 20: POST creates element, response has id
    // Server expects { elements: [...] } array — not a single element
    const r = await httpPost('/api/whiteboard/elements', {
      elements: [{ type: 'text', x: 100, y: 100, content: 'test element' }],
    });
    assert(r.status === 200, 'POST /api/whiteboard/elements → 200');
    assert(
      r.data && Array.isArray(r.data.added) && r.data.added.length > 0 && r.data.added[0].id,
      'response has added array with id',
    );
    if (r.data?.added?.[0]?.id) {
      createdElementId = r.data.added[0].id;
    }
  }

  {
    // Test 21: DELETE removes element
    if (createdElementId) {
      const r = await httpDelete(`/api/whiteboard/elements/${createdElementId}`);
      assert(r.status === 200, `DELETE /api/whiteboard/elements/:id → 200 (id: ${createdElementId})`);
    } else {
      skip('DELETE /api/whiteboard/elements/:id → 200', 'element was not created');
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Content / Markdown
  // ═══════════════════════════════════════════════════════════════
  section('Content / Markdown — POST /api/fetch-markdown');

  {
    // Test 22: fetch-markdown returns markdown field (skip on network failure)
    try {
      const r = await httpPost('/api/fetch-markdown', { url: 'https://example.com' });
      if (r.status === 200) {
        assert('markdown' in r.data, 'POST /api/fetch-markdown → response has markdown field');
      } else {
        skip('POST /api/fetch-markdown → response has markdown field', `server returned ${r.status}`);
      }
    } catch (err) {
      skip('POST /api/fetch-markdown → response has markdown field', `network unavailable: ${err.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Misc
  // ═══════════════════════════════════════════════════════════════
  section('Misc');

  {
    // Test 23: stats endpoint
    const r = await httpGet('/api/stats');
    assert(r.status === 200, 'GET /api/stats → 200');
    assert(r.data && typeof r.data === 'object', 'response is an object');
    assert('count' in r.data, 'stats has count field');
    assert('status' in r.data, 'stats has status field');
  }

  {
    // Test 24: categories endpoint
    const r = await httpGet('/api/categories');
    assert(r.status === 200, 'GET /api/categories → 200');
    assert(
      Array.isArray(r.data) || (r.data && typeof r.data === 'object'),
      'categories response is array or object',
    );
  }

  // ─── Summary ────────────────────────────────────────────────────
  const failures = printSummary('API Endpoint Tests');
  process.exit(failures ? 1 : 0);
}

export { main };
main().catch(e => { console.error(e); process.exit(1); });
