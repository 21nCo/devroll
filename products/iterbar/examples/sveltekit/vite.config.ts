import { iterbar } from "@iterbar/vite";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

// SvelteKit renders its own HTML, so src/hooks.client.ts imports "@iterbar/vite/client" to show the bar.
export default defineConfig({
  plugins: [sveltekit(), iterbar()],
});
