import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { UiPlugin, UiPluginProps } from '../../src/ui/plugin-registry';

interface Track {
  path: string;
  name: string;
  title: string;
  album: string;
}

// Server-side playback state. There is no "queue": playback is always a playlist.
// `playlist` is the name of the playlist currently PLAYING — which may differ
// from the playlist a tab is VIEWING.
interface PlaybackState {
  playlist: string | null;
  tracks: Track[];
  current: number;
  serial: number;
  playSerial: number;
  paused: boolean;
  pauseTime: number;
}

// The player UI + streaming routes are mounted here on the main harness server
// (see MOUNT in plugins/music/index.ts).
const BASE = '/api/plugin/music';

const C = {
  bg: '#0a0a0a',
  panel: '#141414',
  panel2: '#1c1c1c',
  accent: '#00cc88',
  accentDim: '#003d29',
  accentBorder: '#005540',
  text: '#e0e0e0',
  muted: '#888',
  border: '#252525',
  danger: '#cc3344',
};

function fmt(s: number): string {
  if (!isFinite(s)) return '0:00';
  const sec = Math.floor(s);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function esc(s: string): string {
  return String(s);
}

const streamUrl = (t: Track) => `${BASE}/stream?path=${encodeURIComponent(t.path)}`;
const titleOf = (p: string) => (p.split('/').pop() || p).replace(/\.[^.]+$/, '');
// Playlist entries are bare paths (no metadata), so use the containing folder as
// the album/artist line — good enough for the two-row song layout.
const albumOf = (p: string) => {
  const parts = p.split('/').filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : '';
};

const MOBILE_QUERY = '(max-width: 700px)';
const matchesMobile = () => typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches;

function MusicPlayer({ open, onClose }: UiPluginProps) {
  const [pb, setPb] = useState<PlaybackState>({
    playlist: null, tracks: [], current: -1, serial: -1, playSerial: -1, paused: true, pauseTime: 0,
  });
  const [plNames, setPlNames] = useState<string[]>(['default']);
  const [viewed, setViewed] = useState('default');       // selected tab
  const [viewedTracks, setViewedTracks] = useState<string[]>([]); // stored paths

  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(100);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Track[]>([]);
  const [browsePath, setBrowsePath] = useState('root');
  const [browseDirs, setBrowseDirs] = useState<{ name: string; path: string }[]>([]);
  const [browseFiles, setBrowseFiles] = useState<Track[]>([]);
  const [crumbStack, setCrumbStack] = useState<string[]>([]);

  // The library is an on-demand overlay (no persistent sidebar): it starts closed
  // and is opened via the ☰ toggle or the playlist's "＋ Add" button. isMobile
  // only controls whether that overlay is full-screen or a left panel.
  const [isMobile, setIsMobile] = useState(matchesMobile);
  const [libOpen, setLibOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setIsMobile(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const seekRef = useRef<HTMLInputElement | null>(null);
  const seenSerialRef = useRef(-1);
  const seenPlayRef = useRef(-1);

  // ── playback state sync ──
  const applyPB = useCallback((st: PlaybackState) => {
    const playChanged = st.playSerial !== seenPlayRef.current;
    seenSerialRef.current = st.serial;
    seenPlayRef.current = st.playSerial;
    setPb(st);
    if (playChanged && audioRef.current) {
      if (st.current >= 0 && st.tracks[st.current]) {
        audioRef.current.src = streamUrl(st.tracks[st.current]);
        audioRef.current.play().catch(() => {});
      } else {
        audioRef.current.pause();
        audioRef.current.removeAttribute('src');
      }
    }
  }, []);

  const refreshPB = useCallback(async () => {
    try {
      applyPB(await (await fetch(`${BASE}/api/player`)).json());
    } catch (e) {
      console.error('Failed to refresh playback:', e);
    }
  }, [applyPB]);

  // ── tabs + viewed playlist ──
  const loadTabs = useCallback(async () => {
    try {
      setPlNames(await (await fetch(`${BASE}/api/playlists`)).json());
    } catch (e) {
      console.error('Failed to load playlists:', e);
    }
  }, []);

  const loadViewed = useCallback(async (name: string) => {
    try {
      const pl = await (await fetch(`${BASE}/api/playlist/get?name=${encodeURIComponent(name)}`)).json();
      setViewed(pl.name || name);
      setViewedTracks(pl.tracks || []);
    } catch (e) {
      console.error('Failed to load playlist:', e);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    loadTabs();
    loadViewed(viewed);
    refreshPB();
    // Load the library root up front — the ☰ button now only toggles the overlay
    // (it used to trigger this browse), so without it the library opens empty.
    browseDir('root');
    const interval = setInterval(refreshPB, 2000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const selectTab = async (name: string) => {
    setViewed(name);
    await loadViewed(name);
  };

  // Play the VIEWED playlist from `index` — the only thing that changes playback.
  const playViewed = async (index: number) => {
    try {
      applyPB(await (await fetch(`${BASE}/api/player/play?name=${encodeURIComponent(viewed)}&index=${index}`)).json());
    } catch (e) {
      console.error('Failed to play:', e);
    }
  };

  const removeFromViewed = async (i: number) => {
    try {
      await fetch(`${BASE}/api/playlist/remove?name=${encodeURIComponent(viewed)}&index=${i}`);
      await loadViewed(viewed);
    } catch (e) {
      console.error('Failed to remove:', e);
    }
  };

  const clearViewed = async () => {
    if (!window.confirm(`Clear playlist "${viewed}"?`)) return;
    try {
      await fetch(`${BASE}/api/playlist/clear?name=${encodeURIComponent(viewed)}`);
      await loadViewed(viewed);
    } catch (e) {
      console.error('Failed to clear:', e);
    }
  };

  const createPlaylist = async () => {
    const name = window.prompt('New playlist name:');
    if (!name || !name.trim()) return;
    try {
      await fetch(`${BASE}/api/playlist/create?name=${encodeURIComponent(name.trim())}`);
      await loadTabs();
      await selectTab(name.trim());
    } catch (e) {
      console.error('Failed to create playlist:', e);
    }
  };

  const deleteViewed = async () => {
    if (viewed === 'default') return;
    if (!window.confirm(`Delete playlist "${viewed}"?`)) return;
    try {
      await fetch(`${BASE}/api/playlist/delete?name=${encodeURIComponent(viewed)}`);
      setViewed('default');
      await loadTabs();
      await loadViewed('default');
    } catch (e) {
      console.error('Failed to delete playlist:', e);
    }
  };

  // Add a library file/folder to the VIEWED playlist; optionally start playing it.
  const addToViewed = async (path: string, play: boolean) => {
    const startIdx = viewedTracks.length;
    try {
      await fetch(`${BASE}/api/playlist/add?name=${encodeURIComponent(viewed)}&path=${encodeURIComponent(path)}`);
      await loadViewed(viewed);
      if (play) await playViewed(startIdx);
    } catch (e) {
      console.error('Failed to add:', e);
    }
  };

  // ── transport ──
  const buildOrder = (): number[] => {
    const order = pb.tracks.map((_, i) => i);
    if (shuffle) {
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      const at = order.indexOf(pb.current);
      if (at > 0) [order[0], order[at]] = [order[at], order[0]];
    }
    return order;
  };

  // Advance to a track from the CURRENT snapshot immediately and synchronously.
  // This is critical for iOS: Safari blocks `.play()` on a new src if it happens
  // after an `await` (e.g. a server round-trip) while backgrounded, so a track
  // ending in the background would just stop. We swap the src and play in the same
  // tick as the `ended`/action event, then tell the server fire-and-forget and
  // adopt its serials so the 2s poll doesn't reload the track.
  const playLocal = (index: number) => {
    const a = audioRef.current;
    const t = pb.tracks[index];
    if (!a || !t) return;
    a.src = streamUrl(t);
    a.play().catch(() => {});
    fetch(`${BASE}/api/player/index?index=${index}`)
      .then((r) => r.json())
      .then((st) => { seenSerialRef.current = st.serial; seenPlayRef.current = st.playSerial; setPb(st); })
      .catch((e) => console.error('Failed to sync track:', e));
  };

  const nextTrack = () => {
    if (pb.tracks.length === 0) return;
    const order = buildOrder();
    const ci = order.indexOf(pb.current);
    if (ci < order.length - 1) playLocal(order[ci + 1]);
    else if (repeat) playLocal(order[0]);
    else audioRef.current?.pause();
  };

  const prevTrack = () => {
    if (pb.tracks.length === 0) return;
    if (audioRef.current && audioRef.current.currentTime > 3) {
      audioRef.current.currentTime = 0;
      return;
    }
    const order = buildOrder();
    const ci = order.indexOf(pb.current);
    if (ci > 0) playLocal(order[ci - 1]);
    else if (audioRef.current) audioRef.current.currentTime = 0;
  };

  const togglePlayPause = () => {
    const a = audioRef.current;
    if (!a) return;
    if (!a.getAttribute('src') && pb.tracks.length === 0) return;
    if (a.paused) a.play().catch(() => {});
    else a.pause();
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const vol = parseInt(e.target.value, 10);
    setVolume(vol);
    if (audioRef.current) audioRef.current.volume = vol / 100;
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (audioRef.current && duration > 0) {
      audioRef.current.currentTime = (parseInt(e.target.value, 10) / 1000) * duration;
    }
  };

  const handleTimeUpdate = () => {
    const a = audioRef.current;
    if (!a) return;
    setCurrentTime(a.currentTime);
    // Feed the lock-screen scrubber its position.
    if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession && a.duration && isFinite(a.duration)) {
      try { navigator.mediaSession.setPositionState({ duration: a.duration, position: a.currentTime, playbackRate: a.playbackRate || 1 }); } catch { /* invalid state mid-load */ }
    }
  };
  const handleLoadedMetadata = () => {
    if (audioRef.current) setDuration(audioRef.current.duration);
  };
  const handleEnded = () => {
    if (repeat && pb.tracks.length === 1 && audioRef.current) {
      audioRef.current.currentTime = 0;
      audioRef.current.play().catch(() => {});
    } else {
      nextTrack();
    }
  };

  // ── library browse + search ──
  const searchMusic = async (query: string) => {
    if (!query.trim()) { setSearchResults([]); return; }
    try {
      const data = await (await fetch(`${BASE}/api/search?q=${encodeURIComponent(query)}`)).json();
      setSearchResults(data.tracks || []);
    } catch (e) {
      console.error('Search failed:', e);
    }
  };
  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const q = e.target.value;
    setSearchQuery(q);
    setTimeout(() => searchMusic(q), 250);
  };
  // Search results render inside the library panel, so opening search also opens
  // the library. Closing clears the query so the browse view returns.
  const openSearch = () => { setSearchOpen(true); setLibOpen(true); };
  const closeSearch = () => { setSearchOpen(false); setSearchQuery(''); setSearchResults([]); };

  const browseDir = async (path: string) => {
    try {
      const data = await (await fetch(`${BASE}/api/browse?path=${encodeURIComponent(path)}`)).json();
      if (path !== 'root') setCrumbStack((prev) => [...prev, path]);
      setBrowsePath(data.path);
      setBrowseDirs(data.dirs || []);
      setBrowseFiles(data.files || []);
    } catch (e) {
      console.error('Browse failed:', e);
    }
  };
  const openBrowse = (path: string) => {
    if (crumbStack.length > 0) setCrumbStack((prev) => prev.slice(0, -1));
    browseDir(path);
  };

  const currentTrack = pb.playlist && pb.current >= 0 ? pb.tracks[pb.current] : null;

  // ── OS media session (lock-screen controls + iOS background playback) ──
  // Without this, mobile Safari suspends the page in the background and won't let
  // playback continue or advance between tracks (the async fetch→play on track
  // end gets blocked). Registering metadata + action handlers marks this as an
  // active media session so the OS keeps the audio alive and shows lock-screen
  // controls. Handlers are registered once and dispatch through a ref so they
  // always invoke the latest transport logic.
  const transportRef = useRef({ next: nextTrack, prev: prevTrack });
  transportRef.current = { next: nextTrack, prev: prevTrack };

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', () => { audioRef.current?.play().catch(() => {}); });
    ms.setActionHandler('pause', () => audioRef.current?.pause());
    ms.setActionHandler('previoustrack', () => transportRef.current.prev());
    ms.setActionHandler('nexttrack', () => transportRef.current.next());
    return () => {
      for (const a of ['play', 'pause', 'previoustrack', 'nexttrack'] as const) {
        try { ms.setActionHandler(a, null); } catch { /* unsupported action */ }
      }
    };
  }, []);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    if (currentTrack && 'MediaMetadata' in window) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: currentTrack.title || titleOf(currentTrack.path),
        artist: currentTrack.album || '',
        album: pb.playlist || '',
      });
    }
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrack?.path, pb.playlist, playing]);

  const handleClose = () => onClose();

  // ── small reusable styles ──
  const smallBtn: React.CSSProperties = {
    background: 'none', border: `1px solid ${C.border}`, color: C.muted,
    fontSize: 11, padding: '3px 9px', borderRadius: 6, cursor: 'pointer', flex: 'none',
  };
  const rowBtn: React.CSSProperties = {
    background: 'none', border: 'none', color: C.muted, cursor: 'pointer',
    fontSize: 13, padding: '2px 4px', lineHeight: 1, flex: 'none',
  };

  const libRow = (f: Track, key: number) => (
    <div
      key={key}
      onClick={() => { addToViewed(f.path, true); setLibOpen(false); }}
      style={{ padding: '9px 10px', borderRadius: 7, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 9, fontSize: 13 }}
    >
      <span style={{ color: C.accent, width: 16, textAlign: 'center' }}>♪</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{esc(f.title)}</span>
      <span style={{ color: C.muted, marginLeft: 'auto', fontSize: 11 }}>{esc(f.album || '')}</span>
      <button
        onClick={(e) => { e.stopPropagation(); addToViewed(f.path, false); }}
        style={rowBtn}
        title={`Add to "${viewed}"`}
      >
        ＋
      </button>
    </div>
  );

  return (
    <>
      {/* Keep the audio element mounted even when the UI is closed so playback
          survives opening/closing the window. */}
      <audio
        ref={audioRef}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onEnded={handleEnded}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        style={{ display: 'none' }}
      />

      {open && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: C.bg, color: C.text, display: 'flex', flexDirection: 'column', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
          {/* Header */}
          <header style={{ padding: '14px 20px', background: C.panel, display: 'flex', alignItems: 'center', gap: 14, borderBottom: '1px solid #222', flex: 'none' }}>
            <button onClick={handleClose} style={{ background: C.panel2, border: '1px solid #2a2a2a', color: C.text, fontSize: 16, lineHeight: 1, cursor: 'pointer', width: 34, height: 34, borderRadius: 8, flex: 'none' }} title="Close">←</button>
            <button onClick={() => setLibOpen((o) => !o)} style={{ background: libOpen ? C.accentDim : C.panel2, border: `1px solid ${libOpen ? C.accentBorder : '#2a2a2a'}`, color: C.text, fontSize: 16, lineHeight: 1, cursor: 'pointer', width: 34, height: 34, borderRadius: 8, flex: 'none' }} title="Toggle library">☰</button>
            {/* Hide the title on mobile while searching so the field has room. */}
            {!(searchOpen && isMobile) && (
              <h1 style={{ fontSize: 16, fontWeight: 600, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                leather<span style={{ color: C.accent }}>Harness</span> · music
              </h1>
            )}
            {/* Search collapses to an icon; tapping it reveals the input. */}
            {searchOpen ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: isMobile ? 1 : 'none' }}>
                <input autoFocus type="search" value={searchQuery} onChange={handleSearchChange} placeholder="Search tracks…" style={{ background: C.panel2, border: '1px solid #2a2a2a', color: C.text, padding: '8px 12px', borderRadius: 8, width: isMobile ? undefined : 220, flex: isMobile ? 1 : 'none', minWidth: 0, outline: 'none' }} />
                <button onClick={closeSearch} style={{ background: C.panel2, border: '1px solid #2a2a2a', color: C.text, fontSize: 16, lineHeight: 1, cursor: 'pointer', width: 34, height: 34, borderRadius: 8, flex: 'none' }} title="Close search">✕</button>
              </div>
            ) : (
              <button onClick={openSearch} style={{ background: searchQuery ? C.accentDim : C.panel2, border: `1px solid ${searchQuery ? C.accentBorder : '#2a2a2a'}`, color: C.text, fontSize: 16, lineHeight: 1, cursor: 'pointer', width: 34, height: 34, borderRadius: 8, flex: 'none' }} title="Search">🔍</button>
            )}
          </header>

          {/* Main content */}
          <main style={{ flex: 1, display: 'flex', minHeight: 0, position: 'relative' }}>
            {/* Library is an on-demand overlay (no persistent sidebar): full-screen
                on mobile, a left panel with a dismissable backdrop on desktop. */}
            {libOpen && (
              <div onClick={() => setLibOpen(false)} style={{ position: 'absolute', inset: 0, zIndex: 4, background: isMobile ? 'transparent' : 'rgba(0,0,0,0.5)' }} />
            )}
            {libOpen && (
            <div style={{
              background: C.panel, borderRight: '1px solid #222', overflowY: 'auto', padding: 10,
              position: 'absolute', top: 0, bottom: 0, left: 0, zIndex: 5,
              width: isMobile ? '100%' : 320, maxWidth: '100%',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 4px 10px' }}>
                <div style={{ fontSize: 12, color: C.muted, wordBreak: 'break-all', flex: 1 }}>
                  {browsePath === 'root' ? 'Library' : browsePath}
                </div>
                <button onClick={() => setLibOpen(false)} style={{ background: C.panel2, border: '1px solid #2a2a2a', color: C.text, fontSize: 15, lineHeight: 1, cursor: 'pointer', width: 30, height: 30, borderRadius: 8, flex: 'none' }} title="Close library">✕</button>
              </div>
              {searchResults.length > 0 ? (
                searchResults.map((f, i) => libRow(f, i))
              ) : (
                <>
                  {browsePath !== 'root' && (
                    <div onClick={() => openBrowse(crumbStack[crumbStack.length - 1] || 'root')} style={{ padding: '9px 10px', borderRadius: 7, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 9, fontSize: 13 }}>
                      <span style={{ color: C.accent, width: 16, textAlign: 'center' }}>↩</span>
                      <span>..</span>
                    </div>
                  )}
                  {browsePath !== 'root' && (
                    <div onClick={() => { addToViewed(browsePath, true); setLibOpen(false); }} style={{ padding: '9px 10px', borderRadius: 7, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 9, fontSize: 13 }}>
                      <span style={{ color: C.accent, width: 16, textAlign: 'center' }}>▶</span>
                      <span>Play this folder</span>
                    </div>
                  )}
                  {browseDirs.map((d, i) => (
                    <div key={i} onClick={() => browseDir(d.path)} style={{ padding: '9px 10px', borderRadius: 7, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 9, fontSize: 13 }}>
                      <span style={{ color: C.accent, width: 16, textAlign: 'center' }}>📁</span>
                      <span>{esc(d.name)}</span>
                    </div>
                  ))}
                  {browseFiles.map((f, i) => libRow(f, i))}
                  {browseDirs.length === 0 && browseFiles.length === 0 && (
                    <div style={{ color: C.muted, padding: 24, textAlign: 'center', fontSize: 13 }}>Empty folder.</div>
                  )}
                </>
              )}
            </div>
            )}

            {/* Right column: tabs + viewed playlist */}
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
              {/* Playlist tabs */}
              <div style={{ display: 'flex', gap: 4, padding: '8px 8px 0', overflowX: 'auto', borderBottom: '1px solid #222', flex: 'none' }}>
                {plNames.map((name) => {
                  const on = name === viewed;
                  return (
                    <div
                      key={name}
                      onClick={() => selectTab(name)}
                      style={{ background: on ? C.bg : C.panel2, border: `1px solid ${on ? C.accent : '#2a2a2a'}`, borderBottom: 'none', color: on ? C.accent : C.muted, fontSize: 13, padding: '7px 12px', borderRadius: '8px 8px 0 0', cursor: 'pointer', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6 }}
                      title={pb.playlist === name ? 'Currently playing' : undefined}
                    >
                      {pb.playlist === name && <span style={{ color: C.accent, fontSize: 10 }}>●</span>}
                      <span>{esc(name)}</span>
                    </div>
                  );
                })}
                <div onClick={createPlaylist} style={{ background: C.panel2, border: '1px solid #2a2a2a', borderBottom: 'none', color: C.muted, fontSize: 13, fontWeight: 600, padding: '7px 12px', borderRadius: '8px 8px 0 0', cursor: 'pointer' }} title="New playlist">＋</div>
              </div>

              {/* Viewed playlist header */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px 6px' }}>
                <h2 style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '.08em', color: C.muted }}>
                  {esc(viewed)}{viewedTracks.length > 0 && ` · ${viewedTracks.length}`}
                </h2>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={() => setLibOpen(true)} style={{ ...smallBtn, color: C.accent, borderColor: C.accentBorder }} title="Add tracks or folders from the library">＋ Add</button>
                  <button onClick={() => playViewed(0)} style={smallBtn} title="Play this playlist">▶ Play</button>
                  <button onClick={clearViewed} style={smallBtn} title="Clear this playlist">Clear</button>
                  {viewed !== 'default' && <button onClick={deleteViewed} style={smallBtn} title="Delete this playlist">🗑</button>}
                </div>
              </div>

              {/* Viewed playlist tracks */}
              <div style={{ overflowY: 'auto', padding: '0 10px 10px', flex: 1 }}>
                {viewedTracks.length === 0 ? (
                  <div style={{ color: C.muted, padding: 24, textAlign: 'center', fontSize: 13 }}>
                    Empty playlist. Add tracks from the library, or ask the model to.
                  </div>
                ) : (
                  viewedTracks.map((p, i) => {
                    const playingHere = pb.playlist === viewed && i === pb.current;
                    return (
                      <div
                        key={i}
                        onClick={() => playViewed(i)}
                        style={{ padding: '9px 12px', borderRadius: 7, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, background: playingHere ? '#0d2035' : 'transparent', boxShadow: playingHere ? `inset 3px 0 0 ${C.accent}` : 'none' }}
                      >
                        <span style={{ color: playingHere ? C.accent : C.muted, width: 22, textAlign: 'right', fontVariantNumeric: 'tabular-nums', flex: 'none' }}>{i + 1}</span>
                        {/* Two rows per song: title on top, album/artist beneath. */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: playingHere ? C.accent : C.text, fontSize: 14 }}>{esc(titleOf(p))}</div>
                          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: C.muted, fontSize: 11, marginTop: 2 }}>{esc(albumOf(p)) || '—'}</div>
                        </div>
                        <button onClick={(e) => { e.stopPropagation(); removeFromViewed(i); }} style={{ ...rowBtn, flex: 'none' }} title="Remove from playlist">✕</button>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </main>

          {/* Footer */}
          <footer style={{ background: C.panel, borderTop: '1px solid #222', padding: '6px 16px', display: 'flex', alignItems: 'center', gap: 14, flex: 'none' }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13, color: C.accent, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {currentTrack?.title || 'Nothing playing'}
              </div>
              <div style={{ fontSize: 11, color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {currentTrack ? `${pb.playlist} · ${currentTrack.album || ''}` : ''}
              </div>
            </div>
            <div style={{ flex: 2, display: 'flex', alignItems: 'center', gap: 8, fontVariantNumeric: 'tabular-nums' }}>
              <span style={{ fontSize: 11, color: C.muted }}>{fmt(currentTime)}</span>
              <input ref={seekRef} type="range" min="0" max="1000" value={duration > 0 ? (currentTime / duration) * 1000 : 0} onChange={handleSeek} style={{ flex: 1, appearance: 'none', height: 4, background: '#2a2a2a', borderRadius: 3, outline: 'none', cursor: 'pointer' }} />
              <span style={{ fontSize: 11, color: C.muted }}>{fmt(duration)}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <button onClick={() => setShuffle((v) => !v)} style={{ background: 'none', border: 'none', color: shuffle ? C.accent : C.text, fontSize: 15, cursor: 'pointer', width: 30, height: 30, borderRadius: '50%' }} title="Shuffle">🔀</button>
              <button onClick={prevTrack} style={{ background: 'none', border: 'none', color: C.text, fontSize: 15, cursor: 'pointer', width: 30, height: 30, borderRadius: '50%' }} title="Previous">⏮</button>
              <button onClick={togglePlayPause} style={{ background: C.accent, color: '#08130d', fontSize: 15, width: 32, height: 32, border: 'none', borderRadius: '50%', cursor: 'pointer' }} title="Play/Pause">{playing ? '⏸' : '▶'}</button>
              <button onClick={nextTrack} style={{ background: 'none', border: 'none', color: C.text, fontSize: 15, cursor: 'pointer', width: 30, height: 30, borderRadius: '50%' }} title="Next">⏭</button>
              <button onClick={() => setRepeat((v) => !v)} style={{ background: 'none', border: 'none', color: repeat ? C.accent : C.text, fontSize: 15, cursor: 'pointer', width: 30, height: 30, borderRadius: '50%' }} title="Repeat">🔁</button>
            </div>
            <input type="range" min="0" max="100" value={volume} onChange={handleVolumeChange} style={{ width: 90 }} title="Volume" />
          </footer>
        </div>
      )}
    </>
  );
}

const plugin: UiPlugin = {
  id: 'music',
  title: 'Music Player',
  icon: '🎵',
  Component: MusicPlayer,
};

export default plugin;
