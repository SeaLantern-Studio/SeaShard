import { ServiceResultValidationError } from "@seashard/plugin-sdk";
import type {
  AgentActivityPresentationField,
  AgentResourceDefinition,
  AgentResourceReadRequest,
  AgentResourceReadResult,
  AgentToolDefinition,
  ExecutionContext,
  JsonValue,
  PluginStorageDeleteOptions,
  PluginStoragePutOptions,
} from "@seashard/plugin-sdk";

export interface ProtocolServiceResultValidationError {
  readonly runtimeId: string;
  readonly contract: string;
  readonly method: string;
  readonly issues: readonly {
    readonly path?: readonly (string | number)[];
    readonly message: string;
  }[];
}

export interface ProtocolError {
  readonly message: string;
  readonly serviceResultValidation?: ProtocolServiceResultValidationError;
}

/** Plugin Host 与 Core 之间保留返回值校验的结构化归责信息。 */
export function serializeProtocolError(error: unknown): ProtocolError {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  if (!(error instanceof ServiceResultValidationError)) return { message };
  return {
    message,
    serviceResultValidation: {
      runtimeId: error.runtimeId,
      contract: error.contract,
      method: error.method,
      issues: error.issues.map((issue) => ({
        ...(issue.path?.length
          ? {
              path: issue.path.map((segment) =>
                typeof segment === "number" ? segment : String(segment),
              ),
            }
          : {}),
        message: issue.message,
      })),
    },
  };
}

export function deserializeProtocolError(error: ProtocolError | undefined): Error {
  const validation = error?.serviceResultValidation;
  if (validation) {
    return new ServiceResultValidationError(
      validation.runtimeId,
      validation.contract,
      validation.method,
      validation.issues,
    );
  }
  return new Error(error?.message ?? "plugin host request failed");
}

export interface ProtocolRequest {
  type: "request";
  id: string;
  command: string;
  payload: JsonValue;
}

export interface ProtocolResponse {
  type: "response";
  id: string;
  ok: boolean;
  value?: JsonValue;
  error?: ProtocolError;
}

export interface ProtocolNotification {
  type: "notification";
  event: string;
  payload: JsonValue;
}

export type HostProtocolMessage = ProtocolRequest | ProtocolResponse | ProtocolNotification;

export interface PrepareRuntimePayload {
  moduleUrl: string;
  config: JsonValue;
  runtimeId: string;
  execution: ExecutionContext;
}

export interface PreparedRuntimePayload {
  dependencies: string[];
  provides: string[];
}

export interface ServiceRegistrationPayload {
  registrationId: string;
  contract: string;
  methods: string[];
}

export interface ServiceUnregistrationPayload {
  registrationId: string;
}

export interface ContributionRegistrationPayload {
  registrationId: string;
  kind: string;
  value: JsonValue;
}

export interface EventRegistrationPayload {
  registrationId: string;
  event: string;
}

export interface AgentToolRegistrationPayload {
  registrationId: string;
  definition: AgentToolDefinition;
}

export interface AgentToolInvocationPayload {
  registrationId: string;
  input: JsonValue;
}

export interface AgentResourceRegistrationPayload {
  registrationId: string;
  definition: AgentResourceDefinition;
  hasPresentRequest: boolean;
  hasPresentResult: boolean;
}

export interface AgentResourceReadPayload {
  callId: string;
  registrationId: string;
  request: AgentResourceReadRequest;
}

export interface AgentResourcePresentRequestPayload {
  registrationId: string;
  request: AgentResourceReadRequest;
}

export interface AgentResourcePresentResultPayload {
  registrationId: string;
  request: AgentResourceReadRequest;
  result: AgentResourceReadResult;
}

export type AgentResourceReadResponsePayload = AgentResourceReadResult;
export type AgentResourcePresentationResponsePayload = readonly AgentActivityPresentationField[];

export interface AgentCallCancellationPayload {
  callId: string;
}

export interface ServiceCallPayload {
  contract: string;
  method: string;
  args: JsonValue[];
  execution: ExecutionContext;
}

export interface ProviderInvocationPayload {
  registrationId: string;
  method: string;
  args: JsonValue[];
}

export interface EventDispatchPayload {
  registrationId: string;
  payload: JsonValue;
}

export interface StorageGetPayload {
  key: string;
}

export interface StoragePutPayload {
  key: string;
  value: JsonValue;
  options?: PluginStoragePutOptions;
}

export interface StorageDeletePayload {
  key: string;
  options?: PluginStorageDeleteOptions;
}
