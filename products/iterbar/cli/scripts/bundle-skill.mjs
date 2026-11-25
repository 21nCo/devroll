// Copies the iterbar agent skill (products/iterbar/skills/iterbar) into this package's skills/ folder, so the packed
// package carries it and `iterbar init` can install it without a Devroll checkout. Runs after every build.
import { cp, rm } from "node:fs/promises";

const source = new URL("../../skills/iterbar/", import.meta.url);
const target = new URL("../skills/iterbar/", import.meta.url);
await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });
