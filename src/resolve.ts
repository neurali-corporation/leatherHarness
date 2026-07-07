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

/** Call the upstream model, retrying transient network/5xx failures so a blip doesn't kill the loop. */
async function callUpstream(url: string, payload: object): Promise<UpstreamResult> {
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
          return callUpstream(url, noTools);
        }
        // Retry only on rate-limit / server errors; other client errors won't improve on retry.
        if (res.status === 429 || res.status >= 500) { await delay(500 * attempt); continue; }
        return { ok: false, error: lastErr };
      }
      const data = await res.json() as any;
      if (!data?.choices?.[0]?.message) {
        lastErr = `upstream returned no message: ${JSON.stringify(data).slice(0, 300)}`;
        await delay(500 * attempt);
        continue;
      }
      return { ok: true, data };
    } catch (e: any) {
      lastErr = describeError(e);
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
  // Keep the last maxMessages/2 messages, compact the rest
  const keepFromEnd = Math.ceil(maxMessages / 2);
  const messagesToCompact = messages.slice(0, messages.length - keepFromEnd);
  const messagesToKeep = messages.slice(messages.length - keepFromEnd);

  if (messagesToCompact.length === 0) return messages;

  // Some chat templates (Qwen3-style, used by Ornith) raise
  // "No user query found in messages." during llama.cpp's --jinja tool-call
  // parser generation when the request has no `user` turn at all. Compaction
  // otherwise drops the original request into the summarized half, leaving a
  // tail of only assistant/tool messages — so carry the earliest user turn
  // forward whenever the kept tail contains none.
  const preserveUserTurn = (kept: any[]): any[] => {
    if (kept.some((m: any) => m.role === 'user')) return kept;
    const firstUser = messages.find((m: any) => m.role === 'user');
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
      emit?.({ t: 'compact', summary, oldCount: messagesToCompact.length, newCount: messagesToKeep.length + 1 });

      // Replace old messages with the summary
      return [
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
  return preserveUserTurn(messagesToKeep);
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
    const payload = { ...body, messages, tools, stream: false };
    const result = await callUpstream(upstreamUrl, payload);
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
        emit({ t: 'delta', text: content });
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
        emit({ t: 'delta', text: content });
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

    // All harness tools — execute and loop
    messages.push(msg);
    for (const tc of calls) {
      let args: any = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}

      console.log(`🛠️  Executing ${tc.function.name}`);
      emit?.({ t: 'tool_call', id: tc.id, name: tc.function.name, args: tc.function.arguments });
      metrics.toolCalls++;

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

      console.log(`✅ ${tc.function.name} →`, out.slice(0, 80));
      emit?.({ t: 'tool_result', id: tc.id, name: tc.function.name, out });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: out });
    }

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
