import { agentClientModuleLoaders } from "@seashard/agent-client-features/loaders";
import { serverClientModuleLoaders } from "@seashard/server-client-features/loaders";
import { serverInstanceSelection } from "@seashard/server-ui-shared/server-selection";
import { ClientUiRuntime, clientUiRuntimeKey } from "@seashard/ui-runtime";
import "cmzya-modern-ui/style.css";
import { createApp, watch } from "vue";
import App from "./App.vue";
import {
  callServerClientService,
  createServerWebServiceAdapters,
  ServerWebEvents,
  webClientPackageModuleLoader,
} from "./client-runtime";
import { router } from "./router";
import "./style.css";

const events = new ServerWebEvents();
const runtime = new ClientUiRuntime({
  router,
  builtInLoaders: {
    ...agentClientModuleLoaders,
    ...serverClientModuleLoaders,
  },
  packageLoader: webClientPackageModuleLoader,
  hostServices: { call: callServerClientService },
  serviceAdapters: createServerWebServiceAdapters(events),
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
    events.close();
    void runtime.dispose();
  },
  { once: true },
);
