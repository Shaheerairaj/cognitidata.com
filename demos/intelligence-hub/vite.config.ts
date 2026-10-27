import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Browser-only demo: there is no backend and no dev proxy — every `/api/*` call is answered in
// the page by the fake server in src/demo/server.ts.
export default defineConfig({
  // Relative base: the built site works from any folder (e.g. cognitidata.com/demos/intelligence-hub/).
  base: "./",
  plugins: [react()],
});
