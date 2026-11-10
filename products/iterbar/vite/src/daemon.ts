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
 * How a daemon answered `POST /origins`: `ok`; `refused` when it answered `400` (it does not take the origins, such
 * as past its cap on allowed origins, which a new daemon would refuse too); otherwise `gone`: nothing answered in
 * time, or what answers is not a daemon that accepts this token (it stopped, or another server took the port).
 */
type Registration = { readonly result: "ok" | "gone" } | { readonly result: "refused"; readonly status: number };

/** A daemon this process runs, shared by every dev server of its project root in the process. */
interface OwnedDaemon {
  users: number;
  readonly daemon: Promise<RunningDaemon>;
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
  release(): Promise<void>;
}

async function acquireOwned(projectRoot: string, create: boolean): Promise<Lease | null> {
  await owned.closing.get(projectRoot);
  let entry = owned.running.get(projectRoot);
  if (!entry) {
    if (!create) return null;
    const created: OwnedDaemon = { users: 0, daemon: startDaemon({ projectRoot }) };
    owned.running.set(projectRoot, created);
    watchExitSignals();
    const forget = () => {
      if (owned.running.get(projectRoot) === created) owned.running.delete(projectRoot);
      unwatchExitSignals();
    };
    // A daemon that failed to start, or stopped on its own, is not handed out again.
    created.daemon.then((daemon) => daemon.closed.then(forget), forget);
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

function isStoreLocked(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "store_locked";
}

function refusedError(access: DaemonAccess, status: number | null): Error {
  const answer = status === null ? "did not answer" : `answered HTTP ${status}`;
  return new Error(`The Iterbar daemon at ${access.daemonUrl} ${answer} when this dev server registered its origins`);
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
    const lease = this.#lease;
    this.#lease = null;
    await lease?.release();
  }

  async #connect(origins: readonly string[]): Promise<DaemonAccess> {
    if (this.#closed) throw new Error("The Iterbar dev server link is closed");
    if (origins.length === 0) throw new Error("The dev server has no origin to register with the Iterbar daemon");
    if (this.#current) {
      const registration = await this.#register(this.#current, origins);
      if (registration.result === "ok") return this.#current;
      // A live daemon that refuses the origins is kept: a new one would refuse them too.
      if (registration.result === "refused") throw refusedError(this.#current, registration.status);
      this.#current = null;
      // A daemon of this process that no longer answers is let go and replaced.
      const lease = this.#lease;
      this.#lease = null;
      await lease?.release();
    }
    this.#current = await this.#discover(origins);
    return this.#current;
  }

  async #discover(origins: readonly string[]): Promise<DaemonAccess> {
    this.#projectRoot ??= iterbarPaths(await realpath(this.#root)).projectRoot;
    const projectRoot = this.#projectRoot;
    const deadline = Date.now() + this.#lockWaitMs;
    for (;;) {
      // A daemon this process already runs for the root comes first, then one another process runs.
      this.#lease ??= await acquireOwned(projectRoot, false);
      if (this.#lease) {
        const access = this.#access(this.#lease, true);
        const registration = await this.#register(access, origins);
        if (registration.result === "ok") return access;
        throw refusedError(access, registration.result === "refused" ? registration.status : null);
      }
      const info = await readMatchingDaemonFile(projectRoot);
      if (info) {
        const access = { daemonUrl: `http://${DAEMON_HOST}:${info.port}`, token: info.token, started: false };
        const registration = await this.#register(access, origins);
        if (registration.result === "ok") return access;
        if (registration.result === "refused") throw refusedError(access, registration.status);
      }
      try {
        this.#lease = await acquireOwned(projectRoot, true);
        continue;
      } catch (error) {
        // Another process owns the store: its daemon may still be writing daemon.json, or shutting down.
        if (!isStoreLocked(error) || Date.now() >= deadline) throw error;
      }
      await delay(LOCK_RETRY_DELAY_MS);
    }
  }

  #access(lease: Lease, started: boolean): DaemonAccess {
    return { daemonUrl: lease.daemon.url, token: lease.daemon.info.token, started };
  }

  /** Registers the origins; see {@link Registration}. */
  async #register(access: DaemonAccess, origins: readonly string[]): Promise<Registration> {
    for (let start = 0; start < origins.length; start += ORIGINS_PER_REQUEST) {
      try {
        const response = await fetch(`${access.daemonUrl}${daemonPath("registerOrigins")}`, {
          method: "POST",
          headers: { authorization: bearerAuthorization(access.token), "content-type": "application/json" },
          body: JSON.stringify({ schemaVersion: SCHEMA_VERSION, origins: origins.slice(start, start + ORIGINS_PER_REQUEST) }),
          signal: AbortSignal.timeout(this.#requestTimeoutMs),
        });
        await response.body?.cancel();
        // The daemon answers 400 for origins it does not take; any other failure is not a daemon of this store.
        if (response.status === 400) return { result: "refused", status: 400 };
        if (!response.ok) return { result: "gone" };
      } catch {
        // Unreachable, or no answer in time.
        return { result: "gone" };
      }
    }
    return { result: "ok" };
  }
}
