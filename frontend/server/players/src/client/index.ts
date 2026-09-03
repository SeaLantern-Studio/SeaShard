import {
  serverInstanceManagerContract,
  serverPlayerManagerContract,
  type ServerInstanceClientService,
  type ServerPlayerManagerService,
} from "@seashard/contracts";
import { serverInstanceSelection } from "@seashard/server-ui-shared/server-selection";
import { defineClientUiModule } from "@seashard/ui-sdk";
import { Users } from "lucide-vue-next";
import { defineComponent, h } from "vue";
import ServerPlayersPage from "./ServerPlayersPage.vue";

export default defineClientUiModule({
  apply(context) {
    const instances = context.service<ServerInstanceClientService>(serverInstanceManagerContract);
    const players = context.service<ServerPlayerManagerService>(serverPlayerManagerContract);
    const page = defineComponent({
      name: "ServerPlayersFeaturePage",
      setup: () => () =>
        h(ServerPlayersPage, { instances, players, selection: serverInstanceSelection }),
    });
    context.slots.register(
      {
        name: "navigation.page",
        id: "server-players",
        path: "/server/players",
        label: "玩家",
        order: 35,
        icon: Users,
        navigation: true,
        placement: "server",
      },
      page,
    );
  },
});
