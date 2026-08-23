import {
  agentInvocationContract,
  agentSessionContract,
  type AgentInvocationService,
  type AgentModelSelection,
  type AgentSessionService,
  type AgentUserMessage,
} from "@seashard/contracts";
import type { JsonValue, PluginManifest, PluginModule } from "@seashard/plugin-sdk";
import { AgentRuntime, type AgentRuntimeOptions } from "./runtime";

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
    provides: [agentSessionContract, agentInvocationContract],
    async apply(context) {
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
      return () => runtime.dispose();
    },
  };
}

function parseStartSessionInput(value: unknown): {
  initialMessage: AgentUserMessage;
  model?: AgentModelSelection;
} {
  const object = requireObject(value, "startSession input");
  return {
    initialMessage: parseUserMessage(object.initialMessage),
    ...(object.model === undefined ? {} : { model: parseModelSelection(object.model) }),
  };
}

function parseSendMessageInput(value: unknown): {
  sessionId: string;
  message: AgentUserMessage;
  model?: AgentModelSelection;
} {
  const object = requireObject(value, "sendMessage input");
  return {
    sessionId: requireString(object.sessionId, "sessionId"),
    message: parseUserMessage(object.message),
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

function asJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}

export * from "./model-config";
export * from "./runtime";
export * from "./session-journal";
