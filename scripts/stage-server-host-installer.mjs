import { chmod, copyFile, cp, mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const platform = readArgument("--platform") ?? process.platform;
const sourceRoot = resolve(readArgument("--source-root") ?? join(root, "build", "host-installer"));
const sourceApplication = resolve(
  readArgument("--source-app") ?? join(sourceRoot, "mac", "SeaShardHost.app"),
);
const targetRoot = resolve(
  readArgument("--target-root") ?? join(root, "apps", "server", "dist", "host-installer"),
);

await mkdir(targetRoot, { recursive: true });
if (platform === "win32") {
  await copyRequired(
    join(sourceRoot, "SeaShardHostSetup.exe"),
    join(targetRoot, "SeaShardHostSetup.exe"),
  );
} else if (platform === "darwin") {
  await copyRequiredDirectory(sourceApplication, join(targetRoot, "SeaShardHost.app"));
} else if (platform === "linux") {
  const imageTarget = join(targetRoot, "SeaShardHostSetup.AppImage");
  const scriptTarget = join(targetRoot, "install.sh");
  await copyRequired(join(sourceRoot, "SeaShardHostSetup.AppImage"), imageTarget);
  await copyRequired(join(root, "build", "linux-host-appimage-install.sh"), scriptTarget);
  await Promise.all([chmod(imageTarget, 0o755), chmod(scriptTarget, 0o755)]);
} else {
  throw new Error(`Server Controller 暂不支持携带 ${platform} Host 安装文件`);
}

console.log(`SEASHARD_SERVER_HOST_INSTALLER_STAGED platform=${platform} target=${targetRoot}`);

async function copyRequired(source, target) {
  const metadata = await stat(source).catch(() => undefined);
  if (!metadata?.isFile()) throw new Error(`缺少 Host 安装文件：${source}`);
  await copyFile(source, target);
}

async function copyRequiredDirectory(source, target) {
  const metadata = await stat(source).catch(() => undefined);
  if (!metadata?.isDirectory()) throw new Error(`缺少 Host 应用目录：${source}`);
  await cp(source, target, { recursive: true, force: true });
}

function readArgument(name) {
  const prefix = `${name}=`;
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  const value = argument?.slice(prefix.length).trim();
  return value || undefined;
}
