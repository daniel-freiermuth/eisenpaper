import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

// `just dev` runs the Rust server on this port against dev-tasks.json,
// so development never touches the real sheet.
const DEV_BACKEND = "http://127.0.0.1:8742";

export default defineConfig({
  plugins: [svelte()],
  server: {
    proxy: { "/tasks.json": DEV_BACKEND },
  },
  build: {
    target: "es2024",
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
