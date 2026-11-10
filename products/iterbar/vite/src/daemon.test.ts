import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type RunningDaemon } from "@iterbar/cli/daemon";
import { bearerAuthorization, SCHEMA_VERSION } from "iterbar";
import { iterbarPaths } from "iterbar/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonLink, readMatchingDaemonFile } from "./daemon.js";

const ORIGINS = ["http://localhost:5173"];

let roots: string[] = [];
let daemons: RunningDaemon[] = [];
let links: DaemonLink[] = [];

async function tempRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "iterbar-vite-")));
  roots.push(root);
  return root;
}

async function external(projectRoot: string): Promise<RunningDaemon> {
  const daemon = await startDaemon({ projectRoot });
  daemons.push(daemon);
  return daemon;
}

function link(projectRoot: string, requestTimeoutMs?: number): DaemonLink {
  const created = new DaemonLink(projectRoot, { lockWaitMs: 1000, requestTimeoutMs });
  links.push(created);
  return created;
}

async function allowedOrigins(daemonUrl: string, token: string): Promise<string[]> {
  const response = await fetch(`${daemonUrl}/origins`, {
    method: "POST",
    headers: { authorization: bearerAuthorization(token), "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: SCHEMA_VERSION, origins: ["http://example.test"] }),
  });
  return ((await response.json()) as { origins: string[] }).origins;
}

const realFetch = globalThis.fetch;

/** Makes the next `POST /origins` a link sends end as `fail` decides; every other request goes through. */
function failNextRegistration(fail: (url: string, init: RequestInit | undefined) => Promise<Response>): void {
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.endsWith("/origins")) return realFetch(input, init);
    spy.mockRestore();
    return fail(url, init);
  });
}

/** A request that gets no answer until its timeout aborts it, as with a daemon too busy to answer. */
function noAnswer(_url: string, init: RequestInit | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  });
}

const serverError = () => Promise.resolve(new Response("busy", { status: 500 }));

/** Shuts down the daemon this process runs for the root, as an exit signal does, behind its links' backs. */
async function stopOwnedDaemon(projectRoot: string): Promise<void> {
  const owned = (globalThis as Record<symbol, unknown>)[Symbol.for("@iterbar/vite.ownedDaemons")] as {
    running: Map<string, { daemon: Promise<RunningDaemon> }>;
  };
  await (await owned.running.get(projectRoot)?.daemon)?.close();
}

async function slotsStatus(access: { daemonUrl: string; token: string }): Promise<number> {
  return (await fetch(`${access.daemonUrl}/slots`, { headers: { authorization: bearerAuthorization(access.token) } })).status;
}

beforeEach(() => {
  roots = [];
  daemons = [];
  links = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(links.map((each) => each.close()));
  await Promise.all(daemons.map((daemon) => daemon.close()));
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("DaemonLink", () => {
  it("reuses a running daemon whose daemon.json names the same root, registers the origins and leaves it running", async () => {
    const root = await tempRoot();
    const daemon = await external(root);
    const access = await link(root).connect(ORIGINS);
    expect(access).toEqual({ daemonUrl: daemon.url, token: daemon.info.token, started: false });
    expect(await allowedOrigins(daemon.url, daemon.info.token)).toContain("http://localhost:5173");

    await links[0]?.close();
    expect(await readMatchingDaemonFile(root)).toEqual(daemon.info);
  });

  it("does not reuse a live daemon whose daemon.json names another project root", async () => {
    const root = await tempRoot();
    const other = await external(await tempRoot());
    // A daemon.json copied along with .iterbar/ from another checkout still points at a live daemon.
    await mkdir(iterbarPaths(root).directory, { recursive: true });
    await copyFile(iterbarPaths(other.info.projectRoot).daemonFile, iterbarPaths(root).daemonFile);

    const access = await link(root).connect(ORIGINS);
    expect(access.started).toBe(true);
    expect(access.token).not.toBe(other.info.token);
    expect(await readMatchingDaemonFile(root)).toMatchObject({ projectRoot: root, token: access.token, pid: process.pid });
    expect(await allowedOrigins(other.url, other.info.token)).not.toContain("http://localhost:5173");
  });

  it("starts a daemon when daemon.json describes one that is gone, and stops it on close", async () => {
    const root = await tempRoot();
    const gone = await external(root);
    const stale = await readFile(iterbarPaths(root).daemonFile, "utf8");
    await gone.close();
    await writeFile(iterbarPaths(root).daemonFile, stale);

    const created = link(root);
    const access = await created.connect(ORIGINS);
    expect(access.started).toBe(true);
    expect(access.token).not.toBe(gone.info.token);
    await expect(fetch(`${access.daemonUrl}/slots`, { headers: { authorization: bearerAuthorization(access.token) } }))
      .resolves.toMatchObject({ status: 200 });

    await created.close();
    expect(await readMatchingDaemonFile(root)).toBeNull();
    await expect(created.connect(ORIGINS)).rejects.toThrow(/closed/);
  });

  it("moves to a new daemon, with the origins registered again, when the one in use stops", async () => {
    const root = await tempRoot();
    const first = await external(root);
    const created = link(root);
    expect((await created.connect(ORIGINS)).token).toBe(first.info.token);

    await first.close();
    const second = await external(root);
    const access = await created.connect(ORIGINS);
    expect(access).toEqual({ daemonUrl: second.url, token: second.info.token, started: false });
    expect(await allowedOrigins(second.url, second.info.token)).toContain("http://localhost:5173");
  });

  it("keeps the daemon in use when it refuses the origins, rather than replacing a live daemon", async () => {
    const root = await tempRoot();
    const created = link(root);
    const first = await created.connect(ORIGINS);
    expect(first.started).toBe(true);
    // Past the daemon's cap on allowed origins: it answers 400, which a new daemon would answer too.
    const tooMany = Array.from({ length: 300 }, (_, index) => `http://host-${index}.test`);
    await expect(created.connect(tooMany)).rejects.toThrow(/answered HTTP 400/);
    expect(await created.connect(ORIGINS)).toEqual(first);
    expect(await readMatchingDaemonFile(root)).toMatchObject({ token: first.token, pid: process.pid });
  });

  it("keeps its own live daemon and token when a registration times out or fails with a server error", async () => {
    const root = await tempRoot();
    const created = link(root, 300);
    const first = await created.connect(ORIGINS);
    expect(first.started).toBe(true);

    for (const [fail, message] of [[noAnswer, /did not answer in time/], [serverError, /answered HTTP 500/]] as const) {
      failNextRegistration(fail);
      await expect(created.connect(ORIGINS)).rejects.toThrow(message);
      // The daemon still runs with the same token, so pages that already have it stay connected.
      expect(await readMatchingDaemonFile(root)).toMatchObject({ token: first.token, pid: process.pid });
      expect(await slotsStatus(first)).toBe(200);
      expect(await created.connect(ORIGINS)).toEqual(first);
    }
  });

  it("keeps a daemon another process runs when it does not answer in time", async () => {
    const root = await tempRoot();
    const daemon = await external(root);
    const created = link(root, 300);
    const first = await created.connect(ORIGINS);
    expect(first.started).toBe(false);

    failNextRegistration(noAnswer);
    await expect(created.connect(ORIGINS)).rejects.toThrow(/did not answer in time/);
    expect(await readMatchingDaemonFile(root)).toEqual(daemon.info);
    expect(await created.connect(ORIGINS)).toEqual(first);
  });

  it("replaces a daemon.json daemon that does not answer in time once its process is gone", async () => {
    const root = await tempRoot();
    const gone = await external(root);
    await gone.close();
    // The port is now held by something that never answers, and the daemon's process no longer runs.
    const sockets = new Set<Socket>();
    const silent = createNetServer((socket) => sockets.add(socket));
    await new Promise<void>((done) => silent.listen(0, "127.0.0.1", done));
    try {
      const { port } = silent.address() as { port: number };
      const pid = spawnSync(process.execPath, ["-e", ""]).pid;
      await writeFile(iterbarPaths(root).daemonFile, JSON.stringify({ ...gone.info, port, pid }));
      const access = await link(root, 300).connect(ORIGINS);
      expect(access.started).toBe(true);
      expect(await readMatchingDaemonFile(root)).toMatchObject({ token: access.token, pid: process.pid });
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((done) => silent.close(done));
    }
  });

  it("replaces its own daemon once it has shut down, whether in use or just started", async () => {
    const root = await tempRoot();
    const created = link(root);
    const first = await created.connect(ORIGINS);
    await stopOwnedDaemon(root);
    const second = await created.connect(ORIGINS);
    expect(second.started).toBe(true);
    expect(second.token).not.toBe(first.token);
    expect(await readMatchingDaemonFile(root)).toMatchObject({ token: second.token, pid: process.pid });

    // A daemon that shuts down while the link registers with it for the first time is let go too.
    const otherRoot = await tempRoot();
    failNextRegistration(async (url, init) => {
      await stopOwnedDaemon(otherRoot);
      return realFetch(url, init);
    });
    const replaced = await link(otherRoot).connect(ORIGINS);
    expect(replaced.started).toBe(true);
    expect(await readMatchingDaemonFile(otherRoot)).toMatchObject({ token: replaced.token, pid: process.pid });
    expect(await slotsStatus(replaced)).toBe(200);
  });

  it("shares one started daemon between the links of a process until the last one closes", async () => {
    const root = await tempRoot();
    const one = link(root);
    const two = link(root);
    const [first, second] = await Promise.all([one.connect(ORIGINS), two.connect(["http://localhost:5174"])]);
    expect(first.started && second.started).toBe(true);
    expect(second.token).toBe(first.token);

    await one.close();
    expect((await two.connect(ORIGINS)).token).toBe(first.token);
    await two.close();
    expect(await readMatchingDaemonFile(root)).toBeNull();
  });

  it("gives up with store_locked when another process holds the store without a reachable daemon", async () => {
    const root = await tempRoot();
    const holder = await external(root);
    // The holder's daemon.json is gone, so nothing tells the link where the store's daemon listens.
    await rm(iterbarPaths(root).daemonFile);
    await expect(new DaemonLink(root, { lockWaitMs: 300 }).connect(ORIGINS)).rejects.toMatchObject({ code: "store_locked" });
    expect(holder.info.projectRoot).toBe(root);
  });
});
