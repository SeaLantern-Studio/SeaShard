import { runtimeDiagnosticsContract } from "@seashard/contracts";
import { ClientUiRuntime, clientUiRuntimeKey } from "@seashard/ui-runtime";
import { createApp } from "vue";
import "cmzya-modern-ui/style.css";
import App from "./App.vue";
import { builtInClientModuleLoaders } from "./client-modules";
import { router } from "./router";
import "./style.css";

const runtime = new ClientUiRuntime({
  router,
  loaders: builtInClientModuleLoaders,
  services: {
    [runtimeDiagnosticsContract]: window.seashard.runtime,
  },
});

const app = createApp(App);
app.use(router);
app.provide(clientUiRuntimeKey, runtime);
app.mount("#app");

const disposeBootstrapSubscription = window.seashard.client.onBootstrapChanged((snapshot) => {
  void applyBootstrap(snapshot).catch((error) => runtime.failBootstrap(error));
});

window.addEventListener(
  "beforeunload",
  () => {
    disposeBootstrapSubscription();
    void runtime.dispose();
  },
  { once: true },
);

void window.seashard.client
  .getBootstrap()
  .then(applyBootstrap)
  .catch((error) => runtime.failBootstrap(error));

async function applyBootstrap(
  snapshot: Awaited<ReturnType<typeof window.seashard.client.getBootstrap>>,
): Promise<void> {
  const protocolVersion: number = snapshot.protocolVersion;
  if (protocolVersion !== 1) {
    throw new Error(`unsupported desktop client protocol: ${protocolVersion}`);
  }
  if (snapshot.clientSession.target !== "desktop" || snapshot.clientSession.surface !== "primary") {
    throw new Error("desktop client bootstrap targets an unsupported surface");
  }

  await runtime.reconcile(snapshot);
  const pages = runtime.pages.value;
  const currentRuntime = router.currentRoute.value.meta.runtimeId;
  if (pages.length === 0) {
    if (router.currentRoute.value.path !== "/") await router.replace("/");
    return;
  }
  if (
    router.currentRoute.value.path === "/" ||
    typeof currentRuntime !== "string" ||
    !pages.some((page) => page.runtimeId === currentRuntime)
  ) {
    await router.replace(pages[0]!.path);
  }
}
