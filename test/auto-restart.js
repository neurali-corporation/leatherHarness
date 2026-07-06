// test/auto-restart.js — end-to-end tests for backend crash recovery.
// When the spawned model process dies unexpectedly (backend crash, OOM, a
// template abort that takes llama-server down), the launcher must respawn it so
// the harness isn't left without a model. An *intentional* stop must not.
//
// The fake "model" is a bare `node` process that idles forever; we pass a free
// --port (38271) purely so the launcher's freePort() never touches port 8080.

import { strict as assert } from 'node:assert';
import { createModelLauncher } from '../src/model-launcher.ts';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function makeLauncher() {
  return createModelLauncher({
    enableModelLauncher: true,
    models: [{
      name: 'Idler',
      command: 'node',
      params: ['-e', 'setInterval(function(){},1e9)', '--', '--port', '38271'],
      default: true,
    }],
  });
}

// ── A crash (process dies on its own) is auto-restarted ──
async function testAutoRestartOnCrash() {
  const launcher = makeLauncher();

  await launcher.startModel('Idler');
  await delay(300);
  const pid1 = launcher.getStatus().pid;
  assert.ok(pid1 > 0, 'model started');

  // Simulate a backend crash — kill the child out from under the launcher.
  process.kill(pid1, 'SIGKILL');

  // Restart backoff is 1000ms for the first attempt; give it room to respawn.
  await delay(1600);
  const status = launcher.getStatus();
  assert.ok(status.isRunning, 'crashed model was auto-restarted');
  assert.notEqual(status.pid, pid1, 'restart produced a new process');

  await launcher.stopModel();
  console.log('✅ Auto-restart on crash works');
}

// ── An intentional stop must NOT be auto-restarted ──
async function testIntentionalStopStaysDown() {
  const launcher = makeLauncher();

  await launcher.startModel('Idler');
  await delay(300);
  assert.ok(launcher.getStatus().isRunning, 'model started');

  await launcher.stopModel();
  // Wait well past the restart backoff — it must stay down.
  await delay(1600);
  assert.ok(!launcher.getStatus().isRunning, 'intentional stop stays stopped (no auto-restart)');

  console.log('✅ Intentional stop stays down');
}

(async () => {
  try {
    await testAutoRestartOnCrash();
    await testIntentionalStopStaysDown();
    console.log('All auto-restart tests passed');
  } catch (e) {
    console.error('❌ Test failed:', e);
    process.exit(1);
  }
})();
