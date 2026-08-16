import { runtimeDiagnosticsContract, type RuntimeDiagnosticsService } from "@seashard/contracts";
import { defineClientUiModule } from "@seashard/ui-sdk";
import { defineComponent, h } from "vue";
import RuntimeStatusPage from "./RuntimeStatusPage.vue";

export default defineClientUiModule({
  apply(ctx) {
    const diagnostics = ctx.service<RuntimeDiagnosticsService>(runtimeDiagnosticsContract);
    const page = defineComponent({
      name: "RuntimeDiagnosticsPageEntry",
      setup: () => () => h(RuntimeStatusPage, { getSnapshot: () => diagnostics.getSnapshot() }),
    });

    ctx.contribute("navigation.page", {
      id: "runtime-diagnostics",
      path: "/runtime",
      label: "运行状态",
      description: "组件生命周期与宿主健康状态",
      order: 100,
      navigation: false,
      component: page,
    });
  },
});
