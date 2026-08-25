import {
  serverModSourceContract as serverModSourceContractId,
  type ServerModDownloadResult,
  type ServerModSaveAsRequest,
  type ServerModSourceClientService,
} from "@seashard/contracts";
import { defineServiceContract } from "@seashard/plugin-sdk";

export {
  serverModSearchLimits,
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
  /**
   * 将已选择的来源产物保存到 Host 已验证目录。
   *
   * @param request 来源产物身份、目标目录和下载并发数。
   * @returns 完成校验和发布后的下载结果。
   */
  saveAs(request: ServerModSourceSaveRequest): Promise<ServerModDownloadResult>;
}

/** 将共享 Contract 标识关联到资源来源组件实际发布的完整 Host Service。 */
export const serverModSourceContract =
  defineServiceContract<ServerModSourceService>(serverModSourceContractId);
