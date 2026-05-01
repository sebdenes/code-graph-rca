import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Resolve content globs relative to THIS config file, not the CWD.
// Vite runs from `packages/ui/`, so without this anchor Tailwind scans
// nothing and silently drops every utility class.
const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    resolve(here, "index.html"),
    resolve(here, "src/**/*.{ts,tsx}"),
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        muted: "hsl(var(--muted))",
        "muted-foreground": "hsl(var(--muted-foreground))",
        border: "hsl(var(--border))",
        accent: "hsl(var(--accent))",
        "accent-foreground": "hsl(var(--accent-foreground))",
        "score-1": "#dc2626",
        "score-2": "#f97316",
        "score-3": "#eab308",
        "score-4": "#84cc16",
        "score-5": "#22d3ee",
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};
