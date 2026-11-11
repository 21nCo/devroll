import { iterbar } from "@iterbar/vite";
import { defineConfig } from "vite";

// esbuild compiles the JSX (see tsconfig.json); a real app would add @vitejs/plugin-react for Fast Refresh.
export default defineConfig({
  plugins: [iterbar()],
});
