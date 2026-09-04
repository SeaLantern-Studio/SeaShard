import { chmod, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const version = requireArgument("--version");
const outputRoot = resolve(readArgument("--output") ?? join(root, "build", "server-npm"));
if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error(`无效 Server npm 版本：${version}`);

const lifecycleScript = `import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.npm_config_global === "true") {
  const action = process.argv[2] === "uninstall" ? "uninstall" : "install";
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const entry = join(packageRoot, "apps", "server", "dist", "index.js");
  const result = spawnSync(process.execPath, [entry, "service", action], {
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}
`;
await rm(outputRoot, { recursive: true, force: true });
await Promise.all([
  copyDirectory(join(root, "apps", "server", "dist"), join(outputRoot, "apps", "server", "dist")),
  copyDirectory(
    join(root, "apps", "plugin-host", "dist"),
    join(outputRoot, "apps", "plugin-host", "dist"),
  ),
  copyDirectory(
    join(root, "apps", "database-worker", "dist"),
    join(outputRoot, "apps", "database-worker", "dist"),
  ),
]);
const hostInstallerRoot = join(outputRoot, "apps", "server", "dist", "host-installer");
await rm(hostInstallerRoot, { recursive: true, force: true });
await mkdir(hostInstallerRoot, { recursive: true });
await cp(
  join(root, "build", "linux-host-appimage-install.sh"),
  join(hostInstallerRoot, "install.sh"),
);
await chmod(join(hostInstallerRoot, "install.sh"), 0o755);
await chmod(join(outputRoot, "apps", "server", "dist", "index.js"), 0o755);
await mkdir(join(outputRoot, "scripts"), { recursive: true });
await writeFile(join(outputRoot, "scripts", "lifecycle.mjs"), lifecycleScript, "utf8");
await writeFile(
  join(outputRoot, "package.json"),
  `${JSON.stringify(
    {
      name: "@seashard/server",
      version,
      description: "SeaShard headless Minecraft Server Controller",
      license: "UNLICENSED",
      type: "module",
      os: ["win32", "darwin", "linux"],
      engines: { node: ">=24.11.0" },
      bin: { "seashard-server": "apps/server/dist/index.js" },
      scripts: {
        postinstall: "node scripts/lifecycle.mjs install",
        preuninstall: "node scripts/lifecycle.mjs uninstall",
      },
      publishConfig: { access: "public" },
      repository: {
        type: "git",
        url: "git+https://github.com/SeaLantern-Studio/SeaShard.git",
      },
      homepage: "https://github.com/SeaLantern-Studio/SeaShard",
      bugs: "https://github.com/SeaLantern-Studio/SeaShard/issues",
    },
    null,
    2,
  )}\n`,
  "utf8",
);
console.log(`SEASHARD_SERVER_NPM_PACKAGE_READY version=${version} output=${outputRoot}`);

async function copyDirectory(source, destination) {
  await mkdir(destination, { recursive: true });
  await cp(source, destination, { recursive: true, force: true });
}

function readArgument(name) {
  const prefix = `${name}=`;
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  const value = argument?.slice(prefix.length).trim();
  return value || undefined;
}

function requireArgument(name) {
  const value = readArgument(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}
