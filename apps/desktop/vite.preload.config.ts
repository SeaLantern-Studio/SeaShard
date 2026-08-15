import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

const entry = fileURLToPath(new URL("./src/preload/index.ts", import.meta.url));
const outDir = fileURLToPath(new URL("./dist/preload", import.meta.url));

export default defineConfig({
  build: {
    target: "node22",
    outDir,
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    lib: {
      entry,
      formats: ["cjs"],
      fileName: () => "index.cjs",
    },
    rollupOptions: {
      external: [/^node:/, "electron"],
    },
  },
});
