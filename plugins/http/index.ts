import { registerNativeTool } from '../../src/registry.ts';
import type { PluginConfig } from '../../src/plugin-loader.ts';

interface HttpResult {
  status: number;
  ok: boolean;
  body: string;
}

async function request(
  method: string,
  url: string,
  headers?: Record<string, string>,
  body?: string,
): Promise<string> {
  const res = await fetch(url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ?? undefined,
    signal: AbortSignal.timeout(20_000),
    redirect: 'follow',
  });
  const text = await res.text();
  const result: HttpResult = {
    status: res.status,
    ok:     res.ok,
    body:   text.slice(0, 200_000),
  };
  return JSON.stringify(result, null, 2);
}

export const defaultConfig = {};

export function setup(_cfg: PluginConfig) {
  registerNativeTool({
    name: 'http_get',
    description: 'HTTP GET request. Returns status code and response body.',
    parameters: {
      type: 'object',
      properties: {
        url:     { type: 'string',                description: 'Absolute URL' },
        headers: { type: 'object', description: 'Optional request headers' },
      },
      required: ['url'],
    },
    execute: async ({ url, headers }: { url: string; headers?: Record<string, string> }) =>
      request('GET', url, headers),
  });

  registerNativeTool({
    name: 'http_post',
    description: 'HTTP POST request. Returns status code and response body.',
    parameters: {
      type: 'object',
      properties: {
        url:     { type: 'string', description: 'Absolute URL' },
        body:    { type: 'string', description: 'Request body (JSON string or plain text)' },
        headers: { type: 'object', description: 'Optional request headers (Content-Type defaults to application/json when body is set)' },
      },
      required: ['url'],
    },
    execute: async ({ url, body, headers }: { url: string; body?: string; headers?: Record<string, string> }) =>
      request('POST', url, headers, body),
  });

  registerNativeTool({
    name: 'http_put',
    description: 'HTTP PUT request. Returns status code and response body.',
    parameters: {
      type: 'object',
      properties: {
        url:     { type: 'string', description: 'Absolute URL' },
        body:    { type: 'string', description: 'Request body (JSON string or plain text)' },
        headers: { type: 'object', description: 'Optional request headers' },
      },
      required: ['url'],
    },
    execute: async ({ url, body, headers }: { url: string; body?: string; headers?: Record<string, string> }) =>
      request('PUT', url, headers, body),
  });

  registerNativeTool({
    name: 'http_delete',
    description: 'HTTP DELETE request. Returns status code and response body.',
    parameters: {
      type: 'object',
      properties: {
        url:     { type: 'string', description: 'Absolute URL' },
        headers: { type: 'object', description: 'Optional request headers' },
      },
      required: ['url'],
    },
    execute: async ({ url, headers }: { url: string; headers?: Record<string, string> }) =>
      request('DELETE', url, headers),
  });
}
