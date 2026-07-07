// Verbose, stack-trace-first error logging. Use this everywhere we catch so a
// failure — especially a crash on the Pi — is never silent. It prints the error
// name/message, the full stack, the entire `cause` chain (each with its own
// stack), and any extra enumerable props (code/errno/syscall/etc.).
export function logError(context: string, err: unknown): void {
  const ts = new Date().toISOString();
  console.error(`\n❌ ERROR [${context}] @ ${ts}`);

  const seen = new Set<unknown>();
  let cur: any = err;
  let depth = 0;
  while (cur != null && depth < 8 && !seen.has(cur)) {
    seen.add(cur);
    const label = depth === 0 ? '' : '  ↳ cause: ';
    if (cur instanceof Error) {
      console.error(`${label}${cur.name}: ${cur.message}`);
      if (cur.stack) console.error(cur.stack);
      // Extra enumerable props llama.cpp/node-fetch attach (code, errno, …).
      for (const k of Object.keys(cur)) {
        if (k === 'cause' || k === 'stack' || k === 'message' || k === 'name') continue;
        let v: string;
        try { v = JSON.stringify((cur as any)[k]); } catch { v = String((cur as any)[k]); }
        console.error(`   ${k} = ${v}`);
      }
      cur = cur.cause;
    } else {
      // Non-Error throw (string, number, plain object, undefined, …).
      let v: string;
      try { v = JSON.stringify(cur); } catch { v = String(cur); }
      console.error(`${label}non-Error thrown (${typeof cur}): ${v}`);
      cur = undefined;
    }
    depth++;
  }
}

// Install once at startup so nothing dies without a trace. We log and keep
// running rather than exiting — a single bad request (or a client that hangs up
// mid-stream) should never take the whole harness down.
export function installGlobalErrorHandlers(): void {
  process.on('uncaughtException', (e, origin) => logError(`uncaughtException (${origin})`, e));
  process.on('unhandledRejection', (reason) => logError('unhandledRejection', reason));
  process.on('warning', (w) => logError('process warning', w));
}
