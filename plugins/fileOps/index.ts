import { registerNativeTool } from '../../src/registry.ts';
import type { PluginConfig } from '../../src/plugin-loader.ts';
import { readFile, readdir, copyFile, rename, unlink, rmdir, stat } from 'node:fs/promises';
import { resolve as resolvePath, dirname, join } from 'node:path';

interface FileOpsConfig {
  allowedDirs: string[];
  // Separate set of roots where cp/mv may read and write. Independent from allowedDirs.
  writeDirs: string[];
  // delete is destructive — off unless explicitly enabled in config.
  deleteEnabled: boolean;
}

export const defaultConfig: FileOpsConfig = {
  allowedDirs: ['/path/to/your/files'],
  writeDirs: ['/path/to/your/writable/files'],
  deleteEnabled: false,
};

export async function setup(cfg: PluginConfig<FileOpsConfig>) {
  async function getAllowedDirs(): Promise<string[]> {
    const { allowedDirs = [] } = await cfg.get();
    return allowedDirs.map((d) => resolvePath(process.cwd(), d));
  }

  async function getWriteDirs(): Promise<string[]> {
    const { writeDirs = [] } = await cfg.get();
    return writeDirs.map((d) => resolvePath(process.cwd(), d));
  }

  function isPathAllowed(target: string, allowed: string[]): boolean {
    const abs = resolvePath(process.cwd(), target);
    return allowed.some((base) => abs.startsWith(base + '/')) || allowed.includes(abs);
  }

  registerNativeTool({
    name: 'ls',
    description: 'List files and directories in a given directory (non‑recursive). Returns full absolute paths — use these exact strings in subsequent tool calls.',
    parameters: {
      type: 'object',
      properties: { dir: { type: 'string', description: 'Absolute path to list' } },
      required: ['dir'],
    },
    execute: async ({ dir }: { dir: string }) => {
      const allowed = await getAllowedDirs();
      if (!isPathAllowed(dir, allowed)) return 'ERROR: Access denied.';
      const full = resolvePath(process.cwd(), dir);
      try {
        const entries = await readdir(full, { withFileTypes: true });
        return entries.map((e) => {
          const abs = `${full}/${e.name}`;
          return e.isDirectory() ? `${abs}/` : abs;
        }).join('\n') || '(empty)';
      } catch (e: unknown) {
        return `ERROR: ${(e as NodeJS.ErrnoException).message}`;
      }
    },
  });

  registerNativeTool({
    name: 'cat',
    description: 'Read a file and return its contents (max 200KB). Use the exact absolute path returned by ls.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File path to read (relative to allowed roots)' } },
      required: ['path'],
    },
    execute: async ({ path }: { path: string }) => {
      const allowed = await getAllowedDirs();
      if (!isPathAllowed(path, allowed)) return 'ERROR: Access denied.';
      const full = resolvePath(process.cwd(), path);
      try {
        const content = await readFile(full, 'utf8');
        return content.slice(0, 200_000);
      } catch (e: unknown) {
        return `ERROR: ${(e as NodeJS.ErrnoException).message}`;
      }
    },
  });

  registerNativeTool({
    name: 'list_allowed_dirs',
    description:
      'Return the allowed root directories. Always call this first, then use ls with one of these paths to discover exact file paths before accessing files.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      const dirs = await getAllowedDirs();
      return JSON.stringify(dirs, null, 2);
    },
  });

  // List directory tree (directories only, recursive)
  registerNativeTool({
    name: 'dir_tree',
    description: 'List subdirectories under a given directory as a nested JSON object. The root has a path key; subdirectories are nested as empty objects.',
    parameters: {
      type: 'object',
      properties: { dir: { type: 'string', description: 'Absolute path to start' } },
      required: ['dir'],
    },
    execute: async ({ dir }: { dir: string }) => {
      const allowed = await getAllowedDirs();
      if (!isPathAllowed(dir, allowed)) return 'ERROR: Access denied.';
      const base = resolvePath(process.cwd(), dir);
      try {
        const s = await stat(base);
        if (!s.isDirectory()) return 'ERROR: Not a directory.';
      } catch (e: unknown) {
        return `ERROR: ${(e as NodeJS.ErrnoException).message}`;
      }
      async function build(current: string): Promise<Record<string, unknown>> {
        const result: Record<string, unknown> = {};
        const entries = await readdir(current, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory()) {
            result[e.name] = await build(`${current}/${e.name}`);
          }
        }
        return result;
      }
      const tree = await build(base);
      return JSON.stringify(tree, null, 2);
    },
  });

  // Copy a file. Both source and destination must be within the writeDirs roots.
  registerNativeTool({
    name: 'cp',
    description: 'Copy a file from src to dest. Both paths must be within the configured write directories (call list_write_dirs to see them). Overwrites dest if it exists.',
    parameters: {
      type: 'object',
      properties: {
        src: { type: 'string', description: 'Source file path (within a write directory)' },
        dest: { type: 'string', description: 'Destination file path (within a write directory)' },
      },
      required: ['src', 'dest'],
    },
    execute: async ({ src, dest }: { src: string; dest: string }) => {
      const dirs = await getWriteDirs();
      if (!isPathAllowed(src, dirs)) return 'ERROR: Access denied for source.';
      if (!isPathAllowed(dest, dirs)) return 'ERROR: Access denied for destination.';
      const srcAbs = resolvePath(process.cwd(), src);
      const destAbs = resolvePath(process.cwd(), dest);
      try {
        await copyFile(srcAbs, destAbs);
        return `OK: copied ${srcAbs} -> ${destAbs}`;
      } catch (e: unknown) {
        return `ERROR: ${(e as NodeJS.ErrnoException).message}`;
      }
    },
  });

  // Move/rename a file. Both source and destination must be within the writeDirs roots.
  registerNativeTool({
    name: 'mv',
    description: 'Move or rename a file from src to dest. Both paths must be within the configured write directories (call list_write_dirs to see them). Overwrites dest if it exists.',
    parameters: {
      type: 'object',
      properties: {
        src: { type: 'string', description: 'Source file path (within a write directory)' },
        dest: { type: 'string', description: 'Destination file path (within a write directory)' },
      },
      required: ['src', 'dest'],
    },
    execute: async ({ src, dest }: { src: string; dest: string }) => {
      const dirs = await getWriteDirs();
      if (!isPathAllowed(src, dirs)) return 'ERROR: Access denied for source.';
      if (!isPathAllowed(dest, dirs)) return 'ERROR: Access denied for destination.';
      const srcAbs = resolvePath(process.cwd(), src);
      const destAbs = resolvePath(process.cwd(), dest);
      try {
        await rename(srcAbs, destAbs);
        return `OK: moved ${srcAbs} -> ${destAbs}`;
      } catch (e: unknown) {
        return `ERROR: ${(e as NodeJS.ErrnoException).message}`;
      }
    },
  });

  // Rename a file or directory in place (same parent directory, new name).
  registerNativeTool({
    name: 'rename',
    description: 'Rename a file or directory in place — keeps it in the same parent folder, just changes its name. The path must be within the configured write directories (call list_write_dirs to see them). Use mv to relocate to a different folder.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file or directory to rename (within a write directory)' },
        newName: { type: 'string', description: 'New base name only (no slashes), e.g. "Band - 2025 - Album"' },
      },
      required: ['path', 'newName'],
    },
    execute: async ({ path, newName }: { path: string; newName: string }) => {
      if (newName.includes('/') || newName === '.' || newName === '..') {
        return 'ERROR: newName must be a base name with no slashes. Use mv to move across folders.';
      }
      const dirs = await getWriteDirs();
      const srcAbs = resolvePath(process.cwd(), path);
      const destAbs = join(dirname(srcAbs), newName);
      if (!isPathAllowed(srcAbs, dirs)) return 'ERROR: Access denied for source.';
      if (!isPathAllowed(destAbs, dirs)) return 'ERROR: Access denied for destination.';
      try {
        await rename(srcAbs, destAbs);
        return `OK: renamed ${srcAbs} -> ${destAbs}`;
      } catch (e: unknown) {
        return `ERROR: ${(e as NodeJS.ErrnoException).message}`;
      }
    },
  });

  // List the roots cp/mv may operate within.
  registerNativeTool({
    name: 'list_write_dirs',
    description: 'Return the directories within which cp and mv may read and write. Use these to construct valid src/dest paths.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      const dirs = await getWriteDirs();
      return JSON.stringify(dirs, null, 2);
    },
  });

  // Delete a file. Disabled by default — only registered when deleteEnabled is true.
  const { deleteEnabled } = await cfg.get();
  if (deleteEnabled) {
    registerNativeTool({
      name: 'delete_file',
      description: 'Permanently delete a file. The path must be within the configured write directories (call list_write_dirs to see them). This is irreversible.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File path to delete (within a write directory)' } },
        required: ['path'],
      },
      execute: async ({ path }: { path: string }) => {
        const dirs = await getWriteDirs();
        if (!isPathAllowed(path, dirs)) return 'ERROR: Access denied.';
        const abs = resolvePath(process.cwd(), path);
        try {
          await unlink(abs);
          return `OK: deleted ${abs}`;
        } catch (e: unknown) {
          return `ERROR: ${(e as NodeJS.ErrnoException).message}`;
        }
      },
    });

    registerNativeTool({
      name: 'rmdir',
      description: 'Delete an empty directory. The path must be within the configured write directories (call list_write_dirs to see them). This is irreversible — the directory must be empty. Will fail if the directory is not empty.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Empty directory path to delete (within a write directory)' } },
        required: ['path'],
      },
      execute: async ({ path }: { path: string }) => {
        const dirs = await getWriteDirs();
        if (!isPathAllowed(path, dirs)) return 'ERROR: Access denied.';
        const abs = resolvePath(process.cwd(), path);
        try {
          await rmdir(abs);
          return `OK: deleted directory ${abs}`;
        } catch (e: unknown) {
          return `ERROR: ${(e as NodeJS.ErrnoException).message}`;
        }
      },
    });
  }

}
