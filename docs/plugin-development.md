# SeaShard 第三方插件开发指南

> 面向当前 0.x 插件 API。本文只介绍可执行的第三方 **host 插件**；`client` 运行时尚未作为稳定的第三方能力开放。`@seashard/plugin-sdk` 当前也是仓库内包，发布到公共 registry 前应通过 SeaShard 源码工作区获取类型。

## 1. 最小插件结构

```text
my-plugin/
├─ plugin.json
└─ dist/
   └─ host.js
```

入口必须是构建后的 ESM `.js` 或 `.mjs` 文件。建议把第三方依赖打进产物，或使用包内相对导入；不要依赖 SeaShard 内部包。

## 2. `plugin.json`

```json
{
  "id": "acme.greeter",
  "version": "1.0.0",
  "publisher": "acme",
  "entries": [
    {
      "id": "greeter.host",
      "runtime": "host",
      "module": "./dist/host.js",
      "hostProfiles": ["electron", "node", "docker"],
      "activationScopes": ["global"],
      "permissions": ["seashard.logger"],
      "upgradeMode": "hot-swap"
    }
  ],
  "compatibility": {
    "seaShard": ">=0.0.0 <1.0.0"
  }
}
```

必要字段：

| 字段                     | 含义                                                                 |
| ------------------------ | -------------------------------------------------------------------- |
| `id` / `publisher`       | 小写标识符；可使用数字、`.`、`-`，首尾必须是字母或数字               |
| `version`                | 语义化版本                                                           |
| `entries`                | 一个包可包含多个独立入口；入口 `id` 在包内唯一                       |
| `module`                 | 以 `./` 开头的包内 ESM 路径，不允许 `..`、反斜杠或绝对路径           |
| `hostProfiles`           | 至少一个：`electron`、`node`、`docker`                               |
| `activationScopes`       | 可选范围：`global`、`workspace`、`server`、`agent`、`client-session` |
| `permissions`            | 该入口允许调用的 SeaShard 服务 contract；遵循最小权限原则            |
| `upgradeMode`            | `hot-swap` 或 `stop-first`，见下文                                   |
| `compatibility.seaShard` | 当前插件支持的 SeaShard semver 范围                                  |

可用 `os` 和 `arch` 限制平台。清单采用严格校验，未知字段会直接拒绝。

每个启用的 binding 会产生一个运行实例。`activationScopes` 只声明入口允许在哪些范围绑定；用户或宿主决定实际 binding、范围和配置。

## 3. 编写入口模块

```ts
import type { JsonValue, PluginContext, StandardSchema } from "@seashard/plugin-sdk";

type Config = { prefix: string };

export const inject = ["seashard.logger"];
export const provides = ["acme.greeter"];

export const Config = {
  "~standard": {
    version: 1,
    vendor: "acme",
    validate(value: unknown) {
      if (!value || typeof value !== "object" || !("prefix" in value)) {
        return { issues: [{ message: "prefix must be a string" }] };
      }
      const prefix = (value as { prefix?: unknown }).prefix;
      return typeof prefix === "string"
        ? { value: { prefix } }
        : { issues: [{ message: "prefix must be a string" }] };
    },
  },
} satisfies StandardSchema;

export async function apply(ctx: PluginContext, rawConfig: JsonValue) {
  const config = rawConfig as Config;
  const logger = ctx.service<{ write(message: string): Promise<void> }>("seashard.logger");

  ctx.provide("acme.greeter", {
    async greet(name) {
      if (typeof name !== "string") throw new TypeError("name must be a string");
      const message = `${config.prefix}, ${name}`;
      await logger.write(message);
      return message;
    },
  });

  ctx.contribute("acme.greeter.command", { id: "acme.say-hello" });
  ctx.on("acme.greeter.refresh", async (payload) => {
    await logger.write(`refresh: ${JSON.stringify(payload)}`);
  });

  ctx.effect(() => {
    const timer = setInterval(() => {
      void logger.write("greeter heartbeat").catch((error) => {
        console.error("greeter heartbeat failed", error);
      });
    }, 60_000);
    return () => clearInterval(timer);
  }, "greeter timer");
}
```

模块可导出：

- `inject`：启动前必须已经发布的服务 contract。
- `provides`：本入口承诺提供的服务 contract；应与 `ctx.provide()` 保持一致。
- `Config`：可选的 [Standard Schema](https://standardschema.dev/) 校验器。校验失败时入口不会启动。
- `apply(ctx, config)`：入口函数，可以异步执行，也可以返回清理函数。

`inject` 负责启动依赖，`plugin.json.permissions` 负责调用授权。需要调用一个服务时通常两者都要声明。

## 4. `PluginContext` 必知 API

| API                                                   | 用途                                                     |
| ----------------------------------------------------- | -------------------------------------------------------- |
| `ctx.runtimeId`                                       | 当前 binding 的稳定运行实例标识                          |
| `ctx.generation`                                      | 本次启动代次；每次替换或回滚都会变化                     |
| `ctx.execution`                                       | 当前 actor、scope chain 和权限信息                       |
| `ctx.effect(setup, label?)`                           | 注册监听器、定时器、文件句柄、子进程等副作用及其清理函数 |
| `ctx.provide(contract, provider)`                     | 发布服务；注册和撤销由运行时跟踪                         |
| `ctx.service(contract)`                               | 获取服务代理；方法调用应始终 `await`                     |
| `ctx.storage`                                         | 当前 binding 独占的托管 JSON 文档存储                    |
| `ctx.contribute(kind, value)`                         | 发布声明式贡献，例如命令或菜单描述                       |
| `ctx.on(event, handler)` / `ctx.emit(event, payload)` | 订阅和发送范围内事件                                     |

配置、服务参数与返回值、Contribution、事件 payload 都必须是 JSON 值：`null`、布尔值、数字、字符串、数组或普通对象。不要跨边界传递函数、类实例、`Buffer`、流或循环引用。

contract、Contribution kind 和事件名只能使用小写字母、数字及 `.`、`*`、`:`、`-`。建议使用发布者命名空间，例如 `acme.greeter`。

### 托管文档存储

`ctx.storage` 默认可用，不需要额外权限。SeaShard 根据插件 ID 和 `runtimeId` 确定存储命名空间；插件不能指定命名空间，也不能读取同一插件其他 binding 的数据。数据写入独立的 `plugin-data/documents.sqlite3`，不进入核心状态数据库。

```ts
const current = await ctx.storage.get("state/session");
const saved = await ctx.storage.put(
  "state/session",
  { cursor: 42 },
  { expectedRevision: current?.revision ?? null },
);
await ctx.storage.delete("state/session", { expectedRevision: saved.revision });
```

`expectedRevision: null` 表示仅在文档不存在时创建；传入数字执行 CAS 更新，版本不匹配会拒绝写入；省略则无条件写入。可用 `ttlMs` 设置最长 365 天的过期时间。key 最长 255 个字符，可使用字母、数字、`.`、`_`、`-`、`/`，但不能包含空路径段、`.` 或 `..`。单个 JSON 文档最大 1 MiB。

## 5. 生命周期与升级模式

不要在模块顶层创建监听器、定时器、进程或其他副作用。全部放进 `apply()`，并通过 `ctx.effect()` 或 `apply()` 返回的清理函数释放。`provide`、`contribute`、`on` 已自动关联生命周期。

清理可能发生在升级、停用、启动失败或应用退出时；清理代码应可安全执行，并等待异步资源真正关闭。

- **`hot-swap`**：新旧 generation 会短暂同时运行，新版本发布后旧版本才排空并停止。仅适合能够并存的实现；不要争抢固定端口、全局 IPC handler、唯一文件锁等资源。
- **`stop-first`**：先撤下并停止旧版本，再启动新版本。适合独占资源，但升级期间可能短暂无服务；新版本失败时，SeaShard 会重新启动旧规格。

不确定时选择 `stop-first`。不要把 `generation` 当作持久数据主键；需要跨 reload 保留的普通状态优先使用 `ctx.storage`，并通过 revision CAS 处理并发更新。

## 6. 打包与发布

将 `plugin.json` 放在压缩包根目录，把所有入口产物和运行依赖一起打包，然后将 ZIP 文件命名为 `*.seashard-plugin`：

```text
acme-greeter.seashard-plugin
├─ plugin.json
└─ dist/host.js
```

当前限制：压缩包不超过 32 MiB，解压后不超过 128 MiB，最多 4096 个文件，单文件不超过 32 MiB；不允许符号链接或路径穿越。

第三方 host 插件在独立 Node 子进程中运行，但**不是操作系统安全沙箱**。安装时用户必须对该包的精确摘要授予“完整机器访问”信任；`permissions` 只限制 SeaShard 服务调用，不能限制插件直接使用 Node.js、文件系统或网络。

发布前至少验证：

1. 全新安装和配置校验。
2. 所有服务参数与返回值均可 JSON 序列化。
3. 手动 reload 后，新 generation 正常发布，旧 generation 的资源全部释放。
4. 所选升级模式下，启动失败不会损坏持久数据或占用独占资源。
5. `compatibility.seaShard` 准确覆盖实际测试版本。
