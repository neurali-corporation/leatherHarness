import { readdir, readFile, writeFile, access, mkdir } from 'node:fs/promises';
import { resolve as resolvePath, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';

export interface PluginConfig<T extends object = Record<string, unknown>> {
  get(): Promise<T>;
  set(patch: Partial<T>): Promise<void>;
  /**
   * The plugin's own directory, assigned by the app from the plugin's name
   * (`<config>/plugins/<name>`). Plugins persist all their files here rather
   * than deciding an absolute path themselves. The directory is created lazily;
   * call `ensureDir()` (or write through a helper that does) before writing.
   */
  readonly dir: string;
  /** Create the plugin's `dir` if it doesn't exist yet, and return it. */
  ensureDir(): Promise<string>;
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

// The full application-level config template. Every field the harness reads is
// listed here with a sensible empty/default placeholder so a freshly generated
// config.json documents all available settings, and so existing configs get any
// newly added field back-filled on startup (see fillDefaults / loadPlugins).
//   - "" / null  → an optional value that is off/unset by default
//   - []/{}       → an empty collection
//   - concrete    → a working default (ports, thresholds, bundled models)
export const BASE_CONFIG = {
  listen:              { host: '127.0.0.1', port: 8080 },
  upstream:            { baseUrl: '${OPENCODE_ENDPOINT:-http://127.0.0.1:9001/v1}' },
  secret:              '',            // shared secret / Bearer token; "" disables auth
  maxToolRounds:       25,
  maxMessages:         50,            // conversation length before compaction kicks in
  mcpServers:          {},
  pluginsDir:          './plugins',
  enableModelLauncher: true,
  launchersDir:        '',            // "" → auto-discover from ../launchers
  models:              DEFAULT_MODELS,
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Back-fill missing config fields from a template. Every key present in
 * `template` is guaranteed to exist in the result: an existing value always
 * wins (recursing into nested plain objects), and anything absent is filled
 * from the template. Arrays and scalars are treated as atomic — we never merge
 * into a user's array or overwrite a value they already set. Returns the merged
 * object plus whether any key had to be added, so callers can skip rewriting an
 * already-complete file.
 */
export function fillDefaults(existing: unknown, template: unknown): { value: unknown; changed: boolean } {
  if (!isPlainObject(template)) {
    return existing === undefined ? { value: template, changed: true } : { value: existing, changed: false };
  }
  const src = isPlainObject(existing) ? existing : {};
  const out: Record<string, unknown> = { ...src };
  // If the slot was missing (or held a non-object) we're synthesising the whole
  // object from the template, which is itself a change.
  let changed = !isPlainObject(existing);
  for (const [key, tmplVal] of Object.entries(template)) {
    const res = fillDefaults(src[key], tmplVal);
    out[key] = res.value;
    if (res.changed) changed = true;
  }
  return { value: out, changed };
}

// ── discovery registry ──────────────────────────────────────────────────────
// Populated while loadPlugins runs so the /api/discovery endpoint can report
// every configurable surface: the application settings and each plugin's config
// schema (its defaultConfig), with the on-disk path each lives at.
export interface PluginDiscovery {
  name: string;
  defaults: Record<string, unknown>;
  configPath: string;
  loaded: boolean;
}

let applicationDiscovery: { defaults: Record<string, unknown>; configPath: string } | null = null;
const pluginDiscovery: PluginDiscovery[] = [];

export function getDiscovery(): {
  application: { defaults: Record<string, unknown>; configPath: string } | null;
  plugins: PluginDiscovery[];
} {
  return { application: applicationDiscovery, plugins: pluginDiscovery };
}

/**
 * Merge a template into a JSON config file on disk, writing it back only when a
 * field was missing (or the file didn't exist). Reads the raw file — env-var
 * placeholders like "${VAR:-default}" are left untouched so we don't bake
 * resolved values into the config. Returns the merged config object.
 */
async function templateConfigFile(path: string, template: Record<string, unknown>): Promise<Record<string, unknown>> {
  // A plugin with no settings has nothing to template — don't litter the config
  // dir with empty stub files.
  if (Object.keys(template).length === 0) return {};
  let existing: unknown = undefined;
  let raw: string | undefined;
  try {
    raw = await readFile(path, 'utf8');
  } catch { /* file doesn't exist → synthesise it from the template below */ }
  if (raw !== undefined) {
    try {
      existing = JSON.parse(raw);
    } catch {
      // The file exists but is invalid JSON — it may be a hand-edited config we
      // must not clobber. Leave it alone; the operator will see the parse error
      // when the harness reads it.
      console.warn(`Skipping templating of ${path}: existing file is not valid JSON`);
      return {};
    }
  }
  const { value, changed } = fillDefaults(existing, template);
  if (changed) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, stringifyConfig(value), 'utf8');
  }
  return value as Record<string, unknown>;
}

function applyEnv(raw: string): string {
  return raw.replace(/\${([^}]+)}/g, (_, expr) => {
    const [v, d] = expr.split(':-');
    return process.env[v] || d || '';
  });
}

function makePluginConfig<T extends object>(name: string, cfgPath: string): PluginConfig<T> {
  // Every plugin lives under `<config>/plugins/<name>`: both its config.json and
  // any data it persists. The app derives this from the plugin's name so plugins
  // never choose their own absolute paths.
  const pluginDir = join(dirname(cfgPath), 'plugins', name);
  const pluginConfigPath = join(pluginDir, 'config.json');

  return {
    dir: pluginDir,
    async ensureDir(): Promise<string> {
      await mkdir(pluginDir, { recursive: true });
      return pluginDir;
    },
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

  // Template the application config: write it from scratch if missing, or
  // back-fill any newly added fields into an existing one. Either way config.json
  // ends up listing every application setting the harness understands.
  const existedBefore = await fileExists(cfgPath);
  await templateConfigFile(cfgPath, BASE_CONFIG);
  if (!existedBefore) {
    console.log(`No config.json found — generated default at ${cfgPath}. Edit it then restart.`);
  }
  applicationDiscovery = { defaults: BASE_CONFIG as Record<string, unknown>, configPath: cfgPath };

  // Reset per-plugin discovery so repeated loads (e.g. in tests) don't accumulate.
  pluginDiscovery.length = 0;

  const configDirForPlugins = join(dirname(cfgPath), 'plugins');
  const loaded: string[] = [];
  const failed: string[] = [];

  for (const entry of subdirs) {
    const pluginName = entry.name;
    const indexPath = resolvePath(absDir, pluginName, 'index.ts');
    const pluginCfgPath = join(configDirForPlugins, pluginName, 'config.json');

    let mod: { setup?: (cfg: PluginConfig) => void | Promise<void>; defaultConfig?: Record<string, unknown> };
    try {
      mod = await import(indexPath);
    } catch (e) {
      failed.push(pluginName);
      console.warn(`Failed to load plugin "${pluginName}": ${(e as Error).message}`);
      continue;
    }

    // Template the plugin's own config file from its exported defaultConfig, and
    // record it for discovery — independent of whether setup() succeeds, so a
    // plugin whose tools fail to register still gets a documented config stub.
    const defaults = mod.defaultConfig ?? {};
    try {
      await templateConfigFile(pluginCfgPath, defaults);
    } catch (e) {
      console.warn(`Failed to template config for plugin "${pluginName}": ${(e as Error).message}`);
    }
    const discovery: PluginDiscovery = { name: pluginName, defaults, configPath: pluginCfgPath, loaded: false };
    pluginDiscovery.push(discovery);

    if (typeof mod.setup === 'function') {
      try {
        await mod.setup(makePluginConfig(pluginName, cfgPath));
        discovery.loaded = true;
        loaded.push(pluginName);
      } catch (e) {
        failed.push(pluginName);
        console.warn(`Failed to load plugin "${pluginName}": ${(e as Error).message}`);
      }
    } else {
      console.warn(`Plugin "${pluginName}" has no setup() export — skipped`);
    }
  }

  console.log(`Plugins loaded (${loaded.length}): ${loaded.join(', ') || 'none'}`);
  if (failed.length) console.warn(`Plugins failed (${failed.length}): ${failed.join(', ')}`);
}
