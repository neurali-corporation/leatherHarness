import { readdir, readFile, writeFile, access, mkdir } from 'node:fs/promises';
import { resolve as resolvePath, dirname } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';

export interface PluginConfig<T extends object = Record<string, unknown>> {
  get(): Promise<T>;
  set(patch: Partial<T>): Promise<void>;
}

const BASE_CONFIG = {
  listen:        { host: '127.0.0.1', port: 9001 },
  upstream:      { baseUrl: '${OPENCODE_ENDPOINT:-http://127.0.0.1:8080/v1}' },
  maxToolRounds: 25,
  mcpServers:    {},
  pluginsDir:    './plugins',
  pluginConfig:  {} as Record<string, unknown>,
};

function applyEnv(raw: string): string {
  return raw.replace(/\${([^}]+)}/g, (_, expr) => {
    const [v, d] = expr.split(':-');
    return process.env[v] || d || '';
  });
}

function makePluginConfig<T extends object>(name: string, cfgPath: string): PluginConfig<T> {
  return {
    async get(): Promise<T> {
      const raw = await readFile(cfgPath, 'utf8');
      const cfg = JSON.parse(applyEnv(raw));
      return (cfg.pluginConfig?.[name] ?? {}) as T;
    },
    async set(patch: Partial<T>): Promise<void> {
      const raw = await readFile(cfgPath, 'utf8');
      const cfg = JSON.parse(raw);
      cfg.pluginConfig ??= {};
      cfg.pluginConfig[name] ??= {};
      Object.assign(cfg.pluginConfig[name], patch);
      await writeFile(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
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

  // If config.json is missing, collect defaults from all plugins and write it
  if (!(await fileExists(cfgPath))) {
    console.log(`No config.json found — generating default at ${cfgPath}`);
    const pluginConfig: Record<string, unknown> = {};
    for (const entry of subdirs) {
      const indexPath = resolvePath(absDir, entry.name, 'index.ts');
      try {
        const mod = await import(indexPath) as { defaultConfig?: unknown };
        if (mod.defaultConfig !== undefined) {
          pluginConfig[entry.name] = mod.defaultConfig;
        }
      } catch { /* plugin may not load without config — that's fine */ }
    }
    const cfg = { ...BASE_CONFIG, pluginConfig };
    await writeFile(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
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
