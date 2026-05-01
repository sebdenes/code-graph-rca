import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";

const here = dirname(fileURLToPath(import.meta.url));

// PostCSS config is inlined here because Vite looks for postcss.config.js
// in the CWD (packages/ui/), not the web/ subdir, and a separate file there
// would silently be ignored — leading to a build with no Tailwind utilities.
export default defineConfig({
  root: here,
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(here, "src"),
      "@shared": resolve(here, "..", "shared"),
    },
  },
  css: {
    postcss: {
      plugins: [
        tailwindcss({ config: resolve(here, "tailwind.config.js") }),
        autoprefixer(),
      ],
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
