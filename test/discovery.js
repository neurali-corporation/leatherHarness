// test/discovery.js — end-to-end test for config templating + the discovery
// surface. Verifies that on startup the harness writes/back-fills every
// application and plugin config field, and that getDiscovery() reports the full
// configurable surface. Driven in-code against a throwaway config dir (no
// server), per house rules.

import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadPlugins,
  getDiscovery,
  fillDefaults,
  BASE_CONFIG,
} from '../src/plugin-loader.ts';

// ── fillDefaults: the back-fill primitive ──────────────────────────────────
function testFillDefaults() {
  // Missing keys are filled from the template and flagged as a change.
  {
    const { value, changed } = fillDefaults({ a: 1 }, { a: 0, b: 'x' });
    assert.deepEqual(value, { a: 1, b: 'x' }, 'existing wins, missing filled');
    assert.equal(changed, true, 'adding a field is a change');
  }

  // A complete object is left untouched and reports no change (no rewrite).
  {
    const { value, changed } = fillDefaults({ a: 1, b: 'y' }, { a: 0, b: 'x' });
    assert.deepEqual(value, { a: 1, b: 'y' }, 'nothing overwritten');
    assert.equal(changed, false, 'complete config is unchanged');
  }

  // Nested plain objects recurse; arrays and scalars are atomic (never merged).
  {
    const existing = { listen: { host: '0.0.0.0' }, models: [{ name: 'mine' }] };
    const template = { listen: { host: '127.0.0.1', port: 8080 }, models: [{ name: 'default' }] };
    const { value, changed } = fillDefaults(existing, template);
    assert.equal(value.listen.host, '0.0.0.0', 'nested existing value preserved');
    assert.equal(value.listen.port, 8080, 'nested missing value filled');
    assert.deepEqual(value.models, [{ name: 'mine' }], 'user array kept atomically');
    assert.equal(changed, true, 'nested fill is a change');
  }

  // A missing slot is synthesised entirely from the template.
  {
    const { value, changed } = fillDefaults(undefined, { a: { b: '' } });
    assert.deepEqual(value, { a: { b: '' } }, 'undefined synthesised from template');
    assert.equal(changed, true, 'synthesising is a change');
  }
}

// ── startup templating against a throwaway config dir ──────────────────────
async function testStartupTemplating() {
  const dir = await mkdtemp(join(tmpdir(), 'lh-discovery-'));
  const cfgPath = join(dir, 'config.json');

  try {
    // No config at all → a full template is written from scratch.
    await loadPlugins('./plugins', cfgPath);

    const written = JSON.parse(await readFile(cfgPath, 'utf8'));
    for (const key of Object.keys(BASE_CONFIG)) {
      assert.ok(key in written, `fresh config.json contains application field "${key}"`);
    }
    // The fields that used to be read-but-untemplated are now present.
    assert.equal(written.maxMessages, 50, 'maxMessages templated');
    assert.equal(written.secret, '', 'secret templated as empty string');
    assert.equal(written.launchersDir, '', 'launchersDir templated as empty string');
    // Env-var placeholders are preserved verbatim, not resolved.
    assert.ok(
      String(written.upstream.baseUrl).includes('${OPENCODE_ENDPOINT'),
      'env placeholder left untouched',
    );

    // Plugins with settings get their own config file templated from defaultConfig,
    // under the app-assigned `plugins/<name>/` directory.
    const searchCfg = JSON.parse(await readFile(join(dir, 'plugins', 'search', 'config.json'), 'utf8'));
    assert.deepEqual(
      Object.keys(searchCfg).sort(),
      ['exa', 'jina', 'tavily'],
      'search plugin config templated with all provider keys',
    );

    // Discovery reports the application template and every plugin.
    const discovery = getDiscovery();
    assert.ok(discovery.application, 'application discovery present');
    assert.equal(discovery.application.configPath, cfgPath, 'application config path reported');
    assert.ok('secret' in discovery.application.defaults, 'application defaults expose all fields');

    const names = discovery.plugins.map((p) => p.name);
    for (const expected of ['search', 'hue', 'memo', 'clock']) {
      assert.ok(names.includes(expected), `discovery lists plugin "${expected}"`);
    }
    const search = discovery.plugins.find((p) => p.name === 'search');
    assert.ok(search.defaults.tavily, 'plugin discovery exposes its config schema');
    assert.equal(search.loaded, true, 'successfully set-up plugin marked loaded');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── the core bug fix: existing config gains newly added fields ─────────────
async function testBackfillExistingConfig() {
  const dir = await mkdtemp(join(tmpdir(), 'lh-backfill-'));
  const cfgPath = join(dir, 'config.json');

  try {
    // Simulate an older config written before maxMessages/secret existed, with a
    // user-customised value we must not clobber.
    const legacy = {
      listen: { host: '0.0.0.0', port: 9999 },
      upstream: { baseUrl: 'http://example/v1' },
      maxToolRounds: 7,
    };
    await writeFile(cfgPath, JSON.stringify(legacy, null, 2), 'utf8');

    await loadPlugins('./plugins', cfgPath);

    const merged = JSON.parse(await readFile(cfgPath, 'utf8'));
    // User values preserved.
    assert.equal(merged.listen.host, '0.0.0.0', 'user host preserved');
    assert.equal(merged.listen.port, 9999, 'user port preserved');
    assert.equal(merged.maxToolRounds, 7, 'user maxToolRounds preserved');
    assert.equal(merged.upstream.baseUrl, 'http://example/v1', 'user baseUrl preserved');
    // Newly added fields back-filled.
    assert.equal(merged.maxMessages, 50, 'missing maxMessages back-filled');
    assert.equal(merged.secret, '', 'missing secret back-filled');
    assert.ok(Array.isArray(merged.models), 'missing models back-filled');
    assert.equal(merged.enableModelLauncher, true, 'missing enableModelLauncher back-filled');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── an already-complete config is not needlessly rewritten ─────────────────
async function testNoRewriteWhenComplete() {
  const dir = await mkdtemp(join(tmpdir(), 'lh-norewrite-'));
  const cfgPath = join(dir, 'config.json');

  try {
    await loadPlugins('./plugins', cfgPath);              // writes full template
    const before = await readFile(cfgPath, 'utf8');
    await loadPlugins('./plugins', cfgPath);              // complete → should not rewrite
    const after = await readFile(cfgPath, 'utf8');
    assert.equal(after, before, 'complete config left byte-for-byte unchanged');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

(async () => {
  testFillDefaults();
  await testStartupTemplating();
  await testBackfillExistingConfig();
  await testNoRewriteWhenComplete();
  console.log('All discovery/config-templating tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
