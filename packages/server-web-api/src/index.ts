import type {
  AgentModelConfigurationSnapshot,
  ClientEntryPublication,
  ClientServiceCallRequest,
  ServerConsoleLine,
  ServerProcessState,
  ServerRuntimeSnapshot,
} from "@seashard/contracts";
import type { JsonValue } from "@seashard/plugin-sdk";

export const serverWebApiVersion = 1;

export type ServerWebAppearanceTheme = "auto" | "light" | "dark";
export type ServerWebAppearanceColor = "default" | "ocean" | "rose" | "sunset" | "midnight";
export type ServerWebBackgroundSize = "cover" | "contain" | "fill" | "auto";

/** Server Controller 统一保存的网页外观；窗口材质字段有意不进入该边界。 */
export interface ServerWebAppearanceSettings {
  readonly color: ServerWebAppearanceColor;
  readonly theme: ServerWebAppearanceTheme;
  readonly fontSize: number;
  readonly fontFamily: string;
  readonly minimalMode: boolean;
  readonly backgroundImage: string;
  readonly backgroundOpacity: number;
  readonly backgroundBlur: number;
  readonly backgroundBrightness: number;
  readonly backgroundSize: ServerWebBackgroundSize;
}

export interface ServerWebAppearanceSnapshot {
  readonly settings: ServerWebAppearanceSettings;
  readonly revision: number;
  readonly updatedAt?: string;
}

export interface ServerWebHostControllerSnapshot {
  readonly sessionId: string;
  readonly label: string;
}

export interface ServerWebHostControlRequestSnapshot {
  readonly requestId: string;
  readonly requester: ServerWebHostControllerSnapshot;
  readonly requestedAt: string;
}

export interface ServerWebBootstrapSnapshot {
  readonly apiVersion: typeof serverWebApiVersion;
  readonly setupRequired: boolean;
  readonly controllerVersion: string;
  readonly authenticated: boolean;
  readonly username?: string;
}

export interface ServerWebHostSnapshot {
  readonly id: "local";
  readonly connected: boolean;
  readonly hasControl: boolean;
  readonly hostVersion?: string;
  readonly packageType?: string;
  readonly connectedControllers: number;
  readonly revision: number;
  readonly controllerSessionId: string;
  readonly holder?: ServerWebHostControllerSnapshot;
  readonly pending?: ServerWebHostControlRequestSnapshot;
}

export interface ServerWebInstanceSnapshot {
  readonly id: string;
  readonly name: string;
  readonly storageMode: "managed" | "external";
  readonly source: "downloaded" | "imported";
  readonly serverType?: string;
  readonly gameVersion?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastStartedAt?: string;
  readonly totalRuntimeMs?: number;
  readonly runtime: ServerRuntimeSnapshot;
}

export type ServerWebTaskKind = "start" | "stop" | "restart";
export type ServerWebTaskState = "running" | "succeeded" | "failed";

export interface ServerWebTaskSnapshot {
  readonly id: string;
  readonly kind: ServerWebTaskKind;
  readonly instanceId: string;
  readonly state: ServerWebTaskState;
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly resultState?: ServerProcessState;
  readonly error?: string;
}

export interface ServerWebStateSnapshot {
  readonly apiVersion: typeof serverWebApiVersion;
  readonly generatedAt: string;
  readonly host: ServerWebHostSnapshot;
  readonly instances: readonly ServerWebInstanceSnapshot[];
  readonly tasks: readonly ServerWebTaskSnapshot[];
}

export type ServerWebEvent =
  | { readonly type: "state"; readonly state: ServerWebStateSnapshot }
  | { readonly type: "console-line"; readonly line: ServerConsoleLine }
  | {
      readonly type: "agent-model-configuration";
      readonly configuration: AgentModelConfigurationSnapshot;
    }
  | { readonly type: "client-bootstrap"; readonly bootstrap: ServerWebClientBootstrap }
  | { readonly type: "task"; readonly task: ServerWebTaskSnapshot };

export interface ServerWebEventEnvelope {
  readonly sequence: number;
  readonly event: ServerWebEvent;
}

export interface ServerWebTaskAccepted {
  readonly task: ServerWebTaskSnapshot;
}

export interface ServerWebApiError {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

export interface ServerWebClientBootstrap extends ClientEntryPublication {
  readonly apiVersion: typeof serverWebApiVersion;
}

export interface ServerWebClientServiceRequest extends ClientServiceCallRequest {}

export interface ServerWebClientServiceResponse {
  readonly result?: JsonValue;
  readonly resultUndefined: boolean;
}
