import { serverModLoaders, type ServerInstanceSnapshot } from "@seashard/contracts";
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

export interface ServerInstanceAgentResourceOptions {
  listInstances(): Promise<readonly ServerInstanceSnapshot[]>;
}

interface ServerInstancesQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly modLoader?: string;
}

interface ServerInstancesPage {
  readonly items: readonly JsonObject[];
  readonly pagination: {
    readonly page: number;
    readonly pageSize: number;
    readonly totalItems: number;
    readonly totalPages: number;
    readonly hasMore: boolean;
  };
}

const serverInstancesInputSchema: JsonObject = {
  type: "object",
  properties: {
    page: {
      type: "integer",
      minimum: 1,
      default: 1,
      description: "页码，第一页为 1。",
    },
    pageSize: {
      type: "integer",
      minimum: 1,
      maximum: 100,
      default: 10,
      description: "每页返回的服务器实例数量。",
    },
    modLoader: {
      type: "string",
      enum: [...serverModLoaders],
      description: "只返回指定模组加载器的服务器实例。",
    },
  },
  additionalProperties: false,
};

/**
 * 组装服务器实例资源。URI Pattern 留在组件注册位置，资源工厂只持有领域语义。
 */
export function createServerInstancesResource(
  options: ServerInstanceAgentResourceOptions,
): AgentResource {
  return defineAgentResource({
    description:
      "读取和筛选 SeaShard 已登记的服务器实例，包括名称、核心类型、Minecraft 版本、存储方式、来源和最近启动时间；结果不包含宿主文件路径。",
    inputSchema: serverInstancesInputSchema,
    outputDescription: "返回完整服务器实例条目和分页信息。",
    examples: [{ page: 1, pageSize: 10, modLoader: "fabric" }],
    presentation: {
      title: "读取服务器实例",
    },
    implementation: {
      read: (request, execution) => readServerInstances(options, request, execution),
      presentRequest: presentServerInstancesRequest,
      presentResult: presentServerInstancesResult,
    },
  });
}

/**
 * 实例组件在自己的 Fiber 中集中映射资源层级；Plugin Kernel 负责路由和自动注销。
 */
export function registerServerInstanceAgentResources(
  context: Pick<PluginContext, "agentResources">,
  options: ServerInstanceAgentResourceOptions,
): void {
  context.agentResources({
    "server://instances": createServerInstancesResource(options),
  });
}

async function readServerInstances(
  options: ServerInstanceAgentResourceOptions,
  request: AgentResourceReadRequest,
  _execution: AgentResourceExecutionContext,
): Promise<AgentResourceReadResult> {
  const query = parseServerInstancesQuery(request.input);
  const instances = await options.listInstances();
  const filtered = query.modLoader
    ? instances.filter(({ modLoader }) => modLoader === query.modLoader)
    : instances;
  const start = (query.page - 1) * query.pageSize;
  const items = filtered
    .slice(start, start + query.pageSize)
    .map((instance) => projectServerForAgent(instance));
  const totalPages = Math.ceil(filtered.length / query.pageSize);
  return {
    mimeType: "application/json",
    content: {
      items,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalItems: filtered.length,
        totalPages,
        hasMore: query.page < totalPages,
      },
    },
  };
}

function presentServerInstancesRequest(
  request: AgentResourceReadRequest,
): readonly AgentActivityPresentationField[] {
  const query = parseServerInstancesQuery(request.input);
  const start = (query.page - 1) * query.pageSize + 1;
  const end = start + query.pageSize - 1;
  return [
    { value: `${start}～${end}` },
    ...(query.modLoader ? [{ label: "类型", value: displayModLoader(query.modLoader) }] : []),
  ];
}

function presentServerInstancesResult(
  _request: AgentResourceReadRequest,
  result: AgentResourceReadResult,
): readonly AgentActivityPresentationField[] {
  const page = parseServerInstancesPage(result.content);
  return [{ value: String(page.items.length), unit: "个结果" }];
}

function parseServerInstancesQuery(value: JsonValue): ServerInstancesQuery {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("服务器实例资源 input 必须是对象");
  }
  return {
    page: readPositiveInteger(value.page, "page") ?? 1,
    pageSize: readPositiveInteger(value.pageSize, "pageSize") ?? 10,
    ...(typeof value.modLoader === "string" ? { modLoader: value.modLoader } : {}),
  };
}

function parseServerInstancesPage(value: JsonValue): ServerInstancesPage {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.items)) {
    throw new TypeError("服务器实例资源返回值缺少 items");
  }
  return value as unknown as ServerInstancesPage;
}

function readPositiveInteger(value: JsonValue | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`服务器实例资源 ${label} 必须是正整数`);
  }
  return value;
}

function displayModLoader(value: string): string {
  switch (value) {
    case "fabric":
      return "Fabric";
    case "forge":
      return "Forge";
    case "neoforge":
      return "NeoForge";
    case "quilt":
      return "Quilt";
    default:
      return value;
  }
}

/** 资源内容只保留回答问题需要的字段，绝不把宿主绝对路径交给模型。 */
function projectServerForAgent(instance: ServerInstanceSnapshot): JsonObject {
  const projected: JsonObject = {
    id: instance.id,
    name: instance.name,
    storageMode: instance.storageMode,
    source: instance.source,
    modLoader: instance.modLoader,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
  };
  if (instance.serverType) projected.serverType = instance.serverType;
  if (instance.gameVersion) projected.gameVersion = instance.gameVersion;
  if (instance.lastStartedAt) projected.lastStartedAt = instance.lastStartedAt;
  return projected;
}
