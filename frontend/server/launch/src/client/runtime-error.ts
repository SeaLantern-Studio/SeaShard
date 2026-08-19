const electronInvocationPrefix = /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/u;
const missingJava25MessagePrefix = "未检测到已启用的 Java 25。";

/** Electron IPC 只负责传输错误；Renderer 不向用户暴露通道名和内部调用前缀。 */
export function runtimeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(electronInvocationPrefix, "").replace(/^Error:\s*/u, "");
}

/** 只有明确的 Java 25 运行时缺失错误需要阻塞式确认，其他启动错误仍留在原位置。 */
export function isMissingJava25RuntimeError(error: unknown): boolean {
  return runtimeErrorMessage(error).startsWith(missingJava25MessagePrefix);
}
