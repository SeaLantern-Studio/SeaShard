import {
  agentModelConfigurationChangedEvent,
  agentModelConfigurationContract,
  agentInvocationContract,
  agentSessionContract,
  type AgentConversationMode,
  type AgentInvocationService,
  type AgentModelConfigurationService,
  type AgentModelConnectionMutation,
  type AgentModelSelection,
  type AgentSessionService,
  type AgentUserMessage,
} from "@seashard/contracts";
import type { JsonObject, JsonValue, PluginManifest, PluginModule } from "@seashard/plugin-sdk";
import { AgentRuntime, type AgentRuntimeOptions } from "./runtime";
import { registerBuiltInAgentProviderTypes } from "./provider-types";

export const agentRuntimeManifest: PluginManifest = {
  id: "seashard.agent-runtime",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "agent-runtime.host",
      runtime: "host",
      module: "./dist/host.js",
      hostProfiles: ["electron", "node", "docker"],
      activationScopes: ["global"],
      permissions: [],
    },
  ],
  compatibility: {
    seaShard: ">=0.0.0 <1.0.0",
  },
};

export function createAgentRuntimeModule(options: AgentRuntimeOptions): PluginModule {
  return {
    provides: [agentSessionContract, agentInvocationContract, agentModelConfigurationContract],
    async apply(context) {
      registerBuiltInAgentProviderTypes(context);
      const runtime = new AgentRuntime(options);
      await runtime.initialize();
      context.provide(agentSessionContract, {
        listModels: async () => asJsonValue(await runtime.listModels()),
        startSession: async (input) =>
          asJsonValue(await runtime.startSession(parseStartSessionInput(input))),
        sendMessage: async (input) =>
          asJsonValue(await runtime.sendMessage(parseSendMessageInput(input))),
        listSessions: async () => asJsonValue(await runtime.listSessions()),
        getSession: async (sessionId) =>
          asJsonValue(await runtime.getSession(requireString(sessionId, "sessionId"))),
        renameSession: async (sessionId, title) => {
          await runtime.renameSession(
            requireString(sessionId, "sessionId"),
            requireString(title, "title"),
          );
          return null;
        },
        deleteSession: async (sessionId) => {
          await runtime.deleteSession(requireString(sessionId, "sessionId"));
          return null;
        },
      } satisfies Record<
        keyof AgentSessionService,
        (...arguments_: unknown[]) => Promise<JsonValue>
      >);
      context.provide(agentInvocationContract, {
        getInvocation: async (invocationId) =>
          asJsonValue(await runtime.getInvocation(requireString(invocationId, "invocationId"))),
        cancelInvocation: async (invocationId) => {
          await runtime.cancelInvocation(requireString(invocationId, "invocationId"));
          return null;
        },
      } satisfies Record<
        keyof AgentInvocationService,
        (...arguments_: unknown[]) => Promise<JsonValue>
      >);
      context.provide(agentModelConfigurationContract, {
        getConfiguration: async () => asJsonValue(await runtime.getModelConfiguration()),
        mutateConnection: async (input) =>
          asJsonValue(
            await runtime.mutateModelConnection(parseModelConnectionMutationInput(input)),
          ),
        removeConnection: async (input) =>
          asJsonValue(await runtime.removeModelConnection(parseModelConnectionRemovalInput(input))),
        resetConfiguration: async (input) =>
          asJsonValue(
            await runtime.resetModelConfiguration(parseModelConfigurationResetInput(input)),
          ),
        discoverModels: async (input) =>
          asJsonValue(await runtime.discoverModels(parseProviderDiscoveryInput(input))),
        writeCredential: async (input) =>
          asJsonValue(await runtime.writeModelCredential(parseCredentialWriteInput(input))),
        removeCredential: async (input) =>
          asJsonValue(await runtime.removeModelCredential(parseCredentialRemovalInput(input))),
        openConfigurationFile: async () => {
          await runtime.openModelConfigurationFile();
          return null;
        },
      } satisfies Record<
        keyof AgentModelConfigurationService,
        (...arguments_: unknown[]) => Promise<JsonValue>
      >);
      const disposeModelChanges = runtime.onModelConfigurationChanged((snapshot) => {
        void context
          .emit(agentModelConfigurationChangedEvent, asJsonValue(snapshot))
          .catch(
            options.reportError ?? ((error) => console.error("Agent model event failed", error)),
          );
      });
      return async () => {
        disposeModelChanges();
        await runtime.dispose();
      };
    },
  };
}

function parseStartSessionInput(value: unknown): {
  initialMessage: AgentUserMessage;
  mode: AgentConversationMode;
  model?: AgentModelSelection;
} {
  const object = requireObject(value, "startSession input");
  return {
    initialMessage: parseUserMessage(object.initialMessage),
    mode: parseConversationMode(object.mode),
    ...(object.model === undefined ? {} : { model: parseModelSelection(object.model) }),
  };
}

function parseSendMessageInput(value: unknown): {
  sessionId: string;
  message: AgentUserMessage;
  mode: AgentConversationMode;
  model?: AgentModelSelection;
} {
  const object = requireObject(value, "sendMessage input");
  return {
    sessionId: requireString(object.sessionId, "sessionId"),
    message: parseUserMessage(object.message),
    mode: parseConversationMode(object.mode),
    ...(object.model === undefined ? {} : { model: parseModelSelection(object.model) }),
  };
}

function parseUserMessage(value: unknown): AgentUserMessage {
  const object = requireObject(value, "Agent user message");
  return { text: requireString(object.text, "message.text") };
}

function parseModelSelection(value: unknown): AgentModelSelection {
  const object = requireObject(value, "Agent model selection");
  return {
    connectionId: requireString(object.connectionId, "model.connectionId"),
    modelId: requireString(object.modelId, "model.modelId"),
  };
}

function parseModelConnectionMutationInput(value: unknown): {
  readonly expectedRevision: string;
  readonly connectionId: string;
  readonly operations: readonly AgentModelConnectionMutation[];
} {
  const object = requireObject(value, "model connection mutation");
  if (!Array.isArray(object.operations)) {
    throw new TypeError("model connection mutation operations must be an array");
  }
  return {
    expectedRevision: requireString(object.expectedRevision, "expectedRevision"),
    connectionId: requireString(object.connectionId, "connectionId"),
    operations: object.operations.map((operation, index) => {
      const record = requireObject(operation, `operations[${index}]`);
      if (!Array.isArray(record.path)) {
        throw new TypeError(`operations[${index}].path must be an array`);
      }
      const path = record.path.map((segment, pathIndex) =>
        requireString(segment, `operations[${index}].path[${pathIndex}]`),
      );
      if (record.op === "unset") return { op: "unset", path };
      if (record.op !== "set") {
        throw new TypeError(`operations[${index}].op must be set or unset`);
      }
      return {
        op: "set",
        path,
        value: requireJsonValue(record.value, `operations[${index}].value`),
      };
    }),
  };
}

function parseModelConnectionRemovalInput(value: unknown): {
  readonly expectedRevision: string;
  readonly connectionId: string;
} {
  const object = requireObject(value, "model connection removal");
  return {
    expectedRevision: requireString(object.expectedRevision, "expectedRevision"),
    connectionId: requireString(object.connectionId, "connectionId"),
  };
}

function parseModelConfigurationResetInput(value: unknown): {
  readonly expectedRevision: string;
} {
  const object = requireObject(value, "model configuration reset");
  return {
    expectedRevision: requireString(object.expectedRevision, "expectedRevision"),
  };
}

function parseProviderDiscoveryInput(value: unknown): {
  readonly providerType: string;
  readonly settings: JsonObject;
  readonly credentialId?: string;
  readonly credentialValue?: string;
} {
  const object = requireObject(value, "provider model discovery");
  return {
    providerType: requireString(object.providerType, "providerType"),
    settings: requireJsonObject(object.settings, "settings"),
    ...(object.credentialId === undefined
      ? {}
      : { credentialId: requireString(object.credentialId, "credentialId") }),
    ...(object.credentialValue === undefined
      ? {}
      : { credentialValue: requireString(object.credentialValue, "credential value") }),
  };
}

function parseCredentialWriteInput(value: unknown): {
  readonly credentialId: string;
  readonly value: string;
} {
  const object = requireObject(value, "credential write");
  return {
    credentialId: requireString(object.credentialId, "credentialId"),
    value: requireString(object.value, "credential value"),
  };
}

function parseCredentialRemovalInput(value: unknown): { readonly credentialId: string } {
  const object = requireObject(value, "credential removal");
  return { credentialId: requireString(object.credentialId, "credentialId") };
}

function parseConversationMode(value: unknown): AgentConversationMode {
  if (value !== "chat" && value !== "agent") {
    throw new TypeError("mode must be chat or agent");
  }
  return value;
}
function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireJsonValue(
  value: unknown,
  label: string,
  ancestors: ReadonlySet<object> = new Set(),
): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") throw new TypeError(`${label} must be JSON`);
  if (ancestors.has(value)) throw new TypeError(`${label} must not contain cycles`);
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      requireJsonValue(entry, `${label}[${index}]`, nextAncestors),
    );
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      requireJsonValue(entry, `${label}.${key}`, nextAncestors),
    ]),
  );
}

function requireJsonObject(value: unknown, label: string): JsonObject {
  const normalized = requireJsonValue(value, label);
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  return normalized;
}

function asJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}

export * from "./model-config";
export * from "./provider-types";
export * from "./credential-store";
export * from "./help-resource";
export * from "./local-resource";
export * from "./output-collector";
export * from "./runtime";
export * from "./session-journal";
