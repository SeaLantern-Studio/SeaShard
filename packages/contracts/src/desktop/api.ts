import type { JsonValue } from "@seashard/plugin-sdk";
import type { AgentClientService, AgentModelConfigurationClientService } from "../agent";
import type { RuntimeSnapshot } from "../plugin";
import type {
  FileDownloadClientService,
  JavaRuntimeClientService,
  ServerConfigurationClientService,
  ServerCoreDownloadClientService,
  ServerCoreSourceClientService,
  ServerInstanceClientService,
  ServerModSourceClientService,
  ServerRuntimeClientService,
  ServerSettingsClientService,
} from "../server";
import type { ClientServiceCallRequest, DesktopClientBootstrap } from "./client";

export interface SeaShardDesktopApi {
  runtime: {
    getSnapshot(): Promise<RuntimeSnapshot>;
  };
  agent: AgentClientService;
  serverCore: ServerCoreSourceClientService;
  agentModels: AgentModelConfigurationClientService;
  serverSettings: ServerSettingsClientService;
  serverCoreDownload: ServerCoreDownloadClientService;
  fileDownloads: FileDownloadClientService;
  serverMods: ServerModSourceClientService;
  serverInstances: ServerInstanceClientService;
  serverRuntime: ServerRuntimeClientService;
  serverConfiguration: ServerConfigurationClientService;
  javaRuntime: JavaRuntimeClientService;
  dialog: {
    selectDirectory(): Promise<string | undefined>;
  };
  client: {
    getBootstrap(): Promise<DesktopClientBootstrap>;
    onBootstrapChanged(listener: (snapshot: DesktopClientBootstrap) => void): () => void;
    ready(): Promise<void>;
    callService(request: ClientServiceCallRequest): Promise<JsonValue | void>;
  };
  window: {
    minimize(): Promise<void>;
    toggleMaximize(): Promise<boolean>;
    close(): Promise<void>;
  };
}
