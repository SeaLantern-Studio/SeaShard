import assert from "node:assert/strict";
import test from "node:test";
import {
  javaRuntimeManagerContract,
  serverRuntimeContract,
} from "../packages/contracts/src/index.ts";
import { downloadContract } from "../components/network/download/src/index.ts";
import type { HostControlClient } from "../packages/host-control/src/index.ts";
import type { JsonValue, ServiceProvider } from "../packages/plugin-sdk/src/index.ts";
import type { PluginKernel } from "../packages/plugin-system/src/index.ts";
import {
  ControllerHostServiceGateway,
  type ControllerHostServiceSource,
} from "../apps/desktop/src/main/controller-host-services.ts";

await test("Controller gateway exposes only Host machine capabilities", async () => {
  const calls: Array<{ contract: string; method: string; args: readonly JsonValue[] }> = [];
  const client = createClient(calls);
  const services = registerGateway(client);

  assert.deepEqual(
    [...services.keys()].sort(),
    [downloadContract, javaRuntimeManagerContract].sort(),
  );
  assert.equal(services.has(serverRuntimeContract), false);
  assert.deepEqual(await services.get(javaRuntimeManagerContract)!.scan!(), [{ id: "java-21" }]);
  assert.equal(await services.get(downloadContract)!.cancel!("task-1"), null);
  assert.deepEqual(calls, [
    { contract: javaRuntimeManagerContract, method: "scan", args: [] },
    { contract: downloadContract, method: "cancel", args: ["task-1"] },
  ]);
});

await test("machine capability gateway reports an unavailable default Host", async () => {
  const services = registerGateway(undefined);
  await assert.rejects(
    async () => services.get(javaRuntimeManagerContract)!.scan!(),
    (error: unknown) =>
      Boolean(
        error && typeof error === "object" && Reflect.get(error, "code") === "HOST_UNAVAILABLE",
      ),
  );
});

function registerGateway(client: HostControlClient | undefined): Map<string, ServiceProvider> {
  const source: ControllerHostServiceSource = {
    clientFor: () => client,
    connectedClients: () => (client ? [{ hostId: "local", client }] : []),
    knownHostIds: () => ["local"],
    getSnapshot: () =>
      ({
        revision: 1,
        controllerSessionId: "test-controller",
        hosts: [],
      }) as ReturnType<ControllerHostServiceSource["getSnapshot"]>,
  };
  const services = new Map<string, ServiceProvider>();
  const kernel = {
    registerCoreService(contract: string, provider: ServiceProvider) {
      services.set(contract, provider);
      return () => services.delete(contract);
    },
  } as unknown as PluginKernel;
  new ControllerHostServiceGateway(source).register(kernel);
  return services;
}

function createClient(
  calls: Array<{ contract: string; method: string; args: readonly JsonValue[] }>,
): HostControlClient {
  return {
    service(contract: string) {
      return new Proxy(
        {},
        {
          get: (_target, method) => {
            if (typeof method !== "string") return undefined;
            return async (...args: JsonValue[]) => {
              calls.push({ contract, method, args });
              if (contract === javaRuntimeManagerContract && method === "scan") {
                return [{ id: "java-21" }];
              }
              return null;
            };
          },
        },
      );
    },
  } as unknown as HostControlClient;
}
