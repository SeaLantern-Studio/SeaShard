const electronInvocationPrefix = /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/u;
const missingJavaMessagePrefix = /^未检测到已启用的 Java \d+。/u;

/** Electron IPC 只负责传输错误；Renderer 不向用户暴露通道名和内部调用前缀。 */
export function runtimeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(electronInvocationPrefix, "").replace(/^Error:\s*/u, "");
}

/** 任意明确的 Java 主版本缺失都需要阻塞式确认，避免错误挤在启动按钮下方。 */
export function isMissingJavaRuntimeError(error: unknown): boolean {
  return missingJavaMessagePrefix.test(runtimeErrorMessage(error));
}
