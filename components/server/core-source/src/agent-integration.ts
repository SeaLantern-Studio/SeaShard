import {
  formatServerCoreType,
  type ServerCoreArtifact,
  type ServerCoreType,
} from "@seashard/contracts";
import {
  defineAgentResource,
  type AgentActivityPresentationField,
  type AgentResource,
  type AgentResourceExecutionContext,
  type AgentResourceReadRequest,
  type AgentResourceReadResult,
  type JsonObject,
  type JsonValue,
  type PluginContext,
} from "@seashard/plugin-sdk";

const defaultPage = 1;
const defaultPageSize = 20;
const maximumPage = 10_000;
const maximumPageSize = 50;
const maximumQueryLength = 200;
const maximumIdentityLength = 128;

const catalogInputSchema: JsonObject = {
  type: "object",
  properties: {
    query: {
      type: "string",
      maxLength: maximumQueryLength,
      default: "",
      description: "按核心类型 ID、显示名称或 Minecraft 版本文本筛选。",
    },
    page: {
      type: "integer",
      minimum: 1,
      maximum: maximumPage,
      default: defaultPage,
      description: "页码，第一页为 1。",
    },
    pageSize: {
      type: "integer",
      minimum: 1,
      maximum: maximumPageSize,
      default: defaultPageSize,
      description: "每页返回数量，最大 50。",
    },
  },
  additionalProperties: false,
};

const pagedCatalogInputSchema: JsonObject = {
  type: "object",
  properties: {
    page: {
      type: "integer",
      minimum: 1,
      maximum: maximumPage,
      default: defaultPage,
      description: "页码，第一页为 1。",
    },
    pageSize: {
      type: "integer",
      minimum: 1,
      maximum: maximumPageSize,
      default: defaultPageSize,
      description: "每页返回数量，最大 50。",
    },
  },
  additionalProperties: false,
};

export interface ServerCoreCatalogAgentOptions {
  listTypes(): Promise<readonly ServerCoreType[]>;
  listVersions(serverType: string): Promise<readonly string[]>;
  listArtifacts(serverType: string, gameVersion: string): Promise<readonly ServerCoreArtifact[]>;
}

interface CatalogQuery {
  readonly query: string;
  readonly page: number;
  readonly pageSize: number;
}

/** 核心目录只发布后续创建实例所需的稳定身份；图标、下载地址和摘要继续留在 Host。 */
export function registerServerCoreCatalogAgentResources(
  context: Pick<PluginContext, "agentResources">,
  options: ServerCoreCatalogAgentOptions,
): void {
  context.agentResources({
    "server://core-types": createServerCoreTypesResource(options),
    "server://core-types/{serverType}/versions": createServerCoreVersionsResource(options),
    "server://core-types/{serverType}/versions/{gameVersion}/artifacts":
      createServerCoreArtifactsResource(options),
  });
}

export function createServerCoreTypesResource(
  options: ServerCoreCatalogAgentOptions,
): AgentResource {
  return defineAgentResource({
    description:
      "读取 SeaShard 核心目录中的服务器核心类型，支持按稳定类型 ID 或显示名称筛选；结果不包含图标地址或缓存路径。",
    inputSchema: catalogInputSchema,
    outputDescription: "返回核心类型 ID、用户可读名称和有界分页；serverType 可继续用于版本资源。",
    examples: [{ query: "paper", page: 1, pageSize: 20 }],
    presentation: { title: "读取服务器核心类型" },
    implementation: {
      read: (request, execution) => readServerCoreTypes(options, request, execution),
      presentRequest: presentCoreTypesRequest,
      presentResult: presentCatalogResult,
    },
  });
}

export function createServerCoreVersionsResource(
  options: ServerCoreCatalogAgentOptions,
): AgentResource {
  return defineAgentResource({
    description:
      "读取一个明确服务器核心类型支持的 Minecraft 版本；serverType 必须来自核心类型资源。",
    inputSchema: catalogInputSchema,
    outputDescription:
      "返回核心类型、匹配的 Minecraft 版本字符串和有界分页；gameVersion 可继续用于产物资源。",
    examples: [{ query: "1.21", page: 1, pageSize: 20 }],
    presentation: { title: "读取核心支持版本" },
    implementation: {
      read: (request, execution) => readServerCoreVersions(options, request, execution),
      presentRequest: presentCoreVersionsRequest,
      presentResult: presentCatalogResult,
    },
  });
}

export function createServerCoreArtifactsResource(
  options: ServerCoreCatalogAgentOptions,
): AgentResource {
  return defineAgentResource({
    description:
      "读取一个明确核心类型和 Minecraft 版本下可用于创建托管实例的核心产物；路径身份必须来自上级目录资源。",
    inputSchema: pagedCatalogInputSchema,
    outputDescription:
      "返回来源、核心类型、Minecraft 版本、稳定产物文件名和有界分页；不包含下载地址、SHA-256 或缓存路径。",
    examples: [{ page: 1, pageSize: 20 }],
    help: "创建托管实例时，把 artifactFileName 原样传给 server_create-instance。",
    presentation: { title: "读取服务器核心产物" },
    implementation: {
      read: (request, execution) => readServerCoreArtifacts(options, request, execution),
      presentRequest: presentCoreArtifactsRequest,
      presentResult: presentCatalogResult,
    },
  });
}

async function readServerCoreTypes(
  options: ServerCoreCatalogAgentOptions,
  request: AgentResourceReadRequest,
  execution: AgentResourceExecutionContext,
): Promise<AgentResourceReadResult> {
  execution.signal?.throwIfAborted();
  const query = parseCatalogQuery(request.input, true);
  const types = await options.listTypes();
  execution.signal?.throwIfAborted();
  const needle = query.query.toLocaleLowerCase("en-US");
  const filtered = types
    .map(({ id }) => ({ serverType: id, name: formatServerCoreType(id) }))
    .filter(
      ({ serverType, name }) =>
        !needle ||
        serverType.toLocaleLowerCase("en-US").includes(needle) ||
        name.toLocaleLowerCase("en-US").includes(needle),
    );
  return createPagedResult(filtered, query.page, query.pageSize);
}

async function readServerCoreVersions(
  options: ServerCoreCatalogAgentOptions,
  request: AgentResourceReadRequest,
  execution: AgentResourceExecutionContext,
): Promise<AgentResourceReadResult> {
  execution.signal?.throwIfAborted();
  const serverType = expectPathIdentity(request.pathParams.serverType, "serverType");
  const query = parseCatalogQuery(request.input, true);
  const versions = await options.listVersions(serverType);
  execution.signal?.throwIfAborted();
  const needle = query.query.toLocaleLowerCase("en-US");
  const filtered = versions.filter(
    (gameVersion) => !needle || gameVersion.toLocaleLowerCase("en-US").includes(needle),
  );
  return createPagedResult(filtered, query.page, query.pageSize, { serverType });
}

async function readServerCoreArtifacts(
  options: ServerCoreCatalogAgentOptions,
  request: AgentResourceReadRequest,
  execution: AgentResourceExecutionContext,
): Promise<AgentResourceReadResult> {
  execution.signal?.throwIfAborted();
  const serverType = expectPathIdentity(request.pathParams.serverType, "serverType");
  const gameVersion = expectPathIdentity(request.pathParams.gameVersion, "gameVersion");
  const query = parseCatalogQuery(request.input, false);
  const artifacts = await options.listArtifacts(serverType, gameVersion);
  execution.signal?.throwIfAborted();
  const projected = artifacts.map((artifact) => ({
    source: artifact.source,
    serverType: artifact.serverType,
    gameVersion: artifact.gameVersion,
    artifactFileName: artifact.fileName,
  }));
  return createPagedResult(projected, query.page, query.pageSize, { serverType, gameVersion });
}

function createPagedResult<T extends JsonValue>(
  items: readonly T[],
  page: number,
  pageSize: number,
  parent: JsonObject = {},
): AgentResourceReadResult {
  const start = (page - 1) * pageSize;
  const totalPages = Math.ceil(items.length / pageSize);
  return {
    mimeType: "application/json",
    content: {
      ...parent,
      items: items.slice(start, start + pageSize),
      pagination: {
        page,
        pageSize,
        totalItems: items.length,
        totalPages,
        hasMore: page < totalPages,
      },
    },
  };
}

function presentCoreTypesRequest(
  request: AgentResourceReadRequest,
): readonly AgentActivityPresentationField[] {
  const query = parseCatalogQuery(request.input, true);
  return presentPageRequest(query);
}

function presentCoreVersionsRequest(
  request: AgentResourceReadRequest,
): readonly AgentActivityPresentationField[] {
  const serverType = expectPathIdentity(request.pathParams.serverType, "serverType");
  return [
    { label: "核心", value: formatServerCoreType(serverType) },
    ...presentPageRequest(parseCatalogQuery(request.input, true)),
  ];
}

function presentCoreArtifactsRequest(
  request: AgentResourceReadRequest,
): readonly AgentActivityPresentationField[] {
  const serverType = expectPathIdentity(request.pathParams.serverType, "serverType");
  const gameVersion = expectPathIdentity(request.pathParams.gameVersion, "gameVersion");
  return [
    { label: "核心", value: formatServerCoreType(serverType) },
    { label: "版本", value: gameVersion },
    ...presentPageRequest(parseCatalogQuery(request.input, false)),
  ];
}

function presentPageRequest(query: CatalogQuery): readonly AgentActivityPresentationField[] {
  const start = (query.page - 1) * query.pageSize + 1;
  const end = start + query.pageSize - 1;
  return [
    ...(query.query ? [{ label: "搜索", value: query.query }] : []),
    { label: "范围", value: `${start}～${end}` },
  ];
}

function presentCatalogResult(
  _request: AgentResourceReadRequest,
  result: AgentResourceReadResult,
): readonly AgentActivityPresentationField[] {
  if (!result.content || typeof result.content !== "object" || Array.isArray(result.content)) {
    throw new TypeError("服务器核心目录结果必须是对象");
  }
  if (!Array.isArray(result.content.items)) {
    throw new TypeError("服务器核心目录结果缺少 items");
  }
  return [{ value: String(result.content.items.length), unit: "个结果" }];
}

function parseCatalogQuery(value: JsonValue, withQuery: boolean): CatalogQuery {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("服务器核心目录 input 必须是对象");
  }
  return {
    query: withQuery ? expectQuery(value.query) : "",
    page: expectPositiveInteger(value.page, "page") ?? defaultPage,
    pageSize: expectPositiveInteger(value.pageSize, "pageSize") ?? defaultPageSize,
  };
}

function expectQuery(value: JsonValue | undefined): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > maximumQueryLength) {
    throw new TypeError(`服务器核心目录 query 必须是不超过 ${maximumQueryLength} 个字符的字符串`);
  }
  return value.trim();
}

function expectPositiveInteger(value: JsonValue | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`服务器核心目录 ${field} 必须是正整数`);
  }
  return value;
}

function expectPathIdentity(value: string | undefined, field: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > maximumIdentityLength ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    throw new TypeError(`服务器核心目录 ${field} 必须是普通标识符`);
  }
  return value;
}
