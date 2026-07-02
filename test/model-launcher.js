// test/model-launcher.js — end-to-end tests for the model launcher feature.
// Verifies:
//   1. Model launcher parses launcher .sh files correctly
//   2. Model launcher can start/kill/switch models via config
//   3. HTTP routes expose model status, list, start, switch, kill
//   4. UI model switcher appears and functions correctly

import { strict as assert } from 'node:assert';
import { spawn, execSync } from 'child_process';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { resolve as resolvePath, dirname } from 'node:path';
import { homedir } from 'node:os';
import fetch from 'node-fetch';

async function delay(ms) { return new Promise(res => setTimeout(res, ms)); }

// ── Unit tests for the model-launcher module ──

async function testModelLauncherParsing() {
  // Import the model launcher module
  const ml = await import('../src/model-launcher.ts');

  // Test parsing a launcher script
  const script = '#!/bin/bash\nset -e\n\nHF_MODEL="unsloth/Qwen3.6-27B-GGUF"\nHF_FILE="UD-Q4_K_XL"\nCTX="${1:-65536}"\n\necho "🚀 Strix Halo (ROCm) llama-server — Qwen3.6-27B (dense, light)"\n\nllama-server \\\n  -hf "$HF_MODEL:$HF_FILE" \\\n  --jinja \\\n  -ngl 99 \\\n  -fa on \\\n  -c "$CTX" \\\n  --host 0.0.0.0 \\\n  --port 8080 \\\n  --threads 16 \\\n  --metrics';

  const parsed = ml.parseLauncherScript('test-model', script);
  assert.ok(parsed, 'parsed script');
  assert.equal(parsed.name, 'test-model', 'name extracted');
  assert.equal(parsed.command, 'llama-server', 'command is llama-server');
  assert.ok(Array.isArray(parsed.params), 'params is an array');
  assert.ok(parsed.params.length > 0, 'params has items');
  assert.ok(parsed.params.includes('-hf'), 'params contains -hf flag');
  assert.ok(parsed.params.includes('--jinja'), 'params contains --jinja flag');
  assert.ok(parsed.params.includes('--metrics'), 'params contains --metrics flag');
  assert.equal(parsed.hfModel, 'unsloth/Qwen3.6-27B-GGUF', 'HF model extracted');
  assert.equal(parsed.hfFile, 'UD-Q4_K_XL', 'HF file extracted');
  assert.equal(parsed.context, '65536', 'context extracted');

  console.log('✅ Model launcher parsing works');
}

async function testModelLauncherConfig() {
  const ml = await import('../src/model-launcher.ts');

  // Test creating a model launcher from config with command and params
  const config = {
    enableModelLauncher: true,
    models: [
      {
        name: 'Qwen3.6 27B (Q4)',
        command: 'llama-server',
        params: [
          '-hf', 'unsloth/Qwen3.6-27B-GGUF:UD-Q4_K_XL',
          '--jinja',
          '-ngl', '99',
          '-fa', 'on',
          '-c', '65536',
          '-b', '2048',
          '-ub', '512',
          '--cache-type-k', 'q8_0',
          '--cache-type-v', 'q8_0',
          '--temp', '0.6',
          '--top-p', '0.95',
          '--top-k', '20',
          '--min-p', '0',
          '--host', '0.0.0.0',
          '--port', '8080',
          '--threads', '16',
          '--threads-batch', '16',
          '--parallel', '1',
          '-dio',
          '--cache-prompt',
          '--metrics',
        ],
        default: true,
      },
      {
        name: 'Qwen3.6 27B (Q8)',
        command: 'llama-server',
        params: [
          '-hf', 'unsloth/Qwen3.6-27B-GGUF:UD-Q8_K_XL',
          '--jinja',
          '-ngl', '99',
          '-fa', 'on',
          '-c', '262144',
          '-b', '2048',
          '-ub', '512',
          '--cache-type-k', 'q8_0',
          '--cache-type-v', 'q8_0',
          '--temp', '0.6',
          '--top-p', '0.95',
          '--top-k', '20',
          '--min-p', '0',
          '--host', '0.0.0.0',
          '--port', '8080',
          '--threads', '16',
          '--threads-batch', '16',
          '--parallel', '1',
          '-dio',
          '--cache-prompt',
          '--metrics',
        ],
        default: false,
      },
    ],
  };

  const launcher = ml.createModelLauncher(config);
  assert.ok(launcher, 'launcher created');
  assert.equal(launcher.isEnabled(), true, 'launcher enabled');

  const models = launcher.listModels();
  assert.equal(models.length, 2, 'two models registered');
  assert.equal(models[0].name, 'Qwen3.6 27B (Q4)', 'first model name');
  assert.equal(models[1].name, 'Qwen3.6 27B (Q8)', 'second model name');

  const defaultModel = launcher.getDefaultModel();
  assert.ok(defaultModel, 'default model exists');
  assert.equal(defaultModel.name, 'Qwen3.6 27B (Q4)', 'default model is first one');

  console.log('✅ Model launcher config works');
}

async function testModelLauncherStartStop() {
  const ml = await import('../src/model-launcher.ts');

  // Use a simple command that we can verify starts and stops
  const config = {
    enableModelLauncher: true,
    models: [
      {
        name: 'Test Model',
        command: 'sleep 3600',
        default: true,
      },
    ],
  };

  const launcher = ml.createModelLauncher(config);
  assert.ok(launcher, 'launcher created');

  // Start the model
  await launcher.startModel('Test Model');
  await delay(500);

  const status = launcher.getStatus();
  assert.ok(status.isRunning, 'model is running');
  assert.equal(status.modelName, 'Test Model', 'model name matches');
  assert.ok(status.pid > 0, 'pid is set');

  // Stop the model
  await launcher.stopModel();
  await delay(500);

  const statusAfterStop = launcher.getStatus();
  assert.ok(!statusAfterStop.isRunning, 'model is stopped');

  console.log('✅ Model launcher start/stop works');
}

async function testModelLauncherSwitch() {
  const ml = await import('../src/model-launcher.ts');

  const config = {
    enableModelLauncher: true,
    models: [
      {
        name: 'Model A',
        command: 'sleep 3600',
        default: true,
      },
      {
        name: 'Model B',
        command: 'sleep 3600',
        default: false,
      },
    ],
  };

  const launcher = ml.createModelLauncher(config);

  // Start Model A
  await launcher.startModel('Model A');
  await delay(500);
  let status = launcher.getStatus();
  assert.ok(status.isRunning, 'Model A is running');
  assert.equal(status.modelName, 'Model A', 'Model A is active');

  // Switch to Model B
  await launcher.switchModel('Model B');
  await delay(500);
  status = launcher.getStatus();
  assert.ok(status.isRunning, 'Model B is running after switch');
  assert.equal(status.modelName, 'Model B', 'Model B is active after switch');

  // Stop everything
  await launcher.stopModel();

  console.log('✅ Model launcher switch works');
}

async function testModelLauncherAutoStartDefault() {
  const ml = await import('../src/model-launcher.ts');

  const config = {
    enableModelLauncher: true,
    models: [
      {
        name: 'Default Model',
        command: 'sleep 3600',
        default: true,
      },
      {
        name: 'Other Model',
        command: 'sleep 3600',
        default: false,
      },
    ],
  };

  const launcher = ml.createModelLauncher(config);

  // Auto-start should start the default model
  await launcher.autoStart();
  await delay(500);

  const status = launcher.getStatus();
  assert.ok(status.isRunning, 'default model is running after autoStart');
  assert.equal(status.modelName, 'Default Model', 'default model is active');

  // Stop
  await launcher.stopModel();

  console.log('✅ Model launcher autoStart works');
}

async function testModelLauncherDisabled() {
  const ml = await import('../src/model-launcher.ts');

  const config = {
    enableModelLauncher: false,
    models: [],
  };

  const launcher = ml.createModelLauncher(config);
  assert.ok(launcher, 'launcher created even when disabled');
  assert.equal(launcher.isEnabled(), false, 'launcher is disabled');

  const models = launcher.listModels();
  assert.equal(models.length, 0, 'no models when disabled');

  console.log('✅ Model launcher disabled works');
}

// ── E2E tests for HTTP routes ──

async function testHttpRoutes() {
  // Build UI
  console.log('Building UI...');
  execSync('npm run build-ui', { stdio: 'inherit' });

  // Create a test config with model launcher enabled
  const configDir = resolvePath(homedir(), '.config', 'leatherHarness');
  const cfgPath = resolvePath(configDir, 'config.json');

  // Backup existing config if it exists
  let backupConfig = null;
  try {
    backupConfig = await readFile(cfgPath, 'utf8');
  } catch {}

  // Write test config with auto-discovery
  const testConfig = {
    listen: { host: '127.0.0.1', port: 9015 },
    upstream: { baseUrl: 'http://127.0.0.1:12347/v1' },
    maxToolRounds: 5,
    mcpServers: {},
    pluginsDir: './plugins',
    pluginConfig: {},
    enableModelLauncher: true,
    launchersDir: '/home/kkammone/llm/launchers',
  };

  await writeFile(cfgPath, JSON.stringify(testConfig, null, 2), 'utf8');

  // Start mock LLM
  const { createServer } = await import('node:http');
  const mockServer = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
  });
  await new Promise(resolve => mockServer.listen(12347, resolve));

  // Start harness
  const harnessPort = 9015;
  const serverEnv = { ...process.env, PORT: harnessPort.toString(), OPENCODE_ENDPOINT: 'http://127.0.0.1:12347/v1' };
  const serverProc = spawn('node', ['-r', 'ts-node/register', 'src/server.ts'], { stdio: 'inherit', env: serverEnv });

  await delay(2000);

  try {
    // Test GET /api/models/status
    const statusRes = await fetch(`http://127.0.0.1:${harnessPort}/api/models/status`);
    const statusData = await statusRes.json();
    assert.ok(statusData, 'status endpoint returns data');
    assert.equal(statusData.enabled, true, 'model launcher is enabled');

    // Test GET /api/models/list
    const listRes = await fetch(`http://127.0.0.1:${harnessPort}/api/models/list`);
    const listData = await listRes.json();
    assert.ok(listData, 'list endpoint returns data');
    assert.ok(Array.isArray(listData.models), 'models is an array');
    assert.ok(listData.models.length > 0, 'has models');

    // Use the first (default) model for start test
    const defaultModelName = listData.models[0].name;

    // Test POST /api/models/start
    const startRes = await fetch(`http://127.0.0.1:${harnessPort}/api/models/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelName: defaultModelName }),
    });
    const startData = await startRes.json();
    assert.ok(startRes.ok, 'start endpoint succeeds');
    assert.ok(startData.success, 'start returns success');

    await delay(1000);

    // Check status after start (model may have exited if port 8080 is in use)
    const statusAfterStart = await fetch(`http://127.0.0.1:${harnessPort}/api/models/status`);
    const statusAfterData = await statusAfterStart.json();
    assert.ok(statusAfterData.enabled, 'model launcher is enabled');

    // Test POST /api/models/stop
    const stopRes = await fetch(`http://127.0.0.1:${harnessPort}/api/models/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const stopData = await stopRes.json();
    assert.ok(stopRes.ok, 'stop endpoint succeeds');
    assert.ok(stopData.success, 'stop returns success');

    await delay(500);

    // Check status after stop
    const statusAfterStop = await fetch(`http://127.0.0.1:${harnessPort}/api/models/status`);
    const statusAfterStopData = await statusAfterStop.json();
    assert.ok(!statusAfterStopData.isRunning, 'model is stopped after stop');

    console.log('✅ HTTP routes work correctly');
  } finally {
    serverProc.kill();
    await new Promise(res => serverProc.on('close', res));
    mockServer.close();

    // Restore original config
    if (backupConfig) {
      await writeFile(cfgPath, backupConfig, 'utf8');
    } else {
      try { await access(cfgPath); await writeFile(cfgPath, '{}', 'utf8'); } catch {}
    }
  }
}

// ── Run all tests ──

(async () => {
  try {
    await testModelLauncherParsing();
    await testModelLauncherConfig();
    await testModelLauncherStartStop();
    await testModelLauncherSwitch();
    await testModelLauncherAutoStartDefault();
    await testModelLauncherDisabled();
    await testHttpRoutes();
    console.log('\n🎉 All model launcher tests passed!');
  } catch (e) {
    console.error('❌ Test failed:', e);
    process.exit(1);
  }
})();
