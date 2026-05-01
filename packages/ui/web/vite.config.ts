import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(here, "src"),
      "@shared": resolve(here, "..", "shared"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:7331",
    },
  },
  build: {
    outDir: resolve(here, "..", "dist", "web"),
    emptyOutDir: true,
  },
});
