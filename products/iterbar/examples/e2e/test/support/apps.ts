import { spawn, type ChildProcess } from "node:child_process";
import { readdir, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const examplesDirectory = fileURLToPath(new URL("../../../", import.meta.url));

export interface ExampleApp {
  readonly name: string;
  readonly directory: string;
  /** Where `vite build` writes the site that is deployed. */
  readonly outputDirectory: string;
}

export const APPS: readonly ExampleApp[] = ["vite-react", "sveltekit"].map((name) => {
  const directory = join(examplesDirectory, name);
  return { name, directory, outputDirectory: join(directory, "dist") };
});

/** The real path of an app, as the plugin and the daemon record it in `daemon.json`. */
export function projectRoot(app: ExampleApp): Promise<string> {
  return realpath(app.directory);
}

/** A free TCP port on 127.0.0.1. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/** The `vite` command line the app itself depends on. */
function viteBin(app: ExampleApp): string {
  const require = createRequire(join(app.directory, "package.json"));
  return join(dirname(require.resolve("vite/package.json")), "bin", "vite.js");
}

export interface ViteProcess {
  readonly pid: number;
  /** `http://127.0.0.1:<port>` for a server. */
  readonly origin: string;
  output(): string;
  /** Stops the process with a signal (SIGTERM by default; SIGINT is Ctrl+C) and waits for it to exit. */
  stop(signal?: NodeJS.Signals): Promise<number | null>;
}

function runVite(app: ExampleApp, args: readonly string[]): { child: ChildProcess; output: () => string; exited: Promise<number | null> } {
  let output = "";
  const child = spawn(process.execPath, [viteBin(app), ...args], {
    cwd: app.directory,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  return { child, output: () => output, exited };
}

/** Runs `vite build` in the app and fails with its output when it does not succeed. */
export async function buildApp(app: ExampleApp): Promise<void> {
  const run = runVite(app, ["build", "--logLevel", "warn"]);
  const code = await run.exited;
  if (code !== 0) throw new Error(`vite build of ${app.name} exited with ${code}:\n${run.output()}`);
}

/** Starts `vite <command>` (`dev` or `preview`) on a free port of 127.0.0.1 and waits until it serves `/`. */
export async function startVite(app: ExampleApp, command: "dev" | "preview"): Promise<ViteProcess> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const run = runVite(app, [command, "--host", "127.0.0.1", "--port", String(port), "--strictPort"]);
  let exitCode: number | null | undefined;
  void run.exited.then((code) => (exitCode = code));
  const stop = async (signal: NodeJS.Signals = "SIGTERM") => {
    if (exitCode === undefined) run.child.kill(signal);
    return run.exited;
  };
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (exitCode !== undefined) throw new Error(`vite ${command} of ${app.name} exited with ${exitCode}:\n${run.output()}`);
    try {
      const response = await fetch(`${origin}/`, { signal: AbortSignal.timeout(5000) });
      await response.body?.cancel();
      if (response.ok) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`vite ${command} of ${app.name} did not serve ${origin}/ in time:\n${run.output()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { pid: run.child.pid as number, origin, output: run.output, stop };
}

/** Every file below a directory, recursively. */
export async function filesBelow(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

/** The text of every file below a directory, keyed by path. */
export async function readTree(directory: string): Promise<Map<string, string>> {
  const files = await filesBelow(directory);
  return new Map(await Promise.all(files.map(async (file) => [file, await readFile(file, "utf8")] as const)));
}
