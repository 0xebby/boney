import {defineConfig} from "vitest/config";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";

// `__dirname` is unavailable under Vite's native ESM config loader.
const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
  },
  resolve: {
    alias: {"@": resolve(here, "src")},
  },
});
