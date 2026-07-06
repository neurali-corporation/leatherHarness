import { registerNativeTool } from '../../src/registry.ts';
import { registerHttpRoute } from '../../src/http-registry.ts';
import { registerUiIcon } from '../../src/ui-registry.ts';
import { harnessBaseUrl } from '../../src/runtime.ts';
import type { PluginConfig } from '../../src/plugin-loader.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { stat, readdir } from 'node:fs/promises';
import { resolve as resolvePath, extname, basename, dirname, sep } from 'node:path';
import { spawn } from 'node:child_process';

// Path the player UI + streaming routes are mounted at on the main harness server.
const MOUNT = '/music';

interface MusicConfig {
  allowedDirs?: string[];
}

export const defaultConfig: MusicConfig = {
  allowedDirs: ['/srv/samba/content/music'],
};

// Audio formats every modern browser can decode + play natively.
export const AUDIO_EXTS = new Set([
  '.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wav', '.flac', '.webm',
]);

export const MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
  '.wav': 'audio/wav', '.flac': 'audio/flac', '.webm': 'audio/webm',
};

export interface Track {
  /** Absolute path on disk. */
  path: string;
  /** File name including extension. */
  name: string;
  /** Display title (file name without extension). */
  title: string;
  /** Containing directory name — used as an album-ish grouping in the UI. */
  album: string;
}

// ── shared playback queue ────────────────────────────────────────────────────
// One server-side queue is the single source of truth shared by the model (via
// tools) and every open player tab. "Playing" appends to it and plays from there.

export interface QueueState {
  tracks: Track[];
  current: number;   // index of the track to play (−1 = none)
  serial: number;    // bumps whenever the track list changes
  playSerial: number; // bumps whenever a new "play now" command is issued
  paused: boolean;
  pauseTime: number; // last-seen playback position (seconds) when paused
}

const Q: QueueState = { tracks: [], current: -1, serial: 0, playSerial: 0, paused: false, pauseTime: 0 };

function queueSnapshot(): QueueState {
  return {
    tracks: Q.tracks.slice(),
    current: Q.current,
    serial: Q.serial,
    playSerial: Q.playSerial,
    paused: Q.paused,
    pauseTime: Q.pauseTime,
  };
}

/** Append tracks; when `play`, jump playback to the first newly-added track. */
export function queueEnqueue(newTracks: Track[], play: boolean): QueueState {
  if (newTracks.length) {
    const at = Q.tracks.length;
    Q.tracks = Q.tracks.concat(newTracks);
    Q.serial++;
    if (play) { Q.current = at; Q.playSerial++; }
    else if (Q.current < 0) Q.current = at; // first ever add: cue it but don't autoplay
  }
  return queueSnapshot();
}

export function queuePlay(index: number): QueueState {
  if (index >= 0 && index < Q.tracks.length) { Q.current = index; Q.playSerial++; }
  return queueSnapshot();
}

export function queueRemove(index: number): QueueState {
  if (index >= 0 && index < Q.tracks.length) {
    Q.tracks = Q.tracks.slice(0, index).concat(Q.tracks.slice(index + 1));
    if (index < Q.current) Q.current--;
    else if (index === Q.current) Q.current = Math.min(Q.current, Q.tracks.length - 1);
    Q.serial++;
  }
  return queueSnapshot();
}

export function queueClear(): QueueState {
  Q.tracks = []; Q.current = -1; Q.serial++; Q.playSerial++;
  Q.paused = true; Q.pauseTime = 0;
  return queueSnapshot();
}

export function queuePause(): QueueState {
  Q.paused = true;
  return queueSnapshot();
}

export function queueResume(
  currentTime: number,
  currentTrack: number,
): QueueState {
  if (currentTrack >= 0 && currentTrack < Q.tracks.length) {
    Q.current = currentTrack;
    Q.paused = false;
    Q.pauseTime = currentTime;
    Q.playSerial++;
  } else if (currentTrack < 0 && Q.tracks.length > 0) {
    Q.current = 0;
    Q.paused = false;
    Q.pauseTime = currentTime;
    Q.playSerial++;
  } else {
    Q.paused = false;
    Q.pauseTime = 0;
  }
  return queueSnapshot();
}

// ── path safety ────────────────────────────────────────────────────────────

export function pathAllowed(target: string, allowedDirs: string[]): boolean {
  const abs = resolvePath(target);
  return allowedDirs.some((base) => {
    const b = resolvePath(base);
    return abs === b || abs.startsWith(b + sep);
  });
}

function toTrack(absPath: string): Track {
  const name = basename(absPath);
  return {
    path: absPath,
    name,
    title: name.replace(/\.[^.]+$/, ''),
    album: basename(dirname(absPath)),
  };
}

// ── library walking (shared by tools + HTTP server) ──────────────────────────

async function walkAudio(dir: string, out: string[], depth = 0): Promise<void> {
  if (depth > 12) return;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = resolvePath(dir, e.name);
    if (e.isDirectory()) {
      await walkAudio(full, out, depth + 1);
    } else if (AUDIO_EXTS.has(extname(e.name).toLowerCase())) {
      out.push(full);
    }
  }
}

/** Build a flat, sorted playlist from a directory (recursively) or a single file. */
export async function buildPlaylist(target: string, allowedDirs: string[]): Promise<Track[]> {
  const abs = resolvePath(target);
  if (!pathAllowed(abs, allowedDirs)) return [];
  let info;
  try {
    info = await stat(abs);
  } catch {
    return [];
  }
  if (info.isFile()) {
    return AUDIO_EXTS.has(extname(abs).toLowerCase()) ? [toTrack(abs)] : [];
  }
  const files: string[] = [];
  await walkAudio(abs, files);
  files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  return files.map(toTrack);
}

export interface BrowseResult {
  path: string;
  dirs: { name: string; path: string }[];
  files: Track[];
}

/** List the immediate children of a directory (sub-dirs + audio files). */
export async function browseDir(target: string, allowedDirs: string[]): Promise<BrowseResult> {
  const abs = target === 'root' ? '' : resolvePath(target);
  // "root" lists the configured allowed dirs themselves.
  if (!target || target === 'root') {
    return {
      path: 'root',
      dirs: allowedDirs.map((d) => ({ name: basename(d) || d, path: resolvePath(d) })),
      files: [],
    };
  }
  if (!pathAllowed(abs, allowedDirs)) {
    return { path: abs, dirs: [], files: [] };
  }
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch {
    return { path: abs, dirs: [], files: [] };
  }
  const dirs: { name: string; path: string }[] = [];
  const files: Track[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = resolvePath(abs, e.name);
    if (e.isDirectory()) dirs.push({ name: e.name, path: full });
    else if (AUDIO_EXTS.has(extname(e.name).toLowerCase())) files.push(toTrack(full));
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { path: abs, dirs, files };
}

/** Case-insensitive substring search over file names across all allowed dirs. */
export async function searchFiles(query: string, allowedDirs: string[], limit = 25): Promise<Track[]> {
  const all: string[] = [];
  for (const dir of allowedDirs) await walkAudio(resolvePath(dir), all);
  const q = query.toLowerCase();
  return all
    .filter((p) => p.toLowerCase().includes(q))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .slice(0, limit)
    .map(toTrack);
}

// ── streaming ────────────────────────────────────────────────────────────────

function streamNative(req: IncomingMessage, res: ServerResponse, absPath: string): void {
  let size: number;
  try {
    size = statSync(absPath).size;
  } catch {
    res.writeHead(404); res.end('Not found'); return;
  }
  const ext = extname(absPath).toLowerCase();
  const contentType = MIME[ext] ?? 'application/octet-stream';
  const range = req.headers['range'];
  if (range) {
    const [s, e] = range.replace('bytes=', '').split('-');
    const start = parseInt(s, 10) || 0;
    const end = e ? parseInt(e, 10) : size - 1;
    if (start >= size || end >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(end - start + 1),
      'Content-Type': contentType,
    });
    createReadStream(absPath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': String(size),
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
    });
    createReadStream(absPath).pipe(res);
  }
}

/** Transcode anything ffmpeg understands to a progressive MP3 stream (for odd formats). */
function streamTranscoded(req: IncomingMessage, res: ServerResponse, absPath: string): void {
  res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
  const ff = spawn('ffmpeg', [
    '-loglevel', 'error', '-i', absPath,
    '-vn', '-c:a', 'libmp3lame', '-q:a', '4', '-f', 'mp3', 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  ff.stdout.pipe(res);
  ff.on('error', () => res.destroy());
  req.on('close', () => ff.kill());
}

// ── HTTP request handler (exported for testing without a live socket) ─────────

export function handleMusicRequest(
  req: IncomingMessage,
  res: ServerResponse,
  allowedDirs: string[],
  mount = '',
): void | Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  // Strip the mount prefix so routes are matched relative to where we're mounted.
  let route = url.pathname;
  if (mount && (route === mount || route.startsWith(mount + '/'))) {
    route = route.slice(mount.length) || '/';
  }
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (route === '/' || route === '/player') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PLAYER_HTML);
    return;
  }

  if (route === '/api/dirs') {
    return json(200, allowedDirs.map((d) => ({ name: basename(d) || d, path: resolvePath(d) })));
  }

  if (route === '/api/browse') {
    return browseDir(url.searchParams.get('path') ?? 'root', allowedDirs).then((r) => json(200, r));
  }

  if (route === '/api/playlist') {
    const p = url.searchParams.get('path');
    if (!p) return json(400, { error: 'path required' });
    return buildPlaylist(p, allowedDirs).then((tracks) =>
      json(200, { path: resolvePath(p), tracks }),
    );
  }

  if (route === '/api/search') {
    const q = url.searchParams.get('q') ?? '';
    const limit = parseInt(url.searchParams.get('limit') ?? '25', 10);
    if (!q) return json(400, { error: 'q required' });
    return searchFiles(q, allowedDirs, limit).then((tracks) => json(200, { tracks }));
  }

  if (route === '/stream') {
    const p = url.searchParams.get('path');
    if (!p || !pathAllowed(resolvePath(p), allowedDirs)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    const abs = resolvePath(p);
    if (url.searchParams.get('transcode') === '1') return streamTranscoded(req, res, abs);
    return streamNative(req, res, abs);
  }

  // ── shared queue ──
  if (route === '/api/queue') {
    return json(200, queueSnapshot());
  }
  if (route === '/api/queue/add') {
    const p = url.searchParams.get('path');
    const play = url.searchParams.get('play') !== '0';
    if (!p) return json(400, { error: 'path required' });
    return buildPlaylist(p, allowedDirs).then((tracks) => json(200, queueEnqueue(tracks, play)));
  }
  if (route === '/api/queue/play') {
    return json(200, queuePlay(parseInt(url.searchParams.get('index') ?? '-1', 10)));
  }
  if (route === '/api/queue/remove') {
    return json(200, queueRemove(parseInt(url.searchParams.get('index') ?? '-1', 10)));
  }
  if (route === '/api/queue/clear') {
    return json(200, queueClear());
  }
  if (route === '/api/queue/pause') {
    return json(200, queuePause());
  }
  if (route === '/api/queue/resume') {
    const t = parseFloat(url.searchParams.get('time') ?? '0');
    const i = parseInt(url.searchParams.get('track') ?? '-1', 10);
    return json(200, queueResume(t, i));
  }

  res.writeHead(404); res.end('Not found');
}

// ── self-contained browser player UI ─────────────────────────────────────────

const PLAYER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>leatherHarness · Music</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  :root { --bg:#0a0a0a; --panel:#141414; --panel2:#1c1c1c; --accent:#00cc88; --text:#e0e0e0; --dim:#888; }
  html, body { overflow: hidden; }
  body { background: var(--bg); color: var(--text); font-family: system-ui, -apple-system, sans-serif; height: 100vh; height: 100dvh; display: flex; flex-direction: column; }
  main, .sidebar, .queue, .now { min-width: 0; }
  header { padding: 14px 20px; background: var(--panel); display: flex; align-items: center; gap: 14px; border-bottom: 1px solid #222; }
  header h1 { font-size: 16px; font-weight: 600; }
  header h1 span { color: var(--accent); }
  .libtoggle { background: var(--panel2); border: 1px solid #2a2a2a; color: var(--text); font-size: 16px; line-height: 1; cursor: pointer; width: 34px; height: 34px; border-radius: 8px; flex: none; transition: color .15s, border-color .15s; }
  .libtoggle:hover { color: var(--accent); border-color: var(--accent); }
  .libtoggle.on { color: var(--accent); border-color: var(--accent); }
  .search { margin-left: auto; display: flex; gap: 8px; }
  .search input { background: var(--panel2); border: 1px solid #2a2a2a; color: var(--text); padding: 8px 12px; border-radius: 8px; width: 220px; outline: none; }
  .search input:focus { border-color: var(--accent); }
  main { flex: 1; display: grid; grid-template-columns: 280px 1fr; min-height: 0; }
  /* Collapsed library: works for both the desktop grid and the mobile flex column. */
  main.libhidden { grid-template-columns: 1fr; }
  main.libhidden .sidebar { display: none; }
  .sidebar { background: var(--panel); border-right: 1px solid #222; overflow-y: auto; padding: 10px; }
  .crumbs { font-size: 12px; color: var(--dim); padding: 4px 8px 10px; word-break: break-all; }
  .row { padding: 9px 10px; border-radius: 7px; cursor: pointer; display: flex; align-items: center; gap: 9px; font-size: 13px; }
  .row:hover { background: var(--panel2); }
  .row .ic { color: var(--accent); width: 16px; text-align: center; flex: none; }
  .row .meta { color: var(--dim); margin-left: auto; font-size: 11px; }
  .queue { overflow-y: auto; padding: 10px; }
  .queue-head { display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; }
  .queue h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--dim); }
  .qclear { background: none; border: 1px solid var(--border, #252525); color: var(--dim); font-size: 11px; padding: 3px 9px; border-radius: 6px; cursor: pointer; }
  .qclear:hover { color: var(--text); border-color: #3a3a3a; }
  .qx { background: none; border: none; color: var(--dim); cursor: pointer; font-size: 13px; padding: 2px 4px; line-height: 1; flex: none; opacity: 0; }
  .row:hover .qx, .track:hover .qx { opacity: .7; }
  .qx:hover { opacity: 1 !important; color: var(--accent); }
  .track { padding: 9px 12px; border-radius: 7px; cursor: pointer; display: flex; align-items: center; gap: 10px; font-size: 13px; }
  .track:hover { background: var(--panel2); }
  .track.active { background: #0d2035; box-shadow: inset 3px 0 0 var(--accent); }
  .track .num { color: var(--dim); width: 22px; text-align: right; font-variant-numeric: tabular-nums; flex: none; }
  .track .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .track .al { color: var(--dim); margin-left: auto; font-size: 11px; flex: none; }
  .track.active .num { color: var(--accent); }
  .empty { color: var(--dim); padding: 24px; text-align: center; font-size: 13px; }
  footer { background: var(--panel); border-top: 1px solid #222; padding: 6px 16px; display: flex; align-items: center; gap: 14px; }
  .now { min-width: 0; flex: 1; }
  .now .nt { font-size: 13px; color: var(--accent); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .now .na { font-size: 11px; color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ctrls { display: flex; align-items: center; gap: 2px; }
  .btn { background: none; border: none; color: var(--text); font-size: 15px; cursor: pointer; width: 30px; height: 30px; border-radius: 50%; transition: background .15s, color .15s; }
  .btn:hover { background: var(--panel2); }
  .btn.play { background: var(--accent); color: #08130d; font-size: 15px; width: 32px; height: 32px; }
  .btn.play:hover { opacity: .9; background: var(--accent); }
  .btn.on { color: var(--accent); }
  .seek { flex: 2; display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--dim); font-variant-numeric: tabular-nums; }
  input[type=range] { -webkit-appearance: none; appearance: none; height: 4px; background: #2a2a2a; border-radius: 3px; outline: none; cursor: pointer; }
  input[type=range].bar { flex: 1; }
  input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 11px; height: 11px; background: var(--accent); border-radius: 50%; }
  input[type=range]::-moz-range-thumb { width: 11px; height: 11px; background: var(--accent); border: none; border-radius: 50%; }
  .vol { width: 90px; }

  /* ── mobile: single column, compact single-row footer, fits the viewport ── */
  @media (max-width: 680px) {
    header { padding: 10px 12px; gap: 10px; }
    header h1 { font-size: 14px; }
    .search { margin-left: auto; flex: 1; min-width: 0; max-width: 200px; }
    .search input { width: 100%; padding: 7px 10px; }
    /* Library on top, queue below — each scrolls on its own, page never scrolls. */
    main { display: flex; flex-direction: column; }
    .sidebar { border-right: none; border-bottom: 1px solid #222; max-height: 40vh; flex: none; }
    .queue { flex: 1; }
    /* Keep transport + seek on one compact row; now-playing wraps above it. */
    footer { flex-wrap: wrap; gap: 4px 10px; padding: 6px 12px; padding-bottom: max(6px, env(safe-area-inset-bottom, 6px)); }
    .now { flex: 1 1 100%; order: 1; }
    .now .na { display: none; }   /* title alone is enough on a phone */
    .seek { flex: 1 1 auto; order: 3; }
    .ctrls { order: 2; gap: 2px; flex: none; }
    .vol { display: none; }   /* use the device's own volume control */
  }
</style>
</head>
<body>
  <header>
    <button id="back" class="libtoggle" title="Back to leatherHarness">←</button>
    <button id="toggleLib" class="libtoggle" title="Show/hide library">☰</button>
    <h1>leather<span>Harness</span> · music</h1>
    <div class="search">
      <input id="search" type="search" placeholder="Search tracks…" autocomplete="off">
    </div>
  </header>
  <main>
    <div class="sidebar" id="sidebar">
      <div class="crumbs" id="crumbs">Loading…</div>
      <div id="browser"></div>
    </div>
    <div class="queue">
      <div class="queue-head">
        <h2 id="queueTitle">Queue</h2>
        <button id="clearQueue" class="qclear" title="Clear queue">Clear</button>
      </div>
      <div id="queue"><div class="empty">Queue is empty. Play something here, or ask the model to.</div></div>
    </div>
  </main>
  <footer>
    <div class="now">
      <div class="nt" id="nowTitle">Nothing playing</div>
      <div class="na" id="nowAlbum"></div>
    </div>
    <div class="seek">
      <span id="cur">0:00</span>
      <input class="bar" id="seek" type="range" min="0" max="1000" value="0">
      <span id="dur">0:00</span>
    </div>
    <div class="ctrls">
      <button class="btn" id="shuffle" title="Shuffle">🔀</button>
      <button class="btn" id="prev" title="Previous">⏮</button>
      <button class="btn play" id="play" title="Play/Pause">▶</button>
      <button class="btn" id="next" title="Next">⏭</button>
      <button class="btn" id="repeat" title="Repeat">🔁</button>
    </div>
    <input class="vol" id="vol" type="range" min="0" max="100" value="100" title="Volume">
  </footer>
  <audio id="audio"></audio>
<script>
const $ = (id) => document.getElementById(id);
const audio = $('audio');
// Derive our mount point from the URL the browser actually loaded, so every
// request goes back to the same origin/path the page was served from.
const BASE = location.pathname.replace(/\\/player$/, '');
let tracks = [];       // the shared server queue (Track[])
let order = [];        // playback order: indices into tracks
let curTI = -1;        // true index currently loaded into <audio>
let seenSerial = -1, seenPlay = -1;
let shuffle = false, repeat = false;

const fmt = (s) => {
  if (!isFinite(s)) return '0:00';
  s = Math.floor(s);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};
const streamUrl = (t) => BASE + '/stream?path=' + encodeURIComponent(t.path);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

async function getJSON(u, opts) { const r = await fetch(u, opts); return r.json(); }
const post = (u) => getJSON(BASE + u, { method: 'POST' });

function rebuildOrder() {
  order = tracks.map((_, i) => i);
  if (shuffle) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const at = order.indexOf(curTI);
    if (at > 0) [order[0], order[at]] = [order[at], order[0]];
  }
}

function renderQueue() {
  const q = $('queue');
  $('queueTitle').textContent = tracks.length ? 'Queue · ' + tracks.length : 'Queue';
  if (!tracks.length) { q.innerHTML = '<div class="empty">Queue is empty. Play something here, or ask the model to.</div>'; return; }
  q.innerHTML = '';
  tracks.forEach((t, i) => {
    const el = document.createElement('div');
    el.className = 'track' + (i === curTI ? ' active' : '');
    el.innerHTML = '<span class="num">' + (i + 1) + '</span>' +
      '<span class="t">' + esc(t.title) + '</span>' +
      '<span class="al">' + esc(t.album) + '</span>' +
      '<button class="qx" title="Remove">✕</button>';
    el.querySelector('.t').onclick = () => playIndex(i);
    el.querySelector('.num').onclick = () => playIndex(i);
    el.querySelector('.qx').onclick = (e) => { e.stopPropagation(); removeIndex(i); };
    q.appendChild(el);
  });
}

// Lock-screen / Control-Center metadata (also what keeps iOS happy in the
// background) via the Media Session API.
const ms = navigator.mediaSession;
function setMetadata(t) {
  if (!ms || typeof MediaMetadata === 'undefined') return;
  try {
    ms.metadata = new MediaMetadata({
      title: t.title,
      artist: t.album || '',
      album: 'leatherHarness',
      artwork: [{ src: location.origin + '/logo.jpg', sizes: '512x512', type: 'image/jpeg' }],
    });
  } catch (e) {}
}
function updatePosition() {
  if (!ms || !ms.setPositionState || !isFinite(audio.duration) || !audio.duration) return;
  try { ms.setPositionState({ duration: audio.duration, playbackRate: audio.playbackRate || 1, position: audio.currentTime }); } catch (e) {}
}

// Load + play a specific true index locally.
function loadAndPlay(ti) {
  const t = tracks[ti];
  if (!t) return;
  curTI = ti;
  audio.src = streamUrl(t);
  $('nowTitle').textContent = t.title;
  $('nowAlbum').textContent = t.album;
  document.title = t.title + ' · music';
  renderQueue();
  setMetadata(t);
  // Browsers may block autoplay without a gesture; if so the user just presses ▶.
  audio.play().catch(() => {});
}

// Adopt a server queue snapshot. If the list changed, re-render; if a new play
// command was issued (playSerial bumped), jump to and play the server's current.
function applyState(st) {
  const listChanged = st.serial !== seenSerial;
  const playChanged = st.playSerial !== seenPlay;
  seenSerial = st.serial; seenPlay = st.playSerial;
  if (listChanged) { tracks = st.tracks || []; rebuildOrder(); renderQueue(); }
  if (playChanged) {
    if (st.current >= 0 && st.current < tracks.length) {
      if (!order.includes(st.current)) rebuildOrder();
      loadAndPlay(st.current);
    } else { audio.pause(); audio.removeAttribute('src'); curTI = -1; renderQueue(); }
  }
}

// All queue mutations go through the server — one shared source of truth.
async function playIndex(i)   { applyState(await post('/api/queue/play?index=' + i)); }
async function removeIndex(i) { applyState(await post('/api/queue/remove?index=' + i)); }
async function clearQueue()   { applyState(await post('/api/queue/clear')); }
async function addPath(p, play) { applyState(await post('/api/queue/add?play=' + (play ? '1' : '0') + '&path=' + encodeURIComponent(p))); }
async function refresh()      { try { applyState(await getJSON(BASE + '/api/queue')); } catch (e) {} }

function next() {
  if (!tracks.length) return;
  const lp = order.indexOf(curTI);
  if (lp < order.length - 1) playIndex(order[lp + 1]);
  else if (repeat) playIndex(order[0]);
  else audio.pause();
}
function prev() {
  if (!tracks.length) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  const lp = order.indexOf(curTI);
  if (lp > 0) playIndex(order[lp - 1]);
  else audio.currentTime = 0;
}

// ── library browser ──
let crumbStack = [];
function trackRow(f) {
  const el = document.createElement('div');
  el.className = 'row';
  el.innerHTML = '<span class="ic">♪</span><span class="t">' + esc(f.title) + '</span>' +
    '<span class="meta">' + esc(f.album || '') + '</span>' +
    '<button class="qx" title="Add to queue">＋</button>';
  el.querySelector('.t').onclick = () => addPath(f.path, true);   // play now (adds + plays)
  el.querySelector('.ic').onclick = () => addPath(f.path, true);
  el.querySelector('.qx').onclick = (e) => { e.stopPropagation(); addPath(f.path, false); }; // enqueue
  return el;
}
function actionRow(ic, label, onclick) {
  const el = document.createElement('div');
  el.className = 'row';
  el.innerHTML = '<span class="ic">' + ic + '</span><span>' + label + '</span>';
  el.onclick = onclick;
  return el;
}
async function openBrowse(path) {
  const data = await getJSON(BASE + '/api/browse?path=' + encodeURIComponent(path));
  const b = $('browser');
  b.innerHTML = '';
  $('crumbs').textContent = path === 'root' ? 'Library' : data.path;

  if (path !== 'root') {
    b.appendChild(actionRow('↩', '..', () => { crumbStack.pop(); openBrowse(crumbStack[crumbStack.length - 1] || 'root'); }));
    b.appendChild(actionRow('▶', 'Play this folder', () => addPath(data.path, true)));
    b.appendChild(actionRow('＋', 'Queue this folder', () => addPath(data.path, false)));
  }
  data.dirs.forEach((d) => {
    b.appendChild(actionRow('📁', esc(d.name), () => { crumbStack.push(d.path); openBrowse(d.path); }));
  });
  data.files.forEach((f) => b.appendChild(trackRow(f)));
  if (!data.dirs.length && !data.files.length) b.innerHTML += '<div class="empty">Empty folder.</div>';
}

// ── search ──
let searchTimer;
$('search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (!q) return;
  searchTimer = setTimeout(async () => {
    const data = await getJSON(BASE + '/api/search?q=' + encodeURIComponent(q));
    const b = $('browser');
    $('crumbs').textContent = data.tracks.length + ' result(s) for "' + q + '"';
    b.innerHTML = '';
    data.tracks.forEach((f) => b.appendChild(trackRow(f)));
    if (!data.tracks.length) b.innerHTML = '<div class="empty">No matches.</div>';
  }, 250);
});

// ── transport wiring ──
$('play').onclick = () => { if (!tracks.length) return; if (audio.paused) audio.play().catch(() => {}); else audio.pause(); };
$('next').onclick = next;
$('prev').onclick = prev;
$('shuffle').onclick = () => { shuffle = !shuffle; $('shuffle').classList.toggle('on', shuffle); rebuildOrder(); };
$('repeat').onclick = () => { repeat = !repeat; $('repeat').classList.toggle('on', repeat); };
$('vol').oninput = (e) => { audio.volume = e.target.value / 100; };
$('clearQueue').onclick = clearQueue;
// Back to the main harness UI. When embedded as the SPA's full-screen overlay,
// ask the parent to close it; otherwise fall back to history / harness root.
$('back').onclick = () => {
  if (window.parent !== window) {
    window.parent.postMessage('lh:close-overlay', location.origin);
  } else if (window.history.length > 1 && document.referrer && new URL(document.referrer).origin === location.origin) {
    history.back();
  } else {
    location.href = '/';
  }
};
// Show/hide the library sidebar (desktop + mobile), remembering the choice.
const mainEl = document.querySelector('main');
function setLibHidden(hidden) {
  mainEl.classList.toggle('libhidden', hidden);
  $('toggleLib').classList.toggle('on', !hidden);
  try { localStorage.setItem('lh.music.libHidden', hidden ? '1' : '0'); } catch (e) {}
}
$('toggleLib').onclick = () => setLibHidden(!mainEl.classList.contains('libhidden'));
try { setLibHidden(localStorage.getItem('lh.music.libHidden') === '1'); } catch (e) { setLibHidden(false); }
// Lock-screen / Control-Center controls so playback keeps going (and is
// controllable) when iOS Safari is backgrounded or the phone is locked.
if (ms) {
  const set = (a, fn) => { try { ms.setActionHandler(a, fn); } catch (e) {} };
  set('play', () => audio.play().catch(() => {}));
  set('pause', () => audio.pause());
  set('previoustrack', () => prev());
  set('nexttrack', () => next());
  set('seekto', (d) => { if (d.seekTime != null) audio.currentTime = d.seekTime; });
}
// Drive the play/pause icon (and OS playback state) from the real audio state.
audio.addEventListener('play', () => { $('play').textContent = '⏸'; if (ms) ms.playbackState = 'playing'; });
audio.addEventListener('pause', () => { $('play').textContent = '▶'; if (ms) ms.playbackState = 'paused'; });
audio.addEventListener('ended', () => (repeat && order.length === 1) ? loadAndPlay(curTI) : next());
audio.addEventListener('timeupdate', () => {
  $('cur').textContent = fmt(audio.currentTime);
  if (audio.duration) $('seek').value = (audio.currentTime / audio.duration) * 1000;
  updatePosition();
});
audio.addEventListener('loadedmetadata', () => { $('dur').textContent = fmt(audio.duration); updatePosition(); });
$('seek').addEventListener('input', (e) => { if (audio.duration) audio.currentTime = (e.target.value / 1000) * audio.duration; });

// ── boot: a deep-link ?path= enqueues + plays; then poll the shared queue so
// tracks the model adds while the page is open appear (and play) automatically.
(async () => {
  const path = new URLSearchParams(location.search).get('path');
  if (path) { try { await addPath(path, true); } catch (e) { console.error('deep-link failed', e); } }
  else { await refresh(); }
  try { await openBrowse('root'); } catch (e) { console.error('browse failed', e); }
  setInterval(refresh, 2000);
})();
</script>
</body>
</html>`;

// ── plugin wiring ────────────────────────────────────────────────────────────

let routeRegistered = false;

export function setup(cfg: PluginConfig<MusicConfig>) {
  async function dirs(): Promise<string[]> {
    const { allowedDirs = [] } = await cfg.get();
    return allowedDirs.map((d) => resolvePath(d));
  }

  // The player UI lives at <harness>/music/player — same origin the browser is
  // already on, so there's no second server, port, or host to configure.
  function playerBase(): string {
    return `${harnessBaseUrl()}${MOUNT}`;
  }

  // Mount the streaming + player routes on the main harness server. allowedDirs
  // are read fresh on every request so config edits take effect live.
  if (!routeRegistered) {
    routeRegistered = true;
    registerHttpRoute(MOUNT, async (req, res) => {
      await handleMusicRequest(req, res, await dirs(), MOUNT);
    });
    // Contribute a UI icon that opens the player. Relative URL → same origin the
    // browser is already on, so it works regardless of host.
    registerUiIcon({
      id: 'music',
      title: 'Open music player',
      icon: '🎵',
      // The SPA renders its own music window via the client-side UI-plugin
      // registry (see src/ui/plugin-registry.tsx), keyed on this icon's id. The
      // `open` action is the fallback for non-SPA clients: the standalone
      // server-rendered player page.
      run: () => ({ open: `${MOUNT}/player` }),
    });
  }

  registerNativeTool({
    name: 'music_list_dirs',
    description: 'List the allowed music library directories configured in leatherHarness.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => JSON.stringify(await dirs(), null, 2),
  });

  registerNativeTool({
    name: 'music_info',
    description: 'Describe the browser music streaming service: the player URL, supported formats, and the library roots.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      return JSON.stringify({
        name: 'music',
        player: `${playerBase()}/player`,
        howItWorks: 'Streams local audio to the browser (HTTP range requests), the same idea as casting but the receiver is a web page. Supports playlists built from any folder.',
        supportedFormats: [...AUDIO_EXTS].map((e) => e.slice(1)),
        allowedDirs: await dirs(),
      }, null, 2);
    },
  });

  registerNativeTool({
    name: 'music_browse',
    description: 'Browse the music library. Pass "root" for the configured library folders, or a full directory path to list its sub-folders and audio files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to browse, or "root" for the top level.' },
      },
      required: [],
    },
    execute: async ({ path }: { path?: string }) =>
      JSON.stringify(await browseDir(path ?? 'root', await dirs()), null, 2),
  });

  registerNativeTool({
    name: 'music_search',
    description: 'Search the library for audio files whose path/name matches a query.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term (artist, album, or track name).' },
        limit: { type: 'number', description: 'Max results (default 25).' },
      },
      required: ['query'],
    },
    execute: async ({ query, limit = 25 }: { query: string; limit?: number }) => {
      const hits = await searchFiles(query, await dirs(), limit);
      if (!hits.length) return `No matches found for "${query}".`;
      return JSON.stringify(hits, null, 2);
    },
  });

  registerNativeTool({
    name: 'music_play',
    description: 'Play music in the browser. Adds the track/folder to the shared playback queue and starts playing from there (the queue keeps any tracks already in it). Give a single file or a folder (added recursively). Returns the player URL to open.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Full path to a music file or a directory to add and play.' },
      },
      required: ['path'],
    },
    execute: async ({ path }: { path: string }) => {
      const tracks = await buildPlaylist(path, await dirs());
      if (!tracks.length) return `Nothing playable at "${path}" (or it is outside the allowed dirs).`;
      const state = queueEnqueue(tracks, true);
      const url = `${playerBase()}/player`;
      return `Added ${tracks.length} track(s) and started playing from there. Queue now has ${state.tracks.length} track(s).\nOpen/keep the player at: ${url}`;
    },
  });

  registerNativeTool({
    name: 'music_queue_add',
    description: 'Add a track or folder to the end of the shared playback queue WITHOUT interrupting what is currently playing. Use this to queue up music for later.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Full path to a music file or a directory to enqueue.' },
      },
      required: ['path'],
    },
    execute: async ({ path }: { path: string }) => {
      const tracks = await buildPlaylist(path, await dirs());
      if (!tracks.length) return `Nothing playable at "${path}" (or it is outside the allowed dirs).`;
      const state = queueEnqueue(tracks, false);
      return `Queued ${tracks.length} track(s). Queue now has ${state.tracks.length} track(s).`;
    },
  });

  registerNativeTool({
    name: 'music_queue_show',
    description: 'Show the current shared playback queue and which track is playing.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      const s = queueSnapshot();
      if (!s.tracks.length) return 'The queue is empty.';
      return JSON.stringify({
        count: s.tracks.length,
        nowPlaying: s.current >= 0 ? s.tracks[s.current]?.title : null,
        tracks: s.tracks.map((t, i) => ({ i, title: t.title, album: t.album, playing: i === s.current })),
      }, null, 2);
    },
  });

  registerNativeTool({
    name: 'music_queue_clear',
    description: 'Empty the shared playback queue and stop playback.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => { queueClear(); return 'Queue cleared.'; },
  });

  registerNativeTool({
    name: 'music_player_ui',
    description: 'Return the URL of the browser music player, which shows the shared queue. Optionally pass a path to add+play it when the player opens.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Optional folder or file to add and play when the player opens.' },
      },
      required: [],
    },
    execute: async ({ path }: { path?: string }) => {
      const base = playerBase();
      if (!path) return `${base}/player`;
      return `${base}/player?path=${encodeURIComponent(resolvePath(path))}`;
    },
  });
}
