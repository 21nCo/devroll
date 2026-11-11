import { iterbar } from "@iterbar/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In vite dev, iterbar() adds a Babel plugin to @vitejs/plugin-react that stamps each element with its source location.
export default defineConfig({
  plugins: [react(), iterbar()],
});
