import { spawn, execSync } from 'child_process';
import { readFile } from 'node:fs/promises';
import fetch from 'node-fetch';
import assert from 'assert';

async function delay(ms) { return new Promise(res => setTimeout(res, ms)); }

(async () => {
  // Ensure UI is built
  console.log('Building UI...');
  execSync('npm run build-ui', { stdio: 'inherit' });

  // Start server
  const server = spawn('node', ['-r', 'ts-node/register', 'src/server.ts'], { stdio: 'inherit' });
  // Wait a bit for server to start
  await delay(2000);

  try {
    const res = await fetch('http://127.0.0.1:9001/');
    const html = await res.text();
    assert.ok(html.includes('<div id="root"></div>'), 'Root div missing');
    console.log('✅ UI served correctly');
  } catch (e) {
    console.error('❌ Test failed', e);
    process.exit(1);
  } finally {
    server.kill();
  }
})();
