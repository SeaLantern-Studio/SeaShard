import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, type PluginOption } from "vite-plus";

const desktopRoot = fileURLToPath(new URL("./apps/desktop", import.meta.url));
const frontendRoot = fileURLToPath(new URL("./frontend", import.meta.url));
const vuePlugin = vue() as unknown as PluginOption;

/**
 * Renderer 的根目录是 apps/desktop；组件化前端源码位于根目录外的 frontend。
 * 显式加入监听范围，确保外部 Vue/CSS 文件变化能进入 Vite 的 HMR 链路。
 */
const frontendSourceWatcher: PluginOption = {
  name: "seashard-frontend-source-watch",
  configureServer(server) {
    server.watcher.add(frontendRoot);
  },
};

export default defineConfig({
  root: desktopRoot,
  base: "./",
  plugins: [vuePlugin, frontendSourceWatcher],
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
