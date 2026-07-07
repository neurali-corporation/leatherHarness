import { readdir, readFile, writeFile, access, mkdir } from 'node:fs/promises';
import { resolve as resolvePath, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';

export interface PluginConfig<T extends object = Record<string, unknown>> {
  get(): Promise<T>;
  set(patch: Partial<T>): Promise<void>;
}

// Default llama-server launch commands written into a fresh config so the
// model launcher works out of the box. `command` is the executable and
// `params` its llama.cpp `llama-server` arguments — edit the -hf model/quant,
// context, and sampling params to taste, or add your own entries.
export const DEFAULT_MODELS = [
  {
    name: 'Devstral 2 (123B)',
    command: 'llama-server',
    params: [
      '-hf unsloth/Devstral-2-123B-Instruct-2512-GGUF:UD-Q4_K_XL',
      '--jinja',
      '-ngl 99',
      '-fa on',
      '-c 65536',
      '-b 2048',
      '-ub 512',
      '--cache-type-k q8_0',
      '--cache-type-v q8_0',
      '--temp 0.15',
      '--host 0.0.0.0',
      '--port 9001',
      '--threads 16',
      '--threads-batch 16',
      '--parallel 1',
      '-dio',
      '--cache-prompt',
      '--metrics',
    ],
    default: false,
  },
  {
    name: 'MiniMax M2.5',
    command: 'llama-server',
    params: [
      '-hf unsloth/MiniMax-M2.5-GGUF:UD-Q3_K_XL',
      '--jinja',
      '-ngl 99',
      '-fa on',
      '-c 32768',
      '-b 2048',
      '-ub 512',
      '--temp 1.0',
      '--top-p 0.95',
      '--top-k 40',
      '--min-p 0.01',
      '--host 0.0.0.0',
      '--port 9001',
      '--threads 16',
      '--threads-batch 16',
      '--parallel 1',
      '-dio',
      '--cache-prompt',
      '--metrics',
    ],
    default: false,
  },
  {
    name: 'Mistral Medium 3.5',
    command: 'llama-server',
    params: [
      '-hf unsloth/Mistral-Medium-3.5-128B-GGUF:UD-Q4_K_XL',
      '--jinja',
      '-ngl 99',
      '-fa on',
      '-c 65536',
      '-b 2048',
      '-ub 512',
      '--cache-type-k q8_0',
      '--cache-type-v q8_0',
      '--temp 0.7',
      '--chat-template-kwargs {"reasoning_effort":"high"}',
      '--host 0.0.0.0',
      '--port 9001',
      '--threads 16',
      '--threads-batch 16',
      '--parallel 1',
      '-dio',
      '--cache-prompt',
      '--metrics',
    ],
    default: false,
  },
  {
    name: 'Ornith 1.0 35B (agentic coding, light)',
    command: 'llama-server',
    params: [
      '-hf deepreinforce-ai/Ornith-1.0-35B-GGUF:Q4_K_M',
      '--jinja',
      '-ngl 99',
      '-fa on',
      '-c 65536',
      '-b 2048',
      '-ub 512',
      '--cache-type-k q8_0',
      '--cache-type-v q8_0',
      '--temp 0.6',
      '--top-p 0.95',
      '--top-k 20',
      '--min-p 0',
      '--host 0.0.0.0',
      '--port 9001',
      '--threads 16',
      '--threads-batch 16',
      '--parallel 1',
      '-dio',
      '--cache-prompt',
      '--metrics',
    ],
    default: false,
  },
  {
    name: 'Ornith 1.0 35B (agentic coding)',
    command: 'llama-server',
    params: [
      '-hf deepreinforce-ai/Ornith-1.0-35B-GGUF:Q8_0',
      '--jinja',
      '-ngl 99',
      '-fa on',
      '-c 262144',
      '-b 2048',
      '-ub 512',
      '--cache-type-k q8_0',
      '--cache-type-v q8_0',
      '--temp 0.6',
      '--top-p 0.95',
      '--top-k 20',
      '--min-p 0',
      '--host 0.0.0.0',
      '--port 9001',
      '--threads 16',
      '--threads-batch 16',
      '--parallel 1',
      '-dio',
      '--cache-prompt',
      '--metrics',
    ],
    default: false,
  },
  {
    name: 'Qwen3.6-27B (dense, light)',
    command: 'llama-server',
    params: [
      '-hf unsloth/Qwen3.6-27B-GGUF:UD-Q4_K_XL',
      '--jinja',
      '-ngl 99',
      '-fa on',
      '-c 65536',
      '-b 2048',
      '-ub 512',
      '--cache-type-k q8_0',
      '--cache-type-v q8_0',
      '--temp 0.6',
      '--top-p 0.95',
      '--top-k 20',
      '--min-p 0',
      '--host 0.0.0.0',
      '--port 9001',
      '--threads 16',
      '--threads-batch 16',
      '--parallel 1',
      '-dio',
      '--cache-prompt',
      '--metrics',
    ],
    default: true,
  },
  {
    name: 'Qwen3.6-27B (dense)',
    command: 'llama-server',
    params: [
      '-hf unsloth/Qwen3.6-27B-GGUF:UD-Q8_K_XL',
      '--jinja',
      '-ngl 99',
      '-fa on',
      '-c 262144',
      '-b 2048',
      '-ub 512',
      '--cache-type-k q8_0',
      '--cache-type-v q8_0',
      '--temp 0.6',
      '--top-p 0.95',
      '--top-k 20',
      '--min-p 0',
      '--host 0.0.0.0',
      '--port 9001',
      '--threads 16',
      '--threads-batch 16',
      '--parallel 1',
      '-dio',
      '--cache-prompt',
      '--metrics',
    ],
    default: false,
  },
  {
    name: 'Qwen3 Coder Next (80B MoE)',
    command: 'llama-server',
    params: [
      '-hf unsloth/Qwen3-Coder-Next-GGUF:UD-Q8_K_XL',
      '--jinja',
      '-ngl 99',
      '-fa on',
      '-c 65536',
      '-b 2048',
      '-ub 512',
      '--cache-type-k q8_0',
      '--cache-type-v q8_0',
      '--temp 1.0',
      '--top-p 0.95',
      '--top-k 40',
      '--min-p 0.01',
      '--host 0.0.0.0',
      '--port 9001',
      '--threads 16',
      '--threads-batch 16',
      '--parallel 1',
      '-dio',
      '--cache-prompt',
      '--metrics',
    ],
    default: false,
  },
];

// Serialize the config as JSON. Each model's `params` entry bundles a flag with
// its value ("-c 65536"), so standard 2-space formatting already puts one
// logical argument per line.
export function stringifyConfig(cfg: unknown): string {
  return JSON.stringify(cfg, null, 2);
}

const BASE_CONFIG = {
  listen:             { host: '127.0.0.1', port: 8080 },
  upstream:           { baseUrl: '${OPENCODE_ENDPOINT:-http://127.0.0.1:9001/v1}' },
  maxToolRounds:      25,
  mcpServers:         {},
  pluginsDir:         './plugins',
  enableModelLauncher: true,
  models:             DEFAULT_MODELS,
};

function applyEnv(raw: string): string {
  return raw.replace(/\${([^}]+)}/g, (_, expr) => {
    const [v, d] = expr.split(':-');
    return process.env[v] || d || '';
  });
}

function makePluginConfig<T extends object>(name: string, cfgPath: string): PluginConfig<T> {
  const pluginConfigDir = dirname(cfgPath);
  const pluginConfigPath = join(pluginConfigDir, name, 'config.json');

  return {
    async get(): Promise<T> {
      try {
        const raw = await readFile(pluginConfigPath, 'utf8');
        const cfg = JSON.parse(applyEnv(raw));
        return cfg as T;
      } catch {
        return {} as T;
      }
    },
    async set(patch: Partial<T>): Promise<void> {
      await mkdir(dirname(pluginConfigPath), { recursive: true });
      let existing: Record<string, unknown> = {};
      try {
        const raw = await readFile(pluginConfigPath, 'utf8');
        existing = JSON.parse(raw);
      } catch {}
      const updated = { ...existing, ...patch };
      await writeFile(pluginConfigPath, stringifyConfig(updated), 'utf8');
    },
  };
}

async function fileExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

export async function loadPlugins(pluginsDir: string, cfgPath: string): Promise<void> {
  const absDir = resolvePath(process.cwd(), pluginsDir);
  
  const configDir = dirname(cfgPath);
  if (!existsSync(configDir)) {
    await mkdir(configDir, { recursive: true });
  }

  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch {
    console.warn(`Plugins directory not found: ${absDir}`);
    return;
  }

  const subdirs = entries.filter(e => e.isDirectory());

  // If config.json is missing, write a minimal default
  if (!(await fileExists(cfgPath))) {
    console.log(`No config.json found — generating default at ${cfgPath}`);
    const cfg = { ...BASE_CONFIG };
    await writeFile(cfgPath, stringifyConfig(cfg), 'utf8');
    console.log('Default config.json written. Edit it then restart.');
  }

  const loaded: string[] = [];
  const failed: string[] = [];

  for (const entry of subdirs) {
    const pluginName = entry.name;
    const indexPath = resolvePath(absDir, pluginName, 'index.ts');
    try {
      const mod = await import(indexPath) as { setup?: (cfg: PluginConfig) => void | Promise<void> };
      if (typeof mod.setup === 'function') {
        await mod.setup(makePluginConfig(pluginName, cfgPath));
        loaded.push(pluginName);
      } else {
        console.warn(`Plugin "${pluginName}" has no setup() export — skipped`);
      }
    } catch (e) {
      failed.push(pluginName);
      console.warn(`Failed to load plugin "${pluginName}": ${(e as Error).message}`);
    }
  }

  console.log(`Plugins loaded (${loaded.length}): ${loaded.join(', ') || 'none'}`);
  if (failed.length) console.warn(`Plugins failed (${failed.length}): ${failed.join(', ')}`);
}
