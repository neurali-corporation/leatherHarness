import { registerNativeTool } from '../../src/registry.ts';
import type { PluginConfig } from '../../src/plugin-loader.ts';

export const defaultConfig = {};

export function setup(_cfg: PluginConfig) {
  registerNativeTool({
    name: 'scrape',
    description: 'Render a URL with a headless browser, following all redirects, and return the full HTML content of the page with <script> and <style> tags removed from the <head>.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute URL to scrape' },
      },
      required: ['url'],
    },
    execute: async ({ url }: { url: string }) => {
      const describe = (e: unknown) => {
        const err = e as { message?: string; cause?: any };
        let m = err?.message || String(e);
        if (err?.cause) m += ` — cause: ${err.cause.code || err.cause.message || err.cause}`;
        return m;
      };

      let playwright;
      try {
        playwright = await import('playwright');
      } catch (e: unknown) {
        return `ERROR: scrape is unavailable — Playwright failed to load: ${describe(e)}`;
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
          // Clone the document to avoid mutating the live DOM
          const clone = document.cloneNode(true) as Document;
          
          // Remove <script> and <style> from <head>
          const head = clone.querySelector('head');
          if (head) {
            head.querySelectorAll('script, style').forEach(el => el.remove());
          }
          
          // Return the full HTML of the modified document
          return {
            url:   window.location.href,
            title: document.title,
            html:  clone.documentElement.outerHTML,
          };
        });
        const header = `URL: ${result.url}\nTitle: ${result.title}\n\n`;
        return header + result.html;
      } catch (e: unknown) {
        // Return a clean, model-readable failure instead of throwing.
        return `ERROR: failed to fetch ${url}: ${describe(e)}`;
      } finally {
        await browser.close().catch(() => {});
      }
    },
  });
}
