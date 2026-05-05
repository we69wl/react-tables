import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import cssInjectedByJs from "vite-plugin-css-injected-by-js";

export default defineConfig({
  plugins: [
    react(),
    // Injects CSS into the JS bundle — single file, no separate .css needed
    cssInjectedByJs(),
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
    // Single chunk — everything bundled, no code splitting
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
