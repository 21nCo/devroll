# Iterbar example: SvelteKit

A SvelteKit page with two `Variants` slots, `hero` and `pricing`.
`vite.config.ts` adds `iterbar()`, and `src/hooks.client.ts` imports
`@iterbar/vite/client`, because SvelteKit renders its own HTML rather than
Vite's `index.html`. `pnpm dev` shows the Iterbar bar on every page, and the
bar switches each slot between its versions. `pnpm build` prerenders a
static site into `dist/` with no Iterbar runtime: the slots render their
default version.

```sh
pnpm --filter "@iterbar/example-sveltekit^..." build   # build the Iterbar packages once
pnpm --filter @iterbar/example-sveltekit dev
```

The Playwright tests in `../e2e` run this app in dev and as a production
build.
