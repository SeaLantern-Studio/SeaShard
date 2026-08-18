import {
  type JavaInstallationSnapshot,
  type ServerInstanceSnapshot,
  type ServerSettingsSnapshot,
} from "../packages/contracts/src/index.ts";
import {
  VanillaServerRuntimeManager,
  buildVanillaLaunchArguments,
  parseJvmArguments,
  requiredJavaMajor,
  selectJavaInstallation,
  type ServerRuntimeFileSystem,
  type SpawnServerProcess,
} from "../components/server/runtime/src/manager.ts";
import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { delimiter, dirname, resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

class FakeServerProcess extends EventEmitter {
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

const vanillaInstance = {
  id: "instance-vanilla",
  name: "1.21.1-vanilla",
  rootPath: "C:/SeaShard/servers/instance-vanilla",
  coreJarPath: "C:/SeaShard/servers/instance-vanilla/server.jar",
  storageMode: "managed",
  source: "downloaded",
  serverType: "vanilla",
  gameVersion: "1.21.1",
  coreArtifactFileName: "server.jar",
  artifactSha256: "a".repeat(64),
  createdAt: "2026-08-17T12:00:00.000Z",
  updatedAt: "2026-08-17T12:00:01.000Z",
} satisfies ServerInstanceSnapshot;

const java17 = {
  id: "java-17",
  path: "C:/Program Files/Eclipse Adoptium/jdk-17/bin/java.exe",
  javaHome: "C:/Program Files/Eclipse Adoptium/jdk-17",
  version: "17.0.15",
  majorVersion: 17,
  vendor: "Eclipse Adoptium",
  architecture: "x64",
  is64Bit: true,
  source: "registry",
} satisfies JavaInstallationSnapshot;

const java21 = {
  ...java17,
  id: "java-21",
  path: "C:/Program Files/Eclipse Adoptium/jdk-21/bin/java.exe",
  javaHome: "C:/Program Files/Eclipse Adoptium/jdk-21",
  version: "21.0.7",
  majorVersion: 21,
} satisfies JavaInstallationSnapshot;

const settings = {
  resourceDownloadDirectory: "C:/SeaShard/resources",
  defaultDownloadConnections: 8,
  defaultMinimumMemoryMiB: 1_024,
  defaultMaximumMemoryMiB: 2_048,
  defaultServerPort: 25_566,
  autoAcceptEula: true,
  defaultJvmArguments: '-XX:+UseG1GC "-Dmotd=Hello World"',
} satisfies ServerSettingsSnapshot;

function createMemoryFileSystem(initialFiles: ReadonlyMap<string, string>): {
  fileSystem: ServerRuntimeFileSystem;
  files: Map<string, string>;
  accessedPaths: string[];
} {
  const files = new Map(initialFiles);
  const accessedPaths: string[] = [];
  return {
    files,
    accessedPaths,
    fileSystem: {
      access: async (path) => {
        accessedPaths.push(path);
        if (!files.has(path)) throw Object.assign(new Error(`missing ${path}`), { code: "ENOENT" });
      },
      readTextFile: async (path) => {
        const value = files.get(path);
        if (value === undefined) {
          throw Object.assign(new Error(`missing ${path}`), { code: "ENOENT" });
        }
        return value;
      },
      writeTextFile: async (path, content) => {
        files.set(path, content);
      },
    },
  };
}

await test("vanilla runtime starts a direct JAR process and streams bidirectional console IO", async () => {
  const eulaPath = resolve(vanillaInstance.rootPath, "eula.txt");
  const propertiesPath = resolve(vanillaInstance.rootPath, "server.properties");
  const { fileSystem, files } = createMemoryFileSystem(
    new Map([
      [vanillaInstance.coreJarPath, "jar"],
      [eulaPath, "# Minecraft EULA\neula=false\neula=false\n"],
    ]),
  );
  const child = new FakeServerProcess();
  const spawnCalls: Array<{
    command: string;
    arguments_: readonly string[];
    options: Parameters<SpawnServerProcess>[2];
  }> = [];
  const spawnProcess: SpawnServerProcess = (command, arguments_, options) => {
    spawnCalls.push({ command, arguments_, options });
    queueMicrotask(() => child.emit("spawn"));
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  const emittedLines: string[] = [];
  const manager = new VanillaServerRuntimeManager({
    listInstances: async () => [vanillaInstance],
    scanJavaInstallations: async () => [java17, java21],
    readSettings: async () => settings,
    fileSystem,
    spawnProcess,
    now: () => new Date("2026-08-17T13:00:00.000Z"),
    onConsoleLine: (line) => emittedLines.push(`${line.stream}:${line.text}`),
  });

  const started = await manager.start(vanillaInstance.id);
  assert.deepEqual(started, {
    instanceId: vanillaInstance.id,
    state: "running",
    pid: 4_242,
    startedAt: "2026-08-17T13:00:00.000Z",
  });
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0]!.command, java21.path);
  assert.deepEqual(spawnCalls[0]!.arguments_, [
    "-XX:+UseG1GC",
    "-Dmotd=Hello World",
    "-Xms1024M",
    "-Xmx2048M",
    "-jar",
    "server.jar",
    "nogui",
  ]);
  assert.equal(spawnCalls[0]!.options.cwd, vanillaInstance.rootPath);
  assert.equal(spawnCalls[0]!.options.windowsHide, true);
  assert.equal(spawnCalls[0]!.options.env.JAVA_HOME, java21.javaHome);
  assert.equal(
    spawnCalls[0]!.options.env.PATH?.startsWith(`${dirname(java21.path)}${delimiter}`),
    true,
  );
  assert.equal(files.get(eulaPath), "# Minecraft EULA\neula=true\n");
  assert.equal(files.get(propertiesPath), "server-port=25566\n");

  child.stdout.write("[Server thread/INFO]: Done\r\nsecond");
  child.stdout.write(" line\n");
  child.stderr.write("warning from java\n");
  await manager.sendCommand(vanillaInstance.id, "list");
  assert.equal((child.stdin as PassThrough).read()?.toString(), "list\n");
  assert.deepEqual(
    manager
      .getLogs(vanillaInstance.id)
      .filter((line) => ["stdout", "stderr", "input"].includes(line.stream))
      .map((line) => `${line.stream}:${line.text}`),
    [
      "stdout:[Server thread/INFO]: Done",
      "stdout:second line",
      "stderr:warning from java",
      "input:> list",
    ],
  );

  const stopping = await manager.stop(vanillaInstance.id);
  assert.equal(stopping.state, "stopping");
  assert.equal((child.stdin as PassThrough).read()?.toString(), "stop\n");
  assert.equal((await manager.stop(vanillaInstance.id)).state, "stopping");
  child.emitExit(0, null);
  child.stdout.write("saved tail without newline");
  assert.equal(manager.get(vanillaInstance.id).state, "stopping");
  child.emitClose(0, null);
  assert.deepEqual(manager.get(vanillaInstance.id), {
    instanceId: vanillaInstance.id,
    state: "stopped",
    pid: 4_242,
    startedAt: "2026-08-17T13:00:00.000Z",
    stoppedAt: "2026-08-17T13:00:00.000Z",
    exitCode: 0,
  });
  const finalLogs = manager.getLogs(vanillaInstance.id);
  assert.equal(
    finalLogs.some((line) => line.text === "saved tail without newline"),
    true,
  );
  assert.equal(
    emittedLines.includes("system:[SeaShard] 原版服务器进程已启动（Java 21.0.7）。"),
    true,
  );
  await manager.dispose();
});

await test("runtime disposal sends stop, force-terminates on timeout, and waits for close", async () => {
  const eulaPath = resolve(vanillaInstance.rootPath, "eula.txt");
  const propertiesPath = resolve(vanillaInstance.rootPath, "server.properties");
  const { fileSystem } = createMemoryFileSystem(
    new Map([
      [vanillaInstance.coreJarPath, "jar"],
      [eulaPath, "eula=true\n"],
      [propertiesPath, "server-port=25566\n"],
    ]),
  );
  const child = new FakeServerProcess(new PassThrough(), false);
  const manager = new VanillaServerRuntimeManager({
    listInstances: async () => [vanillaInstance],
    scanJavaInstallations: async () => [java21],
    readSettings: async () => settings,
    fileSystem,
    spawnProcess: () => {
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as ChildProcessWithoutNullStreams;
    },
    stopGracePeriodMs: 5,
  });

  await manager.start(vanillaInstance.id);
  let disposed = false;
  const disposeTask = manager.dispose().then(() => {
    disposed = true;
  });
  await new Promise<void>((resolveWait) => setImmediate(resolveWait));
  assert.equal((child.stdin as PassThrough).read()?.toString(), "stop\n");
  assert.equal(disposed, false, "dispose must wait for the Java process to close");

  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 15));
  assert.equal(child.killed, true, "the grace-period timeout must terminate the process");
  assert.equal(disposed, false, "forced termination still must wait for close");
  child.emitExit(null, "SIGTERM");
  child.emitClose(null, "SIGTERM");
  await disposeTask;
  assert.equal(disposed, true);
  assert.equal(manager.get(vanillaInstance.id).state, "stopped");
});

await test("disposal during asynchronous preparation prevents a late process spawn", async () => {
  let releaseInstances = (_instances: readonly ServerInstanceSnapshot[]): void => {};
  const instancesReady = new Promise<readonly ServerInstanceSnapshot[]>((resolveInstances) => {
    releaseInstances = resolveInstances;
  });
  const { fileSystem, accessedPaths } = createMemoryFileSystem(new Map());
  let spawnCount = 0;
  const manager = new VanillaServerRuntimeManager({
    listInstances: () => instancesReady,
    scanJavaInstallations: async () => [java21],
    readSettings: async () => settings,
    fileSystem,
    spawnProcess: () => {
      spawnCount += 1;
      return new FakeServerProcess() as unknown as ChildProcessWithoutNullStreams;
    },
  });

  const startTask = manager.start(vanillaInstance.id);
  await manager.dispose();
  releaseInstances([vanillaInstance]);
  await assert.rejects(startTask, /server runtime is stopped/);
  assert.equal(spawnCount, 0);
  assert.deepEqual(accessedPaths, []);
});

await test("asynchronous stdin failures are handled without escaping as unhandled errors", async () => {
  class FailingStdin extends Writable {
    override _write(
      _chunk: Buffer,
      _encoding: BufferEncoding,
      callback: (error?: Error | null) => void,
    ): void {
      queueMicrotask(() => callback(Object.assign(new Error("broken pipe"), { code: "EPIPE" })));
    }
  }

  const eulaPath = resolve(vanillaInstance.rootPath, "eula.txt");
  const propertiesPath = resolve(vanillaInstance.rootPath, "server.properties");
  const { fileSystem } = createMemoryFileSystem(
    new Map([
      [vanillaInstance.coreJarPath, "jar"],
      [eulaPath, "eula=true\n"],
      [propertiesPath, "server-port=25566\n"],
    ]),
  );
  const child = new FakeServerProcess(new FailingStdin());
  const reportedErrors: unknown[] = [];
  const manager = new VanillaServerRuntimeManager({
    listInstances: async () => [vanillaInstance],
    scanJavaInstallations: async () => [java21],
    readSettings: async () => settings,
    fileSystem,
    spawnProcess: () => {
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as ChildProcessWithoutNullStreams;
    },
    reportError: (error) => reportedErrors.push(error),
  });

  await manager.start(vanillaInstance.id);
  await assert.rejects(manager.sendCommand(vanillaInstance.id, "list"), /broken pipe/);
  await new Promise<void>((resolveWait) => setImmediate(resolveWait));
  assert.equal(child.killed, true);
  assert.equal(manager.get(vanillaInstance.id).state, "failed");
  assert.equal(
    manager
      .getLogs(vanillaInstance.id)
      .some((line) => line.text.includes("服务器标准输入错误：broken pipe")),
    true,
  );
  assert.equal(
    reportedErrors.some((error) => error instanceof Error),
    true,
  );
  await manager.dispose();
});

await test("vanilla runtime rejects undeclared and non-vanilla instances without inspecting files", async () => {
  const instances: readonly ServerInstanceSnapshot[] = [
    {
      ...vanillaInstance,
      id: "instance-paper",
      serverType: "paper",
      coreJarPath: "C:/SeaShard/servers/instance-paper/server.jar",
    },
    {
      ...vanillaInstance,
      id: "instance-unknown",
      serverType: undefined,
      coreJarPath: "C:/SeaShard/servers/instance-unknown/vanilla-1.21.1.jar",
    },
  ];
  const { fileSystem, accessedPaths } = createMemoryFileSystem(new Map());
  let spawnCount = 0;
  const manager = new VanillaServerRuntimeManager({
    listInstances: async () => instances,
    scanJavaInstallations: async () => [java21],
    readSettings: async () => settings,
    fileSystem,
    spawnProcess: () => {
      spawnCount += 1;
      return new FakeServerProcess() as unknown as ChildProcessWithoutNullStreams;
    },
  });

  await assert.rejects(manager.start("instance-paper"), /explicitly marked as vanilla/);
  await assert.rejects(manager.start("instance-unknown"), /explicitly marked as vanilla/);
  assert.equal(spawnCount, 0);
  assert.deepEqual(accessedPaths, []);
  await manager.dispose();
});

await test("vanilla launch helpers select compatible Java and reject reserved JVM arguments", () => {
  assert.equal(requiredJavaMajor("1.16.5"), 8);
  assert.equal(requiredJavaMajor("1.17.1"), 16);
  assert.equal(requiredJavaMajor("1.20.4"), 17);
  assert.equal(requiredJavaMajor("1.20.5"), 21);
  assert.equal(selectJavaInstallation([java21, java17], "1.19.4").id, java17.id);
  assert.equal(selectJavaInstallation([java17, java21], "1.21.1").id, java21.id);
  assert.deepEqual(parseJvmArguments("-Dname=\"Sea Shard\" '-Dliteral=a b'"), [
    "-Dname=Sea Shard",
    "-Dliteral=a b",
  ]);
  assert.throws(
    () =>
      buildVanillaLaunchArguments(vanillaInstance, {
        ...settings,
        defaultJvmArguments: "-Xmx4G",
      }),
    /must not override/,
  );
  assert.throws(() => parseJvmArguments('"unterminated'), /unterminated quote/);
});
