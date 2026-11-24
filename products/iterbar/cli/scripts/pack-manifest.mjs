// Keeps build-only fields out of the packed manifest. `npm pack` (the publish workflow's packer) copies package.json
// as it is, workspace devDependencies included, which an install run from the unpacked tarball cannot resolve.
// `prepack` sets package.json aside and writes it without devDependencies; `postpack` puts the original back. A
// prepack that finds a manifest already set aside (an earlier pack that failed) restores it first.
import { access, readFile, rename, writeFile } from "node:fs/promises";

const manifest = new URL("../package.json", import.meta.url);
const saved = new URL("../package.json.pack-original", import.meta.url);
const exists = (url) => access(url).then(() => true, () => false);

const step = process.argv[2];
if (step === "prepack") {
  if (await exists(saved)) await rename(saved, manifest);
  const text = await readFile(manifest, "utf8");
  await writeFile(saved, text);
  const packed = JSON.parse(text);
  delete packed.devDependencies;
  await writeFile(manifest, `${JSON.stringify(packed, null, 2)}\n`);
} else if (step === "postpack") {
  if (await exists(saved)) await rename(saved, manifest);
} else {
  throw new Error(`pack-manifest.mjs takes prepack or postpack, not ${JSON.stringify(step)}`);
}
