import {
  serverRuntimeSupportedTypes,
  type ServerInstanceSnapshot,
  type ServerRuntimeSupportedType,
} from "../packages/contracts/src/index.ts";
import { ServerRuntimeManager } from "../components/server/runtime/src/manager.ts";
import { matchesServerReadinessMarker } from "../components/server/runtime/src/readiness.ts";
import type { SpawnServerProcess } from "../components/server/runtime/src/process.ts";
import { formatRuntimeDuration } from "../frontend/server/shared/src/runtime-duration.ts";
import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { delimiter, dirname, resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import {
  createMemoryFileSystem,
  FakeServerProcess,
  java17,
  java21,
  settings,
  materializeTestStartupSettings,
  vanillaInstance,
} from "./server-runtime-fixtures.ts";

await test("runtime duration formatting keeps stable Chinese units", () => {
  assert.equal(formatRuntimeDuration(0), "0 秒");
  assert.equal(formatRuntimeDuration(61_000), "1 分 1 秒");
  assert.equal(formatRuntimeDuration(3_661_000), "1 小时 1 分");
  assert.equal(formatRuntimeDuration(90_000_000), "1 天 1 小时");
});

await test("runtime readiness markers cover every supported core protocol", () => {
  const listeningTypes = new Set<ServerRuntimeSupportedType>([
    "bungeecord",
    "lightfall",
    "travertine",
  ]);
  for (const serverType of serverRuntimeSupportedTypes) {
    if (listeningTypes.has(serverType)) {
      assert.equal(matchesServerReadinessMarker(serverType, "Listening on /0.0.0.0:25577"), true);
      assert.equal(
        matchesServerReadinessMarker(serverType, 'Done (1.000s)! For help, type "help"'),
        false,
      );
      continue;
    }
    assert.equal(
      matchesServerReadinessMarker(serverType, 'Done (1.000s)! For help, type "help"'),
      true,
    );
  }
  assert.equal(
    matchesServerReadinessMarker("banner", '加载完成 (10.574s)！如需帮助，请键入 "help" 或 "?"'),
    true,
  );
  assert.equal(
    matchesServerReadinessMarker(
      "nukkitx",
      "23:41:21 [main] [INFO] Done (4.018s)! For help, type help",
    ),
    true,
  );
  for (const serverType of listeningTypes) {
    assert.equal(matchesServerReadinessMarker(serverType, "Listening on /127.0.0.1:25577"), true);
    assert.equal(
      matchesServerReadinessMarker(serverType, "Listening on /localhost/127.0.0.1:25577"),
      true,
    );
  }
});

await test("stopped file operations exclude server startup until the transaction settles", async () => {
  let listInstanceCalls = 0;
  let markOperationStarted!: () => void;
  let releaseOperation!: () => void;
  const operationStarted = new Promise<void>((resolveStarted) => {
    markOperationStarted = resolveStarted;
  });
  const operationGate = new Promise<void>((resolveOperation) => {
    releaseOperation = resolveOperation;
  });
  const runtimeReservations = new Set<string>();
  const manager = new ServerRuntimeManager({
    listInstances: async () => {
      listInstanceCalls += 1;
      return [vanillaInstance];
    },
    scanJavaInstallations: async () => {
      throw new Error("startup entered after stopped operation");
    },
    readSettings: async () => settings,
    ensureInstanceStartupSettings: (instanceId, startupSettings) =>
      materializeTestStartupSettings(vanillaInstance, instanceId, startupSettings),
    reserveInstanceRuntime: async (instanceId) => {
      runtimeReservations.add(instanceId);
    },
    releaseInstanceRuntime: async (instanceId) => {
      runtimeReservations.delete(instanceId);
    },
  });

  const mutation = manager.runWhileStopped(vanillaInstance.id, "执行测试操作", async () => {
    markOperationStarted();
    await operationGate;
    return "updated";
  });
  await operationStarted;

  const startup = manager.startWithReceipt(vanillaInstance.id);
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  assert.equal(listInstanceCalls, 0);
  assert.equal(manager.get(vanillaInstance.id).state, "stopped");

  releaseOperation();
  assert.equal(await mutation, "updated");
  await assert.rejects(startup, /startup entered after stopped operation/u);
  assert.equal(listInstanceCalls, 1);
  assert.deepEqual([...runtimeReservations], []);
  await manager.dispose();
});

await test("vanilla runtime starts a direct JAR process and streams bidirectional console IO", async () => {
  const eulaPath = resolve(vanillaInstance.rootPath, "eula.txt");
  const propertiesPath = resolve(vanillaInstance.rootPath, "server.properties");
  const { fileSystem, files } = createMemoryFileSystem(
    new Map([
      [vanillaInstance.coreJarPath, "jar"],
      [eulaPath, "# Minecraft EULA\neula=false\neula=false\n"],
    ]),
  );
  let child = new FakeServerProcess();
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
  const recordedStartTimes: Array<{ instanceId: string; startedAt: string }> = [];
  const recordedRuntimes: Array<{ instanceId: string; startedAt: string; stoppedAt: string }> = [];
  let now = new Date("2026-08-17T13:00:00.000Z");
  const runtimeReservations = new Set<string>();
  const manager = new ServerRuntimeManager({
    listInstances: async () => [vanillaInstance],
    scanJavaInstallations: async () => [java17, java21],
    readSettings: async () => settings,
    ensureInstanceStartupSettings: (instanceId, startupSettings) =>
      materializeTestStartupSettings(vanillaInstance, instanceId, startupSettings),
    recordInstanceStartedAt: async (instanceId, startedAt) => {
      recordedStartTimes.push({ instanceId, startedAt });
    },
    reserveInstanceRuntime: async (instanceId) => {
      assert.equal(runtimeReservations.has(instanceId), false);
      runtimeReservations.add(instanceId);
    },
    releaseInstanceRuntime: async (instanceId) => {
      runtimeReservations.delete(instanceId);
    },
    recordInstanceRuntime: async (instanceId, startedAt, stoppedAt) => {
      recordedRuntimes.push({ instanceId, startedAt, stoppedAt });
    },
    fileSystem,
    spawnProcess,
    now: () => now,
    onConsoleLine: (line) => emittedLines.push(`${line.stream}:${line.text}`),
  });

  const startReceipt = await manager.startWithReceipt(vanillaInstance.id);
  const started = startReceipt.snapshot;
  assert.deepEqual(started, {
    instanceId: vanillaInstance.id,
    state: "running",
    pid: 4_242,
    startedAt: "2026-08-17T13:00:00.000Z",
  });
  assert.deepEqual([...runtimeReservations], [vanillaInstance.id]);
  assert.equal(
    manager
      .getLogs(vanillaInstance.id)
      .find(({ sequence }) => sequence === startReceipt.startedLogSequence)?.stream,
    "system",
  );
  assert.deepEqual(recordedStartTimes, [
    {
      instanceId: vanillaInstance.id,
      startedAt: "2026-08-17T13:00:00.000Z",
    },
  ]);
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

  let stoppedMutationCalls = 0;
  await assert.rejects(
    manager.runWhileStopped(vanillaInstance.id, "创建世界备份", async () => {
      stoppedMutationCalls += 1;
    }),
    /服务器正在运行，无法创建世界备份。请先停止服务器后重试。/u,
  );
  assert.equal(stoppedMutationCalls, 0);

  const readyWait = manager.waitUntilReady(vanillaInstance.id, { timeoutMs: 1_000 });
  child.stdout.write('[Server thread/INFO]: Done (6.793s)! For help, type "help"\r\nsecond');
  child.stdout.write(" line\n");
  child.stdout.write(Buffer.from("c3fcc1eeb2bbb4e6d4da0a", "hex"));
  child.stdout.write("\u001b]0;Nukkit MOT\u0007");
  child.stdout.write("22:38:12 [main] [INFO] Ready\u001b[0m\n");
  child.stdout.write("Picked up JAVA_TOOL_OPTIONS: -Dfile.encoding=UTF-8\n");
  child.stderr.write("0% [        ]\r50% [====    ]\r100% [========]\n");
  child.stderr.write("warning from java\n");
  assert.deepEqual(await readyWait, {
    snapshot: {
      instanceId: vanillaInstance.id,
      state: "running",
      pid: 4_242,
      startedAt: "2026-08-17T13:00:00.000Z",
    },
    readyLogSequence: 3,
    readyAt: "2026-08-17T13:00:00.000Z",
    readyMarker: '[Server thread/INFO]: Done (6.793s)! For help, type "help"',
  });
  const commandReceipt = await manager.sendCommandWithReceipt(vanillaInstance.id, "list");
  assert.equal((child.stdin as PassThrough).read()?.toString(), "list\n");
  assert.equal(
    manager
      .getLogs(vanillaInstance.id)
      .find(({ sequence }) => sequence === commandReceipt.commandLogSequence)?.text,
    "> list",
  );
  assert.deepEqual(
    manager
      .getLogs(vanillaInstance.id)
      .filter((line) => ["stdout", "stderr", "input"].includes(line.stream))
      .map((line) => `${line.stream}:${line.text}`),
    [
      'stdout:[Server thread/INFO]: Done (6.793s)! For help, type "help"',
      "stdout:second line",
      "stdout:命令不存在",
      "stdout:22:38:12 [main] [INFO] Ready",
      "stderr:100% [========]",
      "stderr:warning from java",
      "input:> list",
    ],
  );

  const stopReceipt = await manager.stopWithReceipt(vanillaInstance.id);
  const stopping = stopReceipt.snapshot;
  assert.equal(stopping.state, "stopping");
  assert.equal(
    manager
      .getLogs(vanillaInstance.id)
      .find(({ sequence }) => sequence === stopReceipt.stopCommandLogSequence)?.text,
    "> stop",
  );
  assert.equal((child.stdin as PassThrough).read()?.toString(), "stop\n");
  assert.equal((await manager.stop(vanillaInstance.id)).state, "stopping");
  const stoppedWait = manager.waitUntilStopped(vanillaInstance.id, { timeoutMs: 1_000 });
  child.emitExit(0, null);
  child.stdout.write("saved tail without newline");
  assert.equal(manager.get(vanillaInstance.id).state, "stopping");
  now = new Date("2026-08-17T13:02:03.000Z");
  child.emitClose(0, null);
  await new Promise<void>((resolveWait) => setImmediate(resolveWait));
  assert.deepEqual((await stoppedWait).snapshot, {
    instanceId: vanillaInstance.id,
    state: "stopped",
    pid: 4_242,
    startedAt: "2026-08-17T13:00:00.000Z",
    stoppedAt: "2026-08-17T13:02:03.000Z",
    exitCode: 0,
  });
  assert.deepEqual(manager.get(vanillaInstance.id), {
    instanceId: vanillaInstance.id,
    state: "stopped",
    pid: 4_242,
    startedAt: "2026-08-17T13:00:00.000Z",
    stoppedAt: "2026-08-17T13:02:03.000Z",
    exitCode: 0,
  });
  assert.deepEqual(recordedRuntimes, [
    {
      instanceId: vanillaInstance.id,
      startedAt: "2026-08-17T13:00:00.000Z",
      stoppedAt: "2026-08-17T13:02:03.000Z",
    },
  ]);
  assert.deepEqual([...runtimeReservations], []);
  const finalLogs = manager.getLogs(vanillaInstance.id);
  assert.equal(
    finalLogs.some((line) => line.text === "saved tail without newline"),
    true,
  );
  assert.equal(
    emittedLines.includes("system:[SeaShard] Vanilla 服务器进程已启动（Java 21.0.7）。"),
    true,
  );

  // 第二次运行仍保留上一轮日志；等待器只能接受当前 ActiveSession 新产生的就绪标志。
  child = new FakeServerProcess();
  now = new Date("2026-08-17T13:03:00.000Z");
  await manager.start(vanillaInstance.id);
  const cancelled = new AbortController();
  const staleMarkerWait = manager.waitUntilReady(vanillaInstance.id, {
    timeoutMs: 1_000,
    signal: cancelled.signal,
  });
  cancelled.abort(new Error("restart readiness wait cancelled"));
  await assert.rejects(staleMarkerWait, /restart readiness wait cancelled/u);

  const restartedReadyWait = manager.waitUntilReady(vanillaInstance.id, { timeoutMs: 1_000 });
  child.stdout.write('[Server thread/INFO]: Done (1.000s)! For help, type "help"\n');
  assert.equal((await restartedReadyWait).readyMarker.includes("Done (1.000s)!"), true);

  await manager.stop(vanillaInstance.id);
  const restartedStoppedWait = manager.waitUntilStopped(vanillaInstance.id, {
    timeoutMs: 1_000,
  });
  now = new Date("2026-08-17T13:04:00.000Z");
  child.finish(0, null);
  assert.equal((await restartedStoppedWait).snapshot.state, "stopped");

  // close 时仍要把无换行尾部写入控制台，但 stopping 会话不能再被这段 Done 标记为可用。
  child = new FakeServerProcess();
  now = new Date("2026-08-17T13:05:00.000Z");
  await manager.start(vanillaInstance.id);
  const closingReadyWait = manager.waitUntilReady(vanillaInstance.id, { timeoutMs: 1_000 });
  const closingMarker = '[Server thread/INFO]: Done (0.500s)! For help, type "help"';
  child.stdout.write(closingMarker);
  child.finish(0, null);
  await assert.rejects(closingReadyWait, /exited before becoming ready/u);
  assert.equal(
    manager.getLogs(vanillaInstance.id).some(({ text }) => text === closingMarker),
    true,
  );
  await manager.dispose();
});

await test("runtime materializes global defaults once before an instance first starts", async () => {
  let instance: ServerInstanceSnapshot = {
    ...vanillaInstance,
    id: "instance-first-start-defaults",
    rootPath: "C:/SeaShard/servers/instance-first-start-defaults",
    coreJarPath: "C:/SeaShard/servers/instance-first-start-defaults/server.jar",
  };
  let defaults = settings;
  const { fileSystem, files } = createMemoryFileSystem(new Map([[instance.coreJarPath, "jar"]]));
  const children: FakeServerProcess[] = [];
  const launchArguments: Array<readonly string[]> = [];
  const materializedSettings: Array<NonNullable<ServerInstanceSnapshot["startupSettings"]>> = [];
  const manager = new ServerRuntimeManager({
    listInstances: async () => [instance],
    scanJavaInstallations: async () => [java21],
    readSettings: async () => defaults,
    ensureInstanceStartupSettings: async (instanceId, startupSettings) => {
      assert.equal(instanceId, instance.id);
      materializedSettings.push(startupSettings);
      if (!instance.startupSettings) instance = { ...instance, startupSettings };
      return instance;
    },
    fileSystem,
    spawnProcess: (_command, arguments_) => {
      launchArguments.push(arguments_);
      const child = new FakeServerProcess();
      children.push(child);
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as ChildProcessWithoutNullStreams;
    },
  });

  await manager.start(instance.id);
  assert.deepEqual(materializedSettings, [
    {
      minimumMemoryMiB: 1_024,
      maximumMemoryMiB: 2_048,
      serverPort: 25_566,
      autoAcceptEula: true,
      jvmArguments: '-XX:+UseG1GC "-Dmotd=Hello World"',
    },
  ]);
  assert.deepEqual(launchArguments[0], [
    "-XX:+UseG1GC",
    "-Dmotd=Hello World",
    "-Xms1024M",
    "-Xmx2048M",
    "-jar",
    "server.jar",
    "nogui",
  ]);
  await manager.stop(instance.id);
  const firstStopped = manager.waitUntilStopped(instance.id, { timeoutMs: 1_000 });
  children[0]!.finish(0, null);
  await firstStopped;

  defaults = {
    ...settings,
    defaultMinimumMemoryMiB: 2_048,
    defaultMaximumMemoryMiB: 4_096,
    defaultServerPort: 25_590,
    defaultJvmArguments: "-XX:+UseZGC",
  };
  await manager.start(instance.id);
  assert.equal(materializedSettings.length, 1);
  assert.deepEqual(launchArguments[1], launchArguments[0]);
  assert.equal(files.get(resolve(instance.rootPath, "server.properties")), "server-port=25566\n");

  await manager.stop(instance.id);
  const secondStopped = manager.waitUntilStopped(instance.id, { timeoutMs: 1_000 });
  children[1]!.finish(0, null);
  await secondStopped;
  await manager.dispose();
});

await test("instance startup settings override global launch values and update an existing port", async () => {
  const instance: ServerInstanceSnapshot = {
    ...vanillaInstance,
    id: "instance-vanilla-overridden",
    rootPath: "C:/SeaShard/servers/instance-vanilla-overridden",
    coreJarPath: "C:/SeaShard/servers/instance-vanilla-overridden/server.jar",
    startupSettings: {
      minimumMemoryMiB: 768,
      maximumMemoryMiB: 3_072,
      serverPort: 25_580,
      autoAcceptEula: false,
      jvmArguments: "-XX:+UseZGC",
    },
  };
  const eulaPath = resolve(instance.rootPath, "eula.txt");
  const propertiesPath = resolve(instance.rootPath, "server.properties");
  const { fileSystem, files } = createMemoryFileSystem(
    new Map([
      [instance.coreJarPath, "jar"],
      [eulaPath, "# Minecraft EULA\neula=false\n"],
      [propertiesPath, "# custom\nserver-port=25565\nmotd=SeaShard\n"],
    ]),
  );
  const child = new FakeServerProcess();
  let arguments_: readonly string[] = [];
  const manager = new ServerRuntimeManager({
    listInstances: async () => [instance],
    scanJavaInstallations: async () => [java21],
    readSettings: async () => settings,
    ensureInstanceStartupSettings: (instanceId, startupSettings) =>
      materializeTestStartupSettings(instance, instanceId, startupSettings),
    fileSystem,
    spawnProcess: (_command, launchArguments) => {
      arguments_ = launchArguments;
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as ChildProcessWithoutNullStreams;
    },
  });
  const preview = await manager.preview(instance.id, {
    minimumMemoryMiB: 1_024,
    maximumMemoryMiB: 4_096,
    serverPort: 25_581,
    autoAcceptEula: true,
    jvmArguments: "-XX:+UseG1GC",
  });
  assert.equal(preview.instanceId, instance.id);
  assert.equal(preview.command.includes(java21.path), true);
  assert.equal(
    preview.command.includes("-XX:+UseG1GC -Xms1024M -Xmx4096M -jar server.jar nogui"),
    true,
  );

  await manager.start(instance.id);
  assert.deepEqual(arguments_, [
    "-XX:+UseZGC",
    "-Xms768M",
    "-Xmx3072M",
    "-jar",
    "server.jar",
    "nogui",
  ]);
  assert.equal(files.get(eulaPath), "# Minecraft EULA\neula=false\n");
  assert.equal(files.get(propertiesPath), "# custom\nserver-port=25580\nmotd=SeaShard\n");
  await manager.stop(instance.id);
  child.finish(0, null);
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
    ensureInstanceStartupSettings: (instanceId, startupSettings) =>
      materializeTestStartupSettings(vanillaInstance, instanceId, startupSettings),
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
    ensureInstanceStartupSettings: (instanceId, startupSettings) =>
      materializeTestStartupSettings(vanillaInstance, instanceId, startupSettings),
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

await test("startup settlement wait follows the active instance operation", async () => {
  let markInstanceLookupStarted!: () => void;
  let releaseInstances!: (instances: readonly ServerInstanceSnapshot[]) => void;
  const lookupStarted = new Promise<void>((resolveStarted) => {
    markInstanceLookupStarted = resolveStarted;
  });
  const instancesReady = new Promise<readonly ServerInstanceSnapshot[]>((resolveInstances) => {
    releaseInstances = resolveInstances;
  });
  const { fileSystem } = createMemoryFileSystem(new Map([[vanillaInstance.coreJarPath, "jar"]]));
  const child = new FakeServerProcess();
  const manager = new ServerRuntimeManager({
    listInstances: () => {
      markInstanceLookupStarted();
      return instancesReady;
    },
    scanJavaInstallations: async () => [java21],
    readSettings: async () => settings,
    ensureInstanceStartupSettings: (instanceId, startupSettings) =>
      materializeTestStartupSettings(vanillaInstance, instanceId, startupSettings),
    fileSystem,
    spawnProcess: () => {
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as ChildProcessWithoutNullStreams;
    },
  });

  const startup = manager.start(vanillaInstance.id);
  await lookupStarted;
  assert.equal(manager.get(vanillaInstance.id).state, "starting");
  let waitSettled = false;
  const wait = manager
    .waitUntilStartupSettled(vanillaInstance.id, { timeoutMs: 1_000 })
    .then((snapshot) => {
      waitSettled = true;
      return snapshot;
    });
  await new Promise<void>((resolveWait) => setImmediate(resolveWait));
  assert.equal(waitSettled, false);

  releaseInstances([vanillaInstance]);
  assert.equal((await startup).state, "running");
  assert.equal((await wait).state, "running");
  await manager.stop(vanillaInstance.id);
  const stopped = manager.waitUntilStopped(vanillaInstance.id, { timeoutMs: 1_000 });
  child.finish(0, null);
  await stopped;
  await manager.dispose();
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
    ensureInstanceStartupSettings: (instanceId, startupSettings) =>
      materializeTestStartupSettings(vanillaInstance, instanceId, startupSettings),
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
    ensureInstanceStartupSettings: (instanceId, startupSettings) =>
      materializeTestStartupSettings(unknownInstance, instanceId, startupSettings),
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
      ensureInstanceStartupSettings: (instanceId, startupSettings) =>
        materializeTestStartupSettings(instance, instanceId, startupSettings),
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
      ensureInstanceStartupSettings: (instanceId, startupSettings) =>
        materializeTestStartupSettings(instance, instanceId, startupSettings),
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
