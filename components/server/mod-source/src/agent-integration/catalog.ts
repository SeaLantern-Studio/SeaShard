import type { AgentResource } from "@seashard/plugin-sdk";
import {
  createServerCatalogResource,
  createServerProjectResource,
  type ServerCatalogResourceDefinition,
} from "./resource-catalog";
import { externalModContentNotice, type ServerModCatalogAgentRegistrationOptions } from "./shared";

const modCatalogDefinition: ServerCatalogResourceDefinition = {
  resourceType: "mod",
  resourceName: "Mod",
  allItemsLabel: "全部 Mod",
  itemUnit: "个 Mod",
  catalogPath: "server://mods/catalog",
  installToolName: "server_install-mod",
  catalogTitle: "搜索服务器 Mod",
  projectTitle: "读取 Mod 项目详情",
  externalContentNotice: externalModContentNotice,
  supportsLoader: true,
};

/** Mod 入口只声明领域词汇与加载器能力，分页和安全投影复用统一目录适配器。 */
export function createServerModCatalogResource(
  options: ServerModCatalogAgentRegistrationOptions,
): AgentResource {
  return createServerCatalogResource(options, modCatalogDefinition);
}

export function createServerModProjectResource(
  options: ServerModCatalogAgentRegistrationOptions,
): AgentResource {
  return createServerProjectResource(options, modCatalogDefinition);
}
