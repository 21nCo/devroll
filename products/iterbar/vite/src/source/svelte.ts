import MagicString from "magic-string";
import type { AST, PreprocessorGroup, Processed } from "svelte/compiler";
import { SOURCE_ATTRIBUTE, sourcePath, stampValue, type SourceRoot } from "./location.js";

/** The part of `svelte/compiler` the preprocessor uses, loaded from the app's own Svelte. */
export interface SvelteCompiler {
  readonly parse: (source: string, options: { filename?: string; modern: true }) => AST.Root;
  readonly preprocess: (source: string, preprocessor: PreprocessorGroup, options?: { filename?: string }) => Promise<Processed>;
}

/** Each character but line breaks as a space, so every offset after it stays where it was. */
function blank(code: string): string {
  return code.replace(/[^\n\r]/g, " ");
}

/** Every regular element in a fragment, at any depth: inside elements, components, blocks and snippets. */
function regularElements(root: AST.Fragment): AST.RegularElement[] {
  const found: AST.RegularElement[] = [];
  const pending: unknown[] = [root];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null || seen.has(value)) continue;
    seen.add(value);
    if ((value as { type?: unknown }).type === "RegularElement") found.push(value as AST.RegularElement);
    for (const child of Object.values(value)) pending.push(child);
  }
  return found;
}

function isStamped(element: AST.RegularElement): boolean {
  if (element.attributes.length > 0 && element.attributes.every((attribute) => attribute.type === "SpreadAttribute")) return false;
  return !element.attributes.some((attribute) => attribute.type === "Attribute" && attribute.name === SOURCE_ATTRIBUTE);
}

/** An attribute value Svelte reads back as `value`: entities for the characters a quoted value gives meaning to. */
function attributeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/\{/g, "&#123;").replace(/\}/g, "&#125;");
}

/** 1-based line and 0-based column of each offset, counted as the Svelte compiler does (UTF-16 code units). */
function locator(source: string): (offset: number) => { line: number; column: number } {
  const starts = [0];
  for (let index = source.indexOf("\n"); index !== -1; index = source.indexOf("\n", index + 1)) starts.push(index + 1);
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle]! <= offset) low = middle;
      else high = middle - 1;
    }
    return { line: low + 1, column: offset - starts[low]! };
  };
}

/**
 * A Svelte preprocessor that stamps each regular element of a project component with `data-iterbar-src`, at the
 * location the Svelte compiler's own parser gives its opening tag. Components, `svelte:` and `<slot>` elements,
 * elements whose only attributes are spreads, and files outside the project root or in `node_modules` keep their
 * markup as written. It must see the component as written, ahead of any other preprocessor.
 */
export function svelteSourcePreprocessor(root: SourceRoot, compiler: SvelteCompiler): PreprocessorGroup {
  return {
    name: "iterbar-source",
    async markup({ content, filename }) {
      const file = filename === undefined ? null : sourcePath(root, filename);
      if (file === null) return undefined;
      // Svelte's own preprocess finds the scripts and styles; blanked, a `lang="scss"` style does not stop the parser,
      // and every element keeps its offset.
      const markup = await compiler.preprocess(content, {
        script: ({ content: code }) => ({ code: blank(code) }),
        style: ({ content: code }) => ({ code: blank(code) }),
      }, { filename });
      let ast: AST.Root;
      try {
        ast = compiler.parse(markup.code, { filename, modern: true });
      } catch {
        // Markup the compiler cannot read gets no stamps; compiling it reports the error.
        return undefined;
      }
      const locate = locator(content);
      const output = new MagicString(content);
      for (const element of regularElements(ast.fragment)) {
        const nameEnd = element.start + 1 + element.name.length;
        if (content.slice(element.start, nameEnd) !== `<${element.name}` || !isStamped(element)) continue;
        const { line, column } = locate(element.start);
        output.appendLeft(nameEnd, ` ${SOURCE_ATTRIBUTE}="${attributeText(stampValue(file, line, column))}"`);
      }
      if (!output.hasChanged()) return undefined;
      return { code: output.toString(), map: output.generateMap({ source: filename, file: filename, hires: true, includeContent: true }) };
    },
  };
}
