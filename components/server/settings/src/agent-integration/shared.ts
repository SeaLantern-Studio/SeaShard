import type { ServerSettingsSnapshot, ServerStartupDefaultsUpdate } from "@seashard/contracts";
import type { JsonObject, JsonValue } from "@seashard/plugin-sdk";

export type ServerSettingsAgentStartupDefaultsPatch = Partial<ServerStartupDefaultsUpdate>;

/** 设置组件在同一写队列中捕获前后快照，避免 Agent 自行拼接非原子的修改回执。 */
export interface ServerSettingsAgentMutationReceipt {
  readonly before: ServerSettingsSnapshot;
  readonly after: ServerSettingsSnapshot;
}

/** Agent 适配器只依赖设置组件公开的领域操作，不直接接触插件存储。 */
export interface ServerSettingsAgentRegistrationOptions {
  get(): Promise<ServerSettingsSnapshot>;
  setDefaultDownloadConnections(connections: number): Promise<ServerSettingsAgentMutationReceipt>;
  updateStartupDefaults(
    patch: ServerSettingsAgentStartupDefaultsPatch,
  ): Promise<ServerSettingsAgentMutationReceipt>;
}

interface ServerSettingsAgentProjectionField {
  readonly target: "root" | "startupDefaults";
  readonly outputKey: string;
  readonly sourceKey: keyof ServerSettingsSnapshot;
}

/**
 * Agent 可见设置只在这里登记一次。资源投影与 changed 判断都消费同一列表，
 * 新设置因此不会出现已经返回给模型却遗漏变化检测的分叉。
 */
const serverSettingsAgentProjectionFields = [
  {
    target: "root",
    outputKey: "defaultDownloadConnections",
    sourceKey: "defaultDownloadConnections",
  },
  {
    target: "startupDefaults",
    outputKey: "minimumMemoryMiB",
    sourceKey: "defaultMinimumMemoryMiB",
  },
  {
    target: "startupDefaults",
    outputKey: "maximumMemoryMiB",
    sourceKey: "defaultMaximumMemoryMiB",
  },
  {
    target: "startupDefaults",
    outputKey: "serverPort",
    sourceKey: "defaultServerPort",
  },
  {
    target: "startupDefaults",
    outputKey: "autoAcceptEula",
    sourceKey: "autoAcceptEula",
  },
  {
    target: "startupDefaults",
    outputKey: "jvmArguments",
    sourceKey: "defaultJvmArguments",
  },
] as const satisfies readonly ServerSettingsAgentProjectionField[];

/** Agent 投影有意舍弃 resourceDownloadDirectory，防止宿主目录通过资源或修改回执泄漏。 */
export function projectServerSettings(snapshot: ServerSettingsSnapshot): JsonObject {
  const startupDefaults: JsonObject = {};
  const projected: JsonObject = { startupDefaults };
  for (const field of serverSettingsAgentProjectionFields) {
    const target = field.target === "root" ? projected : startupDefaults;
    target[field.outputKey] = snapshot[field.sourceKey];
  }
  return projected;
}

/** 所有设置工具共用同一种前后快照回执，便于模型稳定判断幂等修改。 */
export function projectMutation(receipt: ServerSettingsAgentMutationReceipt): JsonObject {
  const before = projectServerSettings(receipt.before);
  const after = projectServerSettings(receipt.after);
  return {
    before,
    after,
    changed: serverSettingsAgentProjectionFields.some(
      ({ sourceKey }) => receipt.before[sourceKey] !== receipt.after[sourceKey],
    ),
  };
}

/** Schema 在 Registry 层校验，领域适配器仍执行同一份本地边界检查。 */
export function expectObject(
  value: JsonValue,
  label: string,
  allowedProperties?: Readonly<Record<string, true>>,
): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} 必须是对象`);
  }
  if (allowedProperties) {
    const unknownProperty = Object.keys(value).find((key) => allowedProperties[key] !== true);
    if (unknownProperty) throw new TypeError(`${label} 不支持参数 ${unknownProperty}`);
  }
  return value;
}

export function expectInteger(
  value: JsonValue | undefined,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new TypeError(`${field} 必须是 ${minimum} 到 ${maximum} 之间的安全整数`);
  }
  return value;
}
