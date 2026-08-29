import type {
  ServerConsoleLine,
  ServerConsoleStream,
  ServerRuntimeSnapshot,
  ServerRuntimeSupportedType,
} from "@seashard/contracts";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { ProcessLineDecoder } from "../console-decoder";
import { matchesServerReadinessMarker } from "../readiness";

export interface ActiveSession {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stdout: ProcessLineDecoder;
  readonly stderr: ProcessLineDecoder;
  readonly closed: Promise<void>;
  readonly resolveClosed: () => void;
  readonly ready: Promise<ServerConsoleLine>;
  readonly resolveReady: (line: ServerConsoleLine) => void;
  readonly serverType: ServerRuntimeSupportedType;
  readonly stopCommand: string;
  snapshot: ServerRuntimeSnapshot;
  readyLine?: ServerConsoleLine;
  forceStopTimer?: NodeJS.Timeout;
  stdinFailure?: Error;
  stopCommandLogSequence?: number;
}

export interface ActiveSessionCallbacks {
  readonly onLine: (stream: "stdout" | "stderr", text: string) => void;
  readonly onStdinError: (error: Error) => void;
  readonly onProcessError: (error: Error) => void;
  readonly onClose: (code: number | null, signal: NodeJS.Signals | null) => void;
}

/** 创建单个进程会话并集中绑定流解码、进程事件和两个生命周期 Promise。 */
export function createActiveSession(
  child: ChildProcessWithoutNullStreams,
  snapshot: ServerRuntimeSnapshot,
  serverType: ServerRuntimeSupportedType,
  stopCommand: string,
  callbacks: ActiveSessionCallbacks,
): ActiveSession {
  const stdout = new ProcessLineDecoder((line) => callbacks.onLine("stdout", line));
  const stderr = new ProcessLineDecoder((line) => callbacks.onLine("stderr", line));
  let resolveClosed = (): void => {};
  const closed = new Promise<void>((resolveSession) => {
    resolveClosed = resolveSession;
  });
  let resolveReady = (_line: ServerConsoleLine): void => {};
  const ready = new Promise<ServerConsoleLine>((resolveMarker) => {
    resolveReady = resolveMarker;
  });
  const session: ActiveSession = {
    child,
    stdout,
    stderr,
    closed,
    resolveClosed,
    ready,
    resolveReady,
    serverType,
    stopCommand,
    snapshot,
  };

  child.stdout.on("data", (chunk: Buffer | string) => stdout.write(chunk));
  child.stderr.on("data", (chunk: Buffer | string) => stderr.write(chunk));
  child.stdin.on("error", callbacks.onStdinError);
  child.on("error", callbacks.onProcessError);
  // close 在 stdout/stderr 已关闭后触发，能够保证最后一块无换行输出也被解码。
  child.once("close", callbacks.onClose);
  return session;
}

/** 历史日志、Agent 输入与已经进入 stopping 的会话均不能触发当前进程就绪。 */
export function captureSessionReadiness(
  session: ActiveSession,
  stream: ServerConsoleStream,
  line: ServerConsoleLine,
): void {
  if (
    session.readyLine ||
    session.snapshot.state === "stopping" ||
    (stream !== "stdout" && stream !== "stderr") ||
    !matchesServerReadinessMarker(session.serverType, line.text)
  ) {
    return;
  }
  session.readyLine = { ...line };
  session.resolveReady(session.readyLine);
}
