import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { startDaemon, type RunningDaemon } from "@iterbar/cli/daemon";
import {
  bearerAuthorization,
  DAEMON_HOST,
  daemonInfoSchema,
  daemonPath,
  type DaemonInfo,
  safeParseMessage,
  SCHEMA_VERSION,
} from "iterbar";
import { iterbarPaths } from "iterbar/node";

/** What the bar needs to reach a daemon. */
export interface DaemonAccess {
  /** `http://127.0.0.1:<port>`. */
  readonly daemonUrl: string;
  readonly token: string;
  /** True when this process started the daemon; false for a daemon that was already running. */
  readonly started: boolean;
}

export interface DaemonLinkOptions {
  /** How long one request to a daemon may take. */
  readonly requestTimeoutMs?: number;
  /** How long to keep retrying while another process holds the store lock without a reachable daemon yet. */
  readonly lockWaitMs?: number;
}

/** `POST /origins` takes at most this many origins per request (`registerOriginsRequestSchema`). */
const ORIGINS_PER_REQUEST = 32;
const LOCK_RETRY_DELAY_MS = 100;

const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * How a daemon answered `POST /origins`:
 * - `ok`;
 * - `refused`: it answered `400`, as it does for origins it does not take (past its cap on allowed origins), which a
 *   new daemon would refuse too;
 * - `failed`: no answer in time, or a server error: a live daemon that is busy may answer the next time;
 * - `gone`: nothing listens on its port, or what answers does not take this token (it stopped, or another server
 *   took the port).
 */
type Registration =
  | { readonly result: "ok" }
  | { readonly result: "refused" | "failed" | "gone"; readonly detail: string };
type FailedRegistration = Exclude<Registration, { readonly result: "ok" }>;

function statusRegistration(status: number): FailedRegistration {
  const detail = `answered HTTP ${status}`;
  if (status === 400) return { result: "refused", detail };
  if (status >= 500 || status === 408 || status === 429) return { result: "failed", detail };
  return { result: "gone", detail };
}

function isTimeout(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/** A daemon this process runs, shared by every dev server of its project root in the process. */
interface OwnedDaemon {
  users: number;
  readonly daemon: Promise<RunningDaemon>;
  /** Set once the daemon failed to start or has shut down; it is then no longer handed out. */
  stopped: boolean;
}

interface OwnedDaemons {
  readonly running: Map<string, OwnedDaemon>;
  /** Daemons being shut down, so a new one for the same root starts only once the old one released the store. */
  readonly closing: Map<string, Promise<void>>;
  /** The exit signal listener while any daemon runs; see {@link watchExitSignals}. */
  signalListener: ((signal: NodeJS.Signals) => void) | null;
}

// On globalThis, so two copies of this module (a config reloaded through another path) still share one daemon.
const OWNED_KEY = Symbol.for("@iterbar/vite.ownedDaemons");
const owned: OwnedDaemons = ((globalThis as Record<symbol, unknown>)[OWNED_KEY] as OwnedDaemons | undefined)
  ?? ((globalThis as Record<symbol, unknown>)[OWNED_KEY] = {
    running: new Map(), closing: new Map(), signalListener: null,
  } satisfies OwnedDaemons);

/** Signals that end `vite dev` without Vite closing its server: Ctrl+C and a closed terminal. Vite closes on SIGTERM. */
const EXIT_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGHUP"];
/** How long an exit signal waits for the daemons to shut down. */
const SIGNAL_SHUTDOWN_MS = 3000;

function unwatchExitSignals(): void {
  const listener = owned.signalListener;
  if (!listener || owned.running.size > 0) return;
  for (const signal of EXIT_SIGNALS) process.off(signal, listener);
  owned.signalListener = null;
}

/**
 * While this process runs a daemon, Ctrl+C or a closed terminal first shuts the daemons down, so they remove their
 * `daemon.json` and release the store lock. Then, unless another listener handles the signal, it is raised again
 * and ends the process as it would have without this listener.
 */
function watchExitSignals(): void {
  if (owned.signalListener) return;
  const listener = (signal: NodeJS.Signals) => {
    const closing = [
      ...[...owned.running.values()].map((entry) => entry.daemon.then((daemon) => daemon.close())),
      ...owned.closing.values(),
    ];
    owned.running.clear();
    unwatchExitSignals();
    void Promise.race([
      Promise.allSettled(closing),
      new Promise((done) => setTimeout(done, SIGNAL_SHUTDOWN_MS).unref()),
    ]).then(() => {
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    });
  };
  owned.signalListener = listener;
  for (const signal of EXIT_SIGNALS) process.on(signal, listener);
}

/** A use of an owned daemon; releasing the last one shuts the daemon down. */
interface Lease {
  readonly daemon: RunningDaemon;
  /** Whether the daemon has shut down, by its last release or an exit signal. */
  readonly stopped: boolean;
  release(): Promise<void>;
}

async function acquireOwned(projectRoot: string, create: boolean): Promise<Lease | null> {
  await owned.closing.get(projectRoot);
  let entry = owned.running.get(projectRoot);
  if (!entry) {
    if (!create) return null;
    const created: OwnedDaemon = { users: 0, daemon: startDaemon({ projectRoot }), stopped: false };
    owned.running.set(projectRoot, created);
    watchExitSignals();
    const forget = () => {
      created.stopped = true;
      if (owned.running.get(projectRoot) === created) owned.running.delete(projectRoot);
      unwatchExitSignals();
    };
    // A daemon that failed to start, or stopped, is not handed out again.
    created.daemon.then((daemon) => daemon.closed).then(forget, forget);
    entry = created;
  }
  const current = entry;
  current.users += 1;
  let daemon: RunningDaemon;
  try {
    daemon = await current.daemon;
  } catch (error) {
    current.users -= 1;
    throw error;
  }
  let released = false;
  return {
    daemon,
    get stopped() {
      return current.stopped;
    },
    async release() {
      if (released) return;
      released = true;
      current.users -= 1;
      if (current.users > 0) return;
      if (owned.running.get(projectRoot) === current) owned.running.delete(projectRoot);
      unwatchExitSignals();
      const closing = daemon.close().finally(() => {
        if (owned.closing.get(projectRoot) === closing) owned.closing.delete(projectRoot);
      });
      owned.closing.set(projectRoot, closing);
      await closing;
    },
  };
}

/** The `daemon.json` of a project when it is valid and names the same project root; otherwise `null`. */
export async function readMatchingDaemonFile(projectRoot: string): Promise<DaemonInfo | null> {
  const paths = iterbarPaths(projectRoot);
  let json: unknown;
  try {
    json = JSON.parse(await readFile(paths.daemonFile, "utf8"));
  } catch {
    return null;
  }
  const parsed = safeParseMessage(daemonInfoSchema, json, "daemon info");
  return parsed.success && parsed.data.projectRoot === paths.projectRoot ? parsed.data : null;
}

/** Whether a process runs with this id (`EPERM`: it runs as another user). */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown } | null)?.code === "EPERM";
  }
}

/** Whether the project's `daemon.json` still names this daemon, and its process still runs. */
async function isStillListed(projectRoot: string, access: DaemonAccess): Promise<boolean> {
  const info = await readMatchingDaemonFile(projectRoot);
  return info !== null && info.token === access.token && `http://${DAEMON_HOST}:${info.port}` === access.daemonUrl
    && isRunning(info.pid);
}

function isStoreLocked(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "store_locked";
}

function registrationError(access: DaemonAccess, registration: FailedRegistration): Error {
  return new Error(`The Iterbar daemon at ${access.daemonUrl} ${registration.detail} when this dev server registered its origins`);
}

/**
 * One dev server's connection to its project's daemon. It reuses a running daemon whose `daemon.json` names the
 * same project root, otherwise starts one in this process, and registers the dev server's origins with it. A daemon
 * it started stops when the last dev server in the process that uses it closes.
 */
export class DaemonLink {
  readonly #root: string;
  readonly #requestTimeoutMs: number;
  readonly #lockWaitMs: number;
  #projectRoot: string | undefined;
  #current: DaemonAccess | null = null;
  #lease: Lease | null = null;
  /** Serializes connects, so concurrent page loads share one discovery and start at most one daemon. */
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(projectRoot: string, options: DaemonLinkOptions = {}) {
    this.#root = resolve(projectRoot);
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 2000;
    this.#lockWaitMs = options.lockWaitMs ?? 5000;
  }

  /**
   * Makes sure a daemon serves the project and allows `origins`, and returns how to reach it. Each call checks the
   * daemon in use by registering the origins again, so a daemon that stopped or restarted is replaced.
   */
  connect(origins: readonly string[]): Promise<DaemonAccess> {
    const result = this.#queue.then(() => this.#connect(origins));
    this.#queue = result.catch(() => undefined);
    return result;
  }

  /** Releases a daemon this link started. Idempotent; `connect` fails afterwards. */
  async close(): Promise<void> {
    this.#closed = true;
    await this.#queue;
    this.#current = null;
    await this.#releaseLease();
  }

  async #releaseLease(): Promise<void> {
    const lease = this.#lease;
    this.#lease = null;
    await lease?.release();
  }

  /**
   * Whether the daemon a registration failed with is gone for good, so it is let go and replaced. This process's own
   * daemon is gone only once it has shut down: while it runs, a failure (a slow answer, a server error) is passed on,
   * and the daemon, its token and the pages connected to it stay. Another process's daemon is gone when nothing
   * listens on its port or what answers does not take its token; a slow answer or server error keeps it while
   * `daemon.json` still names it and its process runs.
   */
  async #isGone(access: DaemonAccess, registration: FailedRegistration): Promise<boolean> {
    if (this.#lease) return this.#lease.stopped;
    if (registration.result !== "failed") return registration.result === "gone";
    return this.#projectRoot === undefined || !(await isStillListed(this.#projectRoot, access));
  }

  async #connect(origins: readonly string[]): Promise<DaemonAccess> {
    if (this.#closed) throw new Error("The Iterbar dev server link is closed");
    if (origins.length === 0) throw new Error("The dev server has no origin to register with the Iterbar daemon");
    const current = this.#current;
    if (current) {
      const registration = await this.#register(current, origins);
      if (registration.result === "ok") return current;
      if (!(await this.#isGone(current, registration))) throw registrationError(current, registration);
      this.#current = null;
      await this.#releaseLease();
    }
    this.#current = await this.#discover(origins);
    return this.#current;
  }

  /** This process's daemon for the root comes first, then one another process runs, then a new one in this process. */
  async #discover(origins: readonly string[]): Promise<DaemonAccess> {
    this.#projectRoot ??= iterbarPaths(await realpath(this.#root)).projectRoot;
    const projectRoot = this.#projectRoot;
    const deadline = Date.now() + this.#lockWaitMs;
    for (;;) {
      const access = await this.#viaOwned(projectRoot, origins) ?? await this.#viaDaemonFile(projectRoot, origins);
      if (access) return access;
      if (!(await this.#startOwned(projectRoot, deadline))) await delay(LOCK_RETRY_DELAY_MS);
    }
  }

  /** This process's daemon for the root; `null` when there is none, or it has shut down and was let go. */
  async #viaOwned(projectRoot: string, origins: readonly string[]): Promise<DaemonAccess | null> {
    this.#lease ??= await acquireOwned(projectRoot, false);
    if (!this.#lease) return null;
    const access: DaemonAccess = { daemonUrl: this.#lease.daemon.url, token: this.#lease.daemon.info.token, started: true };
    const registration = await this.#register(access, origins);
    if (registration.result === "ok") return access;
    if (!(await this.#isGone(access, registration))) throw registrationError(access, registration);
    await this.#releaseLease();
    return null;
  }

  /** The daemon `daemon.json` names for the same root; `null` when there is none, or it is gone. */
  async #viaDaemonFile(projectRoot: string, origins: readonly string[]): Promise<DaemonAccess | null> {
    const info = await readMatchingDaemonFile(projectRoot);
    if (!info) return null;
    const access: DaemonAccess = { daemonUrl: `http://${DAEMON_HOST}:${info.port}`, token: info.token, started: false };
    const registration = await this.#register(access, origins);
    if (registration.result === "ok") return access;
    if (await this.#isGone(access, registration)) return null;
    throw registrationError(access, registration);
  }

  /** Starts a daemon in this process; `false` while another process holds the store, until the deadline. */
  async #startOwned(projectRoot: string, deadline: number): Promise<boolean> {
    try {
      this.#lease = await acquireOwned(projectRoot, true);
      return true;
    } catch (error) {
      // Another process owns the store: its daemon may still be writing daemon.json, or shutting down.
      if (!isStoreLocked(error) || Date.now() >= deadline) throw error;
      return false;
    }
  }

  /** Registers the origins; see {@link Registration}. */
  async #register(access: DaemonAccess, origins: readonly string[]): Promise<Registration> {
    for (let start = 0; start < origins.length; start += ORIGINS_PER_REQUEST) {
      let response: Response;
      try {
        response = await fetch(`${access.daemonUrl}${daemonPath("registerOrigins")}`, {
          method: "POST",
          headers: { authorization: bearerAuthorization(access.token), "content-type": "application/json" },
          body: JSON.stringify({ schemaVersion: SCHEMA_VERSION, origins: origins.slice(start, start + ORIGINS_PER_REQUEST) }),
          signal: AbortSignal.timeout(this.#requestTimeoutMs),
        });
      } catch (error) {
        // No answer in time from a daemon that may be busy, or nothing listening at all.
        return isTimeout(error)
          ? { result: "failed", detail: "did not answer in time" }
          : { result: "gone", detail: "did not answer" };
      }
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) return statusRegistration(response.status);
    }
    return { result: "ok" };
  }
}
