import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import cssInjectedByJs from "vite-plugin-css-injected-by-js";

export default defineConfig({
  plugins: [
    react(),
    // Store CSS in a global variable instead of injecting into <head>.
    // The web component reads this and injects it only into its own shadow root,
    // so Bootstrap never touches the host page's styles.
    cssInjectedByJs({
      injectCode: (cssCode) => `window.__TABLE_WIDGET_CSS__=${cssCode};`,
    }),
  ],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  build: {
    lib: {
      entry: "src/web-component/index.jsx",
      name: "TableWidget",
      fileName: "table-widget",
      formats: ["iife"],
    },
    outDir: "dist-wc",
    emptyOutDir: true,
    minify: true,
    // Inline all assets (fonts, images) as base64 data URIs so the IIFE bundle
    // is fully self-contained — otherwise woff2 URLs in the CSS string 404.
    assetsInlineLimit: 1024 * 1024 * 10,
    // Single chunk — everything bundled, no code splitting
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
