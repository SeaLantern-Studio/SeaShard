import type { Api, Model, Models, ThinkingLevel } from "@earendil-works/pi-ai";
import type {
  AgentConfiguredModel,
  AgentModelConfigurationSnapshot,
  AgentModelConnectionModel,
  AgentModelSelection,
} from "@seashard/contracts";
import type { AgentProviderCatalogModel, JsonObject } from "@seashard/plugin-sdk";
import type { AgentPiProviderConnection } from "../provider-types";

export type AgentProviderOptions = Record<string, JsonObject>;

export interface ResolvedAgentModel {
  readonly selection: AgentModelSelection;
  readonly models: Models;
  readonly model: Model<Api>;
  readonly requestOptions?: JsonObject;
  readonly reasoning?: ThinkingLevel;
}

export interface AgentProviderTypeSnapshot {
  readonly id: string;
  readonly displayName: string;
  readonly settingsSchema: JsonObject;
  readonly catalog?: readonly AgentProviderCatalogModel[];
  validateSettings(settings: JsonObject): void;
  create(input: {
    readonly connectionId: string;
    readonly settings: JsonObject;
    readonly apiKey?: string;
  }): object;
  discoverModels?(input: {
    readonly settings: JsonObject;
    readonly apiKey?: string;
    readonly signal: AbortSignal;
  }): Promise<readonly AgentProviderCatalogModel[]>;
}

export interface AgentProviderTypeSource {
  snapshot(): {
    readonly definitions: readonly AgentProviderTypeSnapshot[];
    resolve(id: string): AgentProviderTypeSnapshot | undefined;
  };
  onChanged(listener: () => void): () => void;
}

export interface AgentCredentialSource {
  initialize?(): Promise<void>;
  read(credentialId: string): string | undefined;
  write?(credentialId: string, value: string): Promise<void>;
  remove?(credentialId: string): Promise<void>;
  onChanged?(listener: () => void): () => void;
  dispose?(): Promise<void>;
}

export interface ParsedConnection {
  readonly id: string;
  readonly displayName?: string;
  readonly providerType: string;
  readonly credentialId?: string;
  readonly settings: JsonObject;
  readonly models?: readonly AgentModelConnectionModel[];
}

export interface EffectiveModel extends AgentConfiguredModel {
  readonly providerType: string;
  readonly providerOptions?: AgentProviderOptions;
  readonly connection: AgentPiProviderConnection;
  readonly piModel: Model<Api>;
}

export interface CatalogSnapshot {
  readonly revision: string;
  readonly source: string;
  readonly models: readonly EffectiveModel[];
  readonly configuration: AgentModelConfigurationSnapshot;
  readonly loadedAt: string;
}
