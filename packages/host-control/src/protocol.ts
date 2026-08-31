import type { JsonValue } from "@seashard/plugin-sdk";

export const hostControlProtocolVersion = 1;

export interface HostControlDescriptor {
  readonly protocolVersion: typeof hostControlProtocolVersion;
  readonly socketPath: string;
  readonly descriptorPath: string;
  readonly token: string;
  readonly pid: number;
  readonly startedAt: string;
}

export interface HostControllerIdentity {
  /** 每次 Desktop 进程启动生成的新会话标识。 */
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

export type HostControlEventName = "control-snapshot" | "control-requested";

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
  callService(call: HostServiceCall): Promise<JsonValue | void>;
  /** Host 端最终裁决调用是否需要写控制权，Controller 的 UI 状态不属于安全边界。 */
  isMutation(call: Pick<HostServiceCall, "contract" | "method">): boolean;
}
