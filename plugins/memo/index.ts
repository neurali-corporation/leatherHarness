import { registerNativeTool } from '../../src/registry.ts';
import type { PluginConfig } from '../../src/plugin-loader.ts';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { homedir } from 'node:os';

interface MemoConfig {
  path?: string;
}

export const defaultConfig: MemoConfig = {
  path: '~/.config/leatherHarness/memo',
};

// Sub-memo file names are sanitized to a safe basename; they live alongside the
// main memo as `<name>.md` so the whole memo store is one flat directory.
function sanitizeName(name: string): string {
  const safe = name.trim().replace(/[^A-Za-z0-9 _-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || 'untitled';
}

export function setup(cfg: PluginConfig<MemoConfig>) {
  async function mainMemoPath(): Promise<string> {
    const { path: p } = await cfg.get();
    if (p) return p.replace(/^~/, homedir());
    return `${homedir()}/.config/leatherHarness/plugins/memo`;
  }

  // Resolve the target file: the main memo when no name is given, else a sub-memo
  // stored as `<name>.md` in the same directory as the main memo.
  async function targetPath(name?: string): Promise<string> {
    if (name && name.trim()) {
      return join(dirname(await mainMemoPath()), `${sanitizeName(name)}.md`);
    }
    return mainMemoPath();
  }

  async function readMemo(name?: string): Promise<string> {
    try { return await readFile(await targetPath(name), 'utf8'); }
    catch (_) { return ''; }
  }

  // The memo is stored and read back as Markdown — write tools should pass
  // Markdown-formatted content (headings, lists, etc.) so it renders cleanly.
  async function writeMemo(content: string, name?: string): Promise<void> {
    const p = await targetPath(name);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content, 'utf8');
  }

  // Names of all sub-memos (the `.md` files beside the main memo, main excluded).
  async function listSubMemos(): Promise<string[]> {
    const main = await mainMemoPath();
    try {
      const entries = await readdir(dirname(main));
      const mainBase = basename(main);
      return entries
        .filter(f => f.endsWith('.md') && f !== mainBase)
        .map(f => f.slice(0, -3))
        .sort();
    } catch (_) { return []; }
  }

  registerNativeTool({
    name: 'read_memo',
    description: 'Read a persistent memo — your long-term memory across conversations. Omit "name" to read the main memo (user preferences, ongoing tasks, context). Pass a sub-memo name to read that specific note (see list_memos).',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Sub-memo name to read. Omit for the main memo.' },
      },
      required: [],
    },
    execute: async ({ name }: { name?: string }) => {
      const c = await readMemo(name);
      if (c) return c;
      return name ? `(sub-memo "${sanitizeName(name)}" is empty or does not exist)` : '(memo is empty)';
    },
  });

  registerNativeTool({
    name: 'write_memo',
    description: 'Overwrite a persistent memo entirely. Omit "name" to write the main memo; pass a name to create/overwrite a sub-memo in the same directory. Use the main memo for high-level, always-relevant context and sub-memos for topic-specific detail. Content must be in Markdown format.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Full new content for the memo in Markdown format (replaces everything)' },
        name:    { type: 'string', description: 'Sub-memo name to write. Omit for the main memo.' },
      },
      required: ['content'],
    },
    execute: async ({ content, name }: { content: string; name?: string }) => {
      await writeMemo(content, name);
      return name ? `Sub-memo "${sanitizeName(name)}" saved.` : 'Memo saved.';
    },
  });

  registerNativeTool({
    name: 'append_memo',
    description: 'Append a note to a persistent memo without overwriting existing content. Omit "name" for the main memo; pass a name to append to a sub-memo. Text should be in Markdown format.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Markdown-formatted text to append' },
        name: { type: 'string', description: 'Sub-memo name to append to. Omit for the main memo.' },
      },
      required: ['text'],
    },
    execute: async ({ text, name }: { text: string; name?: string }) => {
      const existing = await readMemo(name);
      await writeMemo(existing ? `${existing}\n${text}` : text, name);
      return name ? `Appended to sub-memo "${sanitizeName(name)}".` : 'Appended to memo.';
    },
  });

  registerNativeTool({
    name: 'list_memos',
    description: 'List the names of all sub-memos stored alongside the main memo. Use a returned name with read_memo/write_memo/append_memo to work with that sub-memo.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      const subs = await listSubMemos();
      return subs.length ? subs.join('\n') : '(no sub-memos)';
    },
  });
}
