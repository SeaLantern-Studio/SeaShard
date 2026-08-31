import { javaRuntimeManagerContract } from "@seashard/contracts";
import { downloadContract } from "@seashard/download";
import { HostControlRpcError, type HostControlClient } from "@seashard/host-control";
import type { JsonValue, ServiceProvider } from "@seashard/plugin-sdk";
import type { PluginKernel } from "@seashard/plugin-system";
import type { DesktopHostConnections } from "./desktop-host-connections";

export type ControllerHostServiceSource = Pick<
  DesktopHostConnections,
  "clientFor" | "connectedClients" | "knownHostIds" | "getSnapshot"
>;

/**
 * Controller 到 Host 的设备能力网关。
 * 这里只转发通用下载与 Java 事实；服务器领域 Contract 由 Controller 本地 Provider 持有。
 */
export class ControllerHostServiceGateway {
  constructor(private readonly hosts: ControllerHostServiceSource) {}

  register(kernel: PluginKernel): void {
    this.registerDefaultHostContract(kernel, javaRuntimeManagerContract, [
      "scan",
      "inspect",
      "remove",
      "setDisabled",
    ]);
    this.registerDefaultHostContract(kernel, downloadContract, [
      "start",
      "snapshot",
      "wait",
      "listTasks",
      "listUserVisibleTasks",
      "cancel",
    ]);
  }

  private registerDefaultHostContract(
    kernel: PluginKernel,
    contract: string,
    methods: readonly string[],
  ): void {
    kernel.registerCoreService(
      contract,
      createProvider(methods, (method, args) =>
        this.callDefaultHostService(contract, method, args),
      ),
    );
  }

  private async callDefaultHostService(
    contract: string,
    method: string,
    args: readonly JsonValue[],
  ): Promise<JsonValue | void> {
    const route = this.hosts.connectedClients()[0];
    if (!route) throw new HostControlRpcError("HOST_UNAVAILABLE", "默认 Host 当前不可用");
    return callHost(route.client, contract, method, args);
  }
}

function createProvider(
  methods: readonly string[],
  call: (method: string, args: readonly JsonValue[]) => Promise<JsonValue | void>,
): ServiceProvider {
  return Object.fromEntries(
    methods.map((method) => [method, (...args: JsonValue[]) => call(method, args)]),
  );
}

async function callHost(
  client: HostControlClient,
  contract: string,
  method: string,
  args: readonly JsonValue[],
): Promise<JsonValue | void> {
  const service = client.service<ServiceProvider>(contract);
  const target = service[method];
  if (!target) throw new Error(`Host Service 方法不存在：${contract}.${method}`);
  return target(...args);
}
