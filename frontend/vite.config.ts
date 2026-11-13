/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the UI and the API are kept same-origin via this proxy, exactly
// like Caddy does in production - so cookies and CSRF behave identically.
const API_TARGET = process.env.API_TARGET ?? "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: API_TARGET, changeOrigin: false } },
  },
  build: {
    sourcemap: true,
    // The explorer chunk is mostly Cytoscape (~580 kB, ~180 kB gzip). It is
    // already split out and loaded only when a network is opened.
    chunkSizeWarningLimit: 700,
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});
