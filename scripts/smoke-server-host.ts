import type { ServerConsoleLine } from "../packages/contracts/src/index";
import { SQLiteDatabaseBroker } from "../components/data/database-sqlite/src/index";
import { registerStandaloneHost } from "../packages/host-installation/src/index";
import { startSeaShardHost, type SeaShardHostRuntime } from "../packages/host-runtime/src/index";
import {
  SQLiteServerInstanceRegistry,
  serverInstanceDataCapsule,
  writePortableInstanceManifests,
} from "../components/server/instance-manager/src/index";
import { ServerLocalHostConnection } from "../apps/server/src/local-host";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const databaseWorkerEntry = fileURLToPath(
  new URL("../apps/database-worker/dist/index.js", import.meta.url),
);
const pluginHostEntry = fileURLToPath(
  new URL("../apps/plugin-host/dist/index.js", import.meta.url),
);
const dataRoot = await mkdtemp(join(tmpdir(), "seashard-server-host-smoke-"));
const instanceId = "server-host-smoke";
let host: SeaShardHostRuntime | undefined;
let connection: ServerLocalHostConnection | undefined;
let reconnected: ServerLocalHostConnection | undefined;

try {
  await registerStandaloneHost(dataRoot, "nsis");
  await prepareFakeMinecraftServer(dataRoot);
  host = await startSeaShardHost({
    dataRoot,
    seaShardVersion: "0.0.0",
    packageType: "nsis",
    databaseWorkerEntry,
    pluginHostEntry,
  });

  connection = await ServerLocalHostConnection.connect({
    dataRoot,
    identity: { sessionId: "server-host-smoke-controller", label: "Server Host Smoke" },
  });
  assert.equal(connection.snapshot().hasControl, true);
  const instances = await connection.listInstances();
  assert.deepEqual(
    instances.map(({ id }) => id),
    [instanceId],
  );
  console.log(`SEASHARD_SERVER_HOST_SMOKE_INSTANCES count=${instances.length}`);

  const consoleLines: ServerConsoleLine[] = [];
  const stopConsole = connection.onConsoleLine((line) => consoleLines.push(line));
  await connection.start(instanceId);
  const running = await connection.waitUntilStartupSettled(instanceId, 15_000);
  assert.equal(running.state, "running");
  console.log(`SEASHARD_SERVER_HOST_SMOKE_RUNNING pid=${running.pid}`);

  await connection.sendCommand(instanceId, "list");
  await waitUntil(() => consoleLines.some(({ text }) => text === "COMMAND:list"), 5_000);
  assert.ok((await connection.getLogs(instanceId)).some(({ text }) => text === "COMMAND:list"));
  console.log("SEASHARD_SERVER_HOST_SMOKE_CONSOLE_OK");

  const restarted = await connection.restart(instanceId, 15_000);
  assert.equal(restarted.state, "running");
  console.log(`SEASHARD_SERVER_HOST_SMOKE_RESTARTED pid=${restarted.pid}`);

  stopConsole();
  connection.dispose();
  connection = undefined;
  await delay(200);

  reconnected = await ServerLocalHostConnection.connect({
    dataRoot,
    identity: { sessionId: "server-host-smoke-reconnect", label: "Server Host Smoke Reconnect" },
  });
  const afterDisconnect = await reconnected.getRuntime(instanceId);
  assert.equal(afterDisconnect.state, "running");
  console.log(`SEASHARD_SERVER_HOST_SMOKE_CONTROLLER_RESTART_SURVIVED pid=${afterDisconnect.pid}`);

  await reconnected.stop(instanceId);
  const stopped = await reconnected.waitUntilStopped(instanceId, 15_000);
  assert.equal(stopped.state, "stopped");
  console.log("SEASHARD_SERVER_HOST_SMOKE_STOPPED");
  console.log("SEASHARD_SERVER_HOST_SMOKE_OK");
} finally {
  connection?.dispose();
  reconnected?.dispose();
  await host?.dispose().catch(() => undefined);
  await rm(dataRoot, { recursive: true, force: true });
}

async function prepareFakeMinecraftServer(hostDataRoot: string): Promise<void> {
  const rootPath = join(hostDataRoot, "servers", instanceId);
  const sourceRoot = join(hostDataRoot, "smoke-java-source");
  const classesRoot = join(sourceRoot, "classes");
  const coreJarPath = join(rootPath, "server.jar");
  await Promise.all([
    mkdir(rootPath, { recursive: true }),
    mkdir(classesRoot, { recursive: true }),
  ]);
  const sourcePath = join(sourceRoot, "FakeServer.java");
  await writeFile(
    sourcePath,
    `import java.io.BufferedReader;
import java.io.InputStreamReader;

public final class FakeServer {
  public static void main(String[] args) throws Exception {
    System.out.println("Done (0.1s)! For help, type \\"help\\"");
    BufferedReader input = new BufferedReader(new InputStreamReader(System.in));
    for (String line; (line = input.readLine()) != null; ) {
      System.out.println("COMMAND:" + line);
      if (line.equals("stop")) break;
    }
  }
}
`,
    "utf8",
  );
  await run("javac", ["-d", classesRoot, sourcePath]);
  await run("jar", [
    "--create",
    "--file",
    coreJarPath,
    "--main-class",
    "FakeServer",
    "-C",
    classesRoot,
    ".",
  ]);

  const now = new Date().toISOString();
  const manifestPath = await writePortableInstanceManifests({
    id: instanceId,
    name: "Server Host Smoke",
    rootPath,
    coreJarPath,
    storageMode: "managed",
    source: "downloaded",
    modLoader: null,
    serverType: "vanilla",
    gameVersion: "1.20.4",
    createdAt: now,
    updatedAt: now,
    totalRuntimeMs: 0,
    startupSettings: {
      minimumMemoryMiB: 512,
      maximumMemoryMiB: 512,
      serverPort: 25_565,
      autoAcceptEula: true,
      jvmArguments: "",
    },
  });

  const broker = await SQLiteDatabaseBroker.create({
    databasePath: join(hostDataRoot, "seashard.sqlite3"),
    workerEntry: databaseWorkerEntry,
    readWorkers: 1,
  });
  try {
    const repository = await broker.registerCapsule(serverInstanceDataCapsule);
    await new SQLiteServerInstanceRegistry(repository).insertManifestPath(manifestPath);
  } finally {
    await broker.close();
  }
}

function run(executable: string, arguments_: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-16_384);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${executable} exited: ${code ?? signal}`));
    });
  });
}

async function waitUntil(predicate: () => boolean, timeoutMilliseconds: number): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error("Timed out waiting for Server Host smoke condition");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
