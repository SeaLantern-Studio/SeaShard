import { defineClientUiModule } from "@seashard/ui-sdk";
import { LockKeyhole } from "lucide-vue-next";
import { defineComponent, h } from "vue";
import ServerWebAuthenticationPage from "./ServerWebAuthenticationPage.vue";

export { default as ServerWebAuthenticationPage } from "./ServerWebAuthenticationPage.vue";

export default defineClientUiModule({
  apply(context) {
    const page = defineComponent({
      name: "ServerWebAuthenticationFeaturePage",
      setup: () => () => h(ServerWebAuthenticationPage),
    });
    context.slots.register(
      {
        name: "navigation.page",
        id: "server-web-authentication",
        path: "/authentication",
        label: "登录",
        icon: LockKeyhole,
        navigation: false,
        placement: "main",
      },
      page,
    );
  },
});
