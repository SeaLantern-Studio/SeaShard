import type { AgentResource } from "@seashard/plugin-sdk";
import {
  createServerCatalogResource,
  createServerProjectResource,
  type ServerCatalogResourceDefinition,
} from "./resource-catalog";
import {
  externalDatapackContentNotice,
  type ServerDatapackCatalogAgentRegistrationOptions,
} from "./shared";

const datapackCatalogDefinition: ServerCatalogResourceDefinition = {
  resourceType: "datapack",
  resourceName: "数据包",
  allItemsLabel: "全部数据包",
  itemUnit: "个数据包",
  catalogPath: "server://datapacks/catalog",
  installToolName: "server_install-datapack",
  catalogTitle: "搜索服务器数据包",
  projectTitle: "读取数据包项目详情",
  externalContentNotice: externalDatapackContentNotice,
  supportsLoader: false,
};

/** 数据包没有加载器筛选；其余目录语义与 Mod 保持完全一致。 */
export function createServerDatapackCatalogResource(
  options: ServerDatapackCatalogAgentRegistrationOptions,
): AgentResource {
  return createServerCatalogResource(options, datapackCatalogDefinition);
}

export function createServerDatapackProjectResource(
  options: ServerDatapackCatalogAgentRegistrationOptions,
): AgentResource {
  return createServerProjectResource(options, datapackCatalogDefinition);
}
