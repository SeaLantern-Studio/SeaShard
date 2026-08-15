import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, type PluginOption } from "vite-plus";

const desktopRoot = fileURLToPath(new URL("./apps/desktop", import.meta.url));
const vuePlugin = vue() as unknown as PluginOption;

export default defineConfig({
  root: desktopRoot,
  base: "./",
  plugins: [vuePlugin],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
});
