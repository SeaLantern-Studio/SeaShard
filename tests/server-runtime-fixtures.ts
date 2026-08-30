import type {
  JavaInstallationSnapshot,
  ServerInstanceSnapshot,
  ServerInstanceStartupSettings,
  ServerSettingsSnapshot,
} from "../packages/contracts/src/index.ts";
import type { ServerRuntimeFileSystem } from "../components/server/runtime/src/filesystem.ts";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";

export class FakeServerProcess extends EventEmitter {
  readonly pid = 4_242;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  private closed = false;

  constructor(
    readonly stdin: Writable = new PassThrough(),
    private readonly closeAfterKill = true,
  ) {
    super();
  }

  kill(): boolean {
    this.killed = true;
    if (this.closeAfterKill) {
      queueMicrotask(() => this.finish(null, "SIGTERM"));
    }
    return true;
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.emit("exit", code, signal);
  }

  emitClose(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }

  finish(code: number | null, signal: NodeJS.Signals | null): void {
    this.emitExit(code, signal);
    this.emitClose(code, signal);
  }
}

export const vanillaInstance = {
  id: "instance-vanilla",
  name: "1.21.1-vanilla",
  rootPath: "C:/SeaShard/servers/instance-vanilla",
  coreJarPath: "C:/SeaShard/servers/instance-vanilla/server.jar",
  source: "downloaded",
  storageMode: "managed",
  modLoader: null,
  serverType: "vanilla",
  gameVersion: "1.21.1",
  coreArtifactFileName: "server.jar",
  artifactSha256: "a".repeat(64),
  createdAt: "2026-08-17T12:00:00.000Z",
  updatedAt: "2026-08-17T12:00:01.000Z",
} satisfies ServerInstanceSnapshot;

export const java17 = {
  id: "java-17",
  path: "C:/Program Files/Eclipse Adoptium/jdk-17/bin/java.exe",
  javaHome: "C:/Program Files/Eclipse Adoptium/jdk-17",
  version: "17.0.15",
  majorVersion: 17,
  vendor: "Eclipse Adoptium",
  architecture: "x64",
  is64Bit: true,
  source: "registry",
  disabled: false,
} satisfies JavaInstallationSnapshot;

export const java21 = {
  ...java17,
  id: "java-21",
  path: "C:/Program Files/Eclipse Adoptium/jdk-21/bin/java.exe",
  javaHome: "C:/Program Files/Eclipse Adoptium/jdk-21",
  version: "21.0.7",
  majorVersion: 21,
} satisfies JavaInstallationSnapshot;

export const java25 = {
  ...java21,
  id: "java-25",
  path: "C:/Program Files/Eclipse Adoptium/jdk-25/bin/java.exe",
  javaHome: "C:/Program Files/Eclipse Adoptium/jdk-25",
  version: "25.0.1",
  majorVersion: 25,
} satisfies JavaInstallationSnapshot;

export const settings = {
  resourceDownloadDirectory: "C:/SeaShard/resources",
  defaultDownloadConnections: 8,
  defaultMinimumMemoryMiB: 1_024,
  defaultMaximumMemoryMiB: 2_048,
  defaultServerPort: 25_566,
  autoAcceptEula: true,
  defaultJvmArguments: '-XX:+UseG1GC "-Dmotd=Hello World"',
} satisfies ServerSettingsSnapshot;

/** Runtime 单元测试使用的最小 Instance Manager ensure 语义。 */
export async function materializeTestStartupSettings(
  instance: ServerInstanceSnapshot,
  instanceId: string,
  startupSettings: ServerInstanceStartupSettings,
): Promise<ServerInstanceSnapshot> {
  if (instance.id !== instanceId) throw new Error(`missing test server instance ${instanceId}`);
  return instance.startupSettings ? instance : { ...instance, startupSettings };
}

export function createMemoryFileSystem(
  initialFiles: ReadonlyMap<string, string | Uint8Array>,
  hashOverrides: ReadonlyMap<string, string> = new Map(),
): {
  fileSystem: ServerRuntimeFileSystem;
  files: Map<string, string | Uint8Array>;
  accessedPaths: string[];
} {
  const files = new Map<string, string | Uint8Array>(
    [...initialFiles].map(([path, content]) => [resolve(path), content]),
  );
  const normalizedHashOverrides = new Map(
    [...hashOverrides].map(([path, hash]) => [resolve(path), hash]),
  );
  const accessedPaths: string[] = [];
  return {
    files,
    accessedPaths,
    fileSystem: {
      access: async (path) => {
        const resolvedPath = resolve(path);
        accessedPaths.push(resolvedPath);
        if (!files.has(resolvedPath)) {
          throw Object.assign(new Error(`missing ${resolvedPath}`), { code: "ENOENT" });
        }
      },
      copyFile: async (source, target) => {
        const value = files.get(resolve(source));
        if (value === undefined) {
          throw Object.assign(new Error(`missing ${resolve(source)}`), { code: "ENOENT" });
        }
        files.set(resolve(target), typeof value === "string" ? value : value.slice());
      },
      createDirectory: async () => {},
      hashFile: async (path, algorithm) => {
        const resolvedPath = resolve(path);
        const value = files.get(resolvedPath);
        if (value === undefined) {
          throw Object.assign(new Error(`missing ${resolvedPath}`), { code: "ENOENT" });
        }
        return (
          normalizedHashOverrides.get(resolvedPath) ??
          createHash(algorithm).update(value).digest("hex")
        );
      },
      readTextFile: async (path) => {
        const value = files.get(resolve(path));
        if (value === undefined) {
          throw Object.assign(new Error(`missing ${resolve(path)}`), { code: "ENOENT" });
        }
        return typeof value === "string" ? value : new TextDecoder().decode(value);
      },
      writeBinaryFile: async (path, content) => {
        files.set(resolve(path), content.slice());
      },
      writeTextFile: async (path, content) => {
        files.set(resolve(path), content);
      },
    },
  };
}
