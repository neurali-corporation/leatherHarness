import { registerNativeTool } from '../../src/registry.ts';
import type { PluginConfig } from '../../src/plugin-loader.ts';

interface LastfmConfig {
  apiKey: string | null;
  // Only needed for authenticated/write methods (scrobbling). Read-only tools below don't use it.
  sharedSecret: string | null;
}

export const defaultConfig: LastfmConfig = {
  apiKey: null,
  sharedSecret: null,
};

const API_ROOT = 'https://ws.audioscrobbler.com/2.0/';
const TIMEOUT_MS = 15_000;

export function setup(cfg: PluginConfig<LastfmConfig>) {
  // Call a read-only Last.fm API method. Returns parsed JSON or throws with a readable message.
  async function call(method: string, params: Record<string, string | number | undefined>): Promise<any> {
    const { apiKey } = await cfg.get();
    if (!apiKey) throw new Error('Last.fm apiKey not configured. Set pluginConfig.lastfm.apiKey in config.json.');

    const qs = new URLSearchParams({ method, api_key: apiKey, format: 'json' });
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') qs.set(k, String(v));
    }

    const res = await fetch(`${API_ROOT}?${qs}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const data = await res.json().catch(() => null) as any;
    if (data && typeof data.error === 'number') {
      throw new Error(`Last.fm error ${data.error}: ${data.message ?? 'unknown'}`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return data;
  }

  // Wrap a tool body so configuration/network errors come back as a clean string.
  const safe = (fn: (args: any) => Promise<string>) => async (args: any): Promise<string> => {
    try { return await fn(args); }
    catch (e: unknown) { return `ERROR: ${(e as Error).message}`; }
  };

  const arr = <T>(v: T | T[] | undefined): T[] => (Array.isArray(v) ? v : v ? [v] : []);
  const num = (s: string | undefined) => (s ? Number(s).toLocaleString() : '0');
  const stripTags = (html: string) => html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

  // Footer for methods that return a Last.fm `@attr` block (page/totalPages/total).
  const pageFooter = (attr: any): string => {
    const page = Number(attr?.page), totalPages = Number(attr?.totalPages);
    if (!page || !totalPages) return '';
    const more = page < totalPages ? `; pass page:${page + 1} for more` : '';
    return `\n— page ${page}/${totalPages} (${Number(attr.total).toLocaleString()} total${more})`;
  };

  // *.search uses OpenSearch fields instead of an `@attr` block.
  const searchFooter = (results: any): string => {
    const total = Number(results?.['opensearch:totalResults'] ?? 0);
    const per   = Number(results?.['opensearch:itemsPerPage']) || 0;
    const start = Number(results?.['opensearch:startIndex'] ?? 0);
    if (!total || !per) return '';
    const page = Math.floor(start / per) + 1;
    const totalPages = Math.ceil(total / per);
    const more = page < totalPages ? `; pass page:${page + 1} for more` : '';
    return `\n— page ${page}/${totalPages} (${total.toLocaleString()} total${more})`;
  };

  registerNativeTool({
    name: 'lastfm_artist_info',
    description: 'Get Last.fm info for an artist: listeners, play count, top tags, similar artists, and a short bio.',
    parameters: {
      type: 'object',
      properties: { artist: { type: 'string', description: 'Artist name' } },
      required: ['artist'],
    },
    execute: safe(async ({ artist }: { artist: string }) => {
      const a = (await call('artist.getInfo', { artist, autocorrect: 1 })).artist;
      if (!a) return 'No artist found.';
      const tags = arr<any>(a.tags?.tag).map(t => t.name).join(', ');
      const similar = arr<any>(a.similar?.artist).map(s => s.name).join(', ');
      const bio = stripTags(a.bio?.summary ?? '');
      return [
        `${a.name}`,
        `Listeners: ${num(a.stats?.listeners)}  Plays: ${num(a.stats?.playcount)}`,
        tags && `Tags: ${tags}`,
        similar && `Similar: ${similar}`,
        bio && `\n${bio}`,
      ].filter(Boolean).join('\n');
    }),
  });

  registerNativeTool({
    name: 'lastfm_similar_artists',
    description: 'Get artists similar to a given artist, ranked by match.',
    parameters: {
      type: 'object',
      properties: {
        artist: { type: 'string', description: 'Artist name' },
        limit:  { type: 'number', description: 'Max results (default 15)' },
      },
      required: ['artist'],
    },
    execute: safe(async ({ artist, limit = 15 }: { artist: string; limit?: number }) => {
      const list = arr<any>((await call('artist.getSimilar', { artist, autocorrect: 1, limit })).similarartists?.artist);
      if (!list.length) return 'No similar artists found.';
      return list.map(s => `${s.name}  (match ${Math.round(Number(s.match) * 100)}%)`).join('\n');
    }),
  });

  registerNativeTool({
    name: 'lastfm_artist_top_tracks',
    description: 'Get the most popular tracks for an artist on Last.fm.',
    parameters: {
      type: 'object',
      properties: {
        artist: { type: 'string', description: 'Artist name' },
        limit:  { type: 'number', description: 'Max results per page (default 15)' },
        page:   { type: 'number', description: 'Page number, 1-indexed (default 1)' },
      },
      required: ['artist'],
    },
    execute: safe(async ({ artist, limit = 15, page = 1 }: { artist: string; limit?: number; page?: number }) => {
      const top = (await call('artist.getTopTracks', { artist, autocorrect: 1, limit, page })).toptracks;
      const list = arr<any>(top?.track);
      if (!list.length) return 'No tracks found.';
      const offset = (Number(top?.['@attr']?.perPage) || limit) * ((Number(top?.['@attr']?.page) || page) - 1);
      return list.map((t, i) => `${offset + i + 1}. ${t.name}  (${num(t.playcount)} plays)`).join('\n') + pageFooter(top?.['@attr']);
    }),
  });

  registerNativeTool({
    name: 'lastfm_artist_top_albums',
    description: 'Get the most popular albums for an artist on Last.fm.',
    parameters: {
      type: 'object',
      properties: {
        artist: { type: 'string', description: 'Artist name' },
        limit:  { type: 'number', description: 'Max results per page (default 15)' },
        page:   { type: 'number', description: 'Page number, 1-indexed (default 1)' },
      },
      required: ['artist'],
    },
    execute: safe(async ({ artist, limit = 15, page = 1 }: { artist: string; limit?: number; page?: number }) => {
      const top = (await call('artist.getTopAlbums', { artist, autocorrect: 1, limit, page })).topalbums;
      const list = arr<any>(top?.album);
      if (!list.length) return 'No albums found.';
      const offset = (Number(top?.['@attr']?.perPage) || limit) * ((Number(top?.['@attr']?.page) || page) - 1);
      return list.map((al, i) => `${offset + i + 1}. ${al.name}  (${num(al.playcount)} plays)`).join('\n') + pageFooter(top?.['@attr']);
    }),
  });

  registerNativeTool({
    name: 'lastfm_album_info',
    description: 'Get Last.fm info for an album: listeners, play count, tags, and full tracklist.',
    parameters: {
      type: 'object',
      properties: {
        artist: { type: 'string', description: 'Artist name' },
        album:  { type: 'string', description: 'Album title' },
      },
      required: ['artist', 'album'],
    },
    execute: safe(async ({ artist, album }: { artist: string; album: string }) => {
      const al = (await call('album.getInfo', { artist, album, autocorrect: 1 })).album;
      if (!al) return 'No album found.';
      const tags = arr<any>(al.tags?.tag).map(t => t.name).join(', ');
      const tracks = arr<any>(al.tracks?.track).map((t, i) => {
        const dur = Number(t.duration) ? `  ${Math.floor(t.duration / 60)}:${String(t.duration % 60).padStart(2, '0')}` : '';
        return `  ${i + 1}. ${t.name}${dur}`;
      }).join('\n');
      return [
        `${al.artist} — ${al.name}`,
        `Listeners: ${num(al.listeners)}  Plays: ${num(al.playcount)}`,
        tags && `Tags: ${tags}`,
        tracks && `\nTracklist:\n${tracks}`,
      ].filter(Boolean).join('\n');
    }),
  });

  registerNativeTool({
    name: 'lastfm_track_info',
    description: 'Get Last.fm info for a single track: listeners, play count, tags, album, and duration.',
    parameters: {
      type: 'object',
      properties: {
        artist: { type: 'string', description: 'Artist name' },
        track:  { type: 'string', description: 'Track title' },
      },
      required: ['artist', 'track'],
    },
    execute: safe(async ({ artist, track }: { artist: string; track: string }) => {
      const t = (await call('track.getInfo', { artist, track, autocorrect: 1 })).track;
      if (!t) return 'No track found.';
      const tags = arr<any>(t.toptags?.tag).map(x => x.name).join(', ');
      const dur = Number(t.duration) ? `${Math.floor(t.duration / 60000)}:${String(Math.floor((t.duration % 60000) / 1000)).padStart(2, '0')}` : 'unknown';
      return [
        `${t.artist?.name} — ${t.name}`,
        t.album?.title && `Album: ${t.album.title}`,
        `Listeners: ${num(t.listeners)}  Plays: ${num(t.playcount)}  Duration: ${dur}`,
        tags && `Tags: ${tags}`,
      ].filter(Boolean).join('\n');
    }),
  });

  registerNativeTool({
    name: 'lastfm_search',
    description: 'Search Last.fm for an artist, album, or track by name.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term' },
        type:  { type: 'string', description: 'What to search for', enum: ['artist', 'album', 'track'] },
        limit: { type: 'number', description: 'Max results per page (default 10)' },
        page:  { type: 'number', description: 'Page number, 1-indexed (default 1)' },
      },
      required: ['query', 'type'],
    },
    execute: safe(async ({ query, type, limit = 10, page = 1 }: { query: string; type: 'artist' | 'album' | 'track'; limit?: number; page?: number }) => {
      const data = await call(`${type}.search`, { [type]: query, limit, page } as Record<string, string | number>);
      const results = data.results;
      const list = arr<any>(results?.[`${type}matches`]?.[type]);
      if (!list.length) return 'No results.';
      const offset = (Number(results?.['opensearch:itemsPerPage']) || limit) * (page - 1);
      return list.map((r, i) => {
        const n = offset + i + 1;
        if (type === 'artist') return `${n}. ${r.name}  (${num(r.listeners)} listeners)`;
        return `${n}. ${r.artist} — ${r.name}`;
      }).join('\n') + searchFooter(results);
    }),
  });

  registerNativeTool({
    name: 'lastfm_tag_top',
    description: 'Browse Last.fm by tag/genre: get the top artists, albums, or tracks for a tag (e.g. "melodic death metal", "shoegaze").',
    parameters: {
      type: 'object',
      properties: {
        tag:   { type: 'string', description: 'Tag/genre name' },
        type:  { type: 'string', description: 'What to list for the tag', enum: ['artist', 'album', 'track'] },
        limit: { type: 'number', description: 'Max results per page (default 15)' },
        page:  { type: 'number', description: 'Page number, 1-indexed (default 1)' },
      },
      required: ['tag', 'type'],
    },
    execute: safe(async ({ tag, type, limit = 15, page = 1 }: { tag: string; type: 'artist' | 'album' | 'track'; limit?: number; page?: number }) => {
      const method = { artist: 'tag.getTopArtists', album: 'tag.getTopAlbums', track: 'tag.getTopTracks' }[type];
      const container = { artist: 'topartists', album: 'albums', track: 'tracks' }[type];
      const box = (await call(method, { tag, limit, page }))[container];
      const list = arr<any>(box?.[type]);
      if (!list.length) return `No ${type}s found for tag "${tag}".`;
      const offset = (Number(box?.['@attr']?.perPage) || limit) * ((Number(box?.['@attr']?.page) || page) - 1);
      return list.map((r, i) => {
        const who = type === 'artist' ? r.name : `${r.artist?.name ?? r.artist} — ${r.name}`;
        return `${offset + i + 1}. ${who}`;
      }).join('\n') + pageFooter(box?.['@attr']);
    }),
  });

  registerNativeTool({
    name: 'lastfm_tag_info',
    description: 'Get info about a Last.fm tag/genre: usage count, reach, and a short description.',
    parameters: {
      type: 'object',
      properties: { tag: { type: 'string', description: 'Tag/genre name' } },
      required: ['tag'],
    },
    execute: safe(async ({ tag }: { tag: string }) => {
      const t = (await call('tag.getInfo', { tag })).tag;
      if (!t) return `No info for tag "${tag}".`;
      const wiki = stripTags(t.wiki?.summary ?? '');
      return [
        `${t.name}`,
        `Taggings: ${num(String(t.total ?? t.taggings))}  Reach: ${num(String(t.reach))}`,
        wiki && `\n${wiki}`,
      ].filter(Boolean).join('\n');
    }),
  });

  registerNativeTool({
    name: 'lastfm_user_recent_tracks',
    description: "Get a Last.fm user's recently scrobbled tracks (most recent first).",
    parameters: {
      type: 'object',
      properties: {
        user:  { type: 'string', description: 'Last.fm username' },
        limit: { type: 'number', description: 'Max results per page (default 15)' },
        page:  { type: 'number', description: 'Page number, 1-indexed (default 1)' },
      },
      required: ['user'],
    },
    execute: safe(async ({ user, limit = 15, page = 1 }: { user: string; limit?: number; page?: number }) => {
      const recent = (await call('user.getRecentTracks', { user, limit, page })).recenttracks;
      const list = arr<any>(recent?.track);
      if (!list.length) return 'No recent tracks.';
      return list.map(t => {
        const when = t['@attr']?.nowplaying ? 'now playing' : (t.date?.['#text'] ?? '');
        return `${t.artist?.['#text'] ?? t.artist?.name ?? ''} — ${t.name}${when ? `  (${when})` : ''}`;
      }).join('\n') + pageFooter(recent?.['@attr']);
    }),
  });

  registerNativeTool({
    name: 'lastfm_user_top_artists',
    description: "Get a Last.fm user's most-played artists over a period.",
    parameters: {
      type: 'object',
      properties: {
        user:   { type: 'string', description: 'Last.fm username' },
        period: { type: 'string', description: 'Time range (default overall)', enum: ['overall', '7day', '1month', '3month', '6month', '12month'] },
        limit:  { type: 'number', description: 'Max results per page (default 15)' },
        page:   { type: 'number', description: 'Page number, 1-indexed (default 1)' },
      },
      required: ['user'],
    },
    execute: safe(async ({ user, period = 'overall', limit = 15, page = 1 }: { user: string; period?: string; limit?: number; page?: number }) => {
      const top = (await call('user.getTopArtists', { user, period, limit, page })).topartists;
      const list = arr<any>(top?.artist);
      if (!list.length) return 'No data.';
      const offset = (Number(top?.['@attr']?.perPage) || limit) * ((Number(top?.['@attr']?.page) || page) - 1);
      return list.map((a, i) => `${offset + i + 1}. ${a.name}  (${num(a.playcount)} plays)`).join('\n') + pageFooter(top?.['@attr']);
    }),
  });
}
