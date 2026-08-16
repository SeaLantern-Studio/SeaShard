import { serverCoreSourceContract, type ServerCoreSourceClientService } from "@seashard/contracts";
import { defineClientUiModule } from "@seashard/ui-sdk";
import { defineComponent, h } from "vue";
import ServerDownloadPage from "./ServerDownloadPage.vue";
import { downloadResourceCategories } from "./resource-categories";

export default defineClientUiModule({
  apply(context) {
    const coreSource = context.service<ServerCoreSourceClientService>(serverCoreSourceContract);

    for (const category of downloadResourceCategories) {
      const page = defineComponent({
        name: `ServerDownload_${category.id}`,
        setup: () => () => h(ServerDownloadPage, { coreSource, category }),
      });

      context.contribute("navigation.page", {
        id: category.id === "server-core" ? "server-download" : `server-download-${category.id}`,
        path: category.path,
        label: category.label,
        description: category.description,
        order: category.order,
        icon: category.icon,
        navigation: true,
        placement: "server-download",
        component: page,
      });
    }
  },
});
