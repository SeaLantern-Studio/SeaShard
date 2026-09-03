import {
  serverWebApiVersion,
  type ServerWebApiError,
  type ServerWebBootstrapSnapshot,
  type ServerWebClientBootstrap,
  type ServerWebClientServiceRequest,
  type ServerWebClientServiceResponse,
  type ServerWebEventEnvelope,
  type ServerWebTaskKind,
} from "@seashard/server-web-api";
import {
  agentModelConfigurationChangedEvent,
  clientPluginAssetScheme,
  serverCoreSourceContract,
  serverInstanceManagerContract,
  type AgentModelConfigurationSnapshot,
} from "@seashard/contracts";
import type { JsonValue } from "@seashard/plugin-sdk";
import {
  projectClientEntryPublication,
  resolveClientPluginAssetPath,
  type PluginKernel,
} from "@seashard/plugin-system";
import { timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import {
  createServer as createHttpsServer,
  type ServerOptions as HttpsServerOptions,
} from "node:https";
import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { AuthError, ServerAdministratorAuth } from "./auth";
import { ServerWebStateCoordinator, WebStateError, type ServerWebHostSource } from "./state";

const defaultPort = 18_127;
const maximumRequestBytes = 64 * 1024;
const statePublishIntervalMilliseconds = 2_000;
const eventHeartbeatMilliseconds = 15_000;
const failedLoginWindowMilliseconds = 5 * 60 * 1_000;
const maximumFailedLogins = 5;

interface TlsOptions {
  readonly certificatePath: string;
  readonly keyPath: string;
}

interface ServerWebServiceControl {
  readonly token: string;
  readonly pid: number;
  readonly startedAt: string;
  requestShutdown(): void;
}
export interface StartServerWebOptions {
  readonly dataRoot: string;
  readonly publicRoot: string;
  readonly localHost?: ServerWebHostSource;
  readonly controller?: PluginKernel;
  readonly host?: string;
  readonly port?: number;
  readonly tls?: TlsOptions;
  readonly serviceControl?: ServerWebServiceControl;
}

export interface ServerWebAddress {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly url: string;
}

/** 独立 Server 的 HTTP/TLS 生命周期；不引用 Electron、Desktop IPC 或 Renderer 全局对象。 */
export class ServerWebRuntime {
  private disposeTask?: Promise<void>;

  constructor(
    readonly address: ServerWebAddress,
    private readonly server: HttpServer,
    private readonly state: ServerWebStateCoordinator,
    private readonly eventResponses: Set<ServerResponse>,
    private readonly stateTimer: ReturnType<typeof setInterval>,
    private readonly heartbeatTimer: ReturnType<typeof setInterval>,
    private readonly stopAgentModelConfiguration: (() => void) | undefined,
  ) {}

  dispose(): Promise<void> {
    this.disposeTask ??= (async () => {
      clearInterval(this.stateTimer);
      clearInterval(this.heartbeatTimer);
      this.stopAgentModelConfiguration?.();
      this.state.dispose();
      for (const response of this.eventResponses) response.end();
      this.eventResponses.clear();
      await closeServer(this.server);
    })();
    return this.disposeTask;
  }
}

export async function startServerWeb(options: StartServerWebOptions): Promise<ServerWebRuntime> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? defaultPort;
  if (!Number.isSafeInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
    throw new TypeError("Server Web 端口必须位于 0～65535");
  }

  const publicRoot = resolve(options.publicRoot);
  const indexPath = resolve(publicRoot, "index.html");
  if (!(await stat(indexPath).catch(() => undefined))?.isFile()) {
    throw new Error(`Server Web 前端尚未构建：${indexPath}`);
  }

  const auth = new ServerAdministratorAuth(options.dataRoot);
  const secure = Boolean(options.tls);
  if (!isLoopbackHost(host)) {
    if (!options.tls) throw new Error("非本机监听必须配置 TLS 证书和私钥");
    if (!(await auth.isConfigured())) {
      throw new Error("非本机监听前必须先在本机完成管理员设置");
    }
  }

  const state = new ServerWebStateCoordinator(options.localHost);
  const stopAgentModelConfiguration = options.controller?.events.on(
    agentModelConfigurationChangedEvent,
    "seashard.server-web",
    { type: "global", id: "global" },
    (configuration) => {
      state.publishAgentModelConfiguration(
        configuration as unknown as AgentModelConfigurationSnapshot,
      );
    },
  );
  const eventResponses = new Set<ServerResponse>();
  const failedLogins = new Map<string, number[]>();
  const requestHandler = (request: IncomingMessage, response: ServerResponse) => {
    void routeRequest({
      request,
      response,
      publicRoot,
      controller: options.controller,
      auth,
      state,
      secure,
      eventResponses,
      failedLogins,
      serviceControl: options.serviceControl,
    }).catch((error) => writeError(response, error));
  };
  const server = options.tls
    ? createHttpsServer(await readTlsOptions(options.tls), requestHandler)
    : createHttpServer(requestHandler);

  try {
    await listen(server, requestedPort, host);
  } catch (error) {
    state.dispose();
    stopAgentModelConfiguration?.();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    state.dispose();
    throw new Error("Server Web 未能取得监听地址");
  }
  const actualAddress: ServerWebAddress = {
    host,
    port: address.port,
    secure,
    url: `${secure ? "https" : "http"}://${formatUrlHost(host)}:${address.port}`,
  };
  const stateTimer = setInterval(
    () => void state.publishState().catch(() => undefined),
    statePublishIntervalMilliseconds,
  );
  const heartbeatTimer = setInterval(() => {
    for (const response of eventResponses) response.write(": heartbeat\n\n");
  }, eventHeartbeatMilliseconds);
  return new ServerWebRuntime(
    actualAddress,
    server,
    state,
    eventResponses,
    stateTimer,
    heartbeatTimer,
    stopAgentModelConfiguration,
  );
}

interface RequestContext {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly publicRoot: string;
  readonly controller?: PluginKernel;
  readonly auth: ServerAdministratorAuth;
  readonly state: ServerWebStateCoordinator;
  readonly secure: boolean;
  readonly eventResponses: Set<ServerResponse>;
  readonly failedLogins: Map<string, number[]>;
  readonly serviceControl?: ServerWebServiceControl;
}

async function routeRequest(context: RequestContext): Promise<void> {
  const { request, response, auth, secure } = context;
  applySecurityHeaders(response);
  const url = new URL(request.url ?? "/", requestOrigin(request, secure));
  const method = request.method ?? "GET";

  if (url.pathname === "/api/health" && method === "GET") {
    return writeJson(response, 200, runtimeHealth(context.serviceControl));
  }

  if (url.pathname === "/api/service/status" && method === "GET") {
    requireServiceControl(context);
    return writeJson(response, 200, runtimeHealth(context.serviceControl));
  }

  if (url.pathname === "/api/service/shutdown" && method === "POST") {
    const control = requireServiceControl(context);
    writeJson(response, 202, { ok: true });
    setImmediate(() => control.requestShutdown());
    return;
  }

  if (url.pathname === "/api/bootstrap" && method === "GET") {
    const session = auth.authenticate(request.headers.cookie);
    return writeJson(response, 200, {
      apiVersion: serverWebApiVersion,
      setupRequired: !(await auth.isConfigured()),
      authenticated: Boolean(session),
      ...(session ? { username: session.username } : {}),
    } satisfies ServerWebBootstrapSnapshot);
  }

  if (url.pathname === "/api/setup" && method === "POST") {
    requireSameOrigin(request, secure);
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      throw new HttpError(403, "LOCAL_SETUP_REQUIRED", "首次管理员设置只允许从本机访问");
    }
    const body = await readJsonBody(request);
    const session = await auth.setup(body.username, body.password);
    const token = await auth.login(body.username, body.password);
    response.setHeader("Set-Cookie", auth.sessionCookie(token, secure));
    return writeJson(response, 201, {
      apiVersion: serverWebApiVersion,
      setupRequired: false,
      authenticated: true,
      username: session.username,
    } satisfies ServerWebBootstrapSnapshot);
  }

  if (url.pathname === "/api/login" && method === "POST") {
    requireSameOrigin(request, secure);
    const remote = request.socket.remoteAddress ?? "unknown";
    rejectBlockedLogin(context.failedLogins, remote);
    const body = await readJsonBody(request);
    try {
      const token = await auth.login(body.username, body.password);
      context.failedLogins.delete(remote);
      response.setHeader("Set-Cookie", auth.sessionCookie(token, secure));
      return writeJson(response, 200, {
        apiVersion: serverWebApiVersion,
        setupRequired: false,
        authenticated: true,
        username: String(body.username).trim(),
      } satisfies ServerWebBootstrapSnapshot);
    } catch (error) {
      recordFailedLogin(context.failedLogins, remote);
      throw error;
    }
  }

  if (url.pathname === "/api/logout" && method === "POST") {
    requireSameOrigin(request, secure);
    auth.logout(request.headers.cookie);
    response.setHeader("Set-Cookie", auth.expiredSessionCookie(secure));
    return writeJson(response, 200, { ok: true });
  }

  const session = auth.authenticate(request.headers.cookie);
  if (url.pathname.startsWith("/api/") && !session) {
    throw new HttpError(401, "AUTH_REQUIRED", "请先登录 Server Controller");
  }

  if (url.pathname.startsWith("/api/server-assets/") && (method === "GET" || method === "HEAD")) {
    return serveServerImageAsset(
      requireController(context),
      url.pathname,
      response,
      method === "HEAD",
    );
  }

  if (url.pathname === "/api/client/bootstrap" && method === "GET") {
    return writeJson(response, 200, createClientBootstrap(requireController(context)));
  }
  if (url.pathname === "/api/client/services" && method === "POST") {
    requireSameOrigin(request, secure);
    const controller = requireController(context);
    const serviceRequest = parseClientServiceRequest(await readJsonBody(request));
    const result = await controller.callClientService(serviceRequest);
    return writeJson(response, 200, {
      ...(result === undefined ? {} : { result }),
      resultUndefined: result === undefined,
    } satisfies ServerWebClientServiceResponse);
  }
  if (url.pathname.startsWith("/api/client-assets/") && method === "GET") {
    return serveClientAsset(requireController(context), url.pathname, response);
  }

  if (url.pathname === "/api/state" && method === "GET") {
    return writeJson(response, 200, await context.state.snapshot());
  }
  if (url.pathname === "/api/events" && method === "GET") {
    return openEventStream(context, url);
  }

  const instanceRoute = matchInstanceRoute(url.pathname);
  if (instanceRoute?.operation === "logs" && method === "GET") {
    const after = readSequence(url.searchParams.get("after"));
    return writeJson(response, 200, {
      lines: await context.state.getLogs(instanceRoute.instanceId, after),
    });
  }
  if (
    instanceRoute &&
    (instanceRoute.operation === "start" ||
      instanceRoute.operation === "stop" ||
      instanceRoute.operation === "restart") &&
    method === "POST"
  ) {
    requireSameOrigin(request, secure);
    const task = context.state.startTask(
      instanceRoute.operation as ServerWebTaskKind,
      instanceRoute.instanceId,
    );
    return writeJson(response, 202, { task });
  }
  if (instanceRoute?.operation === "command" && method === "POST") {
    requireSameOrigin(request, secure);
    const body = await readJsonBody(request);
    await context.state.sendCommand(
      instanceRoute.instanceId,
      requireString(body.command, "command"),
    );
    return writeJson(response, 200, { accepted: true });
  }

  if (url.pathname.startsWith("/api/")) {
    throw new HttpError(404, "API_NOT_FOUND", "Server Web API 路径不存在");
  }
  if (method !== "GET" && method !== "HEAD") {
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "请求方法不受支持");
  }
  await serveStatic(context.publicRoot, url.pathname, response, method === "HEAD");
}

function requireController(context: RequestContext): PluginKernel {
  if (!context.controller) {
    throw new HttpError(503, "CONTROLLER_UNAVAILABLE", "Server Controller 功能尚未就绪");
  }
  return context.controller;
}

function createClientBootstrap(controller: PluginKernel): ServerWebClientBootstrap {
  const publication = projectClientEntryPublication(controller.clientEntrySnapshot());
  return {
    apiVersion: serverWebApiVersion,
    revision: publication.revision,
    entries: publication.entries.map((entry) => ({
      ...entry,
      module:
        entry.module.source === "builtin"
          ? entry.module
          : {
              source: "package",
              url: webClientAssetUrl(entry.module.url, entry.integrity),
            },
    })),
  };
}

function webClientAssetUrl(sourceUrl: string, integrity: string): string {
  const source = new URL(sourceUrl);
  if (
    source.protocol !== `${clientPluginAssetScheme}:` ||
    source.hostname !== integrity ||
    source.search ||
    source.hash
  ) {
    throw new TypeError("Client Entry 资源地址无效");
  }
  return `/api/client-assets/${integrity}${source.pathname}`;
}

async function serveClientAsset(
  controller: PluginKernel,
  pathname: string,
  response: ServerResponse,
): Promise<void> {
  const match = /^\/api\/client-assets\/([a-f0-9]{64})(\/.+)$/u.exec(pathname);
  if (!match) throw new HttpError(404, "CLIENT_ASSET_NOT_FOUND", "Client Entry 资源不存在");
  const target = await resolveClientPluginAssetPath(
    controller.clientEntrySnapshot(),
    `${clientPluginAssetScheme}://${match[1]}${match[2]}`,
  );
  if (!target) throw new HttpError(404, "CLIENT_ASSET_NOT_FOUND", "Client Entry 资源不存在");
  await serveFile(target, response, false, true);
}

interface ServerImagePathResolver {
  resolveIconPath(identity: string): Promise<string | null>;
}

/** 浏览器只提交受限图标身份；真实文件路径始终由 Host 领域 Service 解析。 */
async function serveServerImageAsset(
  controller: PluginKernel,
  pathname: string,
  response: ServerResponse,
  headOnly: boolean,
): Promise<void> {
  const match = /^\/api\/server-assets\/(core|instance)-icons\/([^/]+)$/u.exec(pathname);
  if (!match) throw new HttpError(404, "SERVER_ASSET_NOT_FOUND", "服务器图片资源不存在");

  const kind = match[1]!;
  let identity: string;
  try {
    identity = decodeURIComponent(match[2]!);
  } catch {
    throw new HttpError(400, "INVALID_PATH", "服务器图片资源路径编码无效");
  }
  const coreIcon = kind === "core";
  if (
    (coreIcon && !/^[a-f0-9]{64}$/u.test(identity)) ||
    (!coreIcon &&
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?::[A-Za-z0-9][A-Za-z0-9_-]{0,127})?$/u.test(identity))
  ) {
    throw new HttpError(404, "SERVER_ASSET_NOT_FOUND", "服务器图片资源不存在");
  }
  const resolver = controller.service<ServerImagePathResolver>(
    coreIcon ? serverCoreSourceContract : serverInstanceManagerContract,
  );
  const target = await resolver.resolveIconPath(identity);
  const metadata = target ? await stat(target).catch(() => undefined) : undefined;
  if (!target || !metadata?.isFile()) {
    throw new HttpError(404, "SERVER_ASSET_NOT_FOUND", "服务器图片资源不存在");
  }
  await serveFile(target, response, headOnly, coreIcon, metadata.size);
}

function parseClientServiceRequest(value: Record<string, unknown>): ServerWebClientServiceRequest {
  if (!Array.isArray(value.args) || value.args.length > 32) {
    throw new HttpError(400, "INVALID_CLIENT_REQUEST", "Client Service 参数无效");
  }
  const runtimeId = requireString(value.runtimeId, "runtimeId");
  const integrity = requireString(value.integrity, "integrity");
  const contract = requireString(value.contract, "contract");
  const method = requireString(value.method, "method");
  if (!/^[a-f0-9]{64}$/u.test(integrity) || !/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(method)) {
    throw new HttpError(400, "INVALID_CLIENT_REQUEST", "Client Service 调用身份无效");
  }
  return {
    runtimeId,
    integrity,
    contract,
    method,
    args: value.args.map((argument) => parseJsonValue(argument, 0)),
  };
}

function parseJsonValue(value: unknown, depth: number): JsonValue {
  if (depth > 32) {
    throw new HttpError(400, "INVALID_CLIENT_REQUEST", "Client Service 参数层级过深");
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => parseJsonValue(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, parseJsonValue(item, depth + 1)]),
    );
  }
  throw new HttpError(400, "INVALID_CLIENT_REQUEST", "Client Service 参数必须是 JSON 值");
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new HttpError(400, "INVALID_REQUEST", `${field} 必须是非空字符串`);
  }
  return value;
}

async function openEventStream(context: RequestContext, url: URL): Promise<void> {
  const { request, response, state, eventResponses } = context;
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  response.flushHeaders();
  eventResponses.add(response);

  const queued: ServerWebEventEnvelope[] = [];
  let ready = false;
  let lastWritten = readSequence(request.headers["last-event-id"] ?? url.searchParams.get("after"));
  const writeEvent = (event: ServerWebEventEnvelope) => {
    if (event.sequence <= lastWritten) return;
    lastWritten = event.sequence;
    response.write(
      `id: ${event.sequence}\nevent: ${event.event.type}\ndata: ${JSON.stringify(event.event)}\n\n`,
    );
  };
  const stopEvents = state.onEvent((event) => {
    if (ready) writeEvent(event);
    else queued.push(event);
  });
  try {
    response.write(
      `event: state\ndata: ${JSON.stringify({ type: "state", state: await state.snapshot() })}\n\n`,
    );
    for (const event of state.recentEvents(lastWritten)) writeEvent(event);
    ready = true;
    for (const event of queued) writeEvent(event);
  } catch (error) {
    stopEvents();
    eventResponses.delete(response);
    throw error;
  }
  request.once("close", () => {
    stopEvents();
    eventResponses.delete(response);
  });
}

async function serveStatic(
  publicRoot: string,
  pathname: string,
  response: ServerResponse,
  headOnly: boolean,
): Promise<void> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, "INVALID_PATH", "请求路径编码无效");
  }
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  let target = resolve(publicRoot, relative);
  if (target !== publicRoot && !target.startsWith(`${publicRoot}${sep}`)) {
    throw new HttpError(404, "NOT_FOUND", "页面不存在");
  }
  let metadata = await stat(target).catch(() => undefined);
  if (!metadata?.isFile() && !extname(relative)) {
    target = resolve(publicRoot, "index.html");
    metadata = await stat(target).catch(() => undefined);
  }
  if (!metadata?.isFile()) throw new HttpError(404, "NOT_FOUND", "页面不存在");
  await serveFile(target, response, headOnly, !target.endsWith("index.html"), metadata.size);
}

async function serveFile(
  target: string,
  response: ServerResponse,
  headOnly: boolean,
  immutable: boolean,
  knownSize?: number,
): Promise<void> {
  const size = knownSize ?? (await stat(target)).size;
  const body = headOnly ? undefined : await readFile(target);
  response.writeHead(200, {
    "Content-Type": contentType(target),
    "Content-Length": size,
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  response.end(body);
}

function matchInstanceRoute(
  pathname: string,
): { readonly instanceId: string; readonly operation: string } | undefined {
  const match = /^\/api\/instances\/([^/]+)\/(start|stop|restart|command|logs)$/u.exec(pathname);
  if (!match) return undefined;
  try {
    return { instanceId: decodeURIComponent(match[1]!), operation: match[2]! };
  } catch {
    throw new HttpError(400, "INVALID_PATH", "实例路径编码无效");
  }
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumRequestBytes) {
      throw new HttpError(413, "BODY_TOO_LARGE", "请求内容过大");
    }
    chunks.push(buffer);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "INVALID_JSON", "请求内容必须是 JSON 对象");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "INVALID_JSON", "请求内容必须是 JSON 对象");
  }
  return value as Record<string, unknown>;
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  const body = Buffer.from(`${JSON.stringify(value)}\n`);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function writeError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  const normalized = normalizeError(error);
  if (normalized.status === 500) console.error("[server-web] request failed", error);
  writeJson(response, normalized.status, {
    error: { code: normalized.code, message: normalized.message },
  } satisfies ServerWebApiError);
}

function normalizeError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof HttpError) return error;
  if (error instanceof AuthError) {
    return {
      status: error.code === "INVALID_CREDENTIALS" ? 401 : 400,
      code: error.code,
      message: error.message,
    };
  }
  if (error instanceof WebStateError) {
    return {
      status: error.code === "HOST_UNAVAILABLE" ? 503 : 400,
      code: error.code,
      message: error.message,
    };
  }
  return {
    status: 500,
    code: "INTERNAL_ERROR",
    message: "Server Controller 处理请求失败",
  };
}

function requireServiceControl(context: RequestContext): ServerWebServiceControl {
  const control = context.serviceControl;
  if (!control) throw new HttpError(404, "SERVICE_CONTROL_DISABLED", "后台服务控制未启用");
  if (!isLoopbackAddress(context.request.socket.remoteAddress)) {
    throw new HttpError(403, "LOCAL_SERVICE_CONTROL_REQUIRED", "后台服务控制只允许本机访问");
  }
  const authorization = context.request.headers.authorization;
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!secretEquals(token, control.token)) {
    throw new HttpError(401, "INVALID_SERVICE_TOKEN", "后台服务控制令牌无效");
  }
  return control;
}

function runtimeHealth(control: ServerWebServiceControl | undefined): {
  readonly status: "ready";
  readonly pid: number;
  readonly startedAt: string;
  readonly uptimeSeconds: number;
} {
  return {
    status: "ready",
    pid: control?.pid ?? process.pid,
    startedAt: control?.startedAt ?? new Date(Date.now() - process.uptime() * 1_000).toISOString(),
    uptimeSeconds: Math.max(0, process.uptime()),
  };
}

function secretEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function requireSameOrigin(request: IncomingMessage, secure: boolean): void {
  const origin = request.headers.origin;
  if (!origin) return;
  if (origin !== requestOrigin(request, secure)) {
    throw new HttpError(403, "ORIGIN_REJECTED", "请求来源不受信任");
  }
}

function requestOrigin(request: IncomingMessage, secure: boolean): string {
  const host = request.headers.host;
  if (!host) throw new HttpError(400, "HOST_REQUIRED", "请求缺少 Host 标头");
  return `${secure ? "https" : "http"}://${host}`;
}

function rejectBlockedLogin(attemptsByAddress: Map<string, number[]>, address: string): void {
  const attempts = recentLoginAttempts(attemptsByAddress.get(address) ?? []);
  attemptsByAddress.set(address, attempts);
  if (attempts.length >= maximumFailedLogins) {
    throw new HttpError(429, "LOGIN_RATE_LIMITED", "登录失败次数过多，请稍后再试");
  }
}

function recordFailedLogin(attemptsByAddress: Map<string, number[]>, address: string): void {
  attemptsByAddress.set(address, [
    ...recentLoginAttempts(attemptsByAddress.get(address) ?? []),
    Date.now(),
  ]);
}

function recentLoginAttempts(attempts: readonly number[]): number[] {
  const threshold = Date.now() - failedLoginWindowMilliseconds;
  return attempts.filter((attempt) => attempt >= threshold);
}

function readSequence(value: string | string[] | null | undefined): number {
  const source = Array.isArray(value) ? value[0] : value;
  if (!source) return 0;
  const sequence = Number(source);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new HttpError(400, "INVALID_SEQUENCE", "事件序号无效");
  }
  return sequence;
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

async function readTlsOptions(options: TlsOptions): Promise<HttpsServerOptions> {
  const [cert, key] = await Promise.all([
    readFile(options.certificatePath),
    readFile(options.keyPath),
  ]);
  return { cert, key, minVersion: "TLSv1.2" };
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function formatUrlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

function listen(server: HttpServer, port: number, host: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolvePromise();
    });
  });
}

function closeServer(server: HttpServer): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
}
