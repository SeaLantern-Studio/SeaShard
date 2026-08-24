import {
  getServiceProviderMethod,
  resolveServiceResultValidators,
  validateServiceResult,
} from "@seashard/plugin-sdk";
import type {
  AgentActivityPresentationField,
  AgentResourceDefinition,
  AgentResourceImplementation,
  AgentResourceReadResult,
  AgentToolHandler,
  ExecutionContext,
  JsonValue,
  PluginContext,
  PluginModule,
  PluginStoredDocument,
  ServiceProvider,
  ServiceResultValidator,
} from "@seashard/plugin-sdk";
import {
  deserializeProtocolError,
  serializeProtocolError,
} from "@seashard/plugin-system/host-protocol";
import type {
  AgentCallCancellationPayload,
  AgentResourcePresentRequestPayload,
  AgentResourcePresentResultPayload,
  AgentResourceReadPayload,
  AgentResourceRegistrationPayload,
  AgentToolInvocationPayload,
  AgentToolRegistrationPayload,
  EventDispatchPayload,
  HostProtocolMessage,
  PrepareRuntimePayload,
  ProtocolNotification,
  ProtocolResponse,
  ProviderInvocationPayload,
  ServiceCallPayload,
  StorageDeletePayload,
  StorageGetPayload,
  StoragePutPayload,
} from "@seashard/plugin-system";
import { Context, type Fiber } from "cordis";

interface PreparedState {
  module: PluginModule;
  config: JsonValue;
  runtimeId: string;
  execution: ExecutionContext;
}

interface HostedServiceRegistration {
  readonly contract: string;
  readonly runtimeId: string;
  readonly provider: ServiceProvider;
  readonly resultValidators: Readonly<Record<string, ServiceResultValidator>>;
}

const pending = new Map<
  string,
  { resolve(value: JsonValue | undefined): void; reject(error: Error): void }
>();
const providers = new Map<string, HostedServiceRegistration>();
const eventHandlers = new Map<string, (payload: JsonValue) => Promise<void> | void>();
const agentToolHandlers = new Map<string, AgentToolHandler>();
const agentResourceImplementations = new Map<string, AgentResourceImplementation>();
const agentResourceCalls = new Map<string, AbortController>();
let requestCounter = 0;
let registrationCounter = 0;
let prepared: PreparedState | undefined;
let fiber: Fiber | undefined;
let root: Context | undefined;

process.on("message", (message: HostProtocolMessage) => {
  void receive(message);
});
process.once("disconnect", () => {
  void dispose().finally(() => process.exit());
});

async function receive(message: HostProtocolMessage): Promise<void> {
  if (message.type === "response") {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.ok) {
      request.resolve(message.value);
    } else {
      request.reject(deserializeProtocolError(message.error));
    }
    return;
  }
  if (message.type === "notification") {
    await receiveNotification(message);
    return;
  }

  try {
    const value = await executeCommand(message.command, message.payload);
    respond({
      type: "response",
      id: message.id,
      ok: true,
      ...(value === undefined ? {} : { value }),
    });
  } catch (error) {
    respond({ type: "response", id: message.id, ok: false, error: serializeProtocolError(error) });
  }
}

async function executeCommand(command: string, payload: JsonValue): Promise<JsonValue | undefined> {
  switch (command) {
    case "prepare":
      return prepare(payload as unknown as PrepareRuntimePayload);
    case "start":
      await start();
      return undefined;
    case "invoke-provider":
      return invokeProvider(payload as unknown as ProviderInvocationPayload);
    case "dispatch-event":
      await dispatchEvent(payload as unknown as EventDispatchPayload);
      return undefined;
    case "invoke-agent-tool":
      return invokeAgentTool(payload as unknown as AgentToolInvocationPayload);
    case "read-agent-resource":
      return (await readAgentResource(
        payload as unknown as AgentResourceReadPayload,
      )) as unknown as JsonValue;
    case "present-agent-resource-request":
      return (await presentAgentResourceRequest(
        payload as unknown as AgentResourcePresentRequestPayload,
      )) as unknown as JsonValue;
    case "present-agent-resource-result":
      return (await presentAgentResourceResult(
        payload as unknown as AgentResourcePresentResultPayload,
      )) as unknown as JsonValue;
    case "stop":
      await dispose();
      return undefined;
    default:
      throw new Error(`unknown plugin host command: ${command}`);
  }
}

async function prepare(payload: PrepareRuntimePayload): Promise<JsonValue> {
  if (prepared || fiber) throw new Error("plugin host is already prepared");
  const imported = (await import(payload.moduleUrl)) as Partial<PluginModule>;
  if (typeof imported.apply !== "function")
    throw new TypeError("plugin module must export apply(ctx, config)");
  const module = imported as PluginModule;
  const config = await validateConfig(module, payload.config);
  const dependencies = validateContracts(module.inject ?? [], "inject");
  const provides = validateContracts(module.provides ?? [], "provides");
  prepared = {
    module,
    config,
    runtimeId: payload.runtimeId,
    execution: payload.execution,
  };

  return { dependencies, provides };
}

async function start(): Promise<void> {
  if (!prepared) throw new Error("plugin host has not been prepared");
  if (fiber) throw new Error("plugin host is already active");
  root = new Context();
  const state = prepared;
  const plugin = {
    name: state.runtimeId,
    async apply(cordisContext: Context) {
      const pluginContext = createPluginContext(cordisContext, state);
      const cleanup = await state.module.apply(pluginContext, state.config);
      if (cleanup) cordisContext.effect(() => cleanup, "plugin module cleanup");
    },
  };
  const createdFiber = root.plugin(plugin);
  fiber = createdFiber;
  await createdFiber;
}

function createPluginContext(cordisContext: Context, state: PreparedState): PluginContext {
  return {
    execution: state.execution,
    runtimeId: state.runtimeId,
    storage: {
      async get(key) {
        return (await request("storage-get", {
          key,
        } satisfies StorageGetPayload)) as unknown as PluginStoredDocument | undefined;
      },
      async put(key, value, options) {
        const result = await request("storage-put", {
          key,
          value,
          ...(options ? { options } : {}),
        } satisfies StoragePutPayload);
        if (!result) throw new Error("plugin storage put returned no document");
        return result as unknown as PluginStoredDocument;
      },
      async delete(key, options) {
        const result = await request("storage-delete", {
          key,
          ...(options ? { options } : {}),
        } satisfies StorageDeletePayload);
        if (typeof result !== "boolean") {
          throw new Error("plugin storage delete returned an invalid result");
        }
        return result;
      },
    },
    effect(execute, label) {
      cordisContext.effect(async () => (await execute()) ?? (() => {}), label);
    },
    provide(contract, provider, options) {
      const registrationId = nextRegistrationId("service");
      const methods = Object.entries(provider);
      if (!methods.length || methods.some(([, method]) => typeof method !== "function")) {
        throw new TypeError(`service provider ${contract} must expose callable methods`);
      }
      providers.set(registrationId, {
        contract,
        runtimeId: state.runtimeId,
        provider,
        resultValidators: resolveServiceResultValidators(contract, provider, options),
      });
      notify("service-register", {
        registrationId,
        contract,
        methods: methods.map(([method]) => method),
      });
      cordisContext.effect(
        () => () => {
          providers.delete(registrationId);
          notify("service-unregister", { registrationId });
        },
        `service ${contract}`,
      );
    },
    service<T extends object>(contract: string): T {
      return new Proxy(
        {},
        {
          get(_target, property) {
            if (property === "then") return undefined;
            if (typeof property !== "string") return undefined;
            return (...args: JsonValue[]) =>
              request("call-service", {
                contract,
                method: property,
                args,
                execution: state.execution,
              } satisfies ServiceCallPayload);
          },
        },
      ) as T;
    },
    contribute(kind, value) {
      const registrationId = nextRegistrationId("contribution");
      notify("contribution-register", { registrationId, kind, value });
      cordisContext.effect(
        () => () => notify("contribution-unregister", { registrationId }),
        `contribution ${kind}`,
      );
      return registrationId;
    },
    agentTool(definition, execute) {
      const registrationId = nextRegistrationId("agent-tool");
      agentToolHandlers.set(registrationId, execute);
      notify("agent-tool-register", {
        registrationId,
        definition,
      } satisfies AgentToolRegistrationPayload);
      cordisContext.effect(
        () => () => {
          agentToolHandlers.delete(registrationId);
          notify("agent-tool-unregister", { registrationId });
        },
        `Agent tool ${definition.namespace}_${definition.name}`,
      );
      return registrationId;
    },
    agentResources(resources) {
      for (const [pattern, resource] of Object.entries(resources)) {
        const registrationId = nextRegistrationId("agent-resource");
        const { implementation, ...descriptor } = resource;
        const definition: AgentResourceDefinition = { pattern, ...descriptor };
        agentResourceImplementations.set(registrationId, implementation);
        notify("agent-resource-register", {
          registrationId,
          definition,
          hasPresentRequest: implementation.presentRequest !== undefined,
          hasPresentResult: implementation.presentResult !== undefined,
        } satisfies AgentResourceRegistrationPayload);
        cordisContext.effect(
          () => () => {
            agentResourceImplementations.delete(registrationId);
            notify("agent-resource-unregister", { registrationId });
          },
          `Agent resource ${pattern}`,
        );
      }
    },
    aiProviderType(definition) {
      throw new Error(`AI Provider Type ${definition.id} 必须由 Core Host 中的内建组件注册`);
    },
    on(event, handler) {
      const registrationId = nextRegistrationId("event");
      eventHandlers.set(registrationId, handler);
      notify("event-register", { registrationId, event });
      cordisContext.effect(
        () => () => {
          eventHandlers.delete(registrationId);
          notify("event-unregister", { registrationId });
        },
        `event ${event}`,
      );
    },
    async emit(event, payload) {
      await request("emit-event", { event, payload, execution: state.execution });
    },
  };
}

async function invokeProvider(payload: ProviderInvocationPayload): Promise<JsonValue | undefined> {
  const registration = providers.get(payload.registrationId);
  if (!registration) {
    throw new Error(`service registration is not active: ${payload.registrationId}`);
  }
  const method = getServiceProviderMethod(registration.provider, payload.method);
  if (!method) throw new Error(`service method does not exist: ${payload.method}`);
  const result = await method(...payload.args);
  const validator = Object.hasOwn(registration.resultValidators, payload.method)
    ? registration.resultValidators[payload.method]
    : undefined;
  await validateServiceResult(validator, result, {
    runtimeId: registration.runtimeId,
    contract: registration.contract,
    method: payload.method,
  });
  return result === undefined ? undefined : result;
}
async function dispatchEvent(payload: EventDispatchPayload): Promise<void> {
  const handler = eventHandlers.get(payload.registrationId);
  if (!handler) return;
  await handler(payload.payload);
}

async function invokeAgentTool(payload: AgentToolInvocationPayload): Promise<JsonValue> {
  const handler = agentToolHandlers.get(payload.registrationId);
  if (!handler) throw new Error(`Agent tool registration is not active: ${payload.registrationId}`);
  return handler(payload.input, {});
}

async function readAgentResource(
  payload: AgentResourceReadPayload,
): Promise<AgentResourceReadResult> {
  const implementation = requireAgentResourceImplementation(payload.registrationId);
  const controller = new AbortController();
  agentResourceCalls.set(payload.callId, controller);
  try {
    return await implementation.read(payload.request, { signal: controller.signal });
  } finally {
    agentResourceCalls.delete(payload.callId);
  }
}

async function presentAgentResourceRequest(
  payload: AgentResourcePresentRequestPayload,
): Promise<readonly AgentActivityPresentationField[]> {
  const implementation = requireAgentResourceImplementation(payload.registrationId);
  if (!implementation.presentRequest)
    throw new Error(`Agent resource has no request presenter: ${payload.registrationId}`);
  return implementation.presentRequest(payload.request);
}

async function presentAgentResourceResult(
  payload: AgentResourcePresentResultPayload,
): Promise<readonly AgentActivityPresentationField[]> {
  const implementation = requireAgentResourceImplementation(payload.registrationId);
  if (!implementation.presentResult)
    throw new Error(`Agent resource has no result presenter: ${payload.registrationId}`);
  return implementation.presentResult(payload.request, payload.result);
}

function requireAgentResourceImplementation(registrationId: string): AgentResourceImplementation {
  const implementation = agentResourceImplementations.get(registrationId);
  if (!implementation) {
    throw new Error(`Agent resource registration is not active: ${registrationId}`);
  }
  return implementation;
}
async function dispose(): Promise<void> {
  for (const controller of agentResourceCalls.values()) controller.abort("Plugin Host 正在停止");
  await fiber?.dispose();
  fiber = undefined;
  root = undefined;
  prepared = undefined;
  providers.clear();
  eventHandlers.clear();
  agentToolHandlers.clear();
  agentResourceImplementations.clear();
  agentResourceCalls.clear();
}

async function receiveNotification(message: ProtocolNotification): Promise<void> {
  if (message.event === "agent-call-cancel") {
    const payload = message.payload as unknown as AgentCallCancellationPayload;
    agentResourceCalls.get(payload.callId)?.abort("Agent 调用已取消");
    return;
  }
  if (message.event === "terminate") {
    await dispose();
    process.disconnect?.();
  }
}

function request(command: string, payload: unknown): Promise<JsonValue | undefined> {
  const id = `child:${++requestCounter}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ type: "request", id, command, payload: payload as JsonValue });
  });
}

function notify(event: string, payload: unknown): void {
  send({ type: "notification", event, payload: payload as JsonValue });
}

function respond(response: ProtocolResponse): void {
  send(response);
}

function send(message: HostProtocolMessage): void {
  if (!process.send) throw new Error("plugin host IPC channel is not available");
  process.send(message);
}

async function validateConfig(module: PluginModule, config: JsonValue): Promise<JsonValue> {
  if (!module.Config) return config;
  const result = await module.Config["~standard"].validate(config);
  if (result.issues?.length) {
    throw new TypeError(
      `plugin config is invalid: ${result.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  return (result.value ?? config) as JsonValue;
}

function validateContracts(values: readonly string[], exportName: string): string[] {
  const result = [...new Set(values)];
  if (result.some((value) => !/^[a-z0-9][a-z0-9.*:-]*$/.test(value))) {
    throw new TypeError(`plugin ${exportName} contains an invalid contract identifier`);
  }
  return result.sort((left, right) => left.localeCompare(right));
}

function nextRegistrationId(kind: string): string {
  return `${kind}:${++registrationCounter}`;
}
