import { serverClientModuleLoaders } from "@seashard/server-client-features/loaders";
import { serverInstanceSelection } from "@seashard/server-ui-shared/server-selection";
import { ClientUiRuntime, clientUiRuntimeKey } from "@seashard/ui-runtime";
import "cmzya-modern-ui/style.css";
import { createApp, watch } from "vue";
import App from "./App.vue";
import {
  callServerClientService,
  createServerWebServiceAdapters,
  ServerWebConsoleEvents,
  webClientPackageModuleLoader,
} from "./client-runtime";
import { router } from "./router";
import "./style.css";

const consoleEvents = new ServerWebConsoleEvents();
const runtime = new ClientUiRuntime({
  router,
  builtInLoaders: serverClientModuleLoaders,
  packageLoader: webClientPackageModuleLoader,
  hostServices: { call: callServerClientService },
  serviceAdapters: createServerWebServiceAdapters(consoleEvents),
  serverSelection: {
    getCurrentInstanceId: () => serverInstanceSelection.instanceId,
    subscribe(listener) {
      listener(serverInstanceSelection.instanceId);
      return watch(
        () => serverInstanceSelection.instanceId,
        (instanceId) => listener(instanceId),
        { flush: "sync" },
      );
    },
  },
  services: {},
});

const app = createApp(App);
app.use(router);
app.provide(clientUiRuntimeKey, runtime);
app.mount("#app");

window.addEventListener(
  "beforeunload",
  () => {
    consoleEvents.close();
    void runtime.dispose();
  },
  { once: true },
);
