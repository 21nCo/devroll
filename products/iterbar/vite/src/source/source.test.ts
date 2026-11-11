import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eachMapping, originalPositionFor, TraceMap, type EncodedSourceMap } from "@jridgewell/trace-mapping";
import { svelte, vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import react from "@vitejs/plugin-react";
import * as svelteCompiler from "svelte/compiler";
import { build, createServer, type Plugin, type ViteDevServer } from "vite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { iterbar } from "../index.js";
import { sourceRoot, stampSvelteModule } from "./index.js";
import { svelteSourcePreprocessor } from "./svelte.js";

const require = createRequire(import.meta.url);

let root: string;
let servers: ViteDevServer[] = [];

/** The project's own copy of a package, linked from the plugin's dependencies like an app installs it. */
async function linkPackage(name: string): Promise<void> {
  const target = dirname(await realpath(require.resolve(`${name}/package.json`)));
  await symlink(target, join(root, "node_modules", name), "dir");
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

beforeEach(async () => {
  // A real path: Vite resolves module ids to real paths, and serves files only below the real root.
  root = await realpath(await mkdtemp(join(tmpdir(), "iterbar-source-")));
  await mkdir(join(root, "node_modules"));
  for (const name of ["react", "react-dom", "svelte"]) await linkPackage(name);
});

afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()));
  servers = [];
  await rm(root, { recursive: true, force: true });
});

/**
 * A dev server whose React modules all go through Babel, `node_modules` included, so the stamp's own rules decide
 * which files are stamped rather than plugin-react's default exclusion.
 */
async function devServer(
  plugins: Plugin[] = [iterbar()],
  { mode, frameworks }: { mode?: string; frameworks?: Plugin[] } = {},
): Promise<ViteDevServer> {
  const server = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    ...(mode === undefined ? {} : { mode }),
    plugins: [...(frameworks ?? [react({ exclude: [/^\0never$/] }), svelte()]), ...plugins],
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, hmr: false, ws: false },
  });
  servers.push(server);
  return server;
}

async function transform(server: ViteDevServer, url: string): Promise<{ code: string; map: EncodedSourceMap }> {
  const result = await server.transformRequest(url);
  if (!result) throw new Error(`No module for ${url}`);
  return { code: result.code, map: result.map as EncodedSourceMap };
}

/** Every stamp in compiled output, in either quote style and as an attribute or a property. */
function stamps(code: string): string[] {
  return [...code.matchAll(/data-iterbar-src['"]?\s*[:=]\s*['"]([^'"]*)['"]/g)].map((match) => match[1]!);
}

/** 1-based line and 0-based column of an offset in generated code. */
function position(code: string, offset: number): { line: number; column: number } {
  const before = code.slice(0, offset);
  return { line: before.split("\n").length, column: offset - before.lastIndexOf("\n") - 1 };
}

/** Where the source map says the generated code at `offset` was written, as a stamp's `line:column`. */
function mappedLocation(map: EncodedSourceMap, code: string, offset: number): string {
  const original = originalPositionFor(new TraceMap(map), position(code, offset));
  return `${original.line}:${(original.column ?? -1) + 1}`;
}

/**
 * Whether the Svelte compiler's source map names a `tag` element at a stamp's location: it maps the variable that
 * holds the element (named after its tag) to the tag name, one column after the stamp's `<`.
 */
function svelteMapNames(map: EncodedSourceMap, code: string, stamp: string, tag: string): boolean {
  const [line, column] = stamp.split(":").slice(-2).map(Number);
  const lines = code.split("\n");
  let named = false;
  eachMapping(new TraceMap(map), (mapping) => {
    if (mapping.originalLine !== line || mapping.originalColumn !== column) return;
    if (lines[mapping.generatedLine - 1]!.startsWith(tag, mapping.generatedColumn)) named = true;
  });
  return named;
}

const REACT_APP = `import { Fragment } from "react";
import * as ui from "./ui";

type Props = {
  readonly title: string;
};

export function App({ title, ...rest }: Props & Record<string, unknown>) {
  return (
    <main className="page">
      <h1>{title}</h1>
      <my-widget></my-widget>
      <Card />
      <ui.Card />
      <>
        <p>in a fragment</p>
      </>
      <Fragment><span /></Fragment>
      <section {...rest} />
      <aside {...rest} id="mixed" />
    </main>
  );
}

function Card() {
  return <div />;
}
`;

describe("React source locations", () => {
  it("stamps host elements, and no component, fragment or spread-only element, at the TypeScript source map's location", async () => {
    await write("src/App.tsx", REACT_APP);
    await write("src/ui.tsx", "export function Card() {\n  return null;\n}\n");
    const { code, map } = await transform(await devServer(), "/src/App.tsx");

    expect(stamps(code)).toEqual([
      "src/App.tsx:10:5", // <main>
      "src/App.tsx:11:7", // <h1>
      "src/App.tsx:12:7", // <my-widget>, a custom element
      "src/App.tsx:16:9", // <p> inside the fragment, which itself is not stamped
      "src/App.tsx:18:17", // <span> inside <Fragment>
      "src/App.tsx:20:7", // <aside {...rest} id>, which has more than a spread
      "src/App.tsx:26:10", // <div> in Card
    ]);
    // Each stamp is where the TypeScript source map puts the element's compiled call.
    for (const stamp of stamps(code)) {
      const call = code.lastIndexOf("jsxDEV(", code.indexOf(stamp));
      expect(mappedLocation(map, code, call)).toBe(stamp.replace("src/App.tsx:", ""));
    }
  });

  it("leaves an element that already names its source as written", async () => {
    await write("src/App.jsx", `export const App = () => <div data-iterbar-src="elsewhere.jsx:1:1" />;\n`);
    const { code } = await transform(await devServer(), "/src/App.jsx");
    expect(stamps(code)).toEqual(["elsewhere.jsx:1:1"]);
  });

});

const SVELTE_APP = `<script lang="ts">
  import Card from "./Card.svelte";

  type Props = {
    readonly title: string;
    readonly [key: string]: unknown;
  };

  let { title, ...rest }: Props = $props();
</script>

<main class="page">
  <h1>{title}</h1>
  {#if title}<p>shown</p>{/if}
  <Card />
  <section {...rest}></section>
  <aside {...rest} id="mixed"></aside>
</main>

<style>
  main {
    color: black;
  }
</style>
`;

describe("Svelte source locations", () => {
  it("stamps regular elements, and no component or spread-only element, at the Svelte source map's location", async () => {
    await write("src/App.svelte", SVELTE_APP);
    await write("src/Card.svelte", "<div>card</div>\n");
    const server = await devServer();
    const { code, map } = await transform(server, "/src/App.svelte");

    const expected = {
      "src/App.svelte:12:1": "main",
      "src/App.svelte:13:3": "h1",
      "src/App.svelte:14:14": "p", // in an {#if} block
      "src/App.svelte:17:3": "aside", // with more than a spread
    };
    expect(stamps(code).sort()).toEqual(Object.keys(expected).sort());
    // Each stamp is where the Svelte compiler's source map puts the element.
    for (const [stamp, tag] of Object.entries(expected)) expect(svelteMapNames(map, code, stamp, tag), stamp).toBe(true);
    const card = await transform(server, "/src/Card.svelte");
    expect(stamps(card.code)).toEqual(["src/Card.svelte:1:1"]);
    expect(svelteMapNames(card.map, card.code, "src/Card.svelte:1:1", "div")).toBe(true);
  });

  it("stamps the component as written when vite-plugin-svelte's preprocessors are listed first", async () => {
    await write("src/App.svelte", SVELTE_APP);
    await write("src/Card.svelte", "<div>card</div>\n");
    const server = await devServer([iterbar()], { frameworks: svelte({ preprocess: vitePreprocess() }) });
    const { code, map } = await transform(server, "/src/App.svelte");

    const expected = { "src/App.svelte:12:1": "main", "src/App.svelte:13:3": "h1", "src/App.svelte:14:14": "p", "src/App.svelte:17:3": "aside" };
    expect(stamps(code).sort()).toEqual(Object.keys(expected).sort());
    for (const [stamp, tag] of Object.entries(expected)) expect(svelteMapNames(map, code, stamp, tag), stamp).toBe(true);
  });

  it("finds elements past a style that only its preprocessor can read", async () => {
    const component = `<style lang="scss">\n  // a comment Svelte's CSS parser rejects\n  $color: red;\n  div { color: $color; }\n</style>\n<div>scss</div>\n`;
    const filename = join(root, "src/Scss.svelte");
    const result = await stampSvelteModule(component, filename, sourceRoot(root), root);
    expect(result?.code).toContain('<div data-iterbar-src="src/Scss.svelte:6:1">scss</div>');
    // The style is untouched, for its own preprocessor.
    expect(result?.code).toContain("// a comment Svelte's CSS parser rejects");
  });

  it("finds every element around a script whose closing tag the parser reads with a space", async () => {
    const filename = join(root, "src/App.svelte");
    const stampsIn = async (component: string) => stamps((await stampSvelteModule(component, filename, sourceRoot(root), root))?.code ?? "");
    const scripts = `<script module>const a = 1;</script >\n<div>first</div>\n<script>let b = 2;</script>\n<p>second</p>\n`;
    expect(await stampsIn(scripts)).toEqual(["src/App.svelte:2:1", "src/App.svelte:4:1"]);
    const head = `<script>let a = 1;</script >\n<svelte:head><script>window.b = 2;</script></svelte:head>\n<div>after</div>\n`;
    expect(await stampsIn(head)).toEqual(["src/App.svelte:2:14", "src/App.svelte:3:1"]);
    // With a style that only its preprocessor can read, too.
    const scss = `${scripts}<style lang="scss">\n  $color: red;\n  div { color: $color; }\n</style>\n<span>third</span>\n`;
    expect(await stampsIn(scss)).toEqual(["src/App.svelte:2:1", "src/App.svelte:4:1", "src/App.svelte:9:1"]);
  });

  it("leaves a component in node_modules as written when the project root is there too", async () => {
    // Vite requests such a module with a `?v=` query, which no stamp takes; another caller may name it without one.
    const project = join(root, "node_modules/widget");
    await expect(stampSvelteModule("<div></div>\n", join(project, "src/App.svelte"), sourceRoot(project), root)).resolves.toBeNull();
  });

  it("parses with the svelte/compiler each app resolves", async () => {
    // An app whose own Svelte finds no element: its components get no stamp, while the plugin's Svelte would stamp them.
    const real = require.resolve("svelte/compiler");
    await write("other/node_modules/svelte/package.json", JSON.stringify({ name: "svelte", exports: { "./compiler": "./compiler.cjs" } }));
    await write("other/node_modules/svelte/compiler.cjs", `const real = require(${JSON.stringify(real)});
module.exports = { ...real, parse: (...args) => ({ ...real.parse(...args), fragment: { type: "Fragment", nodes: [] } }) };
`);
    const stamped = (app: string) => stampSvelteModule("<div></div>\n", join(app, "src/App.svelte"), sourceRoot(app), app);
    expect((await stamped(root))?.code).toBe('<div data-iterbar-src="src/App.svelte:1:1"></div>\n');
    await expect(stamped(join(root, "other"))).resolves.toBeNull();
  });

  it("leaves markup the compiler cannot parse to the compiler", async () => {
    const filename = join(root, "src/Broken.svelte");
    await expect(stampSvelteModule("<div>{#if}</div>\n", filename, sourceRoot(root), root)).resolves.toBeNull();
  });

  it("writes a path the Svelte parser reads back unchanged, whatever characters it holds", async () => {
    const preprocessor = svelteSourcePreprocessor(sourceRoot(root), svelteCompiler);
    const filename = join(root, 'we"ird {dir} & co', "App.svelte");
    const result = await preprocessor.markup?.({ content: "<div></div>\n", filename });
    const element = svelteCompiler.parse(result!.code, { modern: true }).fragment.nodes[0] as svelteCompiler.AST.RegularElement;
    const attribute = element.attributes[0] as svelteCompiler.AST.Attribute;
    const [text] = attribute.value as svelteCompiler.AST.Text[];
    expect(text!.data).toBe('we"ird {dir} & co/App.svelte:1:1');
  });
});

describe.each([
  { framework: "React", extension: "tsx", component: "export const C = () => <div />;\n", stamp: "1:24", compiled: 'jsxDEV("div"' },
  { framework: "Svelte", extension: "svelte", component: "<div>c</div>\n", stamp: "1:1", compiled: "c</div>" },
])("$framework project files", ({ extension, component, stamp, compiled }) => {
  /** The stamps of a module, after checking that its framework compiled it. */
  async function stampsOf(server: ViteDevServer, path: string): Promise<string[]> {
    const { code } = await transform(server, `/${path}`);
    expect(code).toContain(compiled);
    return stamps(code);
  }

  it("are stamped relative to the project root; files outside it or in node_modules are not", async () => {
    const [inside, outside, vendored] = [`app/src/Inside.${extension}`, `shared/Outside.${extension}`, `app/node_modules/widgets/Widget.${extension}`];
    for (const path of [inside, outside, vendored]) await write(path, component);
    const server = await devServer([iterbar({ projectRoot: "app" })]);

    expect(await stampsOf(server, inside)).toEqual([`src/Inside.${extension}:${stamp}`]);
    expect(await stampsOf(server, outside)).toEqual([]);
    expect(await stampsOf(server, vendored)).toEqual([]);
  });

  it("are not stamped when the project root itself is in node_modules", async () => {
    const file = `node_modules/widget/src/App.${extension}`;
    await write(file, component);
    expect(await stampsOf(await devServer([iterbar({ projectRoot: "node_modules/widget" })]), file)).toEqual([]);
  });
});

describe("Vitest", () => {
  async function stampsOf(server: ViteDevServer): Promise<string[]> {
    return [
      ...stamps((await transform(server, "/src/App.tsx")).code),
      ...stamps((await transform(server, "/src/Card.svelte")).code),
    ];
  }

  beforeEach(async () => {
    await write("src/App.tsx", "export const App = () => <div />;\n");
    await write("src/Card.svelte", "<div>card</div>\n");
  });

  it("gets no stamps on its test-mode dev server, while a dev server does", async () => {
    expect(await stampsOf(await devServer())).toEqual(["src/App.tsx:1:26", "src/Card.svelte:1:1"]);
    expect(await stampsOf(await devServer([iterbar()], { mode: "test" }))).toEqual([]);
  });

  it("gets no stamps when a run picks another mode", async () => {
    // Vitest's server carries Vitest's plugins, by these names, whatever its mode.
    const vitest: Plugin = { name: "vitest" };
    expect(await stampsOf(await devServer([iterbar(), vitest], { mode: "development" }))).toEqual([]);
  });
});

describe("production builds", () => {
  it("contain no data-iterbar-src", async () => {
    await write("src/App.tsx", REACT_APP);
    await write("src/ui.tsx", "export function Card() {\n  return null;\n}\n");
    await write("src/App.svelte", SVELTE_APP);
    await write("src/Card.svelte", "<div>card</div>\n");
    await write("src/main.ts", `import { App } from "./App";\nimport SvelteApp from "./App.svelte";\nexport { App, SvelteApp };\n`);
    const outDir = join(root, "dist");
    await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [react(), svelte(), iterbar()],
      build: { outDir, minify: false, rollupOptions: { input: join(root, "src/main.ts"), preserveEntrySignatures: "strict" } },
    });

    const files = await readdir(outDir, { recursive: true, withFileTypes: true });
    const output = (await Promise.all(files.filter((file) => file.isFile())
      .map((file) => readFile(join(file.parentPath, file.name), "utf8")))).join("\n");
    // Both apps are in the build, without a stamp.
    expect(output).toContain("my-widget");
    expect(output).toContain("shown");
    expect(output).not.toContain("data-iterbar-src");
  });
});
