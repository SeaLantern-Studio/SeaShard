import type { ServerRuntimeSupportedType } from "@seashard/contracts";

/**
 * BungeeCord 系代理核心没有 Minecraft 世界加载阶段；它们以监听代理端口作为可接入标志。
 * 这里使用核心身份决定匹配协议，避免只凭一段宽泛文本把普通日志误判为启动完成。
 */
const listeningReadyServerTypes = new Set<ServerRuntimeSupportedType>([
  "bungeecord",
  "lightfall",
  "travertine",
]);

const minecraftDonePattern =
  /\bDone \(\d+(?:\.\d+)?s\)!\s*(?:For help,\s*type\s+["']?help["']?|$)/u;
const localizedMinecraftDonePattern =
  /加载完成 \(\d+(?:\.\d+)?s\)！\s*如需帮助，请键入 "help" 或 "\?"/u;
const proxyListeningPattern = /\bListening on \/\S+:\d{1,5}\s*$/u;

/**
 * 判断一条核心控制台输出是否代表当前进程已经完成启动。
 * 标志来自各受支持核心的真实启动输出；调用方还需把匹配限定在当前 ActiveSession 内。
 */
export function matchesServerReadinessMarker(
  serverType: ServerRuntimeSupportedType,
  text: string,
): boolean {
  if (listeningReadyServerTypes.has(serverType)) return proxyListeningPattern.test(text);
  return minecraftDonePattern.test(text) || localizedMinecraftDonePattern.test(text);
}
