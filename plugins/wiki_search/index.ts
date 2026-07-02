import { registerNativeTool } from '../../src/registry.ts';
import type { PluginConfig } from '../../src/plugin-loader.ts';

export const defaultConfig = {};

export function setup(_cfg: PluginConfig) {
  registerNativeTool({
    name: 'wiki_search',
    description: 'Search Wikipedia and return the top article snippet.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search term' } },
      required: ['query'],
    },
    execute: async ({ query }: { query: string }) => {
      const api = `https://en.wikipedia.org/api/rest_v1/page/html/${encodeURIComponent(query)}`;
      const res = await fetch(api, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return 'No article found.';
      const html = await res.text();
      const text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return text || 'No content extracted.';
    },
  });
}
