import type {
  ExecutionContext,
  JsonValue,
  PluginStorageDeleteOptions,
  PluginStoragePutOptions,
} from "@seashard/plugin-sdk";

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
  error?: string;
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
