import { registerNativeTool } from './registry.ts';

let browserPromise: Promise<import('playwright').Browser> | null = null;

async function getBrowser() {
  if (!browserPromise) {
    const { chromium } = await import('playwright');
    browserPromise = chromium.launch({ headless: true });
  }
  return browserPromise;
}

// Wait for the page to fully render, then strip <script>, <style> and
// stylesheet <link>s from the document and return the resulting HTML.
async function scrape(url: string): Promise<string> {
  const browser = await getBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
    return await page.evaluate(() => {
      document
        .querySelectorAll('script, style, link[rel="stylesheet"]')
        .forEach(el => el.remove());
      return document.documentElement.outerHTML;
    });
  } finally {
    await context.close();
  }
}

export function registerScrapeTool() {
  registerNativeTool({
    name: 'scrape',
    description:
      'Fetch a URL, wait for the page to completely render, and return its ' +
      'HTML with <head> scripts and CSS (script, style, stylesheet link) removed.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to scrape.' },
      },
      required: ['url'],
    },
    execute: async ({ url }: { url: string }) => scrape(url),
  });
}
