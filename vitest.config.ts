import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@src": fileURLToPath(new URL("./src", import.meta.url)),
      "@minecraft/server": fileURLToPath(new URL("./tests/TreePhysics/mocks/minecraft-server.ts", import.meta.url)),
      "@minecraft/server-ui": fileURLToPath(new URL("./tests/TreePhysics/mocks/minecraft-server-ui.ts", import.meta.url))
    }
  },
  test: {
    environment: "node",
    globals: true,
    include: ["tests/TreePhysics/**/*.test.ts"],
    exclude: ["dist/**", "sample/**", "cannon-es-archive/**", "node_modules/**"]
  }
});
