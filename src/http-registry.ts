import type { IncomingMessage, ServerResponse } from 'node:http';

export type HttpHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

interface Route { prefix: string; handler: HttpHandler; }

const routes: Route[] = [];

/**
 * Let a plugin mount HTTP routes on the main harness server, so it doesn't need
 * to run its own listener. `prefix` matches the exact path or anything below it
 * (e.g. prefix "/music" matches "/music", "/music/player", "/music/stream").
 */
export function registerHttpRoute(prefix: string, handler: HttpHandler) {
  if (routes.some((r) => r.prefix === prefix)) throw new Error(`HTTP route already registered: ${prefix}`);
  routes.push({ prefix, handler });
}

export function matchRoute(pathname: string): HttpHandler | undefined {
  return routes.find((r) => pathname === r.prefix || pathname.startsWith(r.prefix + '/'))?.handler;
}

export default { registerHttpRoute, matchRoute };
