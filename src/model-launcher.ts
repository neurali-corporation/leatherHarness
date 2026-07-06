import { spawn, execFile, ChildProcess } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { resolve as resolvePath, dirname, basename } from 'node:path';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/**
 * Extract the --port value from a llama-server argv, if present.
 * The launcher scripts pass "--port 9001"; without it llama.cpp defaults to 8080.
 */
function extractPort(args: string[]): number {
  const i = args.indexOf('--port');
  if (i !== -1 && args[i + 1]) {
    const p = parseInt(args[i + 1], 10);
    if (!Number.isNaN(p)) return p;
  }
  return 8080;
}

/**
 * Best-effort: kill any process currently listening on the given TCP port and
 * wait until it is actually free. This guards against an orphaned llama-server
 * from a previous harness lifetime (e.g. after a nodemon restart) still holding
 * the port, which would make the new instance fail with EADDRINUSE
 * ("couldn't bind HTTP server socket").
 */
async function freePort(port: number): Promise<void> {
  let pids: string[] = [];
  try {
    const { stdout } = await execFileP('lsof', ['-ti', `tcp:${port}`]);
    pids = stdout.split('\n').map(s => s.trim()).filter(Boolean);
  } catch {
    // lsof exits non-zero when nothing is listening (or isn't installed) — nothing to free.
    return;
  }
  if (pids.length === 0) return;

  console.warn(`⚠️  Port ${port} held by stale process(es) ${pids.join(', ')}; terminating before launch`);
  for (const pid of pids) {
    try { process.kill(Number(pid), 'SIGTERM'); } catch {}
  }

  // Wait up to ~5s for the port to be released, escalating to SIGKILL halfway.
  for (let attempt = 0; attempt < 50; attempt++) {
    await new Promise(r => setTimeout(r, 100));
    let still: string[] = [];
    try {
      const { stdout } = await execFileP('lsof', ['-ti', `tcp:${port}`]);
      still = stdout.split('\n').map(s => s.trim()).filter(Boolean);
    } catch {
      return; // port free
    }
    if (still.length === 0) return;
    if (attempt === 25) {
      for (const pid of still) {
        try { process.kill(Number(pid), 'SIGKILL'); } catch {}
      }
    }
  }
  console.warn(`⚠️  Port ${port} still appears occupied after cleanup attempts`);
}

export interface ModelConfig {
  name: string;
  command: string;
  params?: string[];
  default?: boolean;
}

export interface ModelLauncherConfig {
  enableModelLauncher: boolean;
  models: ModelConfig[];
}

export interface ModelStatus {
  isRunning: boolean;
  modelName: string | null;
  pid: number | null;
  enabled: boolean;
  models: ModelConfig[];
}

export interface ParsedLauncher {
  name: string;
  command: string;
  params: string[];
  hfModel?: string;
  hfFile?: string;
  context?: string;
}

let currentProcess: ChildProcess | null = null;
let currentModelName: string | null = null;
let launcherConfig: ModelLauncherConfig | null = null;

// Set true whenever *we* take the process down (stop / switch / harness exit) so
// its 'exit' event isn't mistaken for a crash and auto-restarted.
let intentionalStop = false;
// Consecutive crash count, for exponential restart backoff. Reset once a process
// has stayed up long enough to be considered healthy.
let restartAttempts = 0;
let restartTimer: ReturnType<typeof setTimeout> | null = null;

function cancelPendingRestart(): void {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
}

/**
 * Parse a launcher shell script to extract the llama-server command, params, and metadata.
 * This is used to generate config from launcher scripts.
 */
export function parseLauncherScript(name: string, script: string): ParsedLauncher {
  const hfModelMatch = script.match(/HF_MODEL="([^"]+)"/);
  const hfFileMatch = script.match(/HF_FILE="([^"]+)"/);
  const ctxMatch = script.match(/CTX="\$\{1:-([0-9]+)\}"/);

  // Extract the full command by joining all lines that are part of the llama-server command
  // Lines ending with \ continue to the next line
  let commandLine = '';
  let inCommand = false;
  const lines = script.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith('llama-server') || line.startsWith('llama-cpp')) {
      inCommand = true;
      commandLine += line.replace(/\\$/, '').trim() + ' ';
    } else if (inCommand) {
      if (line.endsWith('\\')) {
        commandLine += line.replace(/\\$/, '').trim() + ' ';
      } else {
        commandLine += line;
        inCommand = false;
      }
    }
  }

  // Clean up the command line
  commandLine = commandLine.replace(/\s+/g, ' ').trim();

  if (!commandLine) {
    return {
      name,
      command: 'echo',
      params: [`"Model: ${name}"`],
      hfModel: hfModelMatch?.[1],
      hfFile: hfFileMatch?.[1],
      context: ctxMatch?.[1],
    };
  }

  // Split into command and params
  const parts = commandLine.split(' ');
  const cmd = parts[0];
  const params = parts.slice(1);

  return {
    name,
    command: cmd,
    params,
    hfModel: hfModelMatch?.[1],
    hfFile: hfFileMatch?.[1],
    context: ctxMatch?.[1],
  };
}

/**
 * Parse a launcher file and return the extracted command, params, and metadata.
 */
export async function parseLauncherFile(filePath: string): Promise<ParsedLauncher | null> {
  try {
    const content = await readFile(filePath, 'utf8');
    const fileBaseName = basename(filePath, '.sh');
    return parseLauncherScript(fileBaseName, content);
  } catch {
    return null;
  }
}

/**
 * Discover all launcher scripts in a directory and parse them.
 */
export async function discoverLaunchers(launchersDir: string): Promise<ParsedLauncher[]> {
  const launchers: ParsedLauncher[] = [];

  if (!existsSync(launchersDir)) {
    console.log(`Launchers directory not found: ${launchersDir}`);
    return launchers;
  }

  try {
    const entries = await readdir(launchersDir);
    for (const entry of entries) {
      if (entry.endsWith('.sh')) {
        const parsed = await parseLauncherFile(resolvePath(launchersDir, entry));
        if (parsed) {
          launchers.push(parsed);
        }
      }
    }
  } catch (e) {
    console.warn(`Failed to read launchers directory: ${launchersDir}`, e);
  }

  return launchers;
}

/**
 * Auto-discover models from the launchers directory and create a config.
 * This reads all .sh files and parses them to extract model commands.
 */
export async function autoDiscoverModels(launchersDir: string): Promise<ModelConfig[]> {
  const parsedLaunchers = await discoverLaunchers(launchersDir);
  
  return parsedLaunchers.map((launcher, index) => ({
    name: launcher.name.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
    command: launcher.command,
    params: launcher.params,
    default: index === 0, // First model is default
  }));
}

export function createModelLauncher(config: ModelLauncherConfig) {
  launcherConfig = config;

  const startModel = async (modelName: string) => {
    // A manual (re)start supersedes any pending auto-restart.
    cancelPendingRestart();
    if (currentProcess) {
      await stopModel();
    }

    const model = config.models.find(m => m.name === modelName);
    if (!model) {
      throw new Error(`Model not found: ${modelName}`);
    }

    console.log(`🚀 Starting model: ${model.name}`);
    console.log(`   Command: ${model.command} ${model.params?.join(' ') || ''}`);

    try {
      // Split command in case it includes arguments (e.g., "bash -c ...")
      const cmdParts = model.command.split(' ');
      const cmd = cmdParts[0];
      const cmdArgs = cmdParts.length > 1 ? cmdParts.slice(1) : [];
      // Each params entry may bundle a flag and its value ("-c 65536"), so
      // split on whitespace to get individual argv tokens. (Values themselves
      // must not contain spaces.)
      const paramArgs = (model.params || []).flatMap(p => p.split(/\s+/).filter(Boolean));
      const allArgs = [...cmdArgs, ...paramArgs];

      // Defend against an orphaned llama-server (e.g. left behind by a nodemon
      // restart) still bound to the port; otherwise the new instance dies with
      // "couldn't bind HTTP server socket".
      await freePort(extractPort(allArgs));

      // detached: give llama-server its own process group so a controlling-
      // terminal / SSH disconnect (SIGHUP to the foreground group) doesn't reach
      // it and kill the expensive-to-reload model. We keep the ref (no unref) so
      // the child's lifetime is still managed by the harness, and stop/cleanup
      // kill it explicitly by pid.
      const proc = spawn(cmd, allArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });

      currentProcess = proc;
      currentModelName = modelName;
      intentionalStop = false;
      const startedAt = Date.now();

      proc.on('error', (err) => {
        console.error(`❌ Failed to start model ${modelName}:`, err.message);
        if (currentProcess === proc) {
          currentProcess = null;
          currentModelName = null;
        }
      });

      proc.on('exit', (code, signal) => {
        console.log(`Model ${modelName} exited with code ${code}, signal ${signal}`);
        // Ignore a stale process that a newer start already superseded.
        if (currentProcess !== proc) return;
        currentProcess = null;
        currentModelName = null;

        // We took it down on purpose (stop / switch / harness shutdown) — done.
        if (intentionalStop) {
          intentionalStop = false;
          return;
        }
        if (!config.enableModelLauncher) return;

        // Unexpected exit (backend crash, OOM, template abort). Respawn so a
        // transient failure doesn't leave the harness without a model, but back
        // off exponentially so a genuine crash-loop doesn't hammer the GPU.
        if (Date.now() - startedAt > 30000) restartAttempts = 0; // was healthy
        restartAttempts++;
        const backoff = Math.min(1000 * 2 ** (restartAttempts - 1), 30000);
        console.warn(`♻️  Model ${modelName} exited unexpectedly (code ${code}, signal ${signal}); restarting in ${backoff}ms (attempt ${restartAttempts})`);
        cancelPendingRestart();
        restartTimer = setTimeout(() => {
          restartTimer = null;
          startModel(modelName).catch(e => console.error(`❌ Auto-restart of ${modelName} failed:`, e.message));
        }, backoff);
      });

      // Log stdout/stderr
      proc.stdout?.on('data', (data) => {
        console.log(`[Model ${modelName}] ${data.toString().trim()}`);
      });

      proc.stderr?.on('data', (data) => {
        console.warn(`[Model ${modelName} stderr] ${data.toString().trim()}`);
      });

      console.log(`✅ Model ${modelName} started (PID: ${proc.pid})`);
    } catch (e: any) {
      console.error(`❌ Error starting model ${modelName}:`, e.message);
      currentProcess = null;
      currentModelName = null;
      throw e;
    }
  };

  const stopModel = async () => {
    if (!currentProcess) {
      return;
    }

    const modelName = currentModelName;
    const pid = currentProcess.pid;

    // Mark as deliberate so the 'exit' handler doesn't auto-restart it, and
    // drop any restart the previous crash may have already queued.
    intentionalStop = true;
    cancelPendingRestart();

    console.log(`🛑 Stopping model: ${modelName} (PID: ${pid})`);

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        console.warn(`⚠️  Force killing model ${modelName} (PID: ${pid})`);
        try {
          currentProcess?.kill('SIGKILL');
        } catch {}
        currentProcess = null;
        currentModelName = null;
        resolve();
      }, 5000);

      currentProcess?.on('exit', () => {
        clearTimeout(timeout);
        console.log(`✅ Model ${modelName} stopped`);
        currentProcess = null;
        currentModelName = null;
        resolve();
      });

      try {
        currentProcess.kill('SIGTERM');
      } catch (e: any) {
        clearTimeout(timeout);
        console.warn(`Failed to stop model ${modelName}:`, e.message);
        currentProcess = null;
        currentModelName = null;
        resolve();
      }
    });
  };

  return {
    isEnabled: () => config.enableModelLauncher && config.models.length > 0,

    listModels: () => config.models,

    getDefaultModel: () => {
      const defaultModel = config.models.find(m => m.default);
      return defaultModel || (config.models.length > 0 ? config.models[0] : null);
    },

    getStatus: (): ModelStatus => ({
      isRunning: currentProcess !== null,
      modelName: currentModelName,
      pid: currentProcess?.pid ?? null,
      enabled: config.enableModelLauncher,
      models: config.models,
    }),

    startModel,
    stopModel,

    switchModel: async (modelName: string) => {
      console.log(`🔄 Switching model to: ${modelName}`);
      await startModel(modelName);
    },

    autoStart: async () => {
      if (!config.enableModelLauncher || config.models.length === 0) {
        return;
      }

      const defaultModel = config.models.find(m => m.default) || config.models[0];
      if (defaultModel) {
        await startModel(defaultModel.name);
      }
    },
  };
}

export function getModelLauncher(): {
  isEnabled: () => boolean;
  listModels: () => ModelConfig[];
  getDefaultModel: () => ModelConfig | null;
  getStatus: () => ModelStatus;
  startModel: (modelName: string) => Promise<void>;
  stopModel: () => Promise<void>;
  switchModel: (modelName: string) => Promise<void>;
  autoStart: () => Promise<void>;
} | null {
  return launcherConfig ? createModelLauncher(launcherConfig) : null;
}

let exitHandlersRegistered = false;

/**
 * Ensure the spawned model process is killed when the harness itself exits, so
 * a nodemon restart / Ctrl-C doesn't leave an orphaned llama-server holding the
 * port. Registered once; safe to call repeatedly.
 */
function registerExitCleanup(): void {
  if (exitHandlersRegistered) return;
  exitHandlersRegistered = true;

  const cleanup = () => {
    intentionalStop = true;
    cancelPendingRestart();
    if (currentProcess) {
      try { currentProcess.kill('SIGKILL'); } catch {}
      currentProcess = null;
      currentModelName = null;
    }
  };

  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      cleanup();
      process.exit(0);
    });
  }

  // Optionally survive SIGHUP: a controlling-terminal / SSH disconnect must not
  // take a long-running harness down. Registering any handler overrides Node's
  // default (terminate). Combined with the detached child spawn, neither the
  // harness nor llama-server dies when the terminal goes away. This is opt-in —
  // pass --survive-hup (or SURVIVE_HUP=1) at startup — so that by default a
  // terminal hangup still terminates the harness the way Node normally would.
  if (process.argv.includes('--survive-hup') || process.env.SURVIVE_HUP === '1') {
    process.on('SIGHUP', () => {
      console.warn('↩️  Ignoring SIGHUP (terminal disconnect); harness stays up');
    });
  }
}

export function initModelLauncher(config: ModelLauncherConfig): void {
  launcherConfig = config;
  registerExitCleanup();
}

export function resetModelLauncher(): void {
  intentionalStop = true;
  cancelPendingRestart();
  if (currentProcess) {
    try {
      currentProcess.kill('SIGKILL');
    } catch {}
  }
  currentProcess = null;
  currentModelName = null;
  restartAttempts = 0;
  launcherConfig = null;
}
