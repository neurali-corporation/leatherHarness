import React, { useState, useEffect, useRef } from 'react';
import { marked } from 'marked';
import hljs from 'highlight.js/lib/common';
import 'highlight.js/styles/github-dark.css';
import { uiPlugins } from './plugin-registry';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Configure marked once: GFM tables/task-lists, single newlines as <br>,
// syntax-highlighted code blocks with a header bar, links opening in a new tab.
const mdRenderer = new marked.Renderer();
mdRenderer.code = (code, infostring) => {
  const lang = (infostring || '').trim().split(/\s+/)[0];
  let html: string;
  let label = lang;
  try {
    if (lang && hljs.getLanguage(lang)) {
      html = hljs.highlight(code, { language: lang }).value;
    } else {
      const auto = hljs.highlightAuto(code);
      html = auto.value;
      label = auto.language || '';
    }
  } catch {
    html = escapeHtml(code);
  }
  return (
    `<div class="codeblock">` +
      `<div class="cb-head"><span class="cb-lang">${escapeHtml(label || 'text')}</span>` +
      `<button class="cb-copy" type="button">Copy</button></div>` +
      `<pre><code class="hljs">${html}</code></pre>` +
    `</div>`
  );
};
mdRenderer.link = (href, title, text) => {
  const t = title ? ` title="${escapeHtml(title)}"` : '';
  return `<a href="${href}"${t} target="_blank" rel="noopener noreferrer">${text}</a>`;
};
marked.setOptions({ gfm: true, breaks: true, renderer: mdRenderer });

type Msg =
  | { kind: 'user';        content: string }
  | { kind: 'assistant';   content: string }
  | { kind: 'reasoning';   content: string }
  | { kind: 'tool_call';   id: string; name: string; args: string }
  | { kind: 'tool_result'; id: string; name: string; out: string };

interface TokenUsage { prompt: number; completion: number; total: number; }
interface SessionMetrics {
  prompt: number;
  completion: number;
  total: number;
  round: number;
  toolCalls: number;
  compactions: number;
  elapsed: number;
}
interface Session {
  id: string;
  msgs: Msg[];
  input: string;
  loading: boolean;
  tokens: TokenUsage | null;
  metrics: SessionMetrics | null;
}

const C = {
  bg:           '#0a0a0a',
  surface:      '#141414',
  surface2:     '#1c1c1c',
  border:       '#252525',
  text:         '#e0e0e0',
  muted:        '#666',
  accent:       '#00cc88',
  accentDim:    '#003d29',
  accentBorder: '#005540',
  userBg:       '#0d2035',
  userBorder:   '#164060',
  assistBorder: '#222',
  toolBg:       '#111820',
  toolBorder:   '#1a2a20',
  danger:       '#cc3344',
};

export default function App() {
  const [sessions,    setSessions]    = useState<Record<string, Session>>({});
  const [currentId,   setCurrentId]   = useState<string | null>(null);
  const [counter,     setCounter]     = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isMobile,    setIsMobile]    = useState(() => window.innerWidth < 768);
  const [expanded,    setExpanded]    = useState<Set<string>>(new Set());
  const [pluginIcons, setPluginIcons] = useState<{ id: string; title: string; icon: string }[]>([]);
  const [toast,       setToast]       = useState<string | null>(null);
  const [openPlugin,  setOpenPlugin]  = useState<string | null>(null);

  // Plugins can contribute clickable icons to the UI via the ui-registry.
  useEffect(() => {
    fetch('/api/ui/icons')
      .then(r => r.json())
      .then(list => Array.isArray(list) && setPluginIcons(list))
      .catch(() => {});
  }, []);

  const runPluginIcon = async (id: string) => {
    try {
      const res = await fetch(`/api/ui/icons/${encodeURIComponent(id)}`, { method: 'POST' });
      const r = await res.json();
      if (r.open) window.open(r.open, '_blank', 'noopener');
      if (r.navigate) window.location.href = r.navigate;
      if (r.message) { setToast(r.message); setTimeout(() => setToast(null), 3000); }
      if (uiPlugins.some(p => p.id === id)) setOpenPlugin(id);
    } catch {
      setToast('Action failed'); setTimeout(() => setToast(null), 3000);
    }
  };

  const toggleExpanded = (key: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  // Copy-button handling for code blocks (event delegation over the message list).
  const onMessagesClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const btn = (e.target as HTMLElement).closest('.cb-copy');
    if (!btn) return;
    const code = btn.closest('.codeblock')?.querySelector('code')?.textContent ?? '';
    navigator.clipboard?.writeText(code).then(() => {
      const el = btn as HTMLButtonElement;
      el.textContent = 'Copied';
      el.classList.add('copied');
      setTimeout(() => { el.textContent = 'Copy'; el.classList.remove('copied'); }, 1200);
    });
  };

  const textareaRef    = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // One AbortController per session, so stopping one doesn't cancel another.
  const abortRefs      = useRef<Record<string, AbortController>>({});

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Allow Escape to dismiss the music player.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenPlugin(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const createSession = () => {
    setCounter(c => {
      const n  = c + 1;
      const id = `s${n}`;
      setSessions(prev => ({ ...prev, [id]: { id, msgs: [], input: '', loading: false, tokens: null, metrics: null } }));
      setCurrentId(id);
      return n;
    });
    setSidebarOpen(false);
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const closeSession = (id: string) => {
    abortRefs.current[id]?.abort();
    delete abortRefs.current[id];
    setSessions(prev => {
      const next = { ...prev };
      delete next[id];
      if (currentId === id) {
        const remaining = Object.keys(next);
        setCurrentId(remaining.length ? remaining[0] : null);
      }
      return next;
    });
  };

  const switchSession = (id: string) => {
    setCurrentId(id);
    setSidebarOpen(false);
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  useEffect(() => {
    if (Object.keys(sessions).length === 0) createSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [sessions, currentId]);

  const patchSession = (id: string, patch: Partial<Session>) =>
    setSessions(prev => (prev[id] ? { ...prev, [id]: { ...prev[id], ...patch } } : prev));

  const pushMsg = (id: string, msg: Msg) =>
    setSessions(prev => ({
      ...prev,
      [id]: { ...prev[id], msgs: [...prev[id].msgs, msg] },
    }));

  const updateLast = (id: string, updater: (m: Msg) => Msg) =>
    setSessions(prev => {
      const s = prev[id];
      if (!s || s.msgs.length === 0) return prev;
      const msgs = [...s.msgs];
      msgs[msgs.length - 1] = updater(msgs[msgs.length - 1]);
      return { ...prev, [id]: { ...s, msgs } };
    });

  const stopGeneration = (id: string | null = currentId) => {
    if (!id) return;
    abortRefs.current[id]?.abort();
    // The fetch loop's catch swallows AbortError and `finally` clears loading,
    // so any partial assistant reply already streamed in stays in place.
  };

  const sendMessage = async () => {
    if (!currentId) return;
    const sessId = currentId;
    const sess = sessions[sessId];
    if (!sess || sess.loading) return;
    const content = sess.input.trim();
    if (!content) return;

    pushMsg(sessId, { kind: 'user', content });
    // Clear both tokens and metrics so the bar shows "counting tokens…" and then
    // updates live from this turn's metrics events, instead of lingering on the
    // previous turn's stale numbers.
    patchSession(sessId, { input: '', loading: true, tokens: null, metrics: null });

    // Build API messages from display msgs (user/assistant only)
    const apiMsgs = [
      ...sess.msgs
        .filter(m => m.kind === 'user' || m.kind === 'assistant')
        .map(m => ({ role: m.kind as 'user' | 'assistant', content: (m as any).content })),
      { role: 'user' as const, content },
    ];

    const controller = new AbortController();
    abortRefs.current[sessId] = controller;
    try {
      const resp = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Leather-UI': '1' },
        body: JSON.stringify({ model: 'any', messages: apiMsgs, stream: true }),
        signal: controller.signal,
      });

      const reader = resp.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let assistantStarted = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '[DONE]') break;
          let ev: any;
          try { ev = JSON.parse(raw); } catch { continue; }

          if (ev.t === 'reasoning') {
            if (ev.text) pushMsg(sessId, { kind: 'reasoning', content: ev.text });
          } else if (ev.t === 'tool_call') {
            pushMsg(sessId, { kind: 'tool_call', id: ev.id, name: ev.name, args: ev.args ?? '{}' });
          } else if (ev.t === 'tool_result') {
            pushMsg(sessId, { kind: 'tool_result', id: ev.id, name: ev.name, out: ev.out ?? '' });
          } else if (ev.t === 'delta') {
            if (!assistantStarted) {
              pushMsg(sessId, { kind: 'assistant', content: ev.text ?? '' });
              assistantStarted = true;
            } else {
              updateLast(sessId, m => m.kind === 'assistant' ? { ...m, content: ev.text ?? '' } : m);
            }
          } else if (ev.t === 'metrics') {
            patchSession(sessId, {
              metrics: {
                prompt: ev.prompt ?? 0,
                completion: ev.completion ?? 0,
                total: ev.total ?? 0,
                round: ev.round ?? 0,
                toolCalls: ev.toolCalls ?? 0,
                compactions: ev.compactions ?? 0,
                elapsed: ev.elapsed ?? 0,
              },
            });
          } else if (ev.t === 'done') {
            const u = ev.usage ?? {};
            patchSession(sessId, {
              tokens: {
                prompt:     u.prompt_tokens     ?? 0,
                completion: u.completion_tokens ?? 0,
                total:      u.total_tokens      ?? 0,
              },
            });
          } else if (ev.t === 'error') {
            pushMsg(sessId, { kind: 'assistant', content: `Error: ${ev.message}` });
          }
        }
      }
    } catch (e: any) {
      if (e.name !== 'AbortError') {
        pushMsg(sessId, { kind: 'assistant', content: `Error: ${e.message}` });
      }
    } finally {
      patchSession(sessId, { loading: false });
      delete abortRefs.current[sessId];
    }
  };

  const current = currentId ? sessions[currentId] : null;

  const renderMsg = (msg: Msg, idx: number) => {
    if (msg.kind === 'user') {
      return (
        <div key={idx} style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
          <div className="msg-content" style={{
            maxWidth: '82%', background: C.userBg, border: `1px solid ${C.userBorder}`,
            borderRadius: '16px 16px 4px 16px', padding: '9px 13px',
            color: C.text, fontSize: 14, lineHeight: 1.55, wordBreak: 'break-word',
          }}>
            <div dangerouslySetInnerHTML={{ __html: marked.parse(msg.content) as string }} />
          </div>
        </div>
      );
    }

    if (msg.kind === 'assistant') {
      return (
        <div key={idx} style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 10 }}>
          <div className="msg-content" style={{
            maxWidth: '82%', background: C.surface2, border: `1px solid ${C.assistBorder}`,
            borderRadius: '16px 16px 16px 4px', padding: '9px 13px',
            color: C.text, fontSize: 14, lineHeight: 1.55, wordBreak: 'break-word',
          }}>
            <div dangerouslySetInnerHTML={{ __html: marked.parse(msg.content) as string }} />
          </div>
        </div>
      );
    }

    if (msg.kind === 'reasoning') {
      const key = `${currentId}:${idx}`;
      const isOpen = expanded.has(key);
      const preview = msg.content.replace(/\s+/g, ' ').slice(0, 70) + (msg.content.length > 70 ? '…' : '');
      return (
        <div key={idx} style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 6 }}>
          <div style={{ maxWidth: '82%' }}>
            <div
              onClick={() => toggleExpanded(key)}
              style={{
                background: 'transparent', border: `1px dashed ${C.border}`,
                borderRadius: 8, padding: '5px 10px',
                color: C.muted, fontSize: 12, fontStyle: 'italic',
                cursor: 'pointer', userSelect: 'none',
              }}
            >
              <span>{isOpen ? '▾' : '▸'}</span>{' '}
              💭 <span>thinking</span>
              {!isOpen && preview && <span style={{ marginLeft: 6, opacity: 0.7 }}>{preview}</span>}
            </div>
            {isOpen && (
              <div className="reasoning-body">{msg.content}</div>
            )}
          </div>
        </div>
      );
    }

    if (msg.kind === 'tool_call') {
      let pretty = msg.args;
      try { pretty = JSON.stringify(JSON.parse(msg.args), null, 2); } catch { /* leave raw */ }
      const preview = (() => {
        try {
          const a = JSON.parse(msg.args);
          return Object.values(a).map(v => JSON.stringify(v)).join(', ').slice(0, 60);
        } catch { return msg.args.slice(0, 60); }
      })();
      const key = `${currentId}:${idx}`;
      const isOpen = expanded.has(key);
      return (
        <div key={idx} style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 4 }}>
          <div style={{ maxWidth: '82%' }}>
            <div
              onClick={() => toggleExpanded(key)}
              style={{
                background: C.toolBg, border: `1px solid ${C.toolBorder}`,
                borderRadius: 8, padding: '5px 10px',
                color: C.accent, fontSize: 12, fontFamily: 'monospace',
                opacity: 0.85, cursor: 'pointer', userSelect: 'none',
              }}
            >
              <span style={{ color: C.muted }}>{isOpen ? '▾' : '▸'}</span>{' '}
              ⚙ <strong>{msg.name}</strong>
              {!isOpen && preview && <span style={{ color: C.muted }}> ({preview})</span>}
            </div>
            {isOpen && (
              <pre className="tool-body">{pretty}</pre>
            )}
          </div>
        </div>
      );
    }

    if (msg.kind === 'tool_result') {
      const lines = msg.out.split('\n');
      const preview = lines[0].slice(0, 80) + (lines.length > 1 || msg.out.length > 80 ? '…' : '');
      const key = `${currentId}:${idx}`;
      const isOpen = expanded.has(key);
      return (
        <div key={idx} style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 8 }}>
          <div style={{ maxWidth: '82%' }}>
            <div
              onClick={() => toggleExpanded(key)}
              style={{
                background: C.toolBg, border: `1px solid ${C.toolBorder}`,
                borderRadius: 8, padding: '5px 10px',
                color: C.muted, fontSize: 12, fontFamily: 'monospace',
                cursor: 'pointer', userSelect: 'none',
              }}
            >
              <span>{isOpen ? '▾' : '▸'}</span>{' '}
              ✓ <span style={{ color: '#446644' }}>{msg.name}</span>
              {!isOpen && preview && <span style={{ marginLeft: 6 }}>{preview}</span>}
            </div>
            {isOpen && (
              <pre className="tool-body">{msg.out || '(empty)'}</pre>
            )}
          </div>
        </div>
      );
    }

    return null;
  };

  const sidebarContent = (
    <>
      {!isMobile && (
        <div style={{ padding: '12px 10px 8px', borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
          <button onClick={createSession} style={btnStyle(C)}>+ New Session</button>
        </div>
      )}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {Object.values(sessions).map(s => (
          <div
            key={s.id}
            onClick={() => switchSession(s.id)}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '10px 12px', cursor: 'pointer',
              background: s.id === currentId ? '#162419' : 'transparent',
              borderLeft: `2px solid ${s.id === currentId ? C.accent : 'transparent'}`,
              fontSize: 13, color: s.id === currentId ? C.accent : C.text,
            }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 7 }}>
              {s.loading && <span className="busy-dot" style={{ flexShrink: 0, width: 7, height: 7, borderRadius: '50%', background: C.accent }} />}
              Session {s.id}
            </span>
            <button
              onClick={e => { e.stopPropagation(); closeSession(s.id); }}
              style={{ background: 'none', border: 'none', color: C.danger, cursor: 'pointer', fontSize: 13, padding: '2px 4px', lineHeight: 1, opacity: 0.75 }}
            >✕</button>
          </div>
        ))}
      </div>
      {pluginIcons.filter(p => !uiPlugins.some(u => u.id === p.id)).length > 0 && (
        <div style={{
          flexShrink: 0, borderTop: `1px solid ${C.border}`, padding: '8px 10px',
          display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center',
        }}>
          {pluginIcons.filter(p => !uiPlugins.some(u => u.id === p.id)).map(p => (
            <button
              key={p.id}
              onClick={() => runPluginIcon(p.id)}
              title={p.title}
              aria-label={p.title}
              style={{
                width: 34, height: 34, fontSize: 17, lineHeight: 1,
                background: C.surface2, border: `1px solid ${C.border}`,
                borderRadius: 8, cursor: 'pointer', color: C.text,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >{p.icon}</button>
          ))}
        </div>
      )}

      {/* UI-plugin launchers (registry-driven) */}
      {uiPlugins.length > 0 && (
        <div style={{ borderTop: `1px solid ${C.border}`, padding: '8px 10px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {uiPlugins.map(p => (
            <button
              key={p.id}
              onClick={() => setOpenPlugin(p.id)}
              style={{
                width: '100%',
                padding: '6px 0',
                background: C.accentDim,
                border: `1px solid ${C.accentBorder}`,
                color: C.accent,
                borderRadius: 7,
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: 500,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
              }}
            >
              {p.icon} {p.title}
            </button>
          ))}
        </div>
      )}

      {/* Model switcher */}
      <ModelSwitcher />

      {/* Global metrics panel */}
      <GlobalMetricsPanel />

      {/* Upstream metrics panel */}
      <UpstreamMetricsPanel />
    </>
  );

  return (
    <>
      <style>{`
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        html, body { height: 100%; width: 100%; max-width: 100%; overflow: hidden; overscroll-behavior: none; background: ${C.bg}; color: ${C.text}; font-family: system-ui, -apple-system, sans-serif; }
        #root { width: 100%; max-width: 100%; overflow: hidden; }
        ::-webkit-scrollbar { width: 5px; height: 5px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 3px; }
        .msg-content p { margin: 0 0 6px; }
        .msg-content p:last-child { margin-bottom: 0; }
        .msg-content code { background: #1a1a2a; padding: 1px 5px; border-radius: 4px; font-size: 0.875em; }
        .msg-content pre { background: #131320; border: 1px solid #232332; border-radius: 8px; padding: 10px 12px; overflow-x: auto; margin: 6px 0; }
        .msg-content pre code { background: none; padding: 0; }
        .msg-content a { color: ${C.accent}; }
        .msg-content ul, .msg-content ol { padding-left: 18px; margin: 4px 0; }
        .msg-content h1, .msg-content h2, .msg-content h3 { margin: 8px 0 4px; }
        .msg-content blockquote { border-left: 3px solid ${C.accentBorder}; padding-left: 10px; color: ${C.muted}; margin: 4px 0; }
        /* Code blocks with header bar */
        .codeblock { margin: 6px 0; border: 1px solid #232332; border-radius: 8px; overflow: hidden; }
        .codeblock .cb-head { display: flex; align-items: center; justify-content: space-between; background: #181826; padding: 3px 6px 3px 10px; border-bottom: 1px solid #232332; }
        .codeblock .cb-lang { font-size: 11px; color: ${C.muted}; font-family: monospace; text-transform: lowercase; }
        .codeblock .cb-copy { background: none; border: 1px solid #2a2a3a; color: ${C.muted}; font-size: 11px; padding: 2px 8px; border-radius: 5px; cursor: pointer; font-family: inherit; }
        .codeblock .cb-copy:hover { color: ${C.text}; border-color: #3a3a4a; }
        .codeblock .cb-copy.copied { color: ${C.accent}; border-color: ${C.accentBorder}; }
        .codeblock pre { margin: 0; border: none; border-radius: 0; }
        /* GFM tables */
        .msg-content table { border-collapse: collapse; margin: 6px 0; font-size: 13px; display: block; overflow-x: auto; }
        .msg-content th, .msg-content td { border: 1px solid #2a2a3a; padding: 4px 9px; text-align: left; }
        .msg-content th { background: #181826; }
        /* Task lists */
        .msg-content li input[type=checkbox] { margin-right: 6px; }
        .msg-content ul:has(> li > input[type=checkbox]) { list-style: none; padding-left: 4px; }
        /* Expandable tool output */
        .tool-body { margin: 4px 0 0; background: ${C.toolBg}; border: 1px solid ${C.toolBorder}; border-radius: 8px; padding: 8px 10px; font-size: 12px; font-family: monospace; color: ${C.text}; white-space: pre-wrap; word-break: break-word; max-height: 360px; overflow: auto; }
        .reasoning-body { margin: 4px 0 0; background: ${C.surface}; border: 1px dashed ${C.border}; border-radius: 8px; padding: 8px 11px; font-size: 13px; line-height: 1.5; color: ${C.muted}; font-style: italic; white-space: pre-wrap; word-break: break-word; max-height: 360px; overflow: auto; }
        textarea::placeholder { color: ${C.muted}; }
        textarea:focus { outline: none; border-color: ${C.accentBorder} !important; }
        .busy-dot { animation: busy-pulse 1s ease-in-out infinite; }
        @keyframes busy-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
      `}</style>

      {/* Every UI plugin is mounted for the whole app lifetime and told whether
          its window should be visible — so it can own persistent state (e.g. an
          <audio> element that keeps playing while the window is closed). */}
      {uiPlugins.map(p => (
        <p.Component
          key={p.id}
          open={openPlugin === p.id}
          onClose={() => setOpenPlugin(null)}
        />
      ))}

      <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', background: C.bg }}>

        {toast && (
          <div style={{
            position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 50,
            background: C.surface2, border: `1px solid ${C.accentBorder}`, color: C.text,
            padding: '8px 16px', borderRadius: 8, fontSize: 13, boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
          }}>{toast}</div>
        )}

        {isMobile && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px',
            background: C.surface, borderBottom: `1px solid ${C.border}`, flexShrink: 0,
          }}>
            <button
              onClick={() => setSidebarOpen(o => !o)}
              style={{ background: 'none', border: 'none', color: C.text, fontSize: 20, cursor: 'pointer', padding: '2px 6px', lineHeight: 1, flexShrink: 0 }}
            >☰</button>
            <span style={{ flex: 1, fontSize: 14, color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {currentId ?? 'leatherHarness'}
            </span>
            <button onClick={createSession} style={{ ...btnStyle(C), padding: '5px 12px', fontSize: 13 }}>+ New</button>
          </div>
        )}

        <div style={{ flex: 1, display: 'flex', overflow: 'hidden', position: 'relative' }}>

          {isMobile && sidebarOpen && (
            <div
              onClick={() => setSidebarOpen(false)}
              style={{ position: 'absolute', inset: 0, zIndex: 10, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)' }}
            />
          )}

          <div style={{
            width: 220, background: C.surface, borderRight: `1px solid ${C.border}`,
            display: 'flex', flexDirection: 'column', flexShrink: 0, overflowY: 'auto',
            ...(isMobile ? {
              position: 'absolute', inset: '0 auto 0 0', zIndex: 20, width: 240,
              transform: sidebarOpen ? 'translateX(0)' : 'translateX(-100%)',
              transition: 'transform 0.2s ease',
            } : {}),
          }}>
            {sidebarContent}
          </div>

          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>

            <div onClick={onMessagesClick} style={{ flex: 1, minWidth: 0, overflowY: 'auto', overflowX: 'hidden', padding: '16px 12px 8px', WebkitOverflowScrolling: 'touch' as any }}>
              {(() => {
                const empty = !current || current.msgs.length === 0;
                return (
                  <div style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1,
                    gap: 12, padding: '12px 0 24px',
                    marginTop: empty ? '12vh' : 0,
                    transition: 'margin-top 0.4s ease',
                  }}>
                    <img
                      src="/logo.jpg"
                      alt="leatherHarness"
                      
                      
                      style={{ width: '100%', height: '100%', objectFit: 'contain', transition: 'opacity 0.4s ease', opacity: empty ? 1 : 0.85 }}
                    />

                  </div>
                );
              })()}
              {current && current.msgs.map(renderMsg)}
              {current?.loading && (
                <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 10 }}>
                  <div style={{
                    background: C.surface2, border: `1px solid ${C.assistBorder}`,
                    borderRadius: '16px 16px 16px 4px', padding: '9px 14px',
                    color: C.muted, fontSize: 14,
                  }}>thinking…</div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Token bar */}
            <div style={{
              padding: '3px 14px', fontSize: 11, color: C.muted,
              background: C.surface, borderTop: `1px solid ${C.border}`, flexShrink: 0,
              minHeight: 22, display: 'flex', alignItems: 'center', gap: 12,
            }}>
              {current?.metrics ? (
                <>
                  <span>prompt <strong style={{ color: C.text }}>{current.metrics.prompt.toLocaleString()}</strong></span>
                  <span>completion <strong style={{ color: C.text }}>{current.metrics.completion.toLocaleString()}</strong></span>
                  <span>total <strong style={{ color: C.accent }}>{current.metrics.total.toLocaleString()}</strong></span>
                  <span style={{ color: '#333' }}>|</span>
                  <span>round <strong style={{ color: C.text }}>{current.metrics.round}</strong></span>
                  <span>tools <strong style={{ color: C.text }}>{current.metrics.toolCalls}</strong></span>
                  {current.metrics.compactions > 0 && (
                    <span style={{ color: '#cc8800' }}>compact {current.metrics.compactions}</span>
                  )}
                  <span style={{ color: '#333' }}>|</span>
                  <span>{current.metrics.elapsed != null ? (current.metrics.elapsed / 1000).toFixed(1) : '—'}s</span>
                </>
              ) : current?.tokens ? (
                <>
                  <span>prompt <strong style={{ color: C.text }}>{current.tokens.prompt.toLocaleString()}</strong></span>
                  <span>completion <strong style={{ color: C.text }}>{current.tokens.completion.toLocaleString()}</strong></span>
                  <span>total <strong style={{ color: C.accent }}>{current.tokens.total.toLocaleString()}</strong></span>
                </>
              ) : current?.loading ? (
                <span style={{ color: '#333' }}>counting tokens…</span>
              ) : null}
            </div>

            <div style={{
              display: 'flex', alignItems: 'flex-end', gap: 8,
              padding: '10px 12px',
              paddingBottom: 'max(12px, env(safe-area-inset-bottom, 12px))',
              borderTop: `1px solid ${C.border}`, background: C.surface, flexShrink: 0,
            }}>
              <textarea
                ref={textareaRef}
                rows={2}
                style={{
                  flex: 1, minWidth: 0, resize: 'none',
                  background: C.surface2, border: `1px solid ${C.border}`,
                  borderRadius: 10, color: C.text,
                  padding: '8px 12px', fontSize: 16, fontFamily: 'inherit', lineHeight: 1.4,
                }}
                placeholder="Message…"
                value={current?.input ?? ''}
                onChange={e => currentId && patchSession(currentId, { input: e.target.value })}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                onFocus={() => setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 350)}
              />
              {current?.loading ? (
                <button
                  onClick={() => stopGeneration(currentId)}
                  style={{
                    flexShrink: 0, height: 40, padding: '0 18px',
                    background: '#2a0e12', border: `1px solid ${C.danger}`,
                    color: C.danger, borderRadius: 10, fontSize: 14, fontWeight: 500,
                    cursor: 'pointer', transition: 'all 0.15s',
                  }}
                >■ Stop</button>
              ) : (
                <button
                  onClick={sendMessage}
                  disabled={!current?.input.trim()}
                  style={{
                    flexShrink: 0, height: 40, padding: '0 18px',
                    background: !current?.input.trim() ? '#111' : C.accentDim,
                    border: `1px solid ${!current?.input.trim() ? '#222' : C.accentBorder}`,
                    color: !current?.input.trim() ? '#334' : C.accent,
                    borderRadius: 10, fontSize: 14, fontWeight: 500,
                    cursor: !current?.input.trim() ? 'default' : 'pointer',
                    transition: 'all 0.15s',
                  }}
                >Send</button>
              )}
            </div>

          </div>
        </div>
      </div>
    </>
  );
}

function ModelSwitcher() {
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/models/status');
      const data = await res.json();
      setStatus(data);
      setError(null);
      setLoading(false);
    } catch (e: any) {
      setError(e.message);
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleSwitch = async (modelName: string) => {
    try {
      const res = await fetch('/api/models/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelName }),
      });
      const data = await res.json();
      if (!data.success) {
        setToast(`Failed to switch model: ${data.error}`);
        setTimeout(() => setToast(null), 3000);
      }
      await fetchStatus();
    } catch (e: any) {
      setToast(`Error switching model: ${e.message}`);
      setTimeout(() => setToast(null), 3000);
    }
  };

  const handleStop = async () => {
    try {
      const res = await fetch('/api/models/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (!data.success) {
        setToast(`Failed to stop model: ${data.error}`);
        setTimeout(() => setToast(null), 3000);
      }
      await fetchStatus();
    } catch (e: any) {
      setToast(`Error stopping model: ${e.message}`);
      setTimeout(() => setToast(null), 3000);
    }
  };

  if (loading) {
    return (
      <div style={{
        flexShrink: 0, borderTop: `1px solid ${C.border}`, padding: '8px 10px',
        fontSize: 11, color: C.muted,
      }}>
        <div style={{ fontWeight: 500, marginBottom: 4, color: C.text }}>Model Launcher</div>
        <div>loading...</div>
      </div>
    );
  }

  if (error || !status) {
    return null;
  }

  if (!status.enabled) {
    return null;
  }

  return (
    <div style={{
      flexShrink: 0, borderTop: `1px solid ${C.border}`, padding: '8px 10px',
      fontSize: 11, color: C.muted,
    }}>
      <div style={{ fontWeight: 500, marginBottom: 4, color: C.text }}>Model Launcher</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>
            Status: <strong style={{ color: status.isRunning ? C.accent : C.danger }}>
              {status.isRunning ? 'Running' : 'Stopped'}
            </strong>
          </span>
          {status.isRunning && (
            <button
              onClick={handleStop}
              style={{
                background: 'transparent',
                border: `1px solid ${C.danger}`,
                color: C.danger,
                borderRadius: 4,
                padding: '2px 6px',
                cursor: 'pointer',
                fontSize: 10,
              }}
            >Stop</button>
          )}
        </div>
        {status.isRunning && status.modelName && (
          <div style={{ color: C.text, fontSize: 10 }}>
            Current: {status.modelName}
            {status.pid && <span style={{ color: C.muted, marginLeft: 4 }}>(PID: {status.pid})</span>}
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 }}>
          {status.models.map(model => (
            <button
              key={model.name}
              onClick={() => handleSwitch(model.name)}
              disabled={status.isRunning && status.modelName === model.name}
              style={{
                background: status.isRunning && status.modelName === model.name ? C.accentDim : C.surface2,
                border: `1px solid ${status.isRunning && status.modelName === model.name ? C.accentBorder : C.border}`,
                color: status.isRunning && status.modelName === model.name ? C.accent : C.text,
                borderRadius: 4,
                padding: '4px 8px',
                cursor: status.isRunning && status.modelName === model.name ? 'default' : 'pointer',
                fontSize: 10,
                textAlign: 'left',
              }}
            >
              {model.name}
              {model.default && <span style={{ color: C.muted, marginLeft: 4 }}>(default)</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function btnStyle(c: typeof C) {
  return {
    width: '100%' as const, padding: '8px 0' as const,
    background: c.accentDim, border: `1px solid ${c.accentBorder}`,
    color: c.accent, borderRadius: 7, cursor: 'pointer' as const,
    fontSize: 13, fontWeight: 500 as const,
  };
}

function GlobalMetricsPanel() {
  const [metrics, setMetrics] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchMetrics = async () => {
      try {
        const res = await fetch('/api/metrics');
        const data = await res.json();
        setMetrics(data);
        setLoading(false);
      } catch {
        setLoading(false);
      }
    };
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 5000);
    return () => clearInterval(interval);
  }, []);

  if (loading || !metrics) {
    return (
      <div style={{
        flexShrink: 0, borderTop: `1px solid ${C.border}`, padding: '8px 10px',
        fontSize: 11, color: C.muted,
      }}>
        <div style={{ fontWeight: 500, marginBottom: 4, color: C.text }}>Global Metrics</div>
        <div>loading...</div>
      </div>
    );
  }

  const formatUptime = (hours: number) => {
    if (hours == null || isNaN(hours)) return '—';
    if (hours < 1) return `${Math.round(hours * 60)}m`;
    if (hours < 24) return `${hours.toFixed(1)}h`;
    return `${(hours / 24).toFixed(1)}d`;
  };

  return (
    <div style={{
      flexShrink: 0, borderTop: `1px solid ${C.border}`, padding: '8px 10px',
      fontSize: 11, color: C.muted,
    }}>
      <div style={{ fontWeight: 500, marginBottom: 4, color: C.text }}>Global Metrics</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 8px' }}>
        <div>Requests: <strong style={{ color: C.text }}>{metrics.totalRequests}</strong></div>
        <div>Uptime: <strong style={{ color: C.text }}>{formatUptime(metrics.uptimeHours)}</strong></div>
        <div>Tokens: <strong style={{ color: C.accent }}>{metrics.totalTokens.toLocaleString()}</strong></div>
        <div>Avg/req: <strong style={{ color: C.text }}>{metrics.avgTokensPerRequest}</strong></div>
        <div>Tools: <strong style={{ color: C.text }}>{metrics.totalToolCalls}</strong></div>
        <div>Compacts: <strong style={{ color: C.text }}>{metrics.totalCompactions}</strong></div>
      </div>
    </div>
  );
}

function UpstreamMetricsPanel() {
  const [metrics, setMetrics] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchMetrics = async () => {
      try {
        const res = await fetch('/api/upstream/metrics');
        const text = await res.text();
        // 503 with running:false means no model is running — a normal idle
        // state, not an error worth surfacing.
        if (res.status === 503) {
          setMetrics(null);
          setError('no model running');
          setLoading(false);
          return;
        }
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${text.slice(0, 100)}`);
        }
        setMetrics(JSON.parse(text));
        setError(null);
        setLoading(false);
      } catch (e: any) {
        setError(e.message);
        setLoading(false);
      }
    };
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 10000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div style={{
        flexShrink: 0, borderTop: `1px solid ${C.border}`, padding: '8px 10px',
        fontSize: 11, color: C.muted,
      }}>
        <div style={{ fontWeight: 500, marginBottom: 4, color: C.text }}>Upstream Metrics</div>
        <div>loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{
        flexShrink: 0, borderTop: `1px solid ${C.border}`, padding: '8px 10px',
        fontSize: 11, color: C.muted,
      }}>
        <div style={{ fontWeight: 500, marginBottom: 4, color: C.text }}>Upstream Metrics</div>
        <div style={{ color: C.danger }}>Unavailable: {error}</div>
      </div>
    );
  }

  if (!metrics) {
    return null;
  }

  const entries = Object.entries(metrics);
  if (entries.length === 0) {
    return (
      <div style={{
        flexShrink: 0, borderTop: `1px solid ${C.border}`, padding: '8px 10px',
        fontSize: 11, color: C.muted,
      }}>
        <div style={{ fontWeight: 500, marginBottom: 4, color: C.text }}>Upstream Metrics</div>
        <div>No data available</div>
      </div>
    );
  }

  return (
    <div style={{
      flexShrink: 0, borderTop: `1px solid ${C.border}`, padding: '8px 10px',
      fontSize: 11, color: C.muted,
    }}>
      <div style={{ fontWeight: 500, marginBottom: 4, color: C.text }}>Upstream Metrics</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {entries.map(([key, value]) => (
          <div key={key} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ wordBreak: 'break-all', minWidth: 0 }}>{key}</span>
            <strong style={{ color: C.text, flexShrink: 0 }}>
              {typeof value === 'number' ? value.toLocaleString() : String(value)}
            </strong>
          </div>
        ))}
      </div>
    </div>
  );
}
