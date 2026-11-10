# Iterbar example: Vite and React

A Vite and React page with two `Variants` slots, `hero` and `pricing`.
`vite.config.ts` adds `iterbar()`, so `pnpm dev` shows the Iterbar bar on
the page and the bar switches each slot between its versions. `pnpm build`
produces a bundle with no Iterbar runtime: the slots render their default
version.

```sh
pnpm --filter "@iterbar/example-vite-react^..." build   # build the Iterbar packages once
pnpm --filter @iterbar/example-vite-react dev
```

The Playwright tests in `../e2e` run this app in dev and as a production
build.
