import { defineConfig } from "bumpp";
import { globSync } from "tinyglobby";

export default defineConfig({
  execute: "bun install --lockfile-only",
  files: globSync(["./packages/*/package.json", "./bun.lock"], { expandDirectories: false }),
});
