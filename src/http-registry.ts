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

/**
 * Register an HTTP route for a plugin using the default naming convention:
 * `/api/plugin/<pluginName>`. Matches the exact path or anything below it.
 * This is the standard way for plugins to expose HTTP APIs.
 */
export function registerPluginRoute(pluginName: string, handler: HttpHandler) {
  const prefix = `/api/plugin/${pluginName}`;
  registerHttpRoute(prefix, handler);
}

export function matchRoute(pathname: string): HttpHandler | undefined {
  return routes.find((r) => pathname === r.prefix || pathname.startsWith(r.prefix + '/'))?.handler;
}

export default { registerHttpRoute, registerPluginRoute, matchRoute };
