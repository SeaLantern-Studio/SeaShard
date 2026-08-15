import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

const entry = fileURLToPath(new URL("./src/index.ts", import.meta.url));
const outDir = fileURLToPath(new URL("./dist", import.meta.url));

export default defineConfig({
  build: {
    target: "node22",
    outDir,
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    lib: {
      entry,
      formats: ["es"],
      fileName: () => "index.js",
    },
    rollupOptions: {
      external: [/^node:/, "cordis"],
    },
  },
});
