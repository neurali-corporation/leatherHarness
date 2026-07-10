import { registerNativeTool } from '../../src/registry.ts';
import { registerPluginRoute } from '../../src/http-registry.ts';
import { registerUiIcon } from '../../src/ui-registry.ts';
import { harnessBaseUrl } from '../../src/runtime.ts';
import type { PluginConfig } from '../../src/plugin-loader.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { stat, readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve as resolvePath, extname, basename, dirname, sep, join } from 'node:path';
import { spawn } from 'node:child_process';

// Path the player UI + streaming routes are mounted at on the main harness server.
const MOUNT = '/api/plugin/music';

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

// ── playlist storage ─────────────────────────────────────────────────────────
// Playlists are named, ordered lists of track paths, persisted on disk inside
// the plugin's own directory (`<plugin dir>/playlists/<name>.json`) so they
// survive restarts. Every operation is keyed by playlist name; when no name is
// given we fall back to a "default" playlist, creating it on first use. There is
// deliberately no hidden "current playlist" state — each call names its target,
// which keeps the model tools and the UI from stepping on each other.

export interface Playlist {
  name: string;
  tracks: string[];  // absolute file paths, in order
}

// Set by setup() from the directory the app assigns this plugin (cfg.dir) — we
// don't decide our own absolute path. Playlists live under `<plugin dir>/playlists`.
let PLAYLISTS_DIR = '';

const DEFAULT_PLAYLIST = 'default';

// Turn a user/model-supplied name into a safe file base: no path separators or
// traversal, trimmed, non-empty. Purely presentational chars are kept as-is.
export function safePlaylistName(name: string | null | undefined): string {
  const cleaned = (name ?? '').trim().replace(/[/\\]/g, '_').replace(/\.+/g, '.');
  const base = cleaned.replace(/[^A-Za-z0-9 ._-]/g, '_').replace(/^\.+/, '').trim();
  return base.slice(0, 100) || DEFAULT_PLAYLIST;
}

async function ensurePlaylistsDir(): Promise<void> {
  await mkdir(PLAYLISTS_DIR, { recursive: true });
}

async function readPlaylistFile(name: string): Promise<Playlist | null> {
  try {
    const raw = await readFile(join(PLAYLISTS_DIR, `${name}.json`), 'utf8');
    const p = JSON.parse(raw) as Playlist;
    if (p && Array.isArray(p.tracks)) return { name, tracks: p.tracks };
    return null;
  } catch { return null; }
}

async function writePlaylistFile(pl: Playlist): Promise<void> {
  await ensurePlaylistsDir();
  await writeFile(join(PLAYLISTS_DIR, `${pl.name}.json`), JSON.stringify(pl, null, 2), 'utf8');
}

/** All playlist names on disk (sorted, without the .json extension). */
export async function listPlaylists(): Promise<string[]> {
  let files: string[] = [];
  try {
    files = await readdir(PLAYLISTS_DIR);
  } catch { /* dir not created yet */ }
  const names = files.filter(f => f.endsWith('.json')).map(f => f.slice(0, -5));
  // "default" always exists conceptually, even before anything is written.
  if (!names.includes(DEFAULT_PLAYLIST)) names.push(DEFAULT_PLAYLIST);
  return names.sort();
}

/** Read a playlist, creating an empty one (persisted) if it doesn't exist yet. */
export async function getPlaylist(name?: string): Promise<Playlist> {
  const safe = safePlaylistName(name);
  const existing = await readPlaylistFile(safe);
  if (existing) return existing;
  const pl: Playlist = { name: safe, tracks: [] };
  await writePlaylistFile(pl);
  return pl;
}

/** Create a new (or reset an existing to empty) playlist. Returns it. */
export async function createPlaylist(name: string): Promise<Playlist> {
  const pl: Playlist = { name: safePlaylistName(name), tracks: [] };
  await writePlaylistFile(pl);
  return pl;
}

/** Delete a playlist by name. The "default" playlist cannot be deleted. */
export async function deletePlaylist(name: string): Promise<boolean> {
  const safe = safePlaylistName(name);
  if (safe === DEFAULT_PLAYLIST) return false;
  try {
    await rm(join(PLAYLISTS_DIR, `${safe}.json`), { force: true });
    return true;
  } catch { return false; }
}

/** Append tracks (by path) to a playlist. Returns the updated playlist. */
export async function addToPlaylist(name: string | undefined, paths: string[]): Promise<Playlist> {
  const pl = await getPlaylist(name);
  pl.tracks.push(...paths);
  await writePlaylistFile(pl);
  return pl;
}

/** Remove a track from a playlist by index. Returns the updated playlist. */
export async function removeFromPlaylist(name: string | undefined, index: number): Promise<Playlist> {
  const pl = await getPlaylist(name);
  if (index >= 0 && index < pl.tracks.length) {
    pl.tracks.splice(index, 1);
    await writePlaylistFile(pl);
  }
  return pl;
}

/** Clear all tracks from a playlist. Returns the (now empty) playlist. */
export async function clearPlaylist(name?: string): Promise<Playlist> {
  const pl = await getPlaylist(name);
  pl.tracks = [];
  await writePlaylistFile(pl);
  return pl;
}

/** Reorder a playlist (move track at `from` to `to`). Returns the playlist. */
export async function reorderPlaylist(name: string | undefined, from: number, to: number): Promise<Playlist> {
  const pl = await getPlaylist(name);
  if (from >= 0 && from < pl.tracks.length && to >= 0 && to < pl.tracks.length) {
    const [track] = pl.tracks.splice(from, 1);
    pl.tracks.splice(to, 0, track);
    await writePlaylistFile(pl);
  }
  return pl;
}

/** Resolve a Playlist's stored paths to Track objects (dropping any now-disallowed). */
export function resolvePlaylistTracks(pl: Playlist, allowedDirs: string[]): Track[] {
  return pl.tracks.filter((p) => pathAllowed(p, allowedDirs)).map(toTrack);
}

/** Resolve a playlist (by name) to Track objects. */
export async function getPlaylistTracks(name: string | undefined, allowedDirs: string[]): Promise<Track[]> {
  return resolvePlaylistTracks(await getPlaylist(name), allowedDirs);
}

// ── playback state ───────────────────────────────────────────────────────────
// There is no separate "queue": playback is always *a playlist*. The server
// tracks which playlist is currently PLAYING (by name) plus a snapshot of its
// tracks and the position within them. This is distinct from whichever playlist
// a given player tab is VIEWING — selecting a tab only changes the view, never
// playback. Playback changes only when a track is played (from any tab). One
// server-side playback state is shared by the model and every open player tab.

export interface PlaybackState {
  playlist: string | null; // name of the playlist currently playing (null = nothing)
  tracks: Track[];         // snapshot of that playlist's resolved tracks
  current: number;         // index of the track to play (−1 = none)
  serial: number;          // bumps whenever the playing track list changes
  playSerial: number;      // bumps whenever a new "play now" command is issued
  paused: boolean;
  pauseTime: number;       // last-seen playback position (seconds) when paused
}

const PB: PlaybackState = {
  playlist: null, tracks: [], current: -1, serial: 0, playSerial: 0, paused: false, pauseTime: 0,
};

export function playbackSnapshot(): PlaybackState {
  return {
    playlist: PB.playlist,
    tracks: PB.tracks.slice(),
    current: PB.current,
    serial: PB.serial,
    playSerial: PB.playSerial,
    paused: PB.paused,
    pauseTime: PB.pauseTime,
  };
}

/**
 * Start playing a named playlist from `index`. Loads a fresh snapshot of the
 * playlist's tracks and makes it the playing playlist. This is the only thing
 * that changes *what* is playing — viewing a tab does not call it.
 */
export async function playPlaylistFrom(
  name: string | undefined, index: number, allowedDirs: string[],
): Promise<PlaybackState> {
  const pl = await getPlaylist(name);
  PB.playlist = pl.name;
  PB.tracks = pl.tracks.filter((p) => pathAllowed(p, allowedDirs)).map(toTrack);
  PB.current = (index >= 0 && index < PB.tracks.length) ? index : (PB.tracks.length ? 0 : -1);
  PB.serial++;
  PB.playSerial++;
  PB.paused = false;
  PB.pauseTime = 0;
  return playbackSnapshot();
}

/** Jump to another track within the already-playing playlist. */
export function playbackPlayIndex(index: number): PlaybackState {
  if (index >= 0 && index < PB.tracks.length) { PB.current = index; PB.playSerial++; PB.paused = false; }
  return playbackSnapshot();
}

/**
 * Reconcile playback after a playlist file changed. If the edited playlist is the
 * one currently playing, refresh its track snapshot so open tabs see the change;
 * keep playing the same track where possible.
 */
export function syncPlaybackWithPlaylist(name: string, tracks: Track[]): PlaybackState {
  if (PB.playlist === name) {
    const playingPath = PB.current >= 0 ? PB.tracks[PB.current]?.path : null;
    PB.tracks = tracks;
    const at = playingPath ? tracks.findIndex((t) => t.path === playingPath) : -1;
    PB.current = at >= 0 ? at : Math.min(PB.current, tracks.length - 1);
    PB.serial++;
  }
  return playbackSnapshot();
}

export function playbackPause(): PlaybackState {
  PB.paused = true;
  return playbackSnapshot();
}

export function playbackResume(currentTime: number, currentTrack: number): PlaybackState {
  if (currentTrack >= 0 && currentTrack < PB.tracks.length) {
    PB.current = currentTrack;
  } else if (PB.current < 0 && PB.tracks.length > 0) {
    PB.current = 0;
  }
  PB.paused = false;
  PB.pauseTime = PB.current >= 0 ? currentTime : 0;
  if (PB.current >= 0) PB.playSerial++;
  return playbackSnapshot();
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

  // ── playlists (all keyed by ?name=, defaulting to "default") ──
  if (route === '/api/playlists') {
    return listPlaylists().then((names) => json(200, names));
  }
  // Read one named playlist (creates "default" on first use).
  if (route === '/api/playlist/get') {
    return getPlaylist(url.searchParams.get('name') ?? undefined).then((pl) => json(200, pl));
  }
  if (route === '/api/playlist/create') {
    const name = url.searchParams.get('name');
    if (!name) return json(400, { error: 'name required' });
    return createPlaylist(name).then((pl) => json(200, pl));
  }
  if (route === '/api/playlist/delete') {
    const name = url.searchParams.get('name');
    if (!name) return json(400, { error: 'name required' });
    return deletePlaylist(name).then((deleted) => json(200, { deleted }));
  }
  // Mutations persist to disk and, if they hit the *playing* playlist, refresh
  // the live playback snapshot so open tabs pick up the change.
  const mutated = (pl: Playlist) => {
    syncPlaybackWithPlaylist(pl.name, resolvePlaylistTracks(pl, allowedDirs));
    return json(200, pl);
  };
  if (route === '/api/playlist/add') {
    const paths = url.searchParams.getAll('path');
    // A path can be a folder — expand it recursively to audio files.
    if (!paths.length) return json(400, { error: 'path required' });
    return Promise.all(paths.map((p) => buildPlaylist(p, allowedDirs)))
      .then((lists) => lists.flat().map((t) => t.path))
      .then((expanded) => addToPlaylist(url.searchParams.get('name') ?? undefined, expanded))
      .then(mutated);
  }
  if (route === '/api/playlist/remove') {
    const index = parseInt(url.searchParams.get('index') ?? '-1', 10);
    return removeFromPlaylist(url.searchParams.get('name') ?? undefined, index).then(mutated);
  }
  if (route === '/api/playlist/clear') {
    return clearPlaylist(url.searchParams.get('name') ?? undefined).then(mutated);
  }
  if (route === '/api/playlist/reorder') {
    const from = parseInt(url.searchParams.get('from') ?? '-1', 10);
    const to = parseInt(url.searchParams.get('to') ?? '-1', 10);
    return reorderPlaylist(url.searchParams.get('name') ?? undefined, from, to).then(mutated);
  }

  // ── playback (always a playlist; separate from the viewed tab) ──
  if (route === '/api/player') {
    return json(200, playbackSnapshot());
  }
  // Start playing a playlist from a given index (default 0). The ONLY action
  // that changes what is playing — viewing/switching a tab does not.
  if (route === '/api/player/play') {
    const index = parseInt(url.searchParams.get('index') ?? '0', 10);
    return playPlaylistFrom(url.searchParams.get('name') ?? undefined, index, allowedDirs)
      .then((st) => json(200, st));
  }
  // Jump to another track within the already-playing playlist.
  if (route === '/api/player/index') {
    return json(200, playbackPlayIndex(parseInt(url.searchParams.get('index') ?? '-1', 10)));
  }
  if (route === '/api/player/pause') {
    return json(200, playbackPause());
  }
  if (route === '/api/player/resume') {
    const t = parseFloat(url.searchParams.get('time') ?? '0');
    const i = parseInt(url.searchParams.get('track') ?? '-1', 10);
    return json(200, playbackResume(t, i));
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
  main, .sidebar, .right, .now { min-width: 0; }
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
  /* Playlist tabs across the top of the right column. */
  .tabs { display: flex; gap: 4px; padding: 8px 8px 0; overflow-x: auto; border-bottom: 1px solid #222; flex: none; }
  .tab { background: var(--panel2); border: 1px solid #2a2a2a; border-bottom: none; color: var(--dim); font-size: 13px; padding: 7px 12px; border-radius: 8px 8px 0 0; cursor: pointer; white-space: nowrap; display: flex; align-items: center; gap: 6px; }
  .tab:hover { color: var(--text); }
  .tab.on { color: var(--accent); border-color: var(--accent); background: var(--bg); }
  .tab .dot { color: var(--accent); font-size: 10px; line-height: 1; }
  .tab.add { font-weight: 600; }
  .right { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
  .tracklist { overflow-y: auto; padding: 10px; flex: 1; }
  .tracklist .qx { opacity: .6; }
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
    .right { flex: 1; min-height: 0; }
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
    <div class="right">
      <div class="tabs" id="tabs"></div>
      <div class="queue-head">
        <h2 id="viewedTitle">default</h2>
        <div style="display:flex;gap:6px">
          <button id="playAll" class="qclear" title="Play this playlist">▶ Play</button>
          <button id="clearPl" class="qclear" title="Clear this playlist">Clear</button>
          <button id="deletePl" class="qclear" title="Delete this playlist" style="display:none">🗑</button>
        </div>
      </div>
      <div class="tracklist" id="tracklist"></div>
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
const enc = encodeURIComponent;

// Two distinct notions: the VIEWED playlist (the selected tab) and the PLAYING
// playlist (server-side playback). Selecting a tab only changes the view — it
// never touches playback. Whatever is playing keeps playing until you click a
// track in a tab. They can be the same or different playlists.
let viewed = 'default';       // selected tab (viewed playlist)
let viewedTracks = [];        // stored paths of the viewed playlist
let plNames = ['default'];    // tab names
let pb = { playlist: null, tracks: [], current: -1, serial: -1, playSerial: -1, paused: true, pauseTime: 0 };
let order = [];               // playback order (indices into pb.tracks) for shuffle
let curTI = -1;               // index in pb.tracks currently loaded into <audio>
let seenSerial = -1, seenPlay = -1;
let shuffle = false, repeat = false;

const fmt = (s) => {
  if (!isFinite(s)) return '0:00';
  s = Math.floor(s);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};
const streamUrl = (t) => BASE + '/stream?path=' + enc(t.path);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const titleOf = (p) => (String(p).split('/').pop() || p).replace(/\\.[^.]+$/, '');
async function getJSON(u, opts) { const r = await fetch(u, opts); return r.json(); }

// ── playlist tabs ──
async function loadTabs() { try { plNames = await getJSON(BASE + '/api/playlists'); } catch (e) {} renderTabs(); }
function renderTabs() {
  const host = $('tabs');
  host.innerHTML = '';
  plNames.forEach((name) => {
    const el = document.createElement('div');
    el.className = 'tab' + (name === viewed ? ' on' : '');
    // A ● marks the playlist that is currently PLAYING (may differ from viewed).
    el.innerHTML = (pb.playlist === name ? '<span class="dot">●</span>' : '') + '<span>' + esc(name) + '</span>';
    el.onclick = () => selectTab(name);
    host.appendChild(el);
  });
  const add = document.createElement('div');
  add.className = 'tab add';
  add.textContent = '＋';
  add.title = 'New playlist';
  add.onclick = createPlaylistUI;
  host.appendChild(add);
}
async function selectTab(name) { viewed = name; await renderViewed(); renderTabs(); }

// ── viewed playlist (the selected tab) ──
async function renderViewed() {
  let pl = { name: viewed, tracks: [] };
  try { pl = await getJSON(BASE + '/api/playlist/get?name=' + enc(viewed)); } catch (e) {}
  viewed = pl.name || viewed;
  viewedTracks = pl.tracks || [];
  $('viewedTitle').textContent = viewed + (viewedTracks.length ? ' · ' + viewedTracks.length : '');
  $('deletePl').style.display = viewed === 'default' ? 'none' : '';
  const host = $('tracklist');
  host.innerHTML = '';
  if (!viewedTracks.length) {
    host.innerHTML = '<div class="empty">Empty playlist. Add tracks from the library, or ask the model to.</div>';
    return;
  }
  viewedTracks.forEach((p, i) => {
    // Highlight the row only if this playlist is the one actually playing.
    const playingHere = pb.playlist === viewed && i === pb.current;
    const el = document.createElement('div');
    el.className = 'track' + (playingHere ? ' active' : '');
    el.innerHTML = '<span class="num">' + (i + 1) + '</span>' +
      '<span class="t">' + esc(titleOf(p)) + '</span>' +
      '<button class="qx" title="Remove">✕</button>';
    el.querySelector('.t').onclick = () => playViewed(i);
    el.querySelector('.num').onclick = () => playViewed(i);
    el.querySelector('.qx').onclick = (e) => { e.stopPropagation(); removeFromViewed(i); };
    host.appendChild(el);
  });
}

// Play the VIEWED playlist from the given index — this is what switches playback.
async function playViewed(index) { applyPB(await getJSON(BASE + '/api/player/play?name=' + enc(viewed) + '&index=' + index)); }
async function removeFromViewed(i) {
  await getJSON(BASE + '/api/playlist/remove?name=' + enc(viewed) + '&index=' + i);
  await renderViewed();
}
async function clearViewed() {
  if (!confirm('Clear playlist "' + viewed + '"?')) return;
  await getJSON(BASE + '/api/playlist/clear?name=' + enc(viewed));
  await renderViewed();
}
async function createPlaylistUI() {
  const name = prompt('New playlist name:');
  if (!name || !name.trim()) return;
  await getJSON(BASE + '/api/playlist/create?name=' + enc(name.trim()));
  await loadTabs();
  await selectTab(name.trim());
}
async function deleteViewed() {
  if (viewed === 'default') return;
  if (!confirm('Delete playlist "' + viewed + '"?')) return;
  await getJSON(BASE + '/api/playlist/delete?name=' + enc(viewed));
  viewed = 'default';
  await loadTabs();
  await renderViewed();
}
// Add a library file/folder to the VIEWED playlist; optionally start playing it.
async function addToViewed(path, play) {
  const startIdx = viewedTracks.length;
  await getJSON(BASE + '/api/playlist/add?name=' + enc(viewed) + '&path=' + enc(path));
  await renderViewed();
  if (play) await playViewed(startIdx);
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

function rebuildOrder() {
  order = pb.tracks.map((_, i) => i);
  if (shuffle) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const at = order.indexOf(curTI);
    if (at > 0) [order[0], order[at]] = [order[at], order[0]];
  }
}

// Load + play a track from the PLAYING playlist snapshot locally.
function loadAndPlay(ti) {
  const t = pb.tracks[ti];
  if (!t) return;
  curTI = ti;
  audio.src = streamUrl(t);
  $('nowTitle').textContent = t.title;
  $('nowAlbum').textContent = (pb.playlist ? pb.playlist + ' · ' : '') + (t.album || '');
  document.title = t.title + ' · music';
  setMetadata(t);
  // Browsers may block autoplay without a gesture; if so the user just presses ▶.
  audio.play().catch(() => {});
  renderViewed();
}

// Adopt a server playback snapshot. If the playing list changed, rebuild order;
// if a new play command was issued (playSerial bumped), jump to and play it.
function applyPB(st) {
  const listChanged = st.serial !== seenSerial;
  const playChanged = st.playSerial !== seenPlay;
  seenSerial = st.serial; seenPlay = st.playSerial;
  pb = st;
  if (listChanged) { rebuildOrder(); if (pb.playlist === viewed) renderViewed(); }
  if (playChanged) {
    if (st.current >= 0 && st.tracks[st.current]) {
      if (!order.includes(st.current)) rebuildOrder();
      loadAndPlay(st.current);
    } else {
      audio.pause(); audio.removeAttribute('src'); curTI = -1;
      $('nowTitle').textContent = 'Nothing playing'; $('nowAlbum').textContent = '';
    }
  }
  renderTabs();
}
async function refreshPB() { try { applyPB(await getJSON(BASE + '/api/player')); } catch (e) {} }

// Move within the already-PLAYING playlist (next/prev), leaving the view alone.
// loadAndPlay swaps the src + play synchronously — essential on iOS, where a track
// ending in the background can't wait on a server round-trip before playing the
// next one (Safari blocks .play() on a new src after an await). So advance locally
// first, then sync server state in the background without retriggering a reload.
function playLocal(ti) {
  loadAndPlay(ti);
  getJSON(BASE + '/api/player/index?index=' + ti)
    .then((st) => { seenSerial = st.serial; seenPlay = st.playSerial; pb = st; })
    .catch(() => {});
}
function next() {
  if (!pb.tracks.length) return;
  const lp = order.indexOf(curTI);
  if (lp < order.length - 1) playLocal(order[lp + 1]);
  else if (repeat) playLocal(order[0]);
  else audio.pause();
}
function prev() {
  if (!pb.tracks.length) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  const lp = order.indexOf(curTI);
  if (lp > 0) playLocal(order[lp - 1]);
  else audio.currentTime = 0;
}

// ── library browser ──
let crumbStack = [];
function trackRow(f) {
  const el = document.createElement('div');
  el.className = 'row';
  el.innerHTML = '<span class="ic">♪</span><span class="t">' + esc(f.title) + '</span>' +
    '<span class="meta">' + esc(f.album || '') + '</span>' +
    '<button class="qx" title="Add to playlist">＋</button>';
  el.querySelector('.t').onclick = () => addToViewed(f.path, true);   // add to viewed + play
  el.querySelector('.ic').onclick = () => addToViewed(f.path, true);
  el.querySelector('.qx').onclick = (e) => { e.stopPropagation(); addToViewed(f.path, false); }; // add only
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
  const data = await getJSON(BASE + '/api/browse?path=' + enc(path));
  const b = $('browser');
  b.innerHTML = '';
  $('crumbs').textContent = path === 'root' ? 'Library' : data.path;

  if (path !== 'root') {
    b.appendChild(actionRow('↩', '..', () => { crumbStack.pop(); openBrowse(crumbStack[crumbStack.length - 1] || 'root'); }));
    b.appendChild(actionRow('▶', 'Play this folder', () => addToViewed(data.path, true)));
    b.appendChild(actionRow('＋', 'Add folder to playlist', () => addToViewed(data.path, false)));
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
    const data = await getJSON(BASE + '/api/search?q=' + enc(q));
    const b = $('browser');
    $('crumbs').textContent = data.tracks.length + ' result(s) for "' + q + '"';
    b.innerHTML = '';
    data.tracks.forEach((f) => b.appendChild(trackRow(f)));
    if (!data.tracks.length) b.innerHTML = '<div class="empty">No matches.</div>';
  }, 250);
});

// ── transport wiring ──
$('play').onclick = () => { if (!audio.src && !pb.tracks.length) return; if (audio.paused) audio.play().catch(() => {}); else audio.pause(); };
$('next').onclick = next;
$('prev').onclick = prev;
$('shuffle').onclick = () => { shuffle = !shuffle; $('shuffle').classList.toggle('on', shuffle); rebuildOrder(); };
$('repeat').onclick = () => { repeat = !repeat; $('repeat').classList.toggle('on', repeat); };
$('vol').oninput = (e) => { audio.volume = e.target.value / 100; };
$('playAll').onclick = () => playViewed(0);
$('clearPl').onclick = clearViewed;
$('deletePl').onclick = deleteViewed;
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

// ── boot: show the tabs + the default playlist, adopt current playback, then a
// deep-link ?path= adds to the viewed playlist and plays. Poll playback so plays
// the model issues while the page is open are reflected (and heard) here too.
(async () => {
  await loadTabs();
  await selectTab('default');
  await refreshPB();
  const path = new URLSearchParams(location.search).get('path');
  if (path) { try { await addToViewed(path, true); } catch (e) { console.error('deep-link failed', e); } }
  try { await openBrowse('root'); } catch (e) { console.error('browse failed', e); }
  setInterval(refreshPB, 2000);
})();
</script>
</body>
</html>`;

// ── plugin wiring ────────────────────────────────────────────────────────────

let routeRegistered = false;

export function setup(cfg: PluginConfig<MusicConfig>) {
  PLAYLISTS_DIR = join(cfg.dir, 'playlists');

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
    registerPluginRoute('music', async (req, res) => {
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
    name: 'music_play',
    description: 'Play music in the browser. Adds the track/folder (recursively) to a playlist and starts playing that playlist from the first added track. Uses the "default" playlist if none is named. Returns the player URL to open.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Full path to a music file or a directory to add and play.' },
        playlist: { type: 'string', description: 'Playlist to add to and play (default: "default").' },
      },
      required: ['path'],
    },
    execute: async ({ path, playlist }: { path: string; playlist?: string }) => {
      const allowed = await dirs();
      const tracks = await buildPlaylist(path, allowed);
      if (!tracks.length) return `Nothing playable at "${path}" (or it is outside the allowed dirs).`;
      const pl = await addToPlaylist(playlist, tracks.map((t) => t.path));
      const startAt = Math.max(0, pl.tracks.length - tracks.length);
      const state = await playPlaylistFrom(pl.name, startAt, allowed);
      const url = `${playerBase()}/player`;
      return `Added ${tracks.length} track(s) to playlist "${pl.name}" and started playing it (${state.tracks.length} track(s) total).\nOpen/keep the player at: ${url}`;
    },
  });

  // ── playlist management tools ──────────────────────────────────────────────
  // Named, persisted playlists. Every tool takes an optional `playlist` name and
  // falls back to "default" (created on first use) when none is given.

  registerNativeTool({
    name: 'music_playlists',
    description: 'List the names of all saved playlists.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      const names = await listPlaylists();
      return JSON.stringify(names, null, 2);
    },
  });

  registerNativeTool({
    name: 'music_playlist_show',
    description: 'Show the tracks in a saved playlist. Uses the "default" playlist if no name is given.',
    parameters: {
      type: 'object',
      properties: {
        playlist: { type: 'string', description: 'Playlist name (default: "default").' },
      },
      required: [],
    },
    execute: async ({ playlist }: { playlist?: string }) => {
      const tracks = await getPlaylistTracks(playlist, await dirs());
      const name = safePlaylistName(playlist);
      if (!tracks.length) return `Playlist "${name}" is empty.`;
      return JSON.stringify({
        playlist: name,
        count: tracks.length,
        tracks: tracks.map((t, i) => ({ i, title: t.title, album: t.album, path: t.path })),
      }, null, 2);
    },
  });

  registerNativeTool({
    name: 'music_playlist_create',
    description: 'Create a new empty playlist with the given name (overwrites an existing one of the same name to empty).',
    parameters: {
      type: 'object',
      properties: {
        playlist: { type: 'string', description: 'Name for the new playlist.' },
      },
      required: ['playlist'],
    },
    execute: async ({ playlist }: { playlist: string }) => {
      const pl = await createPlaylist(playlist);
      return `Created playlist "${pl.name}".`;
    },
  });

  registerNativeTool({
    name: 'music_playlist_delete',
    description: 'Delete a saved playlist by name. The "default" playlist cannot be deleted.',
    parameters: {
      type: 'object',
      properties: {
        playlist: { type: 'string', description: 'Playlist name to delete.' },
      },
      required: ['playlist'],
    },
    execute: async ({ playlist }: { playlist: string }) => {
      const name = safePlaylistName(playlist);
      const deleted = await deletePlaylist(playlist);
      return deleted ? `Deleted playlist "${name}".`
        : `Could not delete "${name}" (the default playlist is protected, or it did not exist).`;
    },
  });

  registerNativeTool({
    name: 'music_playlist_add',
    description: 'Add a track or folder (recursively) to a saved playlist. Persists to disk. Uses the "default" playlist if no name is given, creating it if needed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Full path to a music file or a directory to add.' },
        playlist: { type: 'string', description: 'Playlist name (default: "default").' },
      },
      required: ['path'],
    },
    execute: async ({ path, playlist }: { path: string; playlist?: string }) => {
      const allowed = await dirs();
      const tracks = await buildPlaylist(path, allowed);
      if (!tracks.length) return `Nothing playable at "${path}" (or it is outside the allowed dirs).`;
      const pl = await addToPlaylist(playlist, tracks.map((t) => t.path));
      syncPlaybackWithPlaylist(pl.name, resolvePlaylistTracks(pl, allowed));
      return `Added ${tracks.length} track(s) to playlist "${pl.name}". It now has ${pl.tracks.length} track(s).`;
    },
  });

  registerNativeTool({
    name: 'music_playlist_remove',
    description: 'Remove the track at a given 0-based index from a saved playlist. Uses the "default" playlist if no name is given.',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'number', description: '0-based index of the track to remove (see music_playlist_show).' },
        playlist: { type: 'string', description: 'Playlist name (default: "default").' },
      },
      required: ['index'],
    },
    execute: async ({ index, playlist }: { index: number; playlist?: string }) => {
      const pl = await removeFromPlaylist(playlist, index);
      syncPlaybackWithPlaylist(pl.name, resolvePlaylistTracks(pl, await dirs()));
      return `Playlist "${pl.name}" now has ${pl.tracks.length} track(s).`;
    },
  });

  registerNativeTool({
    name: 'music_playlist_clear',
    description: 'Remove all tracks from a saved playlist. Uses the "default" playlist if no name is given.',
    parameters: {
      type: 'object',
      properties: {
        playlist: { type: 'string', description: 'Playlist name (default: "default").' },
      },
      required: [],
    },
    execute: async ({ playlist }: { playlist?: string }) => {
      const pl = await clearPlaylist(playlist);
      syncPlaybackWithPlaylist(pl.name, []);
      return `Cleared playlist "${pl.name}".`;
    },
  });

  registerNativeTool({
    name: 'music_playlist_play',
    description: 'Start playing a saved playlist from its first track. Uses the "default" playlist if no name is given. Returns the player URL.',
    parameters: {
      type: 'object',
      properties: {
        playlist: { type: 'string', description: 'Playlist name (default: "default").' },
      },
      required: [],
    },
    execute: async ({ playlist }: { playlist?: string }) => {
      const name = safePlaylistName(playlist);
      const state = await playPlaylistFrom(playlist, 0, await dirs());
      if (!state.tracks.length) return `Playlist "${name}" is empty (nothing to play).`;
      const url = `${playerBase()}/player`;
      return `Playing playlist "${name}" (${state.tracks.length} track(s)) from the top.\nOpen/keep the player at: ${url}`;
    },
  });

  registerNativeTool({
    name: 'music_player_ui',
    description: 'Return the URL of the browser music player, which shows playlists as tabs. Optionally pass a path to add+play it when the player opens.',
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
