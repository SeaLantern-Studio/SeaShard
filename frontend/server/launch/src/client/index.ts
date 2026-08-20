import {
  serverConfigurationContract,
  serverInstanceManagerContract,
  serverRuntimeContract,
  type ServerConfigurationClientService,
  type ServerInstanceClientService,
  type ServerRuntimeClientService,
} from "@seashard/contracts";
import { defineClientUiModule } from "@seashard/ui-sdk";
import { FileCog, LayoutDashboard, Play, Terminal } from "lucide-vue-next";
import { defineComponent, h, reactive } from "vue";
import ServerConfigurationPage from "./ServerConfigurationPage.vue";
import ServerConsolePage from "./ServerConsolePage.vue";
import ServerOverviewPage from "./ServerOverviewPage.vue";
import ServerLaunchPage from "./ServerLaunchPage.vue";
import type { ServerInstanceSelection } from "./server-selection";

export default defineClientUiModule({
  apply(context) {
    const instances = context.service<ServerInstanceClientService>(serverInstanceManagerContract);
    const configuration = context.service<ServerConfigurationClientService>(
      serverConfigurationContract,
    );
    const runtime = context.service<ServerRuntimeClientService>(serverRuntimeContract);
    const selection = reactive<ServerInstanceSelection>({});
    const overviewPage = defineComponent({
      name: "ServerOverview",
      setup: () => () => h(ServerOverviewPage, { instances, runtime, selection }),
    });
    const launchPage = defineComponent({
      name: "ServerLaunch",
      setup: () => () => h(ServerLaunchPage, { instances, runtime, selection }),
    });
    const consolePage = defineComponent({
      name: "ServerConsole",
      setup: () => () => h(ServerConsolePage, { instances, runtime, selection }),
    });
    const configurationPage = defineComponent({
      name: "ServerConfiguration",
      setup: () => () => h(ServerConfigurationPage, { instances, configuration, selection }),
    });
    context.contribute("navigation.page", {
      id: "server-overview",
      path: "/server/overview",
      label: "概览",
      description: "查看当前服务器的状态与实例信息",
      order: -10,
      icon: LayoutDashboard,
      navigation: false,
      placement: "main",
      component: overviewPage,
    });
    context.contribute("navigation.page", {
      id: "server-launch",
      path: "/server/launch",
      label: "启动",
      description: "启动和切换服务器实例",
      order: 0,
      icon: Play,
      navigation: false,
      placement: "main",
      component: launchPage,
    });
    context.contribute("navigation.page", {
      id: "server-console",
      path: "/server/console",
      label: "控制台",
      description: "查看服务器日志并发送命令",
      order: 10,
      icon: Terminal,
      navigation: false,
      placement: "main",
      component: consolePage,
    });
    context.contribute("navigation.page", {
      id: "server-configuration",
      path: "/server/configuration",
      label: "配置管理",
      description: "修改服务器属性与插件配置文件",
      order: 20,
      icon: FileCog,
      navigation: false,
      placement: "main",
      component: configurationPage,
    });
  },
});
