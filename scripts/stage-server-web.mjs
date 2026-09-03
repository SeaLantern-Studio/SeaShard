import { cp, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = join(root, "apps/server-web/dist");
const target = join(root, "apps/server/dist/public");

await requireDirectory(source);
await rm(target, { recursive: true, force: true });
await mkdir(dirname(target), { recursive: true });
await cp(source, target, { recursive: true });
console.log(`SEASHARD_SERVER_WEB_STAGED source=${source} target=${target}`);

async function requireDirectory(path) {
  const metadata = await stat(path).catch(() => undefined);
  if (!metadata?.isDirectory()) {
    throw new Error(`Server Web 构建产物不存在：${path}`);
  }
}
