import {
  type JavaInstallationSnapshot,
  type ServerInstanceSnapshot,
  type ServerSettingsSnapshot,
  serverRuntimeSupportedTypes,
} from "../packages/contracts/src/index.ts";
import {
  ServerRuntimeManager,
  type ServerRuntimeFileSystem,
  type SpawnServerProcess,
} from "../components/server/runtime/src/manager.ts";
import {
  buildServerLaunchPlan,
  parseJvmArguments,
  requiredJavaMajor,
  selectJavaInstallation,
} from "../components/server/runtime/src/profiles/index.ts";
import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
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
  disabled: false,
} satisfies JavaInstallationSnapshot;

const java21 = {
  ...java17,
  id: "java-21",
  path: "C:/Program Files/Eclipse Adoptium/jdk-21/bin/java.exe",
  javaHome: "C:/Program Files/Eclipse Adoptium/jdk-21",
  version: "21.0.7",
  majorVersion: 21,
} satisfies JavaInstallationSnapshot;

const java25 = {
  ...java21,
  id: "java-25",
  path: "C:/Program Files/Eclipse Adoptium/jdk-25/bin/java.exe",
  javaHome: "C:/Program Files/Eclipse Adoptium/jdk-25",
  version: "25.0.1",
  majorVersion: 25,
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

function createMemoryFileSystem(
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
  const manager = new ServerRuntimeManager({
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
  assert.equal(spawnCalls[0]!.options.cwd, resolve(vanillaInstance.rootPath));
  assert.equal(spawnCalls[0]!.options.windowsHide, true);
  assert.equal(spawnCalls[0]!.options.env.JAVA_HOME, java21.javaHome);
  assert.equal(
    spawnCalls[0]!.options.env.PATH?.startsWith(`${dirname(java21.path)}${delimiter}`),
    true,
  );
  const javaToolOptions = spawnCalls[0]!.options.env.JAVA_TOOL_OPTIONS ?? "";
  assert.equal(
    javaToolOptions.endsWith(
      "-Dfile.encoding=UTF-8 -Dsun.stdout.encoding=UTF-8 -Dsun.stderr.encoding=UTF-8",
    ),
    true,
  );
  assert.equal(files.get(eulaPath), "# Minecraft EULA\neula=true\n");
  assert.equal(files.get(propertiesPath), "server-port=25566\n");

  child.stdout.write("[Server thread/INFO]: Done\r\nsecond");
  child.stdout.write(" line\n");
  child.stdout.write(Buffer.from("c3fcc1eeb2bbb4e6d4da0a", "hex"));
  child.stdout.write("\u001b]0;Nukkit MOT\u0007");
  child.stdout.write("22:38:12 [main] [INFO] Ready\u001b[0m\n");
  child.stdout.write("Picked up JAVA_TOOL_OPTIONS: -Dfile.encoding=UTF-8\n");
  child.stderr.write("0% [        ]\r50% [====    ]\r100% [========]\n");
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
      "stdout:命令不存在",
      "stdout:22:38:12 [main] [INFO] Ready",
      "stderr:100% [========]",
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
    emittedLines.includes("system:[SeaShard] Vanilla 服务器进程已启动（Java 21.0.7）。"),
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
  const manager = new ServerRuntimeManager({
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
  const manager = new ServerRuntimeManager({
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
  const manager = new ServerRuntimeManager({
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

await test("runtime rejects undeclared core types without inspecting files", async () => {
  const unknownInstance: ServerInstanceSnapshot = {
    ...vanillaInstance,
    id: "instance-unknown",
    rootPath: "C:/SeaShard/servers/instance-unknown",
    serverType: undefined,
    coreJarPath: "C:/SeaShard/servers/instance-unknown/unknown.jar",
  };
  const { fileSystem, accessedPaths } = createMemoryFileSystem(new Map());
  let spawnCount = 0;
  const manager = new ServerRuntimeManager({
    listInstances: async () => [unknownInstance],
    scanJavaInstallations: async () => [java21],
    readSettings: async () => settings,
    fileSystem,
    spawnProcess: () => {
      spawnCount += 1;
      return new FakeServerProcess() as unknown as ChildProcessWithoutNullStreams;
    },
  });

  await assert.rejects(manager.start("instance-unknown"), /core type <missing> is not supported/);
  assert.equal(spawnCount, 0);
  assert.deepEqual(accessedPaths, []);
  await manager.dispose();
});

await test("launch helpers select compatible Java and reject reserved JVM arguments", () => {
  assert.equal(requiredJavaMajor("1.16.5"), 8);
  assert.equal(requiredJavaMajor("1.17.1"), 16);
  assert.equal(requiredJavaMajor("1.20.4"), 17);
  assert.equal(requiredJavaMajor("1.20.5"), 21);
  assert.equal(requiredJavaMajor("26.1.2"), 25);
  assert.equal(
    selectJavaInstallation([java21, java17], {
      major: 17,
      exact: false,
      description: "fixture",
    }).id,
    java17.id,
  );
  assert.equal(
    selectJavaInstallation([java17, java21], {
      major: 21,
      exact: true,
      description: "fixture",
    }).id,
    java21.id,
  );
  assert.equal(
    selectJavaInstallation([{ ...java17, disabled: true }, java21], {
      major: 17,
      exact: false,
      description: "fixture",
    }).id,
    java21.id,
  );
  assert.throws(
    () =>
      selectJavaInstallation([{ ...java25, disabled: true }], {
        major: 25,
        exact: true,
        description: "NeoForge 26.1",
      }),
    /未检测到已启用的 Java 25。NeoForge 26\.1 必须使用 Java 25/,
  );
  assert.deepEqual(parseJvmArguments("-Dname=\"Sea Shard\" '-Dliteral=a b'"), [
    "-Dname=Sea Shard",
    "-Dliteral=a b",
  ]);
  assert.throws(
    () =>
      buildServerLaunchPlan(vanillaInstance, {
        ...settings,
        defaultJvmArguments: "-Xmx4G",
      }),
    /must not override/,
  );
  assert.throws(() => parseJvmArguments('"unterminated'), /unterminated quote/);
});

await test("all supported direct and self-bootstrap cores retain the verified runtime target", () => {
  const cases = [
    {
      serverType: "paper",
      gameVersion: "1.21.11-rc3",
      artifact: "paper-1.21.11-rc3-31.jar",
      javaMajor: 21,
      programArguments: ["--nogui"],
      stopCommand: "stop",
    },
    {
      serverType: "purpur",
      gameVersion: "1.21.11",
      artifact: "purpur-1.21.11-2563.jar",
      javaMajor: 21,
      programArguments: ["--nogui"],
      stopCommand: "stop",
    },
    {
      serverType: "folia",
      gameVersion: "1.21.11",
      artifact: "folia-1.21.11-14.jar",
      javaMajor: 21,
      programArguments: ["--nogui"],
      stopCommand: "stop",
    },
    {
      serverType: "fabric",
      gameVersion: "1.21.11",
      artifact: "fabric-1.21.11.jar",
      javaMajor: 21,
      programArguments: ["nogui"],
      stopCommand: "stop",
    },
    {
      serverType: "arclight-neoforge",
      gameVersion: "1.21.1",
      artifact: "arclight-neoforge-1.21.1-1.0.2-SNAPSHOT-9c004d4.jar",
      javaMajor: 21,
      programArguments: ["nogui"],
      stopCommand: "stop",
    },
    {
      serverType: "velocity",
      gameVersion: "3.5.0-SNAPSHOT",
      artifact: "velocity-3.5.0-SNAPSHOT-576.jar",
      javaMajor: 21,
      programArguments: [],
      stopCommand: "end",
    },
    {
      serverType: "nukkitx",
      gameVersion: "Nukkit-Mot",
      artifact: "Nukkit-MOT-SNAPSHOT.jar",
      javaMajor: 17,
      programArguments: [],
      stopCommand: "stop",
    },
  ] as const;

  for (const fixture of cases) {
    const rootPath = `C:/SeaShard/servers/instance-${fixture.serverType}`;
    const instance: ServerInstanceSnapshot = {
      ...vanillaInstance,
      id: `instance-${fixture.serverType}`,
      name: fixture.serverType,
      rootPath,
      coreJarPath: `${rootPath}/${fixture.artifact}`,
      serverType: fixture.serverType,
      gameVersion: fixture.gameVersion,
      coreArtifactFileName: fixture.artifact,
    };
    const plan = buildServerLaunchPlan(instance, settings, "win32");
    assert.equal(plan.serverType, fixture.serverType);
    assert.equal(plan.java.major, fixture.javaMajor);
    assert.equal(plan.workingDirectory, resolve(rootPath));
    assert.equal(plan.stopCommand, fixture.stopCommand);
    assert.deepEqual(plan.arguments, [
      "-XX:+UseG1GC",
      "-Dmotd=Hello World",
      "-Xms1024M",
      "-Xmx2048M",
      "-jar",
      fixture.artifact,
      ...fixture.programArguments,
    ]);
  }
  assert.deepEqual(serverRuntimeSupportedTypes, [
    "vanilla",
    "paper",
    "purpur",
    "folia",
    "fabric",
    "quilt",
    "neoforge",
    "arclight-neoforge",
    "mohist",
    "velocity",
    "nukkitx",
    "arclight-fabric",
    "arclight-forge",
    "banner",
    "bukkit",
    "bungeecord",
    "catserver",
    "leaf",
    "leaves",
    "lightfall",
    "pufferfish",
    "pufferfish_purpur",
    "spigot",
    "spongeforge",
    "spongevanilla",
    "travertine",
    "vanilla-snapshot",
    "youer",
  ]);
});

await test("second-batch profiles preserve per-type launch and stop contracts", () => {
  const cases = [
    {
      serverType: "arclight-fabric",
      gameVersion: "1.21.1",
      artifact: "arclight-fabric-1.21.1.jar",
      javaMajor: 21,
      jvmArguments: [],
      programArguments: ["nogui"],
      eula: "minecraft",
      writesServerProperties: true,
      stopCommand: "stop",
    },
    {
      serverType: "arclight-forge",
      gameVersion: "1.21.1",
      artifact: "arclight-forge-1.21.1.jar",
      javaMajor: 21,
      jvmArguments: [],
      programArguments: ["nogui"],
      eula: "minecraft",
      writesServerProperties: true,
      stopCommand: "stop",
    },
    {
      serverType: "banner",
      gameVersion: "1.21.1",
      artifact: "banner-1.21.1.jar",
      javaMajor: 21,
      jvmArguments: [],
      programArguments: ["nogui"],
      eula: "interactive-minecraft",
      writesServerProperties: true,
      stopCommand: "stop",
    },
    {
      serverType: "bukkit",
      gameVersion: "1.21.11",
      artifact: "craftbukkit-1.21.11.jar",
      javaMajor: 21,
      jvmArguments: [],
      programArguments: ["--nogui"],
      eula: "minecraft",
      writesServerProperties: true,
      stopCommand: "stop",
    },
    {
      serverType: "bungeecord",
      gameVersion: "latest",
      artifact: "BungeeCord.jar",
      javaMajor: 8,
      jvmArguments: [],
      programArguments: [],
      eula: "none",
      writesServerProperties: false,
      stopCommand: "end",
    },
    {
      serverType: "catserver",
      gameVersion: "1.18.2",
      artifact: "CatServer-1.18.2.jar",
      javaMajor: 17,
      jvmArguments: [
        "--add-exports=java.base/sun.security.util=ALL-UNNAMED",
        "--add-opens=java.base/java.util.jar=ALL-UNNAMED",
        "--add-opens=java.base/java.lang=ALL-UNNAMED",
      ],
      programArguments: [],
      eula: "minecraft",
      writesServerProperties: true,
      stopCommand: "stop",
    },
    {
      serverType: "leaf",
      gameVersion: "1.21.11",
      artifact: "leaf-1.21.11.jar",
      javaMajor: 21,
      jvmArguments: [],
      programArguments: ["--nogui"],
      eula: "minecraft",
      writesServerProperties: true,
      stopCommand: "stop",
    },
    {
      serverType: "leaves",
      gameVersion: "1.21.10",
      artifact: "leaves-1.21.10.jar",
      javaMajor: 21,
      jvmArguments: ["-Dleavesclip.disable.auto-update=true"],
      programArguments: ["--nogui"],
      eula: "minecraft",
      writesServerProperties: true,
      stopCommand: "stop",
    },
    {
      serverType: "lightfall",
      gameVersion: "1.20",
      artifact: "lightfall.jar",
      javaMajor: 8,
      jvmArguments: [],
      programArguments: [],
      eula: "none",
      writesServerProperties: false,
      stopCommand: "end",
    },
    {
      serverType: "pufferfish",
      gameVersion: "1.21.10",
      artifact: "pufferfish-1.21.10.jar",
      javaMajor: 21,
      jvmArguments: [],
      programArguments: ["--nogui"],
      eula: "minecraft",
      writesServerProperties: true,
      stopCommand: "stop",
    },
  ] as const;

  const buildInstance = (
    fixture: {
      readonly serverType: string;
      readonly gameVersion: string;
      readonly artifact: string;
    },
    rootPath = `C:/SeaShard/servers/instance-${fixture.serverType}`,
  ): ServerInstanceSnapshot => ({
    ...vanillaInstance,
    id: `instance-${fixture.serverType}`,
    name: fixture.serverType,
    rootPath,
    coreJarPath: `${rootPath}/${fixture.artifact}`,
    serverType: fixture.serverType,
    gameVersion: fixture.gameVersion,
    coreArtifactFileName: fixture.artifact,
    artifactSha256: "f".repeat(64),
  });

  for (const fixture of cases) {
    const instance = buildInstance(fixture);
    const plan = buildServerLaunchPlan(instance, settings, "win32");
    assert.equal(plan.serverType, fixture.serverType);
    assert.equal(plan.java.major, fixture.javaMajor);
    assert.equal(plan.java.maximumMajor, undefined);
    assert.equal(plan.workingDirectory, resolve(instance.rootPath));
    assert.equal(plan.eula, fixture.eula);
    assert.equal(plan.writesServerProperties, fixture.writesServerProperties);
    assert.equal(plan.stopCommand, fixture.stopCommand);
    assert.deepEqual(plan.requiredRuntimeFiles, [resolve(instance.coreJarPath)]);
    assert.equal(plan.preparation, undefined);
    assert.deepEqual(plan.arguments, [
      "-XX:+UseG1GC",
      "-Dmotd=Hello World",
      "-Xms1024M",
      "-Xmx2048M",
      ...fixture.jvmArguments,
      "-jar",
      fixture.artifact,
      ...fixture.programArguments,
    ]);
  }

  const historicalCases = [
    {
      serverType: "arclight-fabric",
      gameVersion: "1.20.4",
      artifact: "arclight-fabric-1.20.4.jar",
      javaMajor: 17,
      jvmArguments: [],
      programArguments: ["nogui"],
    },
    {
      serverType: "arclight-forge",
      gameVersion: "1.16.5",
      artifact: "arclight-forge-1.16.5.jar",
      javaMajor: 8,
      jvmArguments: [],
      programArguments: ["nogui"],
    },
    {
      serverType: "banner",
      gameVersion: "1.19.4",
      artifact: "banner-1.19.4.jar",
      javaMajor: 17,
      jvmArguments: [],
      programArguments: ["nogui"],
    },
    {
      serverType: "bukkit",
      gameVersion: "1.8.8",
      artifact: "craftbukkit-1.8.8.jar",
      javaMajor: 8,
      jvmArguments: [],
      programArguments: ["--nogui"],
    },
    {
      serverType: "catserver",
      gameVersion: "1.12.2",
      artifact: "CatServer-1.12.2.jar",
      javaMajor: 8,
      jvmArguments: [],
      programArguments: [],
    },
    {
      serverType: "leaf",
      gameVersion: "1.21.4",
      artifact: "leaf-1.21.4.jar",
      javaMajor: 21,
      jvmArguments: [],
      programArguments: ["--nogui"],
    },
    {
      serverType: "leaves",
      gameVersion: "1.19.4",
      artifact: "leaves-1.19.4.jar",
      javaMajor: 17,
      jvmArguments: ["-Dleavesclip.disable.auto-update=true"],
      programArguments: ["--nogui"],
    },
    {
      serverType: "lightfall",
      gameVersion: "1.18",
      artifact: "lightfall.jar",
      javaMajor: 8,
      jvmArguments: [],
      programArguments: [],
    },
    {
      serverType: "pufferfish",
      gameVersion: "1.17.1",
      artifact: "pufferfish-1.17.1.jar",
      javaMajor: 16,
      jvmArguments: [],
      programArguments: ["--nogui"],
    },
  ] as const;

  for (const fixture of historicalCases) {
    const plan = buildServerLaunchPlan(buildInstance(fixture), settings, "win32");
    assert.equal(plan.java.major, fixture.javaMajor);
    assert.equal(plan.java.maximumMajor, undefined);
    assert.deepEqual(plan.arguments, [
      "-XX:+UseG1GC",
      "-Dmotd=Hello World",
      "-Xms1024M",
      "-Xmx2048M",
      ...fixture.jvmArguments,
      "-jar",
      fixture.artifact,
      ...fixture.programArguments,
    ]);
  }

  for (const [serverType, character] of [
    ["leaf", "!"],
    ["leaves", "+"],
    ["bukkit", "!"],
    ["pufferfish", "+"],
    ["lightfall", "!"],
  ] as const) {
    const fixture = cases.find((candidate) => candidate.serverType === serverType);
    assert.ok(fixture);
    assert.throws(
      () =>
        buildServerLaunchPlan(
          buildInstance(fixture, `C:/SeaShard/servers/${serverType}${character}invalid`),
          settings,
          "win32",
        ),
      /cannot run from a working directory containing/,
    );
  }

  const bukkit = cases.find((fixture) => fixture.serverType === "bukkit");
  assert.ok(bukkit);
  const bukkitPlan = buildServerLaunchPlan(buildInstance(bukkit), settings, "win32");
  const java26 = {
    ...java25,
    id: "java-26",
    path: "C:/Program Files/Eclipse Adoptium/jdk-26/bin/java.exe",
    javaHome: "C:/Program Files/Eclipse Adoptium/jdk-26",
    version: "26.0.0",
    majorVersion: 26,
  } satisfies JavaInstallationSnapshot;
  assert.equal(selectJavaInstallation([java26, java25], bukkitPlan.java).id, java25.id);
  assert.equal(selectJavaInstallation([java26], bukkitPlan.java).id, java26.id);
});

await test("final-batch profiles reuse one strategy across versions and artifact identities", () => {
  const cases = [
    {
      serverType: "pufferfish_purpur",
      gameVersion: "1.18.2",
      artifact: "pufferfish-purpur-history.jar",
      javaMajor: 17,
      exactJava: true,
      programArguments: ["nogui"],
      eula: "minecraft",
      writesServerProperties: true,
      stopCommand: "stop",
    },
    {
      serverType: "spigot",
      gameVersion: "1.20.4",
      artifact: "spigot-history.jar",
      javaMajor: 17,
      exactJava: false,
      programArguments: ["--nogui"],
      eula: "minecraft",
      writesServerProperties: true,
      stopCommand: "stop",
    },
    {
      serverType: "spongevanilla",
      gameVersion: "1.20.4",
      artifact: "spongevanilla-history.jar",
      javaMajor: 17,
      exactJava: true,
      programArguments: [],
      eula: "minecraft",
      writesServerProperties: true,
      stopCommand: "stop",
    },
    {
      serverType: "travertine",
      gameVersion: "1.12",
      artifact: "travertine-history.jar",
      javaMajor: 8,
      exactJava: false,
      programArguments: [],
      eula: "none",
      writesServerProperties: false,
      stopCommand: "end",
    },
    {
      serverType: "vanilla-snapshot",
      gameVersion: "1.20.4-snapshot",
      artifact: "snapshot-history.jar",
      javaMajor: 17,
      exactJava: false,
      programArguments: ["nogui"],
      eula: "minecraft",
      writesServerProperties: true,
      stopCommand: "stop",
    },
  ] as const;

  for (const fixture of cases) {
    const rootPath = `C:/SeaShard/servers/instance-${fixture.serverType}`;
    const instance: ServerInstanceSnapshot = {
      ...vanillaInstance,
      id: `instance-${fixture.serverType}`,
      name: fixture.serverType,
      rootPath,
      coreJarPath: `${rootPath}/${fixture.artifact}`,
      serverType: fixture.serverType,
      gameVersion: fixture.gameVersion,
      coreArtifactFileName: "catalog-name-does-not-control-the-profile.jar",
      artifactSha256: "0".repeat(64),
    };
    const plan = buildServerLaunchPlan(instance, settings, "win32");
    assert.equal(plan.java.major, fixture.javaMajor);
    assert.equal(plan.java.exact, fixture.exactJava);
    assert.equal(plan.java.maximumMajor, undefined);
    assert.equal(plan.eula, fixture.eula);
    assert.equal(plan.writesServerProperties, fixture.writesServerProperties);
    assert.equal(plan.stopCommand, fixture.stopCommand);
    assert.deepEqual(plan.arguments, [
      "-XX:+UseG1GC",
      "-Dmotd=Hello World",
      "-Xms1024M",
      "-Xmx2048M",
      "-jar",
      fixture.artifact,
      ...fixture.programArguments,
    ]);

    const alternateIdentity = buildServerLaunchPlan(
      {
        ...instance,
        coreArtifactFileName: "another-catalog-name.jar",
        artifactSha256: undefined,
      },
      settings,
      "win32",
    );
    assert.deepEqual(alternateIdentity.arguments, plan.arguments);
  }

  const vanilla26 = buildServerLaunchPlan(
    {
      ...vanillaInstance,
      gameVersion: "26.1.2",
    },
    settings,
    "win32",
  );
  assert.deepEqual(vanilla26.java, {
    major: 25,
    exact: false,
    description: "Vanilla",
  });

  const youerRoot = "C:/SeaShard/servers/instance-youer-history";
  const youer = buildServerLaunchPlan(
    {
      ...vanillaInstance,
      id: "instance-youer-history",
      name: "Youer history",
      rootPath: youerRoot,
      coreJarPath: `${youerRoot}/youer-history.jar`,
      serverType: "youer",
      gameVersion: "1.20.2",
      coreArtifactFileName: "youer-unlisted-build.jar",
      artifactSha256: undefined,
    },
    settings,
    "win32",
  );
  assert.deepEqual(youer.java, {
    major: 17,
    exact: false,
    description: "Youer 1.20.2",
  });
  assert.deepEqual(youer.preparation?.arguments, [
    "-Xms256M",
    "-Xmx1024M",
    "-jar",
    "youer-history.jar",
    "nogui",
  ]);
  assert.ok(
    youer.preparation?.sentinels.includes(
      resolve(youerRoot, "libraries", "net", "minecraft", "server", "1.20.2", "server-1.20.2.jar"),
    ),
  );
  assert.equal(youer.preparation?.acceptNonZeroWithSentinels, true);
  assert.deepEqual(youer.arguments.slice(-3), ["-jar", "youer-history.jar", "nogui"]);
});

await test("Banner submits interactive EULA only when automatic acceptance is enabled", async () => {
  async function exerciseBanner(autoAcceptEula: boolean): Promise<{
    initialInput: string | undefined;
    stopInput: string | undefined;
    files: Map<string, string | Uint8Array>;
  }> {
    const rootPath = `C:/SeaShard/servers/banner-${autoAcceptEula ? "auto" : "manual"}`;
    const instance: ServerInstanceSnapshot = {
      ...vanillaInstance,
      id: `instance-banner-${autoAcceptEula ? "auto" : "manual"}`,
      name: "Banner",
      rootPath,
      coreJarPath: `${rootPath}/banner.jar`,
      serverType: "banner",
      gameVersion: "1.21.1",
      coreArtifactFileName: "banner-1.21.1-170.jar",
      artifactSha256: "6d5ca32ecb1b79713dda0ad5bc5eb69ad3418a6f5d60c81f63e060c4e1345ec5",
    };
    const { fileSystem, files } = createMemoryFileSystem(
      new Map([[instance.coreJarPath, "banner"]]),
    );
    const child = new FakeServerProcess();
    const manager = new ServerRuntimeManager({
      listInstances: async () => [instance],
      scanJavaInstallations: async () => [java17, java21],
      readSettings: async () => ({ ...settings, autoAcceptEula }),
      fileSystem,
      spawnProcess: () => {
        queueMicrotask(() => child.emit("spawn"));
        return child as unknown as ChildProcessWithoutNullStreams;
      },
    });

    await manager.start(instance.id);
    const initialInput = (child.stdin as PassThrough).read()?.toString();
    await manager.stop(instance.id);
    const stopInput = (child.stdin as PassThrough).read()?.toString();
    child.finish(0, null);
    await manager.dispose();
    return { initialInput, stopInput, files };
  }

  const automatic = await exerciseBanner(true);
  assert.equal(automatic.initialInput, "true\n");
  assert.equal(automatic.stopInput, "stop\n");
  assert.equal(automatic.files.has(resolve("C:/SeaShard/servers/banner-auto", "eula.txt")), false);
  assert.equal(
    automatic.files.get(resolve("C:/SeaShard/servers/banner-auto", "server.properties")),
    "server-port=25566\n",
  );

  const manual = await exerciseBanner(false);
  assert.equal(manual.initialInput, undefined);
  assert.equal(manual.stopInput, "stop\n");
  assert.equal(manual.files.has(resolve("C:/SeaShard/servers/banner-manual", "eula.txt")), false);
});

await test("Quilt, NeoForge, and Mohist plans preserve their installer handoff contracts", () => {
  const quiltRoot = "C:/SeaShard/servers/instance-quilt";
  const quilt = buildServerLaunchPlan(
    {
      ...vanillaInstance,
      id: "instance-quilt",
      name: "Quilt",
      rootPath: quiltRoot,
      coreJarPath: `${quiltRoot}/quilt-latest.jar`,
      serverType: "quilt",
      gameVersion: "latest",
      coreArtifactFileName: "quilt-latest.jar",
      artifactSha256: "8b716edc692a2fa1fb78dbc2f432643be1bc6c867e5605f36f691f44257120ca",
    },
    settings,
    "win32",
  );
  assert.deepEqual(quilt.preparation?.arguments, [
    "-jar",
    "quilt-latest.jar",
    "install",
    "server",
    "1.21.11",
    "--download-server",
    "--install-dir=server",
  ]);
  assert.equal(quilt.workingDirectory, resolve(quiltRoot, "server"));
  assert.deepEqual(quilt.arguments, [
    "-XX:+UseG1GC",
    "-Dmotd=Hello World",
    "-Xms1024M",
    "-Xmx2048M",
    "-jar",
    "quilt-server-launch.jar",
    "nogui",
  ]);
  const historicalQuilt = buildServerLaunchPlan(
    {
      ...vanillaInstance,
      id: "instance-quilt-history",
      name: "Quilt history",
      rootPath: quiltRoot,
      coreJarPath: `${quiltRoot}/quilt-history.jar`,
      serverType: "quilt",
      gameVersion: "1.20.4",
      coreArtifactFileName: "quilt-unlisted-installer.jar",
      artifactSha256: undefined,
    },
    settings,
    "win32",
  );
  assert.deepEqual(historicalQuilt.preparation?.arguments, [
    "-jar",
    "quilt-history.jar",
    "install",
    "server",
    "1.20.4",
    "--download-server",
    "--install-dir=server",
  ]);

  const neoForgeRoot = "C:/SeaShard/servers/instance-neoforge";
  const neoForgeArtifact = "neoforge-26.1.0.0-alpha.1+snapshot-1-installer.jar";
  const neoForge = buildServerLaunchPlan(
    {
      ...vanillaInstance,
      id: "instance-neoforge",
      name: "NeoForge",
      rootPath: neoForgeRoot,
      coreJarPath: `${neoForgeRoot}/server.jar`,
      serverType: "neoforge",
      gameVersion: "26.1",
      coreArtifactFileName: neoForgeArtifact,
    },
    settings,
    "win32",
  );
  assert.deepEqual(neoForge.java, {
    major: 25,
    exact: true,
    description: "NeoForge 26.1",
  });
  assert.deepEqual(neoForge.preparation?.arguments, ["-jar", "server.jar", "--installServer", "."]);
  assert.deepEqual(neoForge.arguments, [
    "@user_jvm_args.txt",
    "@libraries\\net\\neoforged\\neoforge\\26.1.0.0-alpha.1+snapshot-1\\win_args.txt",
    "nogui",
  ]);
  assert.deepEqual(neoForge.jvmArgumentFile?.managedArguments, [
    "-XX:+UseG1GC",
    "-Dmotd=Hello World",
    "-Xms1024M",
    "-Xmx2048M",
  ]);
  const historicalNeoForge = buildServerLaunchPlan(
    {
      ...vanillaInstance,
      id: "instance-neoforge-history",
      name: "NeoForge history",
      rootPath: neoForgeRoot,
      coreJarPath: `${neoForgeRoot}/history-installer.jar`,
      serverType: "neoforge",
      gameVersion: "1.21.1",
      coreArtifactFileName: "neoforge-21.1.219-installer.jar",
      artifactSha256: undefined,
    },
    settings,
    "win32",
  );
  assert.deepEqual(historicalNeoForge.java, {
    major: 21,
    exact: true,
    description: "NeoForge 1.21.1",
  });
  assert.deepEqual(historicalNeoForge.arguments, [
    "@user_jvm_args.txt",
    "@libraries\\net\\neoforged\\neoforge\\21.1.219\\win_args.txt",
    "nogui",
  ]);

  const mohistRoot = "C:/SeaShard/servers/instance-mohist";
  const mohist = buildServerLaunchPlan(
    {
      ...vanillaInstance,
      id: "instance-mohist",
      name: "Mohist",
      rootPath: mohistRoot,
      coreJarPath: `${mohistRoot}/mohist-1.20.2-173.jar`,
      serverType: "mohist",
      gameVersion: "1.20.2",
      coreArtifactFileName: "mohist-1.20.2-173.jar",
    },
    settings,
    "win32",
  );
  assert.equal(mohist.preparation?.acceptNonZeroWithSentinels, true);
  assert.deepEqual(mohist.preparation?.arguments, [
    "-Xms256M",
    "-Xmx1024M",
    "-jar",
    "mohist-1.20.2-173.jar",
    "nogui",
  ]);
  assert.deepEqual(mohist.arguments.slice(-3), ["-jar", "mohist-1.20.2-173.jar", "nogui"]);
  const historicalMohist = buildServerLaunchPlan(
    {
      ...vanillaInstance,
      id: "instance-mohist-history",
      name: "Mohist history",
      rootPath: mohistRoot,
      coreJarPath: `${mohistRoot}/mohist-history.jar`,
      serverType: "mohist",
      gameVersion: "1.19.4",
      coreArtifactFileName: "mohist-unlisted-build.jar",
      artifactSha256: undefined,
    },
    settings,
    "win32",
  );
  assert.equal(historicalMohist.java.major, 17);
  assert.deepEqual(historicalMohist.arguments.slice(-3), ["-jar", "mohist-history.jar", "nogui"]);
});

await test("Quilt installer runs once and hands off to the generated launcher directory", async () => {
  const rootPath = "C:/SeaShard/servers/instance-quilt-runtime";
  const instance: ServerInstanceSnapshot = {
    ...vanillaInstance,
    id: "instance-quilt-runtime",
    name: "Quilt",
    rootPath,
    coreJarPath: `${rootPath}/quilt-latest.jar`,
    serverType: "quilt",
    gameVersion: "latest",
    coreArtifactFileName: "quilt-latest.jar",
    artifactSha256: "8b716edc692a2fa1fb78dbc2f432643be1bc6c867e5605f36f691f44257120ca",
  };
  const plan = buildServerLaunchPlan(instance, settings, "win32");
  const { fileSystem, files } = createMemoryFileSystem(
    new Map([[instance.coreJarPath, "installer"]]),
  );
  const children: FakeServerProcess[] = [];
  const spawnCalls: Array<{
    command: string;
    arguments_: readonly string[];
    options: Parameters<SpawnServerProcess>[2];
  }> = [];
  const manager = new ServerRuntimeManager({
    listInstances: async () => [instance],
    scanJavaInstallations: async () => [java21],
    readSettings: async () => settings,
    fileSystem,
    spawnProcess: (command, arguments_, options) => {
      const child = new FakeServerProcess();
      const index = children.push(child) - 1;
      spawnCalls.push({ command, arguments_, options });
      queueMicrotask(() => child.emit("spawn"));
      if (index === 0) {
        setImmediate(() => {
          for (const sentinel of plan.preparation!.sentinels) files.set(sentinel, "installed");
          child.finish(0, null);
        });
      }
      return child as unknown as ChildProcessWithoutNullStreams;
    },
  });

  await manager.start(instance.id);
  assert.equal(spawnCalls.length, 2);
  assert.deepEqual(spawnCalls[0]!.arguments_, plan.preparation!.arguments);
  assert.equal(spawnCalls[0]!.options.cwd, resolve(rootPath));
  assert.deepEqual(spawnCalls[1]!.arguments_, plan.arguments);
  assert.equal(spawnCalls[1]!.options.cwd, resolve(rootPath, "server"));
  assert.equal(files.get(resolve(rootPath, "server", "eula.txt")), "eula=true\n");
  assert.equal(files.get(resolve(rootPath, "server", "server.properties")), "server-port=25566\n");

  await manager.stop(instance.id);
  assert.equal((children[1]!.stdin as PassThrough).read()?.toString(), "stop\n");
  children[1]!.finish(0, null);
  await manager.dispose();
});

await test("NeoForge installs with Java 25 and stores heap settings in user_jvm_args.txt", async () => {
  const rootPath = "C:/SeaShard/servers/instance-neoforge-runtime";
  const artifactName = "neoforge-26.1.0.0-alpha.1+snapshot-1-installer.jar";
  const instance: ServerInstanceSnapshot = {
    ...vanillaInstance,
    id: "instance-neoforge-runtime",
    name: "NeoForge",
    rootPath,
    coreJarPath: `${rootPath}/server.jar`,
    serverType: "neoforge",
    gameVersion: "26.1",
    coreArtifactFileName: artifactName,
  };
  const plan = buildServerLaunchPlan(instance, settings, "win32");
  const classPathEntry = resolve(rootPath, "libraries", "fixture.jar");
  const { fileSystem, files } = createMemoryFileSystem(
    new Map([[instance.coreJarPath, "installer"]]),
  );
  const children: FakeServerProcess[] = [];
  const spawnCalls: Array<{
    command: string;
    arguments_: readonly string[];
    options: Parameters<SpawnServerProcess>[2];
  }> = [];
  const manager = new ServerRuntimeManager({
    listInstances: async () => [instance],
    scanJavaInstallations: async () => [java21, java25],
    readSettings: async () => settings,
    fileSystem,
    spawnProcess: (command, arguments_, options) => {
      const child = new FakeServerProcess();
      const index = children.push(child) - 1;
      spawnCalls.push({ command, arguments_, options });
      queueMicrotask(() => child.emit("spawn"));
      if (index === 0) {
        setImmediate(() => {
          for (const sentinel of plan.preparation!.sentinels) files.set(sentinel, "installed");
          files.set(plan.jvmArgumentFile!.path, "# generated by NeoForge\n# -Xmx4G\n");
          files.set(
            plan.preparation!.runtimeArgumentFile!,
            "-classpath\nlibraries/fixture.jar\nnet.neoforged.fml.startup.Server\n",
          );
          files.set(classPathEntry, "library");
          child.finish(0, null);
        });
      }
      return child as unknown as ChildProcessWithoutNullStreams;
    },
  });

  await manager.start(instance.id);
  assert.equal(spawnCalls.length, 2);
  assert.equal(spawnCalls[0]!.command, java25.path);
  assert.deepEqual(spawnCalls[0]!.arguments_, plan.preparation!.arguments);
  assert.equal(spawnCalls[1]!.command, java25.path);
  assert.deepEqual(spawnCalls[1]!.arguments_, plan.arguments);
  assert.equal(
    files.get(plan.jvmArgumentFile!.path),
    [
      "# generated by NeoForge",
      "# -Xmx4G",
      "",
      "# >>> SeaShard managed JVM arguments",
      "-XX:+UseG1GC",
      '"-Dmotd=Hello World"',
      "-Xms1024M",
      "-Xmx2048M",
      "# <<< SeaShard managed JVM arguments",
      "",
    ].join("\n"),
  );

  await manager.stop(instance.id);
  assert.equal((children[1]!.stdin as PassThrough).read()?.toString(), "stop\n");
  children[1]!.finish(0, null);
  await manager.dispose();
});

await test("SpongeForge installs standard Forge, copies the Universal mod, and reuses the runtime", async () => {
  const rootPath = "C:/SeaShard/servers/instance-spongeforge-runtime";
  const artifactName = "spongeforge-26.1.2-64.0.1_19.0.0_RC2627-universal.jar";
  const spongeSha256 = "83320019c99e7d2044f7884677b2e007ef988257633126ae952f2598c0de44df";
  const forgeInstallerSha256 = "c89c563de2e0b8d45c6651de580e2b65b569c52becdb0eeedfd1ab89e60b158d";
  const instance: ServerInstanceSnapshot = {
    ...vanillaInstance,
    id: "instance-spongeforge-runtime",
    name: "SpongeForge",
    rootPath,
    coreJarPath: `${rootPath}/${artifactName}`,
    serverType: "spongeforge",
    gameVersion: "26.1.2",
    coreArtifactFileName: artifactName,
    artifactSha256: spongeSha256,
  };
  const plan = buildServerLaunchPlan(instance, settings, "win32");
  const download = plan.preparation!.downloads![0]!;
  const copy = plan.preparation!.copies![0]!;
  assert.deepEqual(plan.java, {
    major: 25,
    exact: true,
    description: "SpongeForge 26.1.2 / Forge 64.0.1",
  });
  assert.equal(
    download.url,
    "https://maven.minecraftforge.net/net/minecraftforge/forge/26.1.2-64.0.1/forge-26.1.2-64.0.1-installer.jar",
  );
  assert.equal(download.sha256, undefined);
  assert.equal(download.sha256Url, `${download.url}.sha256`);
  assert.equal(download.sha256Path, `${download.path}.sha256`);
  assert.equal(copy.source, resolve(instance.coreJarPath));
  assert.equal(copy.target, resolve(rootPath, "mods", artifactName));
  assert.equal(copy.sha256, undefined);
  assert.deepEqual(plan.preparation!.arguments, [
    "-jar",
    "forge-26.1.2-64.0.1-installer.jar",
    "--installServer",
    ".",
  ]);
  assert.deepEqual(plan.arguments, [
    "@user_jvm_args.txt",
    "@libraries\\net\\minecraftforge\\forge\\26.1.2-64.0.1\\win_args.txt",
    "nogui",
  ]);

  const historicalSpongeForgeRoot = "C:/SeaShard/servers/instance-spongeforge-history";
  const historicalSpongeForge = buildServerLaunchPlan(
    {
      ...vanillaInstance,
      id: "instance-spongeforge-history",
      name: "SpongeForge history",
      rootPath: historicalSpongeForgeRoot,
      coreJarPath: `${historicalSpongeForgeRoot}/spongeforge-history.jar`,
      serverType: "spongeforge",
      gameVersion: "1.21.11",
      coreArtifactFileName: "spongeforge-1.21.11-61.0.6_18.0.0_RC2539-universal.jar",
      artifactSha256: undefined,
    },
    settings,
    "win32",
  );
  assert.deepEqual(historicalSpongeForge.java, {
    major: 21,
    exact: true,
    description: "SpongeForge 1.21.11 / Forge 61.0.6",
  });
  assert.equal(
    historicalSpongeForge.preparation?.downloads?.[0]?.url,
    "https://maven.minecraftforge.net/net/minecraftforge/forge/1.21.11-61.0.6/forge-1.21.11-61.0.6-installer.jar",
  );

  const { fileSystem, files } = createMemoryFileSystem(
    new Map([
      [instance.coreJarPath, "sponge-universal"],
      [download.path, "forge-installer"],
      [download.sha256Path!, `${forgeInstallerSha256}\n`],
    ]),
    new Map([
      [instance.coreJarPath, spongeSha256],
      [download.path, forgeInstallerSha256],
      [copy.target, spongeSha256],
    ]),
  );
  const children: FakeServerProcess[] = [];
  const spawnCalls: Array<{
    command: string;
    arguments_: readonly string[];
    options: Parameters<SpawnServerProcess>[2];
  }> = [];
  let fetchCount = 0;
  const manager = new ServerRuntimeManager({
    listInstances: async () => [instance],
    scanJavaInstallations: async () => [java21, java25],
    readSettings: async () => settings,
    fileSystem,
    fetchPreparationArtifact: async () => {
      fetchCount += 1;
      throw new Error("verified local installer should be reused");
    },
    spawnProcess: (command, arguments_, options) => {
      const child = new FakeServerProcess();
      const index = children.push(child) - 1;
      spawnCalls.push({ command, arguments_, options });
      queueMicrotask(() => child.emit("spawn"));
      if (index === 0) {
        setImmediate(() => {
          for (const sentinel of plan.preparation!.sentinels) {
            if (sentinel !== copy.target) files.set(sentinel, "installed");
          }
          files.set(plan.jvmArgumentFile!.path, "# generated by Forge\n");
          files.set(
            plan.preparation!.runtimeArgumentFile!,
            "-Djava.net.preferIPv6Addresses=system -XX:+UseCompactObjectHeaders -jar forge-26.1.2-64.0.1-shim.jar\n",
          );
          child.finish(0, null);
        });
      }
      return child as unknown as ChildProcessWithoutNullStreams;
    },
  });

  await manager.start(instance.id);
  assert.equal(fetchCount, 0);
  assert.equal(spawnCalls.length, 2);
  assert.equal(spawnCalls[0]!.command, java25.path);
  assert.deepEqual(spawnCalls[0]!.arguments_, plan.preparation!.arguments);
  assert.equal(spawnCalls[1]!.command, java25.path);
  assert.deepEqual(spawnCalls[1]!.arguments_, plan.arguments);
  assert.equal(files.get(copy.target), "sponge-universal");
  assert.equal(files.get(resolve(rootPath, "eula.txt")), "eula=true\n");
  assert.equal(files.get(resolve(rootPath, "server.properties")), "server-port=25566\n");

  await manager.stop(instance.id);
  children[1]!.finish(0, null);
  await manager.start(instance.id);
  assert.equal(spawnCalls.length, 3);
  assert.deepEqual(spawnCalls[2]!.arguments_, plan.arguments);
  await manager.stop(instance.id);
  children[2]!.finish(0, null);
  await manager.dispose();
});

await test("SpongeForge rejects a Forge installer download with the wrong SHA-256", async () => {
  const rootPath = "C:/SeaShard/servers/instance-spongeforge-tampered";
  const artifactName = "spongeforge-26.1.2-64.0.1_19.0.0_RC2627-universal.jar";
  const spongeSha256 = "83320019c99e7d2044f7884677b2e007ef988257633126ae952f2598c0de44df";
  const forgeInstallerSha256 = "c89c563de2e0b8d45c6651de580e2b65b569c52becdb0eeedfd1ab89e60b158d";
  const instance: ServerInstanceSnapshot = {
    ...vanillaInstance,
    id: "instance-spongeforge-tampered",
    name: "SpongeForge tampered",
    rootPath,
    coreJarPath: `${rootPath}/${artifactName}`,
    serverType: "spongeforge",
    gameVersion: "26.1.2",
    coreArtifactFileName: artifactName,
    artifactSha256: spongeSha256,
  };
  const { fileSystem } = createMemoryFileSystem(
    new Map([[instance.coreJarPath, "sponge-universal"]]),
    new Map([[instance.coreJarPath, spongeSha256]]),
  );
  let spawnCount = 0;
  const manager = new ServerRuntimeManager({
    listInstances: async () => [instance],
    scanJavaInstallations: async () => [java25],
    readSettings: async () => settings,
    fileSystem,
    fetchPreparationArtifact: async (url) =>
      url.endsWith(".sha256")
        ? new TextEncoder().encode(`${forgeInstallerSha256}\n`)
        : new TextEncoder().encode("tampered"),
    spawnProcess: () => {
      spawnCount += 1;
      return new FakeServerProcess() as unknown as ChildProcessWithoutNullStreams;
    },
  });

  await assert.rejects(
    manager.start(instance.id),
    /downloaded artifact failed SHA-256 verification/,
  );
  assert.equal(spawnCount, 0);
  assert.equal(manager.get(instance.id).state, "failed");
  await manager.dispose();
});

await test("Youer completes its embedded bootstrap before the managed Java 21 launch", async () => {
  const rootPath = "C:/SeaShard/servers/instance-youer-runtime";
  const instance: ServerInstanceSnapshot = {
    ...vanillaInstance,
    id: "instance-youer-runtime",
    name: "Youer",
    rootPath,
    coreJarPath: `${rootPath}/youer-1.21.1-535.jar`,
    serverType: "youer",
    gameVersion: "1.21.1",
    coreArtifactFileName: "youer-1.21.1-535.jar",
    artifactSha256: "f572a78b85df7f3cf143322ab53844209ec5a75bcfbd2d34978acc4cc68d414b",
  };
  const plan = buildServerLaunchPlan(instance, settings, "win32");
  const { fileSystem, files } = createMemoryFileSystem(
    new Map([[instance.coreJarPath, "youer-bootstrap"]]),
  );
  const children: FakeServerProcess[] = [];
  const spawnCalls: Array<{ command: string; arguments_: readonly string[] }> = [];
  const manager = new ServerRuntimeManager({
    listInstances: async () => [instance],
    scanJavaInstallations: async () => [java25, java21],
    readSettings: async () => settings,
    fileSystem,
    spawnProcess: (command, arguments_) => {
      const child = new FakeServerProcess();
      const index = children.push(child) - 1;
      spawnCalls.push({ command, arguments_ });
      queueMicrotask(() => child.emit("spawn"));
      if (index === 0) {
        setImmediate(() => {
          for (const sentinel of plan.preparation!.sentinels) files.set(sentinel, "installed");
          child.finish(1, null);
        });
      }
      return child as unknown as ChildProcessWithoutNullStreams;
    },
  });

  await manager.start(instance.id);
  assert.equal(spawnCalls.length, 2);
  assert.equal(spawnCalls[0]!.command, java21.path);
  assert.deepEqual(spawnCalls[0]!.arguments_, plan.preparation!.arguments);
  assert.equal(spawnCalls[1]!.command, java21.path);
  assert.deepEqual(spawnCalls[1]!.arguments_, plan.arguments);
  assert.equal(files.get(resolve(rootPath, "eula.txt")), "eula=true\n");
  assert.equal(files.get(resolve(rootPath, "server.properties")), "server-port=25566\n");

  await manager.stop(instance.id);
  children[1]!.finish(0, null);
  await manager.dispose();
});

await test("Mohist completes its EULA-gated bootstrap before the managed heap launch", async () => {
  const rootPath = "C:/SeaShard/servers/instance-mohist-runtime";
  const instance: ServerInstanceSnapshot = {
    ...vanillaInstance,
    id: "instance-mohist-runtime",
    name: "Mohist",
    rootPath,
    coreJarPath: `${rootPath}/mohist-1.20.2-173.jar`,
    serverType: "mohist",
    gameVersion: "1.20.2",
    coreArtifactFileName: "mohist-1.20.2-173.jar",
  };
  const plan = buildServerLaunchPlan(instance, settings, "win32");
  const { fileSystem, files } = createMemoryFileSystem(
    new Map([[instance.coreJarPath, "bootstrap"]]),
  );
  const children: FakeServerProcess[] = [];
  const spawnCalls: Array<{ arguments_: readonly string[] }> = [];
  const manager = new ServerRuntimeManager({
    listInstances: async () => [instance],
    scanJavaInstallations: async () => [java17, java21],
    readSettings: async () => settings,
    fileSystem,
    spawnProcess: (_command, arguments_) => {
      const child = new FakeServerProcess();
      const index = children.push(child) - 1;
      spawnCalls.push({ arguments_ });
      queueMicrotask(() => child.emit("spawn"));
      if (index === 0) {
        setImmediate(() => {
          for (const sentinel of plan.preparation!.sentinels) files.set(sentinel, "installed");
          child.finish(1, null);
        });
      }
      return child as unknown as ChildProcessWithoutNullStreams;
    },
  });

  await manager.start(instance.id);
  assert.equal(spawnCalls.length, 2);
  assert.deepEqual(spawnCalls[0]!.arguments_, plan.preparation!.arguments);
  assert.deepEqual(spawnCalls[1]!.arguments_, plan.arguments);
  assert.equal(files.get(resolve(rootPath, "eula.txt")), "eula=true\n");
  assert.equal(files.get(resolve(rootPath, "server.properties")), "server-port=25566\n");

  await manager.stop(instance.id);
  children[1]!.finish(0, null);
  await manager.dispose();
});

await test("Velocity uses end while Nukkit skips EULA but receives server.properties", async () => {
  async function exerciseDirectCore(
    serverType: "velocity" | "nukkitx",
  ): Promise<{ files: Map<string, string | Uint8Array>; stopInput: string | undefined }> {
    const rootPath = `C:/SeaShard/servers/instance-${serverType}-runtime`;
    const artifact = serverType === "velocity" ? "velocity.jar" : "Nukkit-MOT-SNAPSHOT.jar";
    const instance: ServerInstanceSnapshot = {
      ...vanillaInstance,
      id: `instance-${serverType}-runtime`,
      name: serverType,
      rootPath,
      coreJarPath: `${rootPath}/${artifact}`,
      serverType,
      gameVersion: serverType === "velocity" ? "3.5.0-SNAPSHOT" : "Nukkit-Mot",
      coreArtifactFileName: artifact,
    };
    const { fileSystem, files } = createMemoryFileSystem(
      new Map([[instance.coreJarPath, "runtime"]]),
    );
    const child = new FakeServerProcess();
    const manager = new ServerRuntimeManager({
      listInstances: async () => [instance],
      scanJavaInstallations: async () => [java17, java21],
      readSettings: async () => settings,
      fileSystem,
      spawnProcess: () => {
        queueMicrotask(() => child.emit("spawn"));
        return child as unknown as ChildProcessWithoutNullStreams;
      },
    });
    await manager.start(instance.id);
    await manager.stop(instance.id);
    const stopInput = (child.stdin as PassThrough).read()?.toString();
    child.finish(0, null);
    await manager.dispose();
    return { files, stopInput };
  }

  const velocity = await exerciseDirectCore("velocity");
  assert.equal(velocity.stopInput, "end\n");
  assert.equal(
    velocity.files.has(resolve("C:/SeaShard/servers/instance-velocity-runtime", "eula.txt")),
    false,
  );
  assert.equal(
    velocity.files.has(
      resolve("C:/SeaShard/servers/instance-velocity-runtime", "server.properties"),
    ),
    false,
  );

  const nukkit = await exerciseDirectCore("nukkitx");
  assert.equal(nukkit.stopInput, "stop\n");
  assert.equal(
    nukkit.files.has(resolve("C:/SeaShard/servers/instance-nukkitx-runtime", "eula.txt")),
    false,
  );
  assert.equal(
    nukkit.files.get(resolve("C:/SeaShard/servers/instance-nukkitx-runtime", "server.properties")),
    "server-port=25566\n",
  );
});

await test("installer exit code zero is rejected when required runtime files are absent", async () => {
  const rootPath = "C:/SeaShard/servers/instance-quilt-incomplete";
  const instance: ServerInstanceSnapshot = {
    ...vanillaInstance,
    id: "instance-quilt-incomplete",
    name: "Quilt incomplete",
    rootPath,
    coreJarPath: `${rootPath}/quilt-latest.jar`,
    serverType: "quilt",
    gameVersion: "latest",
    coreArtifactFileName: "quilt-latest.jar",
    artifactSha256: "8b716edc692a2fa1fb78dbc2f432643be1bc6c867e5605f36f691f44257120ca",
  };
  const { fileSystem } = createMemoryFileSystem(new Map([[instance.coreJarPath, "installer"]]));
  const installer = new FakeServerProcess();
  const manager = new ServerRuntimeManager({
    listInstances: async () => [instance],
    scanJavaInstallations: async () => [java21],
    readSettings: async () => settings,
    fileSystem,
    spawnProcess: () => {
      queueMicrotask(() => installer.emit("spawn"));
      setImmediate(() => installer.finish(0, null));
      return installer as unknown as ChildProcessWithoutNullStreams;
    },
  });

  await assert.rejects(
    manager.start(instance.id),
    /installer exited without complete runtime files/,
  );
  assert.equal(manager.get(instance.id).state, "failed");
  await manager.dispose();
});
