import adapter from "@sveltejs/adapter-static";

/** @type {import("@sveltejs/kit").Config} */
export default {
  kit: {
    // A static site in dist/, which the workspace already ignores.
    adapter: adapter({ pages: "dist", assets: "dist" }),
  },
};
