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

function createMemoryFileSystem(initialFiles: ReadonlyMap<string, string>): {
  fileSystem: ServerRuntimeFileSystem;
  files: Map<string, string>;
  accessedPaths: string[];
} {
  const files = new Map([...initialFiles].map(([path, content]) => [resolve(path), content]));
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
      hashFile: async (path, algorithm) => {
        const value = files.get(resolve(path));
        if (value === undefined) {
          throw Object.assign(new Error(`missing ${resolve(path)}`), { code: "ENOENT" });
        }
        return createHash(algorithm).update(value).digest("hex");
      },
      readTextFile: async (path) => {
        const value = files.get(resolve(path));
        if (value === undefined) {
          throw Object.assign(new Error(`missing ${resolve(path)}`), { code: "ENOENT" });
        }
        return value;
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
  ]);
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
    "0.30.0",
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
  assert.throws(
    () =>
      buildServerLaunchPlan(
        {
          ...vanillaInstance,
          id: "instance-quilt-unverified",
          name: "Quilt unverified",
          rootPath: quiltRoot,
          coreJarPath: `${quiltRoot}/quilt-latest.jar`,
          serverType: "quilt",
          gameVersion: "latest",
          coreArtifactFileName: "quilt-latest.jar",
          artifactSha256: undefined,
        },
        settings,
        "win32",
      ),
    /not the verified startup profile/,
  );

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
  assert.deepEqual(mohist.preparation?.hashManifest, {
    path: resolve(mohistRoot, "libraries", "com", "mohistmc", "installation", "installInfo"),
    algorithm: "md5",
    targets: [
      resolve(
        mohistRoot,
        "libraries",
        "net",
        "minecraftforge",
        "forge",
        "1.20.2-48.1.0",
        "forge-1.20.2-48.1.0-server.jar",
      ),
      resolve(mohistRoot, "mohist-1.20.2-173.jar"),
    ],
  });
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
            plan.preparation!.classPathArgumentFile!,
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
  const manifest = plan.preparation!.hashManifest!;
  const { fileSystem, files } = createMemoryFileSystem(
    new Map([
      [instance.coreJarPath, "bootstrap"],
      [manifest.targets[0]!, "stale-forge"],
      [manifest.path, `${"0".repeat(32)}\n${"1".repeat(32)}\n`],
    ]),
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
          files.set(manifest.targets[0]!, "installed");
          const hashes = manifest.targets.map((path) =>
            createHash(manifest.algorithm)
              .update(files.get(resolve(path))!)
              .digest("hex"),
          );
          files.set(manifest.path, `${hashes.reverse().join("\n")}\n`);
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
  ): Promise<{ files: Map<string, string>; stopInput: string | undefined }> {
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
