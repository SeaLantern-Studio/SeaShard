import electron from "electron";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const entry = fileURLToPath(new URL("../apps/desktop/dist/main/index.js", import.meta.url));
const markers = new Set();
let output = "";

const child = spawn(electron, [entry], {
  cwd: root,
  env: {
    ...process.env,
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    SEASHARD_SMOKE: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

const timer = setTimeout(() => {
  child.kill();
}, 30_000);

timer.unref();

for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    output += chunk;
    process.stdout.write(chunk);
    if (chunk.includes("SEASHARD_SMOKE_READY")) markers.add("ready");
    if (chunk.includes("SEASHARD_SMOKE_DISPOSED activeResources=0")) markers.add("disposed");
  });
}

const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => resolve(code));
});

clearTimeout(timer);

if (exitCode !== 0 || !markers.has("ready") || !markers.has("disposed")) {
  throw new Error(`Electron smoke test failed with code ${exitCode}.\n${output}`);
}

console.log("SEASHARD_SMOKE_OK");
