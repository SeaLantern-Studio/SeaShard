import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const nodeVersion = readArgument("--node-version") ?? "24.11.0";
const platform = requireArgument("--platform");
const architecture = requireArgument("--arch");
const githubOutput = readArgument("--github-output");
if (!/^\d+\.\d+\.\d+$/u.test(nodeVersion)) throw new Error(`无效 Node.js 版本：${nodeVersion}`);
if (platform !== "windows" && platform !== "macos" && platform !== "linux") {
  throw new Error(`不支持 Node.js 平台：${platform}`);
}
if (architecture !== "x64" && architecture !== "arm64") {
  throw new Error(`不支持 Node.js 架构：${architecture}`);
}

const distributionPlatform =
  platform === "windows" ? "win" : platform === "macos" ? "darwin" : "linux";
const suffix = platform === "windows" ? "zip" : "tar.xz";
const directoryName = `node-v${nodeVersion}-${distributionPlatform}-${architecture}`;
const archiveName = `${directoryName}.${suffix}`;
const distributionRoot = join(root, "build", "node-runtime", `${platform}-${architecture}`);
const archivePath = join(distributionRoot, archiveName);
const baseUrl = `https://nodejs.org/dist/v${nodeVersion}`;
await rm(distributionRoot, { recursive: true, force: true });
await mkdir(distributionRoot, { recursive: true });

const checksums = await downloadBytes(`${baseUrl}/SHASUMS256.txt`);
const expected = Buffer.from(checksums)
  .toString("utf8")
  .split(/\r?\n/u)
  .map((line) => line.trim().split(/\s+/u))
  .find(([, name]) => name === archiveName)?.[0];
if (!expected || !/^[a-f0-9]{64}$/u.test(expected)) {
  throw new Error(`Node.js 官方校验清单缺少 ${archiveName}`);
}
const archive = await downloadBytes(`${baseUrl}/${archiveName}`);
const actual = createHash("sha256").update(archive).digest("hex");
if (actual !== expected) throw new Error(`Node.js Runtime 摘要校验失败：${archiveName}`);
await writeFile(archivePath, archive);
await run("tar", ["-xf", archiveName, "-C", "."], distributionRoot);
const executable = resolve(
  distributionRoot,
  directoryName,
  platform === "windows" ? "node.exe" : "bin/node",
);
await readFile(executable);
if (githubOutput) await appendFile(githubOutput, `node_executable=${executable}\n`, "utf8");
console.log(`SEASHARD_NODE_RUNTIME_READY path=${executable}`);

async function downloadBytes(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": "SeaShard-Release-Builder" },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）：${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

function run(executable, arguments_, workingDirectory) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, arguments_, {
      cwd: workingDirectory,
      stdio: "inherit",
    });
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
