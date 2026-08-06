import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Portal Administration is shared from ../ui. Keep React single-instanced
    // when Vite resolves that sibling source tree into this application.
    dedupe: ["react", "react-dom"],
    alias: {
      react: path.resolve(__dirname, "node_modules/react"),
      "react-dom": path.resolve(__dirname, "node_modules/react-dom"),
    },
  },
  build: {
    outDir: "web-dist",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
  },
});
