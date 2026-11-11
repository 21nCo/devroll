import type { PluginObj, PluginPass, types as BabelTypes } from "@babel/core";
import { SOURCE_ATTRIBUTE, sourcePath, stampValue, type SourceRoot } from "./location.js";

/** What `@vitejs/plugin-react` hands a Babel plugin factory: Babel's API with its node builders. */
interface BabelApi {
  readonly types: typeof BabelTypes;
}

/**
 * A JSX element name React renders as a DOM element: a plain lowercase name (`div`, `my-element`). A capitalized
 * name, a member expression (`<ui.Button>`) and a namespaced name (`<svg:rect>`) are not stamped.
 */
function isHostName(name: BabelTypes.JSXOpeningElement["name"]): name is BabelTypes.JSXIdentifier {
  return name.type === "JSXIdentifier" && /^[a-z]/.test(name.name);
}

function hasStamp(attributes: BabelTypes.JSXOpeningElement["attributes"]): boolean {
  return attributes.some((attribute) =>
    attribute.type === "JSXAttribute" && attribute.name.type === "JSXIdentifier" && attribute.name.name === SOURCE_ATTRIBUTE);
}

/**
 * The Babel plugin that stamps each JSX host element of a project source file with `data-iterbar-src`, from Babel's
 * own location of its opening tag. Components, fragments, elements whose only attributes are spreads, and files
 * outside the project root or in `node_modules` keep their JSX as written.
 */
export function reactSourcePlugin(root: SourceRoot): (babel: BabelApi) => PluginObj<PluginPass> {
  return ({ types: t }) => ({
    name: "iterbar-source",
    visitor: {
      JSXOpeningElement(path, state) {
        const { node } = path;
        const filename = state.file.opts.filename;
        if (!filename || !node.loc || !isHostName(node.name)) return;
        if (node.attributes.length > 0 && node.attributes.every((attribute) => attribute.type === "JSXSpreadAttribute")) return;
        if (hasStamp(node.attributes)) return;
        const file = sourcePath(root, filename);
        if (file === null) return;
        const value = stampValue(file, node.loc.start.line, node.loc.start.column);
        // An expression, so no character of the path ends a JSX string. First, so an attribute written later (a spread
        // included) still wins, as React applies the last one.
        const stamp = t.jsxAttribute(t.jsxIdentifier(SOURCE_ATTRIBUTE), t.jsxExpressionContainer(t.stringLiteral(value)));
        node.attributes.unshift(stamp);
      },
    },
  });
}
