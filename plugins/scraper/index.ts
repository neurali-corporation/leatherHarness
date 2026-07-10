import { registerNativeTool } from '../../src/registry.ts';
import type { PluginConfig } from '../../src/plugin-loader.ts';

// Full-page HTML is enormous — a single scrape used to return 100k+ tokens and
// blow the model's context window. Strip the page to its main content and return
// Markdown (headings, links, lists preserved; scripts/styles/chrome removed),
// hard-capped in length. With `extract`, the Markdown is instead run through the
// upstream model, which returns just the requested information.
interface ScraperConfig {
  maxChars: number;        // cap on returned Markdown
  extractMaxChars: number; // cap on the extracted answer
  upstreamUrl: string;     // model endpoint for extract mode ('' → env/default)
}

export const defaultConfig: ScraperConfig = { maxChars: 40000, extractMaxChars: 4000, upstreamUrl: '' };

// Same default the harness itself uses (see plugin-loader upstream.baseUrl).
const resolveUpstream = (configured: string) =>
  configured || process.env.OPENCODE_ENDPOINT || 'http://127.0.0.1:9001/v1';

const stripThink = (s: string) => s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

// Ask the upstream model to pull just the requested info out of the page Markdown.
// Returns null on any failure so the caller can fall back to raw Markdown.
async function extractRelevant(upstream: string, query: string, markdown: string): Promise<string | null> {
  try {
    const res = await fetch(`${upstream}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stream: false,
        messages: [
          { role: 'system', content: 'You extract information from web pages. Given a request and the page content (Markdown), reply with only the requested information — concise and faithful to the source, preserving useful links. If the page does not contain it, say so briefly.' },
          { role: 'user', content: `Request: ${query}\n\nPage content:\n${markdown}` },
        ],
      }),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    return typeof content === 'string' ? stripThink(content) : null;
  } catch {
    return null;
  }
}

export function setup(cfg: PluginConfig<ScraperConfig>) {
  registerNativeTool({
    name: 'scrape',
    description: 'Render a URL with a headless browser (following redirects) and return its main content as Markdown, with links preserved and scripts/styles/navigation stripped. Pass `extract` to instead get just the information you ask for, distilled from the page by the model. Long pages are truncated.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute URL to scrape' },
        extract: { type: 'string', description: 'Optional: what to pull from the page (a question or instruction). When set, returns only that distilled answer instead of the full Markdown.' },
      },
      required: ['url'],
    },
    execute: async ({ url, extract }: { url: string; extract?: string }) => {
      const { maxChars = 40000, extractMaxChars = 4000, upstreamUrl = '' } = await cfg.get();
      const describe = (e: unknown) => {
        const err = e as { message?: string; cause?: any };
        let m = err?.message || String(e);
        if (err?.cause) m += ` — cause: ${err.cause.code || err.cause.message || err.cause}`;
        return m;
      };

      let playwright;
      let TurndownService;
      try {
        playwright = await import('playwright');
        TurndownService = (await import('turndown')).default;
      } catch (e: unknown) {
        return `ERROR: scrape is unavailable — dependency failed to load: ${describe(e)}`;
      }

      let browser;
      try {
        browser = await playwright.chromium.launch({ headless: true });
      } catch (e: unknown) {
        return `ERROR: scrape could not start a browser: ${describe(e)}`;
      }

      try {
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
        const result = await page.evaluate(() => {
          // Drop non-content chrome so the conversion focuses on the article.
          const clone = document.cloneNode(true) as Document;
          clone.querySelectorAll(
            'script, style, noscript, svg, iframe, canvas, head, nav, header, footer, aside, form, [aria-hidden="true"], [hidden]'
          ).forEach((el) => el.remove());
          // Resolve relative links/images to absolute against the LIVE document, so
          // the Markdown's URLs are usable (getAttribute alone would stay relative).
          const abs = (rel: string) => { try { return new URL(rel, document.baseURI).href; } catch { return rel; } };
          clone.querySelectorAll('a[href]').forEach((a) => a.setAttribute('href', abs(a.getAttribute('href') || '')));
          clone.querySelectorAll('img[src]').forEach((i) => i.setAttribute('src', abs(i.getAttribute('src') || '')));
          const main = clone.querySelector('main, article') || clone.querySelector('body');
          return { url: window.location.href, title: document.title, html: main ? main.innerHTML : '' };
        });

        const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
        const md = turndown.turndown(result.html || '').replace(/\n{3,}/g, '\n\n').trim();
        const header = `URL: ${result.url}\nTitle: ${result.title}\n\n`;
        // Cap what we feed forward — both for a direct return and as the extractor's
        // input (so extraction itself can't overflow the model's context).
        const capped = md.length > maxChars
          ? md.slice(0, maxChars) + `\n\n…[truncated ${md.length - maxChars} chars — page is longer]`
          : md;

        if (extract && extract.trim()) {
          const answer = await extractRelevant(resolveUpstream(upstreamUrl), extract.trim(), capped);
          if (answer) {
            const trimmed = answer.length > extractMaxChars ? answer.slice(0, extractMaxChars) + '\n…[truncated]' : answer;
            return `${header}Extracted for: ${extract.trim()}\n\n${trimmed}`;
          }
          // Extraction failed — fall back to the Markdown so the caller still gets something.
          return `${header}(extract unavailable — returning page Markdown)\n\n${capped}`;
        }

        return header + capped;
      } catch (e: unknown) {
        // Return a clean, model-readable failure instead of throwing.
        return `ERROR: failed to fetch ${url}: ${describe(e)}`;
      } finally {
        await browser.close().catch(() => {});
      }
    },
  });
}
