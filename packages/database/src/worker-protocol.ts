import type {
  DataCapsule,
  DataCommandRequest,
  DatabaseCheckpointResult,
  DatabaseCommandResult,
  DatabaseIntegrityResult,
  DatabaseValue,
} from "./index";

export type DatabaseWorkerRole = "writer" | "reader" | "maintenance";

export interface DatabaseWorkerData {
  readonly role: DatabaseWorkerRole;
  readonly databasePath: string;
}

export type DatabaseWorkerCommand =
  | { readonly type: "ping" }
  | { readonly type: "register"; readonly capsule: DataCapsule; readonly digest: string }
  | {
      readonly type: "execute";
      readonly namespace: string;
      readonly digest: string;
      readonly command: string;
      readonly parameters: readonly DatabaseValue[];
    }
  | {
      readonly type: "transaction";
      readonly namespace: string;
      readonly digest: string;
      readonly requests: readonly DataCommandRequest[];
    }
  | { readonly type: "quick-check" }
  | { readonly type: "checkpoint" }
  | { readonly type: "backup"; readonly destination: string }
  | { readonly type: "close" };

export interface DatabaseWorkerRequest {
  readonly type: "request";
  readonly id: number;
  readonly command: DatabaseWorkerCommand;
}

export type DatabaseWorkerResult =
  | undefined
  | DatabaseCommandResult
  | readonly DatabaseCommandResult[]
  | DatabaseIntegrityResult
  | DatabaseCheckpointResult;

export interface DatabaseWorkerSuccess {
  readonly type: "response";
  readonly id: number;
  readonly ok: true;
  readonly value?: DatabaseWorkerResult;
}

export interface DatabaseWorkerFailure {
  readonly type: "response";
  readonly id: number;
  readonly ok: false;
  readonly error: string;
}

export type DatabaseWorkerResponse = DatabaseWorkerSuccess | DatabaseWorkerFailure;
