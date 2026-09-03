import type {
  ClientEntryPublication,
  ClientServiceCallRequest,
  ServerConsoleLine,
  ServerProcessState,
  ServerRuntimeSnapshot,
} from "@seashard/contracts";
import type { JsonValue } from "@seashard/plugin-sdk";

export const serverWebApiVersion = 1;

export interface ServerWebBootstrapSnapshot {
  readonly apiVersion: typeof serverWebApiVersion;
  readonly setupRequired: boolean;
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
