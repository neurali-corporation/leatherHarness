import { registerNativeTool } from '../../src/registry.ts';
import type { PluginConfig } from '../../src/plugin-loader.ts';
import { readdir } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';

interface FileSearchConfig {
  allowedDirs: string[];
}

export const defaultConfig: FileSearchConfig = {
  allowedDirs: ['/path/to/your/files'],
};

export function setup(cfg: PluginConfig<FileSearchConfig>) {
  registerNativeTool({
    name: 'search_files',
    description: 'Search for files by name within the allowed directories. Returns up to 10 matching absolute paths. Use this before ls/cat when you know part of a filename.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Case-insensitive substring to match against file and directory names',
        },
      },
      required: ['query'],
    },
    execute: async ({ query }: { query: string }) => {
      const { allowedDirs = [] } = await cfg.get();
      const roots = allowedDirs.map((d) => resolvePath(process.cwd(), d));
      const needles = query.toLowerCase().split(/\s+/).filter(Boolean);
      const results: string[] = [];

      async function walk(dir: string): Promise<void> {
        if (results.length >= 10) return;
        let entries;
        try { entries = await readdir(dir, { withFileTypes: true }); }
        catch { return; }
        for (const e of entries) {
          if (results.length >= 10) return;
          const abs = `${dir}/${e.name}`;
          const lower = e.name.toLowerCase();
          if (needles.every(n => lower.includes(n))) {
            results.push(e.isDirectory() ? `${abs}/` : abs);
          }
          if (e.isDirectory()) await walk(abs);
        }
      }

      for (const root of roots) await walk(root);

      if (results.length === 0) return `No files matching "${query}" found in allowed directories.`;
      return results.join('\n');
    },
  });
}
