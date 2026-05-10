import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: "src/web-component/loader.js",
      name: "TableWidgetLoader",
      fileName: "table-widget-loader",
      formats: ["iife"],
    },
    outDir: "dist-wc",
    emptyOutDir: false, // keep the main bundle built by build:wc
    minify: true,
  },
});
