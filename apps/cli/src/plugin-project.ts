import { inspectPackageDirectory, type InstallCandidate } from "@seashard/plugin-system";
import { Zip, ZipDeflate } from "fflate";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, open, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const seaShardVersion = "0.0.0";
const maximumArchiveSize = 32 * 1024 * 1024;
const deterministicZipTimestamp = new Date("1980-01-01T00:00:00.000Z");

export interface PluginValidationResult {
  readonly root: string;
  readonly candidate: InstallCandidate;
}

export async function validatePluginDirectory(directory: string): Promise<PluginValidationResult> {
  const root = resolve(directory);
  const candidate = await inspectPackageDirectory(root, seaShardVersion);
  return { root, candidate };
}

export async function buildPluginProject(
  directory: string,
  options: { readonly optional?: boolean } = {},
): Promise<boolean> {
  const root = resolve(directory);
  const packagePath = join(root, "package.json");
  let packageDocument: {
    readonly packageManager?: unknown;
    readonly scripts?: Readonly<Record<string, unknown>>;
  };
  try {
    packageDocument = JSON.parse(await readFile(packagePath, "utf8")) as typeof packageDocument;
  } catch (error) {
    if (options.optional && isNodeError(error, "ENOENT")) return false;
    throw new Error(`plugin project package.json could not be read: ${packagePath}`, {
      cause: error,
    });
  }
  if (typeof packageDocument.scripts?.build !== "string") {
    if (options.optional) return false;
    throw new Error(`plugin project does not declare scripts.build: ${packagePath}`);
  }

  const packageManager = await resolvePackageManager(root, packageDocument.packageManager);
  await runCommand(packageManager, packageManager === "yarn" ? ["build"] : ["run", "build"], root);
  return true;
}

/** 将已经通过 Installer 校验的目录按路径顺序写成确定性插件包。 */
export async function packPluginDirectory(directory: string): Promise<{
  readonly outputPath: string;
  readonly validation: PluginValidationResult;
}> {
  const validation = await validatePluginDirectory(directory);
  const { candidate } = validation;
  const outputPath = resolve(
    dirname(validation.root),
    `${candidate.manifest.id}-${candidate.manifest.version}.seashard-plugin`,
  );
  await writePluginArchive(candidate, outputPath);
  const archive = await stat(outputPath);
  if (archive.size > maximumArchiveSize) {
    await rm(outputPath, { force: true });
    throw new Error("plugin archive exceeds 32 MiB");
  }
  return { outputPath, validation };
}

async function writePluginArchive(candidate: InstallCandidate, outputPath: string): Promise<void> {
  const output = await open(outputPath, "wx");
  let writeTask = Promise.resolve();
  let resolveArchive!: () => void;
  let rejectArchive!: (error: Error) => void;
  const archiveCompleted = new Promise<void>((resolvePromise, reject) => {
    resolveArchive = resolvePromise;
    rejectArchive = reject;
  });
  const archive = new Zip((error, data, final) => {
    if (error) {
      rejectArchive(error);
      return;
    }
    if (data.byteLength) {
      writeTask = writeTask.then(async () => {
        await output.write(data);
      });
    }
    if (final) void writeTask.then(resolveArchive, rejectArchive);
  });
  let completed = false;

  try {
    for (const file of candidate.files) {
      const member = new ZipDeflate(file.relativePath, { level: 6 });
      member.mtime = deterministicZipTimestamp;
      archive.add(member);
      for await (const chunk of createReadStream(file.absolutePath)) {
        member.push(chunk as Buffer, false);
      }
      member.push(new Uint8Array(), true);
    }
    archive.end();
    await archiveCompleted;
    completed = true;
  } catch (error) {
    archive.terminate();
    throw error;
  } finally {
    await output.close();
    if (!completed) await rm(outputPath, { force: true });
  }
}

async function resolvePackageManager(
  root: string,
  declared: unknown,
): Promise<"pnpm" | "npm" | "yarn" | "bun"> {
  if (typeof declared === "string") {
    const name = declared.split("@", 1)[0];
    if (name === "pnpm" || name === "npm" || name === "yarn" || name === "bun") return name;
    throw new Error(`unsupported packageManager: ${declared}`);
  }
  const lockfiles = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["package-lock.json", "npm"],
  ] as const;
  for (const [file, packageManager] of lockfiles) {
    try {
      await access(join(root, file));
      return packageManager;
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }
  return "npm";
}

function runCommand(command: string, arguments_: readonly string[], cwd: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const executable = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : command;
    const childArguments =
      process.platform === "win32"
        ? ["/d", "/s", "/c", [command, ...arguments_].join(" ")]
        : arguments_;
    const child = spawn(executable, childArguments, {
      cwd,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else {
        reject(
          new Error(
            `${command} build failed (${code === null ? `signal ${signal}` : `exit ${code}`})`,
          ),
        );
      }
    });
  });
}

function isNodeError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
