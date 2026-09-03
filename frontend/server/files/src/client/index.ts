import {
  serverFileManagerContract,
  serverInstanceManagerContract,
  type ServerFileManagerService,
  type ServerInstanceClientService,
} from "@seashard/contracts";
import { serverInstanceSelection } from "@seashard/server-ui-shared/server-selection";
import { defineClientUiModule } from "@seashard/ui-sdk";
import { Files } from "lucide-vue-next";
import { defineComponent, h } from "vue";
import ServerFilesPage from "./ServerFilesPage.vue";

export default defineClientUiModule({
  apply(context) {
    const instances = context.service<ServerInstanceClientService>(serverInstanceManagerContract);
    const files = context.service<ServerFileManagerService>(serverFileManagerContract);
    const page = defineComponent({
      setup: () => () =>
        h(ServerFilesPage, { instances, files, selection: serverInstanceSelection }),
    });
    context.slots.register(
      {
        name: "navigation.page",
        id: "server-files",
        path: "/server/files",
        label: "文件",
        order: 45,
        icon: Files,
        navigation: true,
        placement: "server",
      },
      page,
    );
  },
});
