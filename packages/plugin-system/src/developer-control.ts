import type { RuntimeControlSnapshot } from "@seashard/plugin-sdk";
import type { PluginRuntimeLifecycleRecord } from "./runtime";
import type { ServiceRuntimeSnapshot } from "./runtime-registries";

export const pluginDeveloperControlProtocolVersion = 1 as const;

/** CLI 写入临时目录的本机会话发现记录；令牌只用于同一用户的进程间鉴别。 */
export interface PluginDeveloperSessionDescriptor {
  readonly protocolVersion: typeof pluginDeveloperControlProtocolVersion;
  readonly sessionId: string;
  readonly token: string;
  readonly socketPath: string;
  readonly descriptorPath: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly mode: "development" | "operation";
  readonly pluginRoot?: string;
  readonly pluginId?: string;
  readonly runtimeIds: readonly string[];
}

/** CLI 通过环境变量交给 Desktop Main 的启动参数。 */
export interface PluginDeveloperControlLaunch {
  readonly protocolVersion: typeof pluginDeveloperControlProtocolVersion;
  readonly sessionId: string;
  readonly token: string;
  readonly socketPath: string;
  readonly descriptorPath: string;
  readonly mode: "development" | "operation";
  readonly pluginRoot?: string;
}

export type PluginDeveloperControlRequest =
  | {
      readonly id: string;
      readonly token: string;
      readonly action: "snapshot";
    }
  | {
      readonly id: string;
      readonly token: string;
      readonly action: "refresh";
    }
  | {
      readonly id: string;
      readonly token: string;
      readonly action: "reload";
      readonly runtimeId?: string;
    }
  | {
      readonly id: string;
      readonly token: string;
      readonly action: "logs";
      readonly runtimeId?: string;
    }
  | {
      readonly id: string;
      readonly token: string;
      readonly action: "install";
      readonly sourcePath: string;
      readonly source: "archive" | "directory";
    }
  | {
      readonly id: string;
      readonly token: string;
      readonly action: "shutdown";
    };

export interface PluginDeveloperHostSnapshot {
  readonly session: PluginDeveloperSessionDescriptor;
  readonly runtime: RuntimeControlSnapshot;
  readonly services: readonly ServiceRuntimeSnapshot[];
}

export interface PluginDeveloperInstallResult {
  readonly pluginId: string;
  readonly version: string;
  readonly digest: string;
  readonly source: "installed";
}

export interface PluginDeveloperControlResults {
  readonly snapshot: PluginDeveloperHostSnapshot;
  readonly refresh: PluginDeveloperHostSnapshot;
  readonly reload: PluginDeveloperHostSnapshot;
  readonly logs: readonly PluginRuntimeLifecycleRecord[];
  readonly install: PluginDeveloperInstallResult;
  readonly shutdown: { readonly accepted: true };
}

export type PluginDeveloperControlSuccess = {
  [Action in keyof PluginDeveloperControlResults]: {
    readonly id: string;
    readonly ok: true;
    readonly action: Action;
    readonly result: PluginDeveloperControlResults[Action];
  };
}[keyof PluginDeveloperControlResults];

export interface PluginDeveloperControlFailure {
  readonly id: string;
  readonly ok: false;
  readonly error: string;
}

export type PluginDeveloperControlResponse =
  | PluginDeveloperControlSuccess
  | PluginDeveloperControlFailure;
