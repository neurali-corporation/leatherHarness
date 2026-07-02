import { registerNativeTool } from '../../src/registry.ts';
import type { PluginConfig } from '../../src/plugin-loader.ts';

interface SearchConfig {
  tavily?: { apiKey?: string };
  exa?: { apiKey?: string };
  jina?: { apiKey?: string };
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  score?: number;
}

interface Provider {
  name: string;
  /** Returns true when the provider has the config it needs to run. */
  enabled(cfg: SearchConfig): boolean;
  search(query: string, maxResults: number, cfg: SearchConfig): Promise<SearchResult[]>;
}

const TIMEOUT_MS = 15_000;

const providers: Provider[] = [
  {
    name: 'tavily',
    enabled: (cfg) => Boolean(cfg.tavily?.apiKey),
    async search(query, maxResults, cfg) {
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.tavily!.apiKey}`,
        },
        body: JSON.stringify({
          query,
          max_results: maxResults,
          search_depth: 'basic',
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }
      const data = await res.json() as { results?: Array<{ title?: string; url?: string; content?: string; score?: number }> };
      return (data.results ?? []).map((r) => ({
        title: r.title ?? '',
        url: r.url ?? '',
        snippet: r.content ?? '',
        score: r.score,
      }));
    },
  },
  {
    name: 'exa',
    enabled: (cfg) => Boolean(cfg.exa?.apiKey),
    async search(query, maxResults, cfg) {
      const res = await fetch('https://api.exa.ai/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': cfg.exa!.apiKey!,
        },
        body: JSON.stringify({
          query,
          numResults: maxResults,
          contents: { text: { maxCharacters: 500 } },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }
      const data = await res.json() as { results?: Array<{ title?: string; url?: string; text?: string; score?: number }> };
      return (data.results ?? []).map((r) => ({
        title: r.title ?? '',
        url: r.url ?? '',
        snippet: (r.text ?? '').replace(/\s+/g, ' ').trim(),
        score: r.score,
      }));
    },
  },
  {
    name: 'jina',
    enabled: (cfg) => Boolean(cfg.jina?.apiKey),
    async search(query, maxResults, cfg) {
      const res = await fetch(`https://s.jina.ai/?q=${encodeURIComponent(query)}`, {
        headers: {
          Authorization: `Bearer ${cfg.jina!.apiKey}`,
          Accept: 'application/json',
          // Skip full page-content fetches — we only want the result list.
          'X-Respond-With': 'no-content',
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }
      const data = await res.json() as { data?: Array<{ title?: string; url?: string; description?: string }> };
      return (data.data ?? []).slice(0, maxResults).map((r) => ({
        title: r.title ?? '',
        url: r.url ?? '',
        snippet: (r.description ?? '').replace(/\s+/g, ' ').trim(),
      }));
    },
  },
];

export const defaultConfig: SearchConfig = {
  tavily: { apiKey: '' },
  exa: { apiKey: '' },
  jina: { apiKey: '' },
};

function formatResults(results: SearchResult[]): string {
  if (results.length === 0) return 'No results.';
  return results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
    .join('\n\n');
}

export function setup(cfg: PluginConfig<SearchConfig>) {
  const providerNames = providers.map((p) => p.name);

  registerNativeTool({
    name: 'web_search',
    description:
      `Search the internet and return ranked results (title, URL, snippet). ` +
      `Set provider to one of [${providerNames.join(', ')}] to use a single provider, ` +
      `or "all" (the default) to query every configured provider in parallel and merge the results.`,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        provider: {
          type: 'string',
          description: `Provider to use: one of [${providerNames.join(', ')}] or "all" (default).`,
          enum: ['all', ...providerNames],
        },
        maxResults: {
          type: 'number',
          description: 'Maximum results per provider (default 5).',
        },
      },
      required: ['query'],
    },
    execute: async ({ query, provider = 'all', maxResults = 5 }: { query: string; provider?: string; maxResults?: number }) => {
      const config = await cfg.get();

      const selected = provider === 'all'
        ? providers
        : providers.filter((p) => p.name === provider);

      if (selected.length === 0) {
        return `ERROR: Unknown provider "${provider}". Available: ${['all', ...providerNames].join(', ')}.`;
      }

      const active = selected.filter((p) => p.enabled(config));
      if (active.length === 0) {
        return provider === 'all'
          ? 'ERROR: No search providers are configured. Set pluginConfig.search.tavily.apiKey in config.json.'
          : `ERROR: Provider "${provider}" is not configured. Set its API key in pluginConfig.search.`;
      }

      const settled = await Promise.allSettled(
        active.map(async (p) => ({ name: p.name, results: await p.search(query, maxResults, config) })),
      );

      const sections: string[] = [];
      for (let i = 0; i < settled.length; i++) {
        const name = active[i].name;
        const outcome = settled[i];
        if (outcome.status === 'fulfilled') {
          sections.push(`## ${name}\n${formatResults(outcome.value.results)}`);
        } else {
          sections.push(`## ${name}\nERROR: ${(outcome.reason as Error).message}`);
        }
      }

      // Single provider: skip the header for cleaner output.
      if (active.length === 1) {
        const only = settled[0];
        return only.status === 'fulfilled'
          ? formatResults(only.value.results)
          : `ERROR: ${(only.reason as Error).message}`;
      }

      return sections.join('\n\n');
    },
  });
}
