const electronInvocationPrefix = /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/u;

/** Electron IPC 只负责传输错误；Renderer 不向用户暴露通道名和内部调用前缀。 */
export function runtimeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(electronInvocationPrefix, "").replace(/^Error:\s*/u, "");
}
