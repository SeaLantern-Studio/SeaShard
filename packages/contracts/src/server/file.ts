import { defineServiceContract } from "@seashard/plugin-sdk";

export const serverFileManagerContract = defineServiceContract<ServerFileManagerService>(
  "seashard.server-file-manager",
);

export type ServerFileEntryKind = "directory" | "file";

/** Host 只发布实例内相对路径；绝对路径和符号链接始终留在安全边界内。 */
export interface ServerFileEntry {
  readonly path: string;
  readonly name: string;
  readonly kind: ServerFileEntryKind;
  readonly size: number;
  readonly modifiedAt: string;
}

export interface ServerTextFileDocument {
  readonly instanceId: string;
  readonly path: string;
  readonly content: string;
  readonly revision: string;
  readonly modifiedAt: string;
}

export interface ServerTextFileWriteRequest {
  readonly instanceId: string;
  readonly path: string;
  readonly content: string;
  readonly expectedRevision?: string;
}

/** 通用文件能力只处理已登记实例内的小型 UTF-8 文本和目录。 */
export interface ServerFileManagerService {
  /**
   * 列出实例根目录下一个受约束目录中的直接子项。
   *
   * @param instanceId 已登记实例 ID。
   * @param directory 实例根目录下的 POSIX 相对目录；空字符串表示实例根目录。
   * @returns 按目录优先、名称稳定排序的文件条目。
   */
  list(instanceId: string, directory: string): Promise<readonly ServerFileEntry[]>;
  /**
   * 读取实例内的小型 UTF-8 文本文件。
   *
   * @param instanceId 已登记实例 ID。
   * @param path 实例根目录下的 POSIX 相对文件路径。
   * @returns 文本内容及用于乐观写入的内容摘要。
   */
  readText(instanceId: string, path: string): Promise<ServerTextFileDocument>;
  /**
   * 在摘要仍匹配时原子写入 UTF-8 文本文件。
   *
   * @param request 实例、相对路径、内容和可选的期望摘要。
   * @returns 落盘后的最新文本投影。
   */
  writeText(request: ServerTextFileWriteRequest): Promise<ServerTextFileDocument>;
  /**
   * 在实例内创建目录及其缺失的父目录。
   *
   * @param instanceId 已登记实例 ID。
   * @param path 实例根目录下的 POSIX 相对目录。
   */
  createDirectory(instanceId: string, path: string): Promise<void>;
  /**
   * 删除实例内的文件或空目录。
   *
   * @param instanceId 已登记实例 ID。
   * @param path 实例根目录下的 POSIX 相对路径。
   */
  delete(instanceId: string, path: string): Promise<void>;
}
