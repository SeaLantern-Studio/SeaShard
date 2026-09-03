import type { JsonValue } from "@seashard/plugin-sdk";

export const hostControlProtocolVersion = 1;

export const hostWorkerDeploymentContract = "seashard.internal.host-worker-deployment";
export const legacyHostMigrationContract = "seashard.internal.legacy-host-migration";
export const hostLifecycleContract = "seashard.internal.host-lifecycle";

export interface LegacyHostMigrationBindingSnapshot {
  readonly entryId: string;
  readonly enabled: boolean;
  readonly config: JsonValue;
}

export interface LegacyHostMigrationPackageSnapshot {
  readonly pluginId: string;
  readonly rootPath: string;
  readonly bindings: readonly LegacyHostMigrationBindingSnapshot[];
}

export interface LegacyHostMigrationSnapshot {
  readonly documentsCompleted: boolean;
  readonly packages: readonly LegacyHostMigrationPackageSnapshot[];
}

export type HostPackageType = "appimage" | "deb" | "nsis" | "pkg";

export interface HostControlDescriptor {
  readonly protocolVersion: typeof hostControlProtocolVersion;
  readonly socketPath: string;
  readonly descriptorPath: string;
  readonly token: string;
  readonly pid: number;
  readonly startedAt: string;
  /** 旧版 Host 描述文件没有该字段；Controller 将缺失版本视为可独立升级。 */
  readonly seaShardVersion?: string;
  /** 安装包类型由 Host 自己报告；旧版描述文件允许缺失。 */
  readonly packageType?: HostPackageType;
}

export interface HostControllerIdentity {
  /** 每次 Controller 进程启动生成的新会话标识。 */
  readonly sessionId: string;
  /** 便于接管提示辨认来源，不参与授权。 */
  readonly label: string;
}

export interface HostControllerSnapshot extends HostControllerIdentity {
  readonly connectedAt: string;
}

export interface HostControlRequestSnapshot {
  readonly requestId: string;
  readonly requester: HostControllerSnapshot;
  readonly requestedAt: string;
}

export interface HostControlSnapshot {
  readonly revision: number;
  readonly holder?: HostControllerSnapshot;
  readonly controllers: readonly HostControllerSnapshot[];
  readonly pending?: HostControlRequestSnapshot;
}

/** Host 当前公开的服务目录；Controller 据此建立保持权限校验的透明代理。 */
export interface HostServiceDescriptor {
  readonly contract: string;
  readonly methods: readonly string[];
}

export type HostControlEventName = "control-snapshot" | "control-requested" | "server-console";

export interface HostControlEventFrame {
  readonly type: "event";
  readonly event: HostControlEventName;
  readonly payload: JsonValue;
}

export type HostControlAction =
  | "hello"
  | "request-control"
  | "confirm-control"
  | "reject-control"
  | "release-control"
  | "describe-services"
  | "service-call";

export interface HostControlRequestFrame {
  readonly type: "request";
  readonly id: string;
  readonly action: HostControlAction;
  readonly payload: JsonValue;
}

export interface HostControlSuccessFrame {
  readonly type: "response";
  readonly id: string;
  readonly ok: true;
  readonly result: JsonValue;
  readonly resultUndefined?: true;
}

export interface HostControlFailureFrame {
  readonly type: "response";
  readonly id: string;
  readonly ok: false;
  readonly code: string;
  readonly error: string;
}

export type HostControlResponseFrame = HostControlSuccessFrame | HostControlFailureFrame;
export type HostControlFrame =
  | HostControlRequestFrame
  | HostControlResponseFrame
  | HostControlEventFrame;

export interface HostServiceCall {
  readonly contract: string;
  readonly method: string;
  readonly args: readonly JsonValue[];
}

export interface HostControlHandlers {
  describeServices(): readonly HostServiceDescriptor[];
  callService(call: HostServiceCall): Promise<JsonValue | void>;
  /** Host 端最终裁决调用是否需要写控制权，Controller 的 UI 状态不属于安全边界。 */
  isMutation(call: Pick<HostServiceCall, "contract" | "method">): boolean;
}
