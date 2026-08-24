import type {
  ServerModDownloadResult,
  ServerModSaveAsRequest,
  ServerModSourceClientService,
} from "@seashard/contracts";

export {
  serverModSearchLimits,
  serverModSourceContract,
  type ServerModEnvironment,
  type ServerModFilterOption,
  type ServerModFilters,
  type ServerModProject,
  type ServerModProjectDetails,
  type ServerModSearchIndex,
  type ServerModSearchRequest,
  type ServerModSearchResult,
  type ServerModSource,
  type ServerModSourceClientService,
  type ServerModVersion,
} from "@seashard/contracts";

export interface ServerModSourceSaveRequest extends ServerModSaveAsRequest {
  readonly destinationDirectory: string;
  readonly connections: number;
}

/** Host 侧目录与下载能力；Client 的目录选择取消语义留在具体 Gateway。 */
export interface ServerModSourceService extends Omit<ServerModSourceClientService, "saveAs"> {
  saveAs(request: ServerModSourceSaveRequest): Promise<ServerModDownloadResult>;
}
