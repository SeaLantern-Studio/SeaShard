import {
  pluginDeveloperControlProtocolVersion,
  type PluginDeveloperControlLaunch,
  type PluginDeveloperControlRequest,
  type PluginDeveloperControlResponse,
  type PluginDeveloperControlResults,
  type PluginDeveloperHostSnapshot,
  type PluginDeveloperSessionDescriptor,
} from "@seashard/plugin-system";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { access, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { LiveServiceProvider } from "./service-catalog";

const electronExecutable = createRequire(import.meta.url)("electron") as string;

const sessionRoot = join(tmpdir(), "seashard-plugin-development");
const maximumResponseBytes = 4 * 1024 * 1024;

export interface RunningDeveloperHost {
  readonly child: ChildProcess;
  readonly descriptor: PluginDeveloperSessionDescriptor;
}

export async function createControlLaunch(
  mode: PluginDeveloperControlLaunch["mode"],
  pluginRoot?: string,
): Promise<PluginDeveloperControlLaunch> {
  await mkdir(sessionRoot, { recursive: true });
  const sessionId = randomBytes(12).toString("hex");
  return {
    protocolVersion: pluginDeveloperControlProtocolVersion,
    sessionId,
    token: randomBytes(32).toString("hex"),
    socketPath:
      process.platform === "win32"
        ? `\\\\.\\pipe\\seashard-plugin-dev-${sessionId}`
        : join(sessionRoot, `${sessionId}.sock`),
    descriptorPath: join(sessionRoot, `${sessionId}.json`),
    mode,
    ...(pluginRoot ? { pluginRoot } : {}),
  };
}

/** 启动真实 Desktop Main，并等待其完成 Bootstrap 与本地控制面注册。 */
export async function launchDeveloperHost(
  launch: PluginDeveloperControlLaunch,
): Promise<RunningDeveloperHost> {
  const desktopEntry = await resolveDesktopEntry();
  const child = spawn(electronExecutable, [desktopEntry], {
    cwd: resolve(dirname(desktopEntry), "../../../.."),
    env: {
      ...process.env,
      SEASHARD_PLUGIN_DEVELOPER_CONTROL: Buffer.from(JSON.stringify(launch), "utf8").toString(
        "base64url",
      ),
    },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  try {
    await waitForHostReady(child, launch.sessionId);
    const descriptor = parseDescriptor(await readFile(launch.descriptorPath, "utf8"));
    return { child, descriptor };
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    throw error;
  }
}

export async function stopDeveloperHost(host: RunningDeveloperHost): Promise<void> {
  if (host.child.exitCode !== null || host.child.signalCode !== null) return;
  try {
    await sendControl(host.descriptor, "shutdown", {});
  } catch {
    // Windows 控制台中断会同时送达父 CLI 与 Electron；子进程先退出时 Socket 消失属于正常关停竞争。
  }
  await waitForExit(host.child, 10_000);
}

export async function runHostOperation<Action extends keyof PluginDeveloperControlResults>(
  action: Action,
  payload: Omit<
    Extract<PluginDeveloperControlRequest, { action: Action }>,
    "id" | "token" | "action"
  >,
): Promise<PluginDeveloperControlResults[Action]> {
  const launch = await createControlLaunch("operation");
  const host = await launchDeveloperHost(launch);
  try {
    return await sendControl(host.descriptor, action, payload);
  } finally {
    try {
      await sendControl(host.descriptor, "shutdown", {});
    } finally {
      await waitForExit(host.child, 10_000);
    }
  }
}

export async function sendControl<Action extends keyof PluginDeveloperControlResults>(
  descriptor: PluginDeveloperSessionDescriptor,
  action: Action,
  payload: Omit<
    Extract<PluginDeveloperControlRequest, { action: Action }>,
    "id" | "token" | "action"
  >,
): Promise<PluginDeveloperControlResults[Action]> {
  const id = randomBytes(12).toString("hex");
  const request = {
    id,
    token: descriptor.token,
    action,
    ...payload,
  } as PluginDeveloperControlRequest;
  const response = await exchange(descriptor.socketPath, request);
  if (response.id !== id) throw new Error("developer control response identity does not match");
  if (!response.ok) throw new Error(response.error);
  if (response.action !== action)
    throw new Error("developer control response action does not match");
  return response.result as PluginDeveloperControlResults[Action];
}

/** 发现并实测仍可连接的开发会话；失效的临时描述文件会被清理。 */
export async function discoverHostSnapshots(): Promise<readonly PluginDeveloperHostSnapshot[]> {
  let names: string[];
  try {
    names = await readdir(sessionRoot);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }

  const snapshots: PluginDeveloperHostSnapshot[] = [];
  for (const name of names.filter((candidate) => candidate.endsWith(".json")).sort()) {
    const descriptorPath = join(sessionRoot, name);
    let descriptor: PluginDeveloperSessionDescriptor | undefined;
    try {
      descriptor = parseDescriptor(await readFile(descriptorPath, "utf8"));
      snapshots.push(await sendControl(descriptor, "snapshot", {}));
    } catch {
      await rm(descriptorPath, { force: true });
      if (descriptor && process.platform !== "win32") {
        await rm(descriptor.socketPath, { force: true });
      }
    }
  }
  return snapshots.sort((left, right) =>
    left.session.startedAt.localeCompare(right.session.startedAt),
  );
}

export function projectLiveServices(
  snapshots: readonly PluginDeveloperHostSnapshot[],
): readonly LiveServiceProvider[] {
  return snapshots.flatMap((snapshot) =>
    snapshot.services.map((service) => ({
      sessionId: snapshot.session.sessionId,
      ...service,
    })),
  );
}

export function selectDevelopmentHostSnapshots(
  snapshots: readonly PluginDeveloperHostSnapshot[],
  runtimeId?: string,
): readonly PluginDeveloperHostSnapshot[] {
  const developmentSnapshots = snapshots.filter(
    (snapshot) => snapshot.session.mode === "development",
  );
  return runtimeId
    ? developmentSnapshots.filter((snapshot) =>
        snapshot.runtime.plugins.some((plugin) => plugin.runtimeId === runtimeId),
      )
    : developmentSnapshots;
}

export async function selectHostSessions(
  runtimeId?: string,
): Promise<readonly PluginDeveloperHostSnapshot[]> {
  const selected = selectDevelopmentHostSnapshots(await discoverHostSnapshots(), runtimeId);
  if (selected.length === 0) {
    throw new Error(
      runtimeId
        ? `no active plugin development session contains runtime ${runtimeId}`
        : "no active plugin development session was found",
    );
  }
  return selected;
}

function exchange(
  socketPath: string,
  request: PluginDeveloperControlRequest,
): Promise<PluginDeveloperControlResponse> {
  return new Promise((resolvePromise, reject) => {
    const socket = connect(socketPath);
    socket.setEncoding("utf8");
    socket.setTimeout(10_000);
    let body = "";
    let settled = false;
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      if (settled) return;
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > maximumResponseBytes) {
        rejectOnce(new Error("developer control response is too large"));
        return;
      }
      const newline = body.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(body.slice(0, newline)) as PluginDeveloperControlResponse;
        settled = true;
        socket.end();
        resolvePromise(response);
      } catch (error) {
        rejectOnce(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("timeout", () => rejectOnce(new Error("developer control request timed out")));
    socket.once("error", (error) => rejectOnce(error));
    socket.once("end", () => {
      if (!settled) rejectOnce(new Error("developer control closed without a response"));
    });
  });
}

function waitForHostReady(child: ChildProcess, sessionId: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => finish(new Error("Desktop Host startup timed out")), 60_000);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolvePromise();
    };
    const onMessage = (message: unknown) => {
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "seashard:plugin-developer-control-ready" &&
        "sessionId" in message &&
        message.sessionId === sessionId
      ) {
        finish();
      }
    };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      finish(
        new Error(
          `Desktop Host exited before readiness (${code === null ? `signal ${signal}` : `code ${code}`})`,
        ),
      );
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      child.kill();
      resolvePromise();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

async function resolveDesktopEntry(): Promise<string> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidate =
    process.env.SEASHARD_DESKTOP_MAIN ??
    resolve(moduleDirectory, "../../desktop/dist/main/index.js");
  try {
    await access(candidate);
  } catch {
    throw new Error(
      `Desktop Host bundle is missing at ${candidate}; build SeaShard before running Host-backed CLI commands`,
    );
  }
  return candidate;
}

function parseDescriptor(source: string): PluginDeveloperSessionDescriptor {
  const value = JSON.parse(source) as Partial<PluginDeveloperSessionDescriptor>;
  if (
    value.protocolVersion !== pluginDeveloperControlProtocolVersion ||
    typeof value.sessionId !== "string" ||
    typeof value.token !== "string" ||
    typeof value.socketPath !== "string" ||
    typeof value.descriptorPath !== "string" ||
    typeof value.pid !== "number" ||
    typeof value.startedAt !== "string" ||
    (value.mode !== "development" && value.mode !== "operation") ||
    !Array.isArray(value.runtimeIds) ||
    value.runtimeIds.some((runtimeId) => typeof runtimeId !== "string")
  ) {
    throw new TypeError("plugin developer session descriptor is invalid");
  }
  return value as PluginDeveloperSessionDescriptor;
}

function isNodeError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
