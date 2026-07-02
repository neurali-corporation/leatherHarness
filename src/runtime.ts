// Small shared view of where the main harness server is listening, so plugins
// can build absolute URLs back to it without each carrying their own host/port.
let listenHost = '127.0.0.1';
let listenPort = 9001;
// The Host header from the most recent browser request — this is the address the
// user actually reaches the harness at (e.g. a LAN IP), which may differ from the
// bind address. Tool-returned URLs should use it so links work from that machine.
let observedHost: string | null = null;

export function setListen(host: string, port: number) {
  listenHost = host;
  listenPort = port;
}

/** Record the Host header of an incoming request (ignoring loopback noise). */
export function noteHost(host: string | undefined) {
  if (host) observedHost = host;
}

/** Base URL the browser uses to reach the harness (e.g. "http://192.168.1.5:9001"). */
export function harnessBaseUrl(): string {
  if (observedHost) return `http://${observedHost}`;
  const host = listenHost === '0.0.0.0' || listenHost === '::' ? '127.0.0.1' : listenHost;
  return `http://${host}:${listenPort}`;
}

export default { setListen, noteHost, harnessBaseUrl };
