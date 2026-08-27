import type {
  AgentToolDefinition,
  AgentToolExecutionContext,
  AgentToolHandler,
  JsonObject,
  JsonValue,
  ScopeAddress,
} from "@seashard/plugin-sdk";
import { compileJsonSchemaValidator } from "../json-schema";

interface AgentToolRegistration {
  readonly id: string;
  readonly runtimeId: string;
  readonly scope: ScopeAddress;
  readonly name: string;
  readonly definition: AgentToolDefinition;
  readonly handler: AgentToolHandler;
  readonly validateInput: (value: JsonValue) => void;
  active: boolean;
}

export interface AgentToolSnapshot {
  readonly name: string;
  readonly definition: AgentToolDefinition;
  execute(input: JsonValue, context: AgentToolExecutionContext): Promise<JsonValue>;
}

/**
 * Agent 工具属于声明组件的运行时资源。快照保留稳定处理器，但组件停止后拒绝继续执行，
 * 防止已开始的 Agent Invocation 穿透已经销毁的 Cordis Fiber。
 */
export class AgentToolRegistry {
  private readonly registrations = new Map<string, AgentToolRegistration>();
  private counter = 0;

  register(
    runtimeId: string,
    scope: ScopeAddress,
    definition: AgentToolDefinition,
    handler: AgentToolHandler,
  ): { id: string; dispose: () => void } {
    if (typeof handler !== "function") throw new TypeError("Agent 工具处理器必须是函数");
    const normalized = normalizeAgentToolDefinition(definition);
    const name = `${normalized.namespace}_${normalized.name}`;
    const existing = this.registrations.get(name);
    if (existing) {
      throw new Error(`Agent 工具 ${name} 已由 ${existing.runtimeId} 注册`);
    }

    const registration: AgentToolRegistration = {
      id: `${runtimeId}:agent-tool:${++this.counter}`,
      runtimeId,
      scope: { ...scope },
      name,
      definition: normalized,
      validateInput: compileJsonSchemaValidator(normalized.inputSchema, `Agent 工具 ${name} 输入`),
      handler,
      active: true,
    };
    this.registrations.set(name, registration);
    return {
      id: registration.id,
      dispose: () => this.remove(registration),
    };
  }

  /** 每次 Invocation 开始时读取一次，保证单次模型闭环使用同一组工具。 */
  snapshot(): AgentToolSnapshot[] {
    return [...this.registrations.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((registration) => ({
        name: registration.name,
        definition: registration.definition,
        execute: async (input, context) => {
          if (!registration.active) {
            throw new Error(`Agent 工具已停止：${registration.name}`);
          }
          registration.validateInput(input);
          return registration.handler(input, context);
        },
      }));
  }

  removeRuntime(runtimeId: string): void {
    for (const registration of this.registrations.values()) {
      if (registration.runtimeId === runtimeId) this.remove(registration);
    }
  }

  countRuntime(runtimeId?: string): number {
    if (!runtimeId) return this.registrations.size;
    let count = 0;
    for (const registration of this.registrations.values()) {
      if (registration.runtimeId === runtimeId) count += 1;
    }
    return count;
  }

  private remove(registration: AgentToolRegistration): void {
    if (!registration.active) return;
    registration.active = false;
    if (this.registrations.get(registration.name) === registration) {
      this.registrations.delete(registration.name);
    }
  }
}

function normalizeAgentToolDefinition(definition: AgentToolDefinition): AgentToolDefinition {
  if (!definition || typeof definition !== "object") {
    throw new TypeError("Agent 工具定义必须是对象");
  }
  const namespace = validateAgentToolSegment(definition.namespace, "命名空间");
  const name = validateAgentToolSegment(definition.name, "名称");
  const title = requireAgentToolText(definition.title, "标题");
  const description = requireAgentToolText(definition.description, "描述");
  const confirmationLevel = definition.confirmationLevel;
  if (
    confirmationLevel !== undefined &&
    confirmationLevel !== 0 &&
    confirmationLevel !== 1 &&
    confirmationLevel !== 2
  ) {
    throw new TypeError(`Agent 工具 ${namespace}_${name} 的 confirmationLevel 必须是 0、1 或 2`);
  }
  if (
    !definition.inputSchema ||
    typeof definition.inputSchema !== "object" ||
    Array.isArray(definition.inputSchema)
  ) {
    throw new TypeError(`Agent 工具 ${namespace}_${name} 的 inputSchema 必须是对象`);
  }
  if (
    definition.outputDescription !== undefined &&
    (typeof definition.outputDescription !== "string" || !definition.outputDescription.trim())
  ) {
    throw new TypeError(`Agent 工具 ${namespace}_${name} 的输出描述不能为空`);
  }
  if (definition.examples !== undefined && !Array.isArray(definition.examples)) {
    throw new TypeError(`Agent 工具 ${namespace}_${name} 的 examples 必须是数组`);
  }
  return {
    namespace,
    name,
    title,
    description,
    ...(confirmationLevel === undefined ? {} : { confirmationLevel }),
    inputSchema: structuredClone(definition.inputSchema) as JsonObject,
    ...(definition.outputDescription === undefined
      ? {}
      : { outputDescription: definition.outputDescription.trim() }),
    ...(definition.examples === undefined
      ? {}
      : { examples: structuredClone(definition.examples) }),
  };
}

function validateAgentToolSegment(value: string, label: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]*$/u.test(value)) {
    throw new TypeError(`Agent 工具${label}不合法：${String(value)}`);
  }
  return value;
}

function requireAgentToolText(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`Agent 工具${label}不能为空`);
  }
  return value.trim();
}
