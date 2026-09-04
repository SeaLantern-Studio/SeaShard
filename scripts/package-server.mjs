import { spawn } from "node:child_process";
import { chmod, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const version = requireArgument("--version");
const platform = requireArgument("--platform");
const architecture = requireArgument("--arch");
const nodeExecutable = resolve(readArgument("--node-executable") ?? process.execPath);
const appImageTool = readArgument("--appimage-tool");
const outputRoot = resolve(readArgument("--output") ?? join(root, "release"));

if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error(`无效 Server 版本：${version}`);
if (platform !== "windows" && platform !== "macos" && platform !== "linux") {
  throw new Error(`Server 发布平台必须是 windows、macos 或 linux：${platform}`);
}
if (architecture !== "x64" && architecture !== "arm64") {
  throw new Error(`Server 发布架构必须是 x64 或 arm64：${architecture}`);
}
if (platform === "linux" && !appImageTool) throw new Error("Linux Server 打包缺少 --appimage-tool");

const buildRoot = join(root, "build", "server-package", `${platform}-${architecture}`);
const portableName = "SeaShardServer";
const portableRoot = join(buildRoot, portableName);
await rm(buildRoot, { recursive: true, force: true });
await mkdir(portableRoot, { recursive: true });
await mkdir(outputRoot, { recursive: true });
await copyServerRuntime(portableRoot);
await writePortableLauncher(portableRoot);
await writeFile(
  join(portableRoot, "release.json"),
  `${JSON.stringify({ schemaVersion: 1, version, platform, architecture }, null, 2)}\n`,
  "utf8",
);

await writeFile(
  join(portableRoot, "package.json"),
  `${JSON.stringify(
    { name: "seashard-server-runtime", version, private: true, type: "module" },
    null,
    2,
  )}\n`,
  "utf8",
);
if (platform === "windows") {
  const archive = join(outputRoot, `SeaShard-Server-${version}-windows-${architecture}.zip`);
  await run("tar", ["-a", "-cf", archive, "-C", buildRoot, portableName]);
} else {
  const archive = join(outputRoot, `SeaShard-Server-${version}-${platform}-${architecture}.tar.gz`);
  await run("tar", ["-czf", archive, "-C", buildRoot, portableName]);
  if (platform === "macos") await createMacPackage();
  else {
    await createDebPackage();
    await createAppImage();
  }
}

console.log(
  `SEASHARD_SERVER_PACKAGE_READY platform=${platform} arch=${architecture} output=${outputRoot}`,
);

async function copyServerRuntime(destination) {
  const runtimeRoot = join(destination, "runtime");
  const nodeTarget = join(runtimeRoot, platform === "windows" ? "node.exe" : "node");
  await mkdir(runtimeRoot, { recursive: true });
  await cp(nodeExecutable, nodeTarget);
  if (platform !== "windows") await chmod(nodeTarget, 0o755);
  await Promise.all([
    copyDirectory(
      join(root, "apps", "server", "dist"),
      join(destination, "apps", "server", "dist"),
    ),
    copyDirectory(
      join(root, "apps", "plugin-host", "dist"),
      join(destination, "apps", "plugin-host", "dist"),
    ),
    copyDirectory(
      join(root, "apps", "database-worker", "dist"),
      join(destination, "apps", "database-worker", "dist"),
    ),
  ]);
  const nodeDistributionRoot =
    platform === "windows" ? dirname(nodeExecutable) : dirname(dirname(nodeExecutable));
  await cp(join(nodeDistributionRoot, "LICENSE"), join(runtimeRoot, "NODE-LICENSE"));
}

async function copyDirectory(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, force: true });
}

async function writePortableLauncher(destination) {
  if (platform === "windows") {
    await writeFile(
      join(destination, "seashard-server.cmd"),
      '@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0apps\\server\\dist\\index.js" %*\r\n',
      "utf8",
    );
    return;
  }
  const launcher = join(destination, "seashard-server");
  await writeFile(
    launcher,
    '#!/bin/sh\nset -eu\nroot="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec "$root/runtime/node" "$root/apps/server/dist/index.js" "$@"\n',
    "utf8",
  );
  await chmod(launcher, 0o755);
}

/**
 * Server 是纯后台进程，因此 macOS PKG 使用稳定的 /usr/local 入口，不额外制造一个
 * 无界面的 App。安装脚本仅在当前用户没有 Host 时复制随包 Host，并让两个 LaunchAgent
 * 都归当前图形会话管理；升级 Server 不会覆盖已有的独立 Host。
 */
async function createMacPackage() {
  const packageRoot = join(buildRoot, "pkg-root");
  const installationRoot = join(packageRoot, "usr", "local", "lib", "seashard-server");
  await copyDirectory(portableRoot, installationRoot);
  await mkdir(join(packageRoot, "usr", "local", "bin"), { recursive: true });
  const systemLauncher = join(packageRoot, "usr", "local", "bin", "seashard-server");
  await writeFile(
    systemLauncher,
    '#!/bin/sh\nexec /usr/local/lib/seashard-server/runtime/node /usr/local/lib/seashard-server/apps/server/dist/index.js "$@"\n',
    "utf8",
  );
  await chmod(systemLauncher, 0o755);

  const scriptsRoot = join(buildRoot, "pkg-scripts");
  await mkdir(scriptsRoot, { recursive: true });
  await Promise.all([
    writeMaintainerScript(scriptsRoot, "preinstall", createMacPreinstallScript()),
    writeMaintainerScript(scriptsRoot, "postinstall", createMacPostinstallScript()),
  ]);
  await run("pkgbuild", [
    "--root",
    packageRoot,
    "--scripts",
    scriptsRoot,
    "--identifier",
    "studio.sealantern.seashard.server",
    "--version",
    version,
    "--install-location",
    "/",
    join(outputRoot, `SeaShard-Server-${version}-macos-${architecture}.pkg`),
  ]);
}

function createMacPreinstallScript() {
  return `${[
    "#!/bin/sh",
    "set -eu",
    'command="/usr/local/bin/seashard-server"',
    'if [ ! -x "$command" ]; then exit 0; fi',
    `console_user="$(stat -f '%Su' /dev/console)"`,
    'if [ -z "$console_user" ] || [ "$console_user" = root ] || [ "$console_user" = loginwindow ]; then exit 0; fi',
    `user_home="$(dscl . -read "/Users/$console_user" NFSHomeDirectory | awk '{print $2}')"`,
    'user_id="$(id -u "$console_user")"',
    '/bin/launchctl asuser "$user_id" /usr/bin/sudo -u "$console_user" /usr/bin/env HOME="$user_home" USER="$console_user" LOGNAME="$console_user" "$command" service stop || true',
    "exit 0",
  ].join("\n")}\n`;
}

function createMacPostinstallScript() {
  return `${[
    "#!/bin/sh",
    "set -eu",
    'command="/usr/local/bin/seashard-server"',
    'bundled_host="/usr/local/lib/seashard-server/apps/server/dist/host-installer/SeaShardHost.app"',
    'installed_host="/Applications/SeaShardHost.app"',
    'host_label="studio.sealantern.seashard.host"',
    `console_user="$(stat -f '%Su' /dev/console)"`,
    'if [ -z "$console_user" ] || [ "$console_user" = root ] || [ "$console_user" = loginwindow ]; then',
    '  echo "SeaShard Server requires an active macOS user session." >&2',
    "  exit 1",
    "fi",
    `user_home="$(dscl . -read "/Users/$console_user" NFSHomeDirectory | awk '{print $2}')"`,
    'user_id="$(id -u "$console_user")"',
    'user_group="$(id -gn "$console_user")"',
    'host_root="$user_home/Library/Application Support/SeaShard/core"',
    'host_marker_root="$host_root/host-installation"',
    'host_agent_dir="$user_home/Library/LaunchAgents"',
    'host_agent_path="$host_agent_dir/$host_label.plist"',
    'if [ ! -f "$host_marker_root/standalone" ] && [ ! -f "$host_marker_root/bundled" ] && [ ! -f "$host_root/host-installation.json" ]; then',
    '  if [ ! -d "$bundled_host" ]; then',
    '    echo "SeaShard Server package does not contain the macOS Host." >&2',
    "    exit 1",
    "  fi",
    '  rm -rf -- "$installed_host"',
    '  /usr/bin/ditto "$bundled_host" "$installed_host"',
    '  /usr/sbin/chown -R root:wheel "$installed_host"',
    '  /usr/bin/install -d -o "$console_user" -g "$user_group" "$host_root" "$host_agent_dir"',
    '  cat > "$host_agent_path" <<EOF',
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    "  <string>$host_label</string>",
    "  <key>ProgramArguments</key>",
    "  <array>",
    "    <string>$installed_host/Contents/MacOS/SeaShardHost</string>",
    "    <string>--data-root=$host_root</string>",
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "</dict>",
    "</plist>",
    "EOF",
    '  /usr/sbin/chown "$console_user:$user_group" "$host_agent_path"',
    '  /bin/chmod 600 "$host_agent_path"',
    '  /bin/launchctl bootout "gui/$user_id/$host_label" >/dev/null 2>&1 || true',
    '  /bin/launchctl bootstrap "gui/$user_id" "$host_agent_path"',
    '  /bin/launchctl enable "gui/$user_id/$host_label"',
    '  /bin/launchctl kickstart -k "gui/$user_id/$host_label"',
    "  attempts=0",
    '  while { [ ! -f "$host_root/host-control.json" ] || { [ ! -f "$host_marker_root/standalone" ] && [ ! -f "$host_root/host-installation.json" ]; }; } && [ "$attempts" -lt 600 ]; do',
    "    sleep 0.1",
    "    attempts=$((attempts + 1))",
    "  done",
    '  if [ ! -f "$host_root/host-control.json" ]; then',
    '    echo "SeaShard Host did not start after installation." >&2',
    "    exit 1",
    "  fi",
    "fi",
    '/bin/launchctl asuser "$user_id" /usr/bin/sudo -u "$console_user" /usr/bin/env HOME="$user_home" USER="$console_user" LOGNAME="$console_user" "$command" service install',
    "exit 0",
  ].join("\n")}\n`;
}

async function createDebPackage() {
  const debRoot = join(buildRoot, "deb-root");
  const installationRoot = join(debRoot, "opt", "seashard-server");
  await copyDirectory(portableRoot, installationRoot);
  await mkdir(join(debRoot, "usr", "bin"), { recursive: true });
  const systemLauncher = join(debRoot, "usr", "bin", "seashard-server");
  await writeFile(
    systemLauncher,
    '#!/bin/sh\nexec /opt/seashard-server/runtime/node /opt/seashard-server/apps/server/dist/index.js "$@"\n',
    "utf8",
  );
  await chmod(systemLauncher, 0o755);

  const controlRoot = join(debRoot, "DEBIAN");
  await mkdir(controlRoot, { recursive: true });
  await writeFile(
    join(controlRoot, "control"),
    `Package: seashard-server\nVersion: ${version}\nSection: utils\nPriority: optional\nArchitecture: ${architecture === "x64" ? "amd64" : "arm64"}\nMaintainer: SeaLantern Studio <SeaLantern-Studio@users.noreply.github.com>\nDepends: ca-certificates, libc6 (>= 2.28)\nDescription: SeaShard headless Minecraft Server Controller\n`,
    "utf8",
  );
  await writeMaintainerScript(controlRoot, "preinst", createDebServiceScript("stop"));
  await writeMaintainerScript(controlRoot, "postinst", createDebServiceScript("install"));
  await writeMaintainerScript(controlRoot, "prerm", createDebServiceScript("uninstall"));
  await run("dpkg-deb", [
    "--root-owner-group",
    "--build",
    debRoot,
    join(outputRoot, `SeaShard-Server-${version}-linux-${architecture}.deb`),
  ]);
}

async function createAppImage() {
  const appDir = join(buildRoot, "SeaShardServer.AppDir");
  const applicationRoot = join(appDir, "usr", "lib", "seashard-server");
  await copyDirectory(portableRoot, applicationRoot);
  const appRun = join(appDir, "AppRun");
  await writeFile(
    appRun,
    '#!/bin/sh\nset -eu\napplication="$APPDIR/usr/lib/seashard-server"\nexport SEASHARD_SERVER_EXECUTABLE="${APPIMAGE:-$APPDIR/AppRun}"\nexport SEASHARD_SERVER_STANDALONE=1\nexec "$application/runtime/node" "$application/apps/server/dist/index.js" "$@"\n',
    "utf8",
  );
  await chmod(appRun, 0o755);
  await writeFile(
    join(appDir, "seashard-server.desktop"),
    "[Desktop Entry]\nType=Application\nName=SeaShard Server Controller\nExec=seashard-server\nIcon=seashard-server\nTerminal=true\nCategories=Utility;\nNoDisplay=true\n",
    "utf8",
  );
  await cp(
    join(root, "apps", "desktop", "src", "renderer", "assets", "logo.svg"),
    join(appDir, "seashard-server.svg"),
  );
  const target = join(outputRoot, `SeaShard-Server-${version}-linux-${architecture}.AppImage`);
  await run(resolve(appImageTool), ["--appimage-extract-and-run", appDir, target], {
    ...process.env,
    ARCH: architecture === "x64" ? "x86_64" : "aarch64",
    VERSION: version,
  });
  await chmod(target, 0o755);
}

function createDebServiceScript(action) {
  const command = "/usr/bin/seashard-server";
  return `${[
    "#!/bin/sh",
    "set -eu",
    "state_root=/var/lib/seashard-server",
    'owner_file="$state_root/service-user"',
    `command=${command}`,
    'if [ ! -x "$command" ]; then exit 0; fi',
    `user="${"${SUDO_USER:-}"}"`,
    'if [ -z "$user" ] || [ "$user" = root ]; then',
    '  if [ -f "$owner_file" ]; then user="$(cat "$owner_file")"; else exit 0; fi',
    "fi",
    `case "$user" in (*[!A-Za-z0-9._-]*|'') exit 0;; esac`,
    'uid="$(id -u "$user")"',
    'home="$(getent passwd "$user" | cut -d: -f6)"',
    'if [ -z "$home" ]; then exit 0; fi',
    'mkdir -p "$state_root"',
    `printf '%s\\n' "$user" > "$owner_file"`,
    "if command -v runuser >/dev/null 2>&1; then",
    `  runuser -u "$user" -- env HOME="$home" XDG_RUNTIME_DIR="/run/user/$uid" "$command" service ${action} || { echo "SeaShard Server user service ${action} failed for $user" >&2; exit 1; }`,
    "fi",
    "exit 0",
  ].join("\n")}\n`;
}

async function writeMaintainerScript(controlRoot, name, content) {
  const path = join(controlRoot, name);
  await writeFile(path, content, "utf8");
  await chmod(path, 0o755);
}

function run(executable, arguments_, environment = process.env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, arguments_, { env: environment, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${basename(executable)} failed (${signal ?? code ?? "unknown"})`));
    });
  });
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
