import { reactive } from "vue";

export interface ServerInstanceSelection {
  instanceId?: string;
}

/** 所有服务器页面共享当前实例；代码包本身不发布页面或申请 Host 权限。 */
export const serverInstanceSelection = reactive<ServerInstanceSelection>({});
