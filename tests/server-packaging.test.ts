import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

await test("Homebrew Formula pins macOS and Linux Server archives by SHA-256", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "seashard-homebrew-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixtures = new Map([
    ["SeaShard-Server-1.2.3-macos-x64.tar.gz", Buffer.from("macos-x64-server")],
    ["SeaShard-Server-1.2.3-macos-arm64.tar.gz", Buffer.from("macos-arm64-server")],
    ["SeaShard-Server-1.2.3-linux-x64.tar.gz", Buffer.from("linux-x64-server")],
    ["SeaShard-Server-1.2.3-linux-arm64.tar.gz", Buffer.from("linux-arm64-server")],
  ]);
  await Promise.all([...fixtures].map(([name, contents]) => writeFile(join(root, name), contents)));
  const output = join(root, "seashard-server.rb");
  await runNode([
    "scripts/generate-homebrew-formula.mjs",
    "--version=1.2.3",
    "--repository=SeaLantern-Studio/SeaShard",
    `--assets=${root}`,
    `--output=${output}`,
  ]);
  const formula = await readFile(output, "utf8");
  assert.match(formula, /class SeashardServer < Formula/u);
  assert.match(formula, /on_macos do/u);
  assert.match(formula, /on_linux do/u);
  assert.match(formula, /on_intel do/u);
  assert.match(formula, /on_arm do/u);
  for (const contents of fixtures.values()) {
    assert.match(formula, new RegExp(createHash("sha256").update(contents).digest("hex"), "u"));
  }
  assert.match(formula, /service do/u);
});

await test("curl installer passes POSIX shell syntax validation", async () => {
  await run("sh", ["-n", "scripts/install-server.sh"]);
});

function runNode(arguments_: readonly string[]): Promise<void> {
  return run(process.execPath, arguments_);
}

function run(executable: string, arguments_: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, arguments_, {
      cwd: resolve("."),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(stderr || `${executable} exited with ${code}`));
    });
  });
}
