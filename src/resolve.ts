import fetch from 'node-fetch';
import { readFile, readdir } from 'node:fs/promises';
import { resolve as resolvePath, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { hasTool, getTool, toolSchemas } from './registry.ts';
import { logError } from './log.ts';

// At startup only the MAIN memo is injected into context. If sub-memos exist
// (other `.md` files in the same directory), we append a one-line mention of
// their names so the model knows it can pull them in via read_memo on demand.
async function readMemoContent(config: any): Promise<string> {
  const memoDir = resolvePath(homedir(), '.config/leatherHarness/plugins/memo');
  const mainMemoFile = 'memo.md';

  let main = '';
  try { main = await readFile(resolvePath(memoDir, mainMemoFile), 'utf8'); } catch (_) {}

  let subs: string[] = [];
  try {
    const entries = await readdir(memoDir);
    subs = entries
      .filter(f => f.endsWith('.md') && f !== mainMemoFile)
      .map(f => f.slice(0, -3))
      .sort();
  } catch (_) {}

  if (!main && subs.length === 0) return '';
  if (subs.length === 0) return main;

  const mention = `Sub-memos available (read on demand with read_memo using the "name" argument): ${subs.join(', ')}`;
  return main ? `${main}\n\n${mention}` : mention;
}

type Emit = (ev: object) => void;

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Turn any thrown value into a useful one-line description (incl. fetch `cause` and timeouts). */
function describeError(e: any): string {
  if (e == null) return 'unknown error';
  let m = e.message || String(e);
  if (e.name === 'AbortError' || e.name === 'TimeoutError') m = `timed out (${m})`;
  const cause = e.cause;
  if (cause) m += ` — cause: ${cause.code || cause.message || cause}`;
  return m;
}

type UpstreamResult = { ok: true; data: any } | { ok: false; error: string };

/**
 * Pull the model's "thinking" out of a response message and return it alongside
 * the user-visible answer. Reasoning shows up two ways depending on the upstream:
 *   - a dedicated field (`reasoning_content` for DeepSeek-style, `reasoning` for o1-style)
 *   - inline `<think>…</think>` tags embedded in `content`
 * We support both, and strip inline think-tags so they never leak into the answer.
 */
function splitReasoning(msg: any): { reasoning: string; content: string } {
  let reasoning: string = msg?.reasoning_content ?? msg?.reasoning ?? '';
  let content: string = msg?.content ?? '';

  // Extract any inline <think>…</think> blocks (and an unclosed trailing one).
  const parts: string[] = [];
  content = content.replace(/<think>([\s\S]*?)<\/think>/gi, (_m: string, inner: string) => {
    parts.push(inner);
    return '';
  });
  const openIdx = content.search(/<think>/i);
  if (openIdx >= 0) {
    parts.push(content.slice(openIdx + content.match(/<think>/i)![0].length));
    content = content.slice(0, openIdx);
  }
  if (parts.length) {
    const inline = parts.join('\n').trim();
    reasoning = reasoning ? `${reasoning}\n${inline}` : inline;
  }

  return { reasoning: reasoning.trim(), content: content.trim() };
}

/**
 * Streaming-aware splitter for inline `<think>…</think>` reasoning. The
 * non-streamed path strips these blocks (via splitReasoning) before emitting, so
 * the streamed path must do the same live — otherwise a model's chain-of-thought
 * leaks token-by-token into the client's output, which for edit-format clients
 * like oh-my-pi corrupts the answer they parse. Tags may straddle chunk
 * boundaries, so we hold back any tail that could be the start of a tag.
 */
function makeThinkFilter() {
  const OPEN = '<think>';
  const CLOSE = '</think>';
  let inThink = false;
  let buf = '';

  // Longest suffix of `s` that is a proper prefix of `tag` — the piece we can't
  // emit yet because it might complete into `tag` on the next chunk.
  const heldPrefix = (s: string, tag: string): number => {
    for (let k = Math.min(s.length, tag.length - 1); k > 0; k--) {
      if (s.slice(s.length - k) === tag.slice(0, k)) return k;
    }
    return 0;
  };

  const feed = (chunk: string): { text: string; reasoning: string } => {
    buf += chunk;
    let text = '';
    let reasoning = '';
    for (;;) {
      if (!inThink) {
        const i = buf.indexOf(OPEN);
        if (i >= 0) { text += buf.slice(0, i); buf = buf.slice(i + OPEN.length); inThink = true; continue; }
        const hold = heldPrefix(buf, OPEN);
        text += buf.slice(0, buf.length - hold);
        buf = buf.slice(buf.length - hold);
        break;
      } else {
        const i = buf.indexOf(CLOSE);
        if (i >= 0) { reasoning += buf.slice(0, i); buf = buf.slice(i + CLOSE.length); inThink = false; continue; }
        const hold = heldPrefix(buf, CLOSE);
        reasoning += buf.slice(0, buf.length - hold);
        buf = buf.slice(buf.length - hold);
        break;
      }
    }
    return { text, reasoning };
  };

  // Flush leftover once the stream ends: an unterminated think block stays
  // reasoning; anything else (incl. a stray partial tag) is real text.
  const flush = (): { text: string; reasoning: string } => {
    const rem = buf;
    buf = '';
    return inThink ? { text: '', reasoning: rem } : { text: rem, reasoning: '' };
  };

  return { feed, flush };
}

/**
 * Consume an OpenAI-style streaming (SSE) chat completion, forwarding assistant
 * text to `onDelta` as each chunk arrives and stitching the pieces back into a
 * single message so callers can treat the result exactly like a non-streamed
 * response. Inline `<think>` reasoning is filtered out of the forwarded text (and
 * kept aside); tool-call fragments are reassembled by index; reasoning and usage
 * (when the upstream includes them) are preserved.
 */
async function consumeStream(body: any, onDelta: (text: string) => void): Promise<any> {
  let content = '';
  let reasoning = '';
  const toolCalls: any[] = [];
  let usage: any;
  let finishReason: string | null = null;
  let buffer = '';
  const think = makeThinkFilter();

  const handleData = (payload: string) => {
    if (payload === '[DONE]') return;
    let chunk: any;
    try { chunk = JSON.parse(payload); } catch { return; }
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string' && delta.content) {
      // Forward only the answer text; inline chain-of-thought is held aside.
      const { text, reasoning: inlineReasoning } = think.feed(delta.content);
      if (inlineReasoning) reasoning += inlineReasoning;
      if (text) { content += text; onDelta(text); }
    }
    const r = delta.reasoning_content ?? delta.reasoning;
    if (typeof r === 'string' && r) reasoning += r;
    for (const tc of delta.tool_calls || []) {
      const i = tc.index ?? 0;
      const slot = (toolCalls[i] ||= { id: tc.id, type: 'function', function: { name: '', arguments: '' } });
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.function.name = tc.function.name;
      if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
    }
  };

  const drainFrame = (frame: string) => {
    for (const line of frame.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data:')) handleData(trimmed.slice(5).trim());
    }
  };

  // SSE frames are separated by a blank line; a frame may split across chunks.
  for await (const piece of body) {
    buffer += piece.toString('utf8');
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      drainFrame(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
    }
  }
  // A final frame may arrive without its trailing blank line — don't drop it.
  if (buffer.trim()) drainFrame(buffer);

  // Emit anything the think-filter was holding back (partial tag, or trailing text).
  const tail = think.flush();
  if (tail.reasoning) reasoning += tail.reasoning;
  if (tail.text) { content += tail.text; onDelta(tail.text); }

  const message: any = { role: 'assistant', content };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls.filter(Boolean);
  return { choices: [{ message, finish_reason: finishReason }], usage };
}

/**
 * Call the upstream model, retrying transient network/5xx failures so a blip
 * doesn't kill the loop. When `onDelta` is supplied and the payload requests
 * `stream: true`, the response is consumed as SSE and assistant text is forwarded
 * token-by-token; the assembled message is returned in the usual non-streamed
 * shape so the rest of the loop is unaffected. Retries stop once any bytes have
 * been streamed to the caller — we can't un-send what a client already received.
 */
async function callUpstream(url: string, payload: object, onDelta?: (text: string) => void): Promise<UpstreamResult> {
  const streaming = !!(payload as any).stream && typeof onDelta === 'function';
  let streamedAny = false;
  const wrappedDelta = onDelta ? (t: string) => { streamedAny = true; onDelta(t); } : undefined;

  const maxAttempts = 10;
  let lastErr = 'unknown error';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(`${url}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        lastErr = `upstream HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`;
        // llama.cpp (--jinja) builds a tool-call parser by rendering the model's
        // chat template; some templates (Qwen3-style, used by Ornith) 400 with a
        // raise_exception during that generation for certain message shapes.
        // Tools aren't required to get *an* answer, so retry the call once without
        // them rather than failing the whole round.
        if (
          res.status === 400 &&
          /parser|No user query|raise_exception/i.test(text) &&
          (payload as any).tools?.length
        ) {
          console.warn('⚠️  Upstream rejected tool-parser generation; retrying without tools');
          const { tools, ...noTools } = payload as any;
          return callUpstream(url, noTools, onDelta);
        }
        // Retry only on rate-limit / server errors; other client errors won't improve on retry.
        if (res.status === 429 || res.status >= 500) { await delay(500 * attempt); continue; }
        return { ok: false, error: lastErr };
      }
      let data: any;
      const isSse = (res.headers.get('content-type') || '').includes('text/event-stream');
      if (streaming && isSse) {
        try {
          data = await consumeStream(res.body, wrappedDelta!);
        } catch (e: any) {
          lastErr = describeError(e);
          // Bytes already on the wire — retrying would duplicate output. Bail.
          if (streamedAny) return { ok: false, error: lastErr };
          await delay(500 * attempt);
          continue;
        }
      } else {
        // Non-streamed body (or an upstream that ignored stream:true and answered
        // with plain JSON) — parse it whole; the caller emits it in one shot.
        data = await res.json();
      }
      if (!data?.choices?.[0]?.message) {
        lastErr = `upstream returned no message: ${JSON.stringify(data).slice(0, 300)}`;
        if (streamedAny) return { ok: false, error: lastErr };
        await delay(500 * attempt);
        continue;
      }
      return { ok: true, data };
    } catch (e: any) {
      lastErr = describeError(e);
      if (streamedAny) return { ok: false, error: lastErr };
      const isConnectionError = e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND' || e.code === 'ETIMEDOUT' || e.cause?.code === 'ECONNREFUSED';
      const backoffMs = isConnectionError ? Math.min(1000 * Math.pow(2, attempt - 1), 30000) : 500 * attempt;
      console.warn(`⚠️  Upstream attempt ${attempt}/${maxAttempts} failed: ${lastErr}`);
      logError(`callUpstream attempt ${attempt}/${maxAttempts}`, e);
      if (attempt < maxAttempts) await delay(backoffMs);
    }
  }
  return { ok: false, error: lastErr };
}

/**
 * Compact old messages by summarizing them into a single block.
 * When the conversation grows too long, we call the upstream LLM to create
 * a summary of the older half of messages, preserving context while freeing
 * up space in the context window.
 */
async function compactMessages(
  messages: any[],
  upstreamUrl: string,
  maxMessages: number,
  emit?: Emit
): Promise<any[]> {
  // The client's system prompt carries standing instructions (tool formats,
  // persona, safety rules) that a lossy summary cannot reproduce — losing it
  // makes clients like oh-my-pi emit malformed tool payloads after the first
  // compaction. Set it aside verbatim and only ever compact the turns after it.
  // Summaries from earlier compactions are also leading system messages, but
  // those must stay compactable or they pile up one per round — fold them back
  // into the conversation so the next summary absorbs them.
  const isSummary = (m: any) =>
    typeof m.content === 'string' && m.content.startsWith('[Compacted Conversation Summary]');
  let systemIdx = 0;
  while (systemIdx < messages.length && messages[systemIdx].role === 'system') systemIdx++;
  const systemMessages = messages.slice(0, systemIdx).filter((m: any) => !isSummary(m));
  const conversation = [
    ...messages.slice(0, systemIdx).filter(isSummary),
    ...messages.slice(systemIdx),
  ];

  // Keep the last maxMessages/2 messages, compact the rest — but never split a
  // tool-call group. A `tool` message is only valid immediately after the
  // assistant message whose tool_calls it answers; if compaction summarizes that
  // assistant into the older half, the kept tail begins with an orphaned `tool`
  // message and llama.cpp (--jinja) 400s on it — which doesn't match the
  // retry-without-tools heuristic, so the whole round fails and long-running
  // clients (opencode, oh-my-pi) stop. Walk the boundary back until the kept tail
  // starts on a clean turn, pulling the parent assistant (and its other results)
  // back with it.
  const keepFromEnd = Math.ceil(maxMessages / 2);
  let cut = Math.max(0, conversation.length - keepFromEnd);
  while (cut > 0 && conversation[cut]?.role === 'tool') cut--;
  const messagesToCompact = conversation.slice(0, cut);
  const messagesToKeep = conversation.slice(cut);

  if (messagesToCompact.length === 0) return messages;

  // Some chat templates (Qwen3-style, used by Ornith) raise
  // "No user query found in messages." during llama.cpp's --jinja tool-call
  // parser generation when the request has no `user` turn at all. Compaction
  // otherwise drops the original request into the summarized half, leaving a
  // tail of only assistant/tool messages — so carry the earliest user turn
  // forward whenever the kept tail contains none.
  const preserveUserTurn = (kept: any[]): any[] => {
    if (kept.some((m: any) => m.role === 'user')) return kept;
    const firstUser = conversation.find((m: any) => m.role === 'user');
    return firstUser ? [firstUser, ...kept] : kept;
  };

  // Build a compacted summary by asking the model to summarize
  const compactPayload = {
    messages: [
      {
        role: 'system',
        content: `You are a conversation compressor. Summarize the following conversation history into a concise but complete summary. Preserve key facts, decisions, tool results, and any important context. Do NOT include your own thoughts or commentary — just the factual summary. Format as plain text with clear sections.\n\nConversation:\n${messagesToCompact.map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`).join('\n\n')}`,
      },
      { role: 'user', content: 'Provide a concise summary of this conversation.' },
    ],
    stream: false,
  };

  try {
    const compactResult = await callUpstream(upstreamUrl, compactPayload);
    if (compactResult.ok) {
      const summary = compactResult.data.choices[0].message.content;
      console.log(`📦 Compacted ${messagesToCompact.length} messages into summary`);
      emit?.({ t: 'compact', summary, oldCount: messagesToCompact.length, newCount: systemMessages.length + messagesToKeep.length + 1 });

      // Replace old messages with the summary, keeping the system prompt verbatim
      return [
        ...systemMessages,
        { role: 'system', content: `[Compacted Conversation Summary]\n${summary}` },
        ...preserveUserTurn(messagesToKeep),
      ];
    }
  } catch (e) {
    console.warn('⚠️  Compaction failed:', e);
    logError('compactMessages', e);
  }

  // If compaction fails, just truncate without summary
  console.log(`✂️  Compaction failed, truncating to last ${messagesToKeep.length} messages`);
  return [...systemMessages, ...preserveUserTurn(messagesToKeep)];
}

export async function resolveRequest(body: any, config: any, emit?: Emit): Promise<any> {
  const maxRounds = config.maxToolRounds || 5;
  const maxMessages = config.maxMessages || 50; // compaction threshold
  const messages = [...body.messages];

  // Metrics tracking
  const metrics = {
    startTime: Date.now(),
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    rounds: 0,
    toolCalls: 0,
    compactions: 0,
  };

  const emitMetrics = () => {
    const elapsed = Date.now() - metrics.startTime;
    emit?.({
      t: 'metrics',
      prompt: metrics.promptTokens,
      completion: metrics.completionTokens,
      total: metrics.totalTokens,
      round: metrics.rounds,
      toolCalls: metrics.toolCalls,
      compactions: metrics.compactions,
      elapsed,
    });
  };

  try {
    const memo = await readMemoContent(config);
    if (memo) {
      const block = `[Persistent Session Memory]\n${memo}`;
      const sysIdx = messages.findIndex((m: any) => m.role === 'system');
      if (sysIdx >= 0) {
        messages[sysIdx] = { ...messages[sysIdx], content: `${messages[sysIdx].content}\n\n${block}` };
      } else {
        messages.unshift({ role: 'system', content: block });
      }
    }
  } catch (_) {}

  const clientTools = body.tools ?? [];
  const upstreamUrl = config.upstream.baseUrl;

  for (let round = 0; round < maxRounds; round++) {
    metrics.rounds = round + 1;
    console.log(`⚙️  Round ${round + 1}/${maxRounds}`);

    // Check if we need to compact before this round
    if (messages.length > maxMessages) {
      console.log(`📦 Messages (${messages.length}) exceed threshold (${maxMessages}), compacting...`);
      const compacted = await compactMessages(messages, upstreamUrl, maxMessages, emit);
      if (compacted) {
        messages.length = 0;
        messages.push(...compacted);
        metrics.compactions++;
        emitMetrics();
      }
    }

    const tools = [...clientTools, ...toolSchemas()];
    // Stream from upstream whenever we have a live consumer (emit). The final
    // answer is forwarded token-by-token as it's generated; tool-call rounds emit
    // no user-visible text, so they're unaffected. include_usage keeps the token
    // metrics working under streaming (llama.cpp sends a trailing usage-only chunk).
    const wantStream = !!emit;
    let streamedText = false;
    const onDelta = emit
      ? (text: string) => { streamedText = true; emit({ t: 'delta', text }); }
      : undefined;
    const payload = {
      ...body,
      messages,
      tools,
      stream: wantStream,
      ...(wantStream ? { stream_options: { include_usage: true } } : {}),
    };
    const result = await callUpstream(upstreamUrl, payload, onDelta);
    if (!result.ok) {
      console.error('❌ Upstream call failed:', result.error);
      if (emit) {
        emit({ t: 'error', message: `Model call failed: ${result.error}` });
        emit({ t: 'done', usage: {} });
        return null;
      }
      return { error: { message: result.error } };
    }
    const data = result.data;
    const msg = data.choices[0].message;
    const calls: any[] = msg.tool_calls || [];
    const { reasoning, content } = splitReasoning(msg);
    if (reasoning && emit) emit({ t: 'reasoning', text: reasoning });

    // Update token counts from this round
    const roundUsage = data.usage ?? {};
    metrics.promptTokens += roundUsage.prompt_tokens ?? 0;
    metrics.completionTokens += roundUsage.completion_tokens ?? 0;
    metrics.totalTokens += roundUsage.total_tokens ?? 0;

    // No tool calls — this is the final answer
    if (calls.length === 0) {
      if (emit) {
        // Streaming already forwarded the text live; only emit here as a fallback
        // when nothing streamed (e.g. an upstream that ignored stream:true).
        if (!streamedText && content) emit({ t: 'delta', text: content });
        emitMetrics();
        emit({ t: 'done', usage: data.usage ?? {} });
        return null;
      }
      return data;
    }

    // Foreign tool calls (client-side tools) — pass through
    const foreign = calls.filter((c: any) => !hasTool(c.function.name));
    if (foreign.length > 0) {
      console.log('⚠️  Foreign tool calls:', foreign.map((c: any) => c.function.name));
      if (emit) {
        if (!streamedText && content) emit({ t: 'delta', text: content });
        // Forward the model's tool_calls so OpenAI-compatible clients (which passed
        // their own tools) actually receive the calls they need to execute. The web
        // UI never sends tools, so it never reaches this branch and ignores the event.
        emit({ t: 'tool_calls', calls });
        emitMetrics();
        emit({ t: 'done', usage: data.usage ?? {} });
        return null;
      }
      return data;
    }

    // All harness tools — execute and loop.
    // The model can request several independent tools in one round; run them
    // concurrently so a round costs the slowest call, not the sum. Results are
    // still appended in call order so each `tool` message pairs with its call in
    // the sequence upstream chat templates expect.
    messages.push(msg);
    metrics.toolCalls += calls.length;
    const results = await Promise.all(calls.map(async (tc: any) => {
      let args: any = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}

      console.log(`🛠️  Executing ${tc.function.name}`);
      emit?.({ t: 'tool_call', id: tc.id, name: tc.function.name, args: tc.function.arguments });

      let out: string;
      try {
        const raw = await getTool(tc.function.name)!.execute(args);
        out = typeof raw === 'string' ? raw : JSON.stringify(raw);
      } catch (e: any) {
        // Never let a tool failure kill the loop — feed the error back so the model can recover.
        out = `ERROR: ${tc.function.name} failed: ${describeError(e)}`;
        console.warn(`⚠️  Tool ${tc.function.name} threw: ${out}`);
        logError(`tool ${tc.function.name}`, e);
      }

      // Backstop: cap any single tool result so one giant output (a scraped page,
      // a huge file read) can't push the request past the model's context window.
      const maxToolChars = config.maxToolOutputChars ?? 60000;
      if (out.length > maxToolChars) {
        out = out.slice(0, maxToolChars) + `\n\n…[truncated ${out.length - maxToolChars} chars]`;
      }

      console.log(`✅ ${tc.function.name} →`, out.slice(0, 80));
      emit?.({ t: 'tool_result', id: tc.id, name: tc.function.name, out });
      return { role: 'tool', tool_call_id: tc.id, content: out };
    }));
    for (const r of results) messages.push(r);

    // Emit metrics after each tool round
    emitMetrics();
  }

  console.error('⛔ Tool round limit exceeded');
  if (emit) {
    emit({ t: 'error', message: `Tool round limit (${maxRounds}) exceeded` });
    emitMetrics();
    emit({ t: 'done', usage: {} });
    return null;
  }
  return { error: { message: 'Tool round limit exceeded' } };
}
