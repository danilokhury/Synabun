#!/usr/bin/env node
// Rebuild the tested contract without installing packages or touching CODEX_HOME.
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function contractShape(value) {
  if (Array.isArray(value)) return value.map(contractShape);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key, child]) => !(['description', 'title', '$schema'].includes(key) && typeof child === 'string'))
    .map(([key, child]) => [key, contractShape(child)]));
}

const read = (dir, name) => JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8'));
const variants = schema => Object.fromEntries(schema.oneOf.map(entry => [entry.properties.method.enum[0], entry]));

export function buildCodexProtocolFixture(dir, stableDir, cliVersion) {
  const fixture = { cliVersion, source: 'codex app-server generate-json-schema --experimental', methods: {}, configEnums: {}, notifications: {}, requests: {}, dataShapes: {}, definitions: {} };
  for (const [file, surface] of [['ClientRequest', 'methods'], ['ServerNotification', 'notifications'], ['ServerRequest', 'requests']]) {
    const schema = read(dir, file);
    const stable = variants(read(stableDir, file));
    Object.assign(fixture.definitions, contractShape(schema.definitions));
    for (const [method, entry] of Object.entries(variants(schema))) {
      const params = entry.properties.params || { type: 'object' };
      const name = params.$ref?.split('/').at(-1);
      fixture[surface][method] = { experimental: !stable[method], params: contractShape(name ? schema.definitions[name] : params) };
    }
  }
  // Responses include fields not referenced from notifications (e.g. model metadata).
  for (const subdir of ['', 'v1', 'v2']) {
    for (const name of readdirSync(join(dir, subdir)).filter(name => name.endsWith('Response.json')).sort()) {
      const schema = read(dir, join(subdir, name.slice(0, -5)));
      Object.assign(fixture.definitions, contractShape(schema.definitions || {}));
      const title = schema.title || name.slice(0, -5);
      fixture.definitions[title] = contractShape(Object.fromEntries(Object.entries(schema).filter(([key]) => key !== 'definitions')));
      fixture.dataShapes[title] = { $ref: `#/definitions/${title}` };
    }
  }
  for (const [name, schema] of Object.entries(fixture.definitions)) {
    if (schema.enum) fixture.configEnums[name] = schema;
    fixture.dataShapes[name] = { $ref: `#/definitions/${name}` };
  }
  return fixture;
}

// Structural changes include nested definitions, so an unchanged $ref cannot hide
// changed enums/fields. Descriptions are preserved in the CLI output, not the fixture.
export function diffCodexProtocolFixtures(before, after) {
  const changes = [];
  for (const [surface, key] of [['client_method', 'methods'], ['server_notification', 'notifications'], ['server_request', 'requests'], ['data_shape', 'definitions']]) {
    for (const name of [...new Set([...Object.keys(before[key]), ...Object.keys(after[key])])].sort()) {
      const oldValue = before[key][name], newValue = after[key][name];
      if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue;
      changes.push({ surface, name, change: !oldValue ? 'added' : !newValue ? 'removed' : 'changed', before: oldValue ?? null, after: newValue ?? null });
    }
  }
  return changes;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const option = name => { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1]; };
  const cli = option('--cli') || 'codex';
  const cliVersion = option('--version') || execFileSync(cli, ['--version'], { encoding: 'utf8' }).match(/\d+\.\d+\.\d+/)?.[0];
  if (!cliVersion) throw new Error('Could not determine CLI version.');
  const temporary = mkdtempSync(join(tmpdir(), 'synabun-codex-protocol-'));
  try {
    const dir = option('--schema-dir') || join(temporary, 'experimental');
    const stableDir = option('--stable-schema-dir') || join(temporary, 'stable');
    if (!option('--schema-dir')) execFileSync(cli, ['app-server', 'generate-json-schema', '--experimental', '--out', dir]);
    if (!option('--stable-schema-dir')) execFileSync(cli, ['app-server', 'generate-json-schema', '--out', stableDir]);
    const fixture = buildCodexProtocolFixture(dir, stableDir, cliVersion);
    const out = option('--out') || resolve(`neural-interface/tests/fixtures/codex-app-server-${cliVersion}.json`);
    writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n');
    if (option('--compare')) {
      const before = JSON.parse(readFileSync(option('--compare'), 'utf8'));
      writeFileSync(option('--diff-out') || `${out}.diff.json`, JSON.stringify(diffCodexProtocolFixtures(before, fixture), null, 2) + '\n');
    }
    console.log(`Wrote ${out}: ${Object.keys(fixture.methods).length} methods, ${Object.keys(fixture.notifications).length} notifications, ${Object.keys(fixture.requests).length} requests.`);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
