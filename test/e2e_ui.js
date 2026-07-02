// test/e2e_ui.js — end-to-end test for the plugin UI-icon extension point.
// Verifies plugins can register clickable icons whose server-side functions run
// and return an action for the UI. Driven in-code (no server), per house rules.

import { strict as assert } from 'node:assert';
import { registerUiIcon, uiIconList, runUiIcon } from '../src/ui-registry.ts';

async function run() {
  // ── a plugin registers an icon with a function ──
  let clicked = 0;
  registerUiIcon({
    id: 'test-icon',
    title: 'Test',
    icon: '🧪',
    run: () => { clicked++; return { open: '/test/page' }; },
  });

  const list = uiIconList();
  const entry = list.find((i) => i.id === 'test-icon');
  assert.ok(entry, 'icon shows up in the list');
  assert.equal(entry.icon, '🧪', 'icon glyph exposed');
  assert.equal(entry.title, 'Test', 'icon title exposed');
  assert.equal(entry.run, undefined, 'list metadata never leaks the function');

  // ── clicking runs the server-side function ──
  const result = await runUiIcon('test-icon');
  assert.equal(clicked, 1, 'run() invoked exactly once');
  assert.deepEqual(result, { open: '/test/page' }, 'action result returned to the UI');

  // ── async functions and message actions work ──
  registerUiIcon({
    id: 'async-icon',
    title: 'Async',
    icon: '⏳',
    run: async () => ({ message: 'done' }),
  });
  assert.deepEqual(await runUiIcon('async-icon'), { message: 'done' }, 'async run resolved');

  // ── guards ──
  assert.throws(() => registerUiIcon({ id: 'test-icon', title: 'dup', icon: 'x', run: () => ({}) }),
    /already registered/, 'duplicate id rejected');
  assert.throws(() => registerUiIcon({ id: 'bad', title: 'x', icon: 'x', run: 'nope' }),
    /must be a function/, 'non-function run rejected');
  await assert.rejects(runUiIcon('does-not-exist'), /No such UI icon/, 'unknown id rejected');

  // ── the music plugin contributes an icon when it loads ──
  const { setup } = await import('../plugins/music/index.ts');
  setup({ get: async () => ({ allowedDirs: ['/tmp'] }), set: async () => {} });
  const musicIcon = uiIconList().find((i) => i.id === 'music');
  assert.ok(musicIcon, 'music plugin registered a UI icon');
  assert.equal(musicIcon.icon, '🎵', 'music icon glyph');
  assert.deepEqual(await runUiIcon('music'), { open: '/music/player' }, 'music icon opens the player');

  console.log('All UI icon tests passed');
}

run().catch((e) => { console.error(e); process.exit(1); });
