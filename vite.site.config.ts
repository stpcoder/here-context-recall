import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(__dirname, "site"),
  base: "/here-context-recall/",
  build: {
    outDir: resolve(__dirname, "dist-site"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        landing: resolve(__dirname, "site/index.html"),
        manual: resolve(__dirname, "site/manual/index.html"),
        social: resolve(__dirname, "site/og.html"),
      },
    },
  },
});
