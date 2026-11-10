# @iterbar/vite

The Iterbar Vite plugin. In `vite dev` it shows the Iterbar bar on every
page, connected to the project's Iterbar daemon. `vite build` and
`vite preview` do not use it, so a production build contains no Iterbar
runtime.

```ts
// vite.config.ts
import { iterbar } from "@iterbar/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [iterbar()],
});
```

That is all a Vite single-page app needs: the plugin adds the bar's client
module to every HTML page Vite serves (`transformIndexHtml`).

SvelteKit renders its own HTML, so import the client from
`src/hooks.client.ts` as well:

```ts
// vite.config.ts
plugins: [sveltekit(), iterbar()],

// src/hooks.client.ts
import "@iterbar/vite/client";
```

In `vite dev` the plugin resolves `@iterbar/vite/client` to the module that
mounts the bar. Anywhere else (a build, a server render, a config without
the plugin) it is an empty module.

Slots come from the `Variants` components of `@iterbar/react` and
`@iterbar/svelte`. See `products/iterbar/examples` for a Vite and React app
and a SvelteKit app.

## The daemon

On the first page load, the plugin finds the project's daemon:

1. A daemon this process already runs for the project.
2. The daemon that `.iterbar/daemon.json` describes, if the file names the
   same project root (its real path) and the daemon answers with that
   file's token. A `daemon.json` copied from another checkout, or left by a
   daemon that died, is never used.
3. Otherwise the plugin starts a daemon inside the dev server's process. It
   stops when the last dev server in the process that uses it closes (Vite
   closes on `SIGTERM`), and when the process gets Ctrl+C (`SIGINT`) or
   `SIGHUP`: the plugin shuts the daemon down first, then lets the signal
   end the process unless something else handles it. A daemon the plugin
   found already running is left running. If the process is killed
   outright, the next start replaces the `daemon.json` and store lock it
   left behind.

If another process holds the store lock but no daemon answers for it, the
plugin waits up to 5 seconds for one to appear, then the bar runs without
feedback and the dev server logs why.

The plugin then registers the dev server's origins with the daemon: every
URL Vite prints (each loopback one also as `localhost`, `127.0.0.1` and
`[::1]`), `server.origin`, and the `origins` option. It repeats this on
every page load, which also notices a daemon that stopped or restarted and
moves to the current one.

The bar gets the daemon's URL and token from `GET <base>__iterbar/config` on
the dev server. Only the dev server's own pages can read it: the request
must be same-origin (`Sec-Fetch-Site`, and `Origin` when sent), and its
host must be one of the registered origins, so a page from another site,
or one that reaches the dev server under a rebound host name, gets a `403`
and no token. The token never goes into the HTML or a cached module. The
host is read from `Host`, or from `:authority` on an HTTPS dev server, which
browsers reach over HTTP/2.

The dev server never serves a `.iterbar/` store, which holds `daemon.json`
with the token and the feedback: every request with a `.iterbar` path
segment (in any case, encoded or not, under `base`, `/@fs/`, `/@id/` or the
public directory) gets a `404` before Vite's own middleware sees it.

Behind a proxy or tunnel that ends TLS and forwards plain HTTP with the
original host, add its `https` origin to `origins` (and the host to
`server.allowedHosts`): a request for that host is accepted as that origin.

## Options

- `projectRoot`: the project whose `.iterbar/` store the daemon serves,
  relative to Vite's root (default: Vite's root). Use the directory your
  coding agent runs `iterbar mcp` in, so both reach the same daemon.
- `origins`: more origins the pages are opened from, such as a tunnel or a
  forwarded port (`["https://my-tunnel.example"]`). Each must be an origin,
  with no path.

## Tests

- `pnpm test`: the plugin against real Vite dev servers, builds and daemons
  on temporary projects.
- The example apps' Playwright tests live in `products/iterbar/examples/e2e`.
