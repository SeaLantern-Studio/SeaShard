import { HostControlRpcError } from "@seashard/host-control";
import type {
  AgentResource,
  AgentResourceDefinition,
  AgentResourceReadResult,
  AgentToolDefinition,
  ScopeAddress,
} from "@seashard/plugin-sdk";
import type { PluginKernel } from "@seashard/plugin-system";
import type { ServerLocalHostConnection } from "./local-host";

const gatewayRuntimeId = "core.server-host-agent-extensions";
const gatewayScope = { type: "global", id: "global" } as const satisfies ScopeAddress;

/**
 * 把 Host 已注册的领域 Agent 能力投影到 Server Controller。
 * 定义与展示信息在 Controller 中参与 Agent 编排，真正的读取和修改仍回到 Host 执行，
 * 因而不会复制服务器运行状态，也不会绕过 Host 的唯一写控制权。
 */
export class ServerHostAgentExtensionGateway {
  private readonly disposers: Array<() => void> = [];
  private fingerprint: string | undefined;

  private constructor(
    private readonly kernel: PluginKernel,
    private readonly host: ServerLocalHostConnection,
  ) {}

  static async register(
    kernel: PluginKernel,
    host: ServerLocalHostConnection,
  ): Promise<ServerHostAgentExtensionGateway | undefined> {
    const gateway = new ServerHostAgentExtensionGateway(kernel, host);
    try {
      await gateway.synchronize();
      return gateway;
    } catch (error) {
      if (
        error instanceof HostControlRpcError &&
        (error.code === "INVALID_ACTION" || error.code === "UNSUPPORTED_ACTION")
      ) {
        gateway.dispose();
        return undefined;
      }
      throw error;
    }
  }

  /** Host Worker 变化后可重复同步；目录未变化时不扰动正在进行的 Agent Invocation。 */
  async synchronize(): Promise<void> {
    const directory = await this.host.describeAgentExtensions();
    const fingerprint = JSON.stringify(directory);
    if (fingerprint === this.fingerprint) return;

    this.clearRegistrations();
    try {
      for (const tool of directory.tools) this.registerTool(tool.name, tool.definition);
      for (const resource of directory.resources) this.registerResource(resource);
      this.fingerprint = fingerprint;
    } catch (error) {
      this.clearRegistrations();
      throw error;
    }
  }

  dispose(): void {
    this.clearRegistrations();
  }

  private registerTool(name: string, definition: AgentToolDefinition): void {
    const declaredName = `${definition.namespace}_${definition.name}`;
    if (name !== declaredName) {
      throw new TypeError(`Host Agent 工具身份不一致：${name} != ${declaredName}`);
    }
    const registration = this.kernel.agentTools.register(
      gatewayRuntimeId,
      gatewayScope,
      definition,
      async (input, execution) => {
        execution.signal?.throwIfAborted();
        const result = await this.host.executeAgentTool(name, input);
        execution.signal?.throwIfAborted();
        return result;
      },
    );
    this.disposers.push(registration.dispose);
  }

  private registerResource(definition: AgentResourceDefinition): void {
    const { pattern, ...descriptor } = definition;
    const resource: AgentResource = {
      ...descriptor,
      implementation: {
        read: async (request, execution): Promise<AgentResourceReadResult> => {
          execution.signal?.throwIfAborted();
          const result = await this.host.readAgentResource(request.uri.href, request.input);
          execution.signal?.throwIfAborted();
          return result;
        },
        presentRequest: async (request) =>
          (await this.host.presentAgentResourceRequest(request.uri.href, request.input)) ?? [],
        presentResult: async (request, result) =>
          (await this.host.presentAgentResourceResult(request.uri.href, request.input, result)) ??
          [],
      },
    };
    const registration = this.kernel.agentResources.register(
      gatewayRuntimeId,
      gatewayScope,
      pattern,
      resource,
    );
    this.disposers.push(registration.dispose);
  }

  private clearRegistrations(): void {
    this.fingerprint = undefined;
    for (const dispose of this.disposers.splice(0).reverse()) dispose();
  }
}
