import { aboutUiServiceContract } from "@seashard/about-ui";
import { hostConnectionsUiServiceContract } from "@seashard/host-connections-ui";
import { uiAppearanceContract } from "@seashard/ui-sdk";
import { agentClientModuleLoaders } from "@seashard/agent-client-features/loaders";
import { serverClientModuleLoaders } from "@seashard/server-client-features/loaders";
import { pluginMarketUiManifest } from "@seashard/plugin-market-ui";
import { pluginSettingsUiManifest } from "@seashard/plugin-settings-ui";
import { serverInstanceSelection } from "@seashard/server-ui-shared/server-selection";
import { ClientUiRuntime, clientUiRuntimeKey } from "@seashard/ui-runtime";
import "cmzya-modern-ui/style.css";
import { createApp, watch } from "vue";
import App from "./App.vue";
import {
  callServerClientService,
  createServerWebServiceAdapters,
  serverWebEvents,
  webClientPackageModuleLoader,
} from "./client-runtime";
import { router } from "./router";
import "./style.css";
import { serverAboutUiService } from "./about";
import { serverAppearanceService } from "./appearance";
import { createServerHostConnectionsUiService } from "./host-connections";

const events = serverWebEvents;
const runtime = new ClientUiRuntime({
  router,
  builtInLoaders: {
    ...agentClientModuleLoaders,
    ...serverClientModuleLoaders,
    "seashard.host-connections-ui/host-connections.client": {
      load: () => import("@seashard/host-connections-ui/client"),
    },
    "seashard.about-ui/about.client": {
      load: () => import("@seashard/about-ui/client"),
    },
    "seashard.personalization-ui/personalization.client": {
      load: () => import("@seashard/personalization-ui/client"),
    },
    [`${pluginSettingsUiManifest.id}/plugin-settings.client`]: {
      load: () => import("@seashard/plugin-settings-ui/client"),
    },
    [`${pluginMarketUiManifest.id}/plugin-market.client`]: {
      load: () => import("@seashard/plugin-market-ui/client"),
    },
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
  services: {
    [uiAppearanceContract]: serverAppearanceService,
    [hostConnectionsUiServiceContract]: createServerHostConnectionsUiService(events),
    [aboutUiServiceContract]: serverAboutUiService,
  },
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
