import type { TSchema, Tool } from "@earendil-works/pi-ai";
import type {
  AgentActivityPresentationField,
  AgentResourceDefinition,
  JsonValue,
} from "@seashard/plugin-sdk";
import type { AgentRuntimeResourceSnapshot, AgentRuntimeTool } from "../runtime";
import { askPiTool, todoPiTool } from "./interactions";

const toolNamePattern = /^[A-Za-z0-9_-]+$/u;

export function indexToolDefinitions(
  definitions: readonly AgentRuntimeTool[],
): ReadonlyMap<string, AgentRuntimeTool> {
  const indexed = new Map<string, AgentRuntimeTool>();
  for (const entry of definitions) {
    if (!toolNamePattern.test(entry.name)) {
      throw new TypeError(`Agent 工具名称不合法：${entry.name}`);
    }
    const expectedName = `${entry.definition.namespace}_${entry.definition.name}`;
    if (entry.name !== expectedName) {
      throw new TypeError(`Agent 工具身份不一致：${entry.name} != ${expectedName}`);
    }
    if (!entry.definition.title.trim() || !entry.definition.description.trim()) {
      throw new TypeError(`Agent 工具缺少标题或描述：${entry.name}`);
    }
    if (indexed.has(entry.name)) throw new TypeError(`Agent 工具名称重复：${entry.name}`);
    indexed.set(entry.name, entry);
  }
  return indexed;
}

export function createPiTools(
  definitions: Iterable<AgentRuntimeTool>,
  resources: AgentRuntimeResourceSnapshot,
): readonly Tool[] {
  const tools: Tool[] = [askPiTool, todoPiTool];
  if (resources.definitions.length) {
    const resourceCatalog = formatResourceCatalog(resources.definitions);
    tools.push({
      name: "read",
      description: [
        "读取当前组件声明的只读资源 URI。每个资源自行定义 input 中的分页、过滤和排序参数。",
        "只能使用下面列出的 URI 模式；不要猜测或使用列表外的 scheme 和路径。",
        "",
        resourceCatalog,
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: `完整资源 URI，必须匹配当前可用模式：\n${formatResourcePatterns(
              resources.definitions,
            )}`,
          },
          input: {
            description: "资源专有读取参数，必须符合所选 URI 模式列出的输入 Schema",
          },
        },
        required: ["path", "input"],
        additionalProperties: false,
      } as unknown as TSchema,
    });
  }
  for (const entry of definitions) {
    tools.push({
      name: entry.name,
      description: entry.definition.description,
      // Registry 的既有 JSON Schema 保持原样；运行期仍由同一严格校验器裁决输入。
      parameters: entry.definition.inputSchema as unknown as TSchema,
    });
  }
  return tools;
}

export function parseResourceReadInput(value: JsonValue): {
  readonly path: string;
  readonly input: JsonValue;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("read 输入必须是对象");
  }
  const unexpected = Object.keys(value).filter((key) => key !== "path" && key !== "input");
  if (unexpected.length) throw new TypeError(`read 包含未知参数：${unexpected.join(", ")}`);
  if (typeof value.path !== "string" || !value.path.trim()) {
    throw new TypeError("read.path 必须是非空字符串");
  }
  if (!Object.hasOwn(value, "input")) throw new TypeError("read.input 是必填字段");
  return {
    path: value.path.trim(),
    input: value.input!,
  };
}

export async function safelyPresentAgentResource(
  present: () => Promise<readonly AgentActivityPresentationField[] | undefined>,
  reportError: (error: unknown) => void,
): Promise<readonly AgentActivityPresentationField[] | undefined> {
  try {
    return await present();
  } catch (error) {
    reportError(error);
    return undefined;
  }
}

/** 把当前 Invocation 真正可用的资源定义写进工具元数据，避免模型猜测路径和 input。 */
function formatResourceCatalog(definitions: readonly AgentResourceDefinition[]): string {
  return [
    "当前可用资源：",
    ...definitions.map((definition) =>
      [
        `- ${definition.pattern} — ${definition.description.replace(/\s+/gu, " ")}`,
        `  输入 Schema：${JSON.stringify(definition.inputSchema)}`,
        ...(definition.examples?.length
          ? [
              `  输入示例：${definition.examples.map((example) => JSON.stringify(example)).join("；")}`,
            ]
          : []),
        ...(definition.outputDescription
          ? [`  返回：${definition.outputDescription.replace(/\s+/gu, " ")}`]
          : []),
      ].join("\n"),
    ),
  ].join("\n");
}

function formatResourcePatterns(definitions: readonly AgentResourceDefinition[]): string {
  return definitions.map(({ pattern }) => `- ${pattern}`).join("\n");
}
