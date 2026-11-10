import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type RunningDaemon } from "@iterbar/cli/daemon";
import { bearerAuthorization, SCHEMA_VERSION } from "iterbar";
import { iterbarPaths } from "iterbar/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

function link(projectRoot: string): DaemonLink {
  const created = new DaemonLink(projectRoot, { lockWaitMs: 1000 });
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

beforeEach(() => {
  roots = [];
  daemons = [];
  links = [];
});

afterEach(async () => {
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
    const gone = await startDaemon({ projectRoot: root });
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
