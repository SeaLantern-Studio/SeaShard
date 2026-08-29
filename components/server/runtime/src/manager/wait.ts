import type { ServerRuntimeSnapshot } from "@seashard/contracts";

/** 核心输出启动完成标志后生成的回执；日志序号可用于继续读取后续控制台输出。 */
export interface ServerRuntimeReadyReceipt {
  readonly snapshot: ServerRuntimeSnapshot;
  readonly readyLogSequence: number;
  readonly readyAt: string;
  readonly readyMarker: string;
}

/** 进程完成退出与底层实例生命周期释放后生成的回执。 */
export interface ServerRuntimeStoppedReceipt {
  readonly snapshot: ServerRuntimeSnapshot;
}

export interface ServerRuntimeWaitOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/**
 * 长等待同时受 Invocation 取消与显式超时约束；结算时移除监听和计时器，
 * 不把已经取消的 Agent 调用残留到后续服务器生命周期。
 */
export function waitForRuntimeEvent<T>(
  operation: Promise<T>,
  options: ServerRuntimeWaitOptions,
  label: string,
): Promise<T> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new TypeError("server runtime wait timeout must be a positive safe integer");
  }
  options.signal?.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const abort = (): void => {
      finish(() => reject(options.signal?.reason ?? new Error(`${label}已取消`)));
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`${label}超时（${Math.ceil(options.timeoutMs / 1_000)} 秒）`)));
    }, options.timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    };
    const finish = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      complete();
    };

    options.signal?.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}
