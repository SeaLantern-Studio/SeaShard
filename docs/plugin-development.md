# SeaShard 第三方插件开发指南

> **维护状态：暂缓更新。** 插件开发链仍在收口，下文的 SDK 版本、示例 Contract 和 CLI 行为可能滞后；待插件开发能力完成后统一校正，当前不要将本文视为最终规范。

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
      "uses": {
        "seashard.logger": ["write"]
      }
    }
  ],
  "compatibility": {
    "seaShard": ">=0.0.0 <1.0.0"
  }
}
```

必要字段：

| 字段                     | 含义                                                          |
| ------------------------ | ------------------------------------------------------------- |
| `id` / `publisher`       | 小写标识符；可使用数字、`.`、`-`，首尾必须是字母或数字        |
| `version`                | 语义化版本                                                    |
| `entries`                | 一个包可包含多个独立入口；入口 `id` 在包内唯一                |
| `module`                 | 以 `./` 开头的包内 ESM 路径，不允许 `..`、反斜杠或绝对路径    |
| `hostProfiles`           | 至少一个：`electron`、`node`、`docker`                        |
| `uses`                   | 按 Contract 列出入口实际调用的方法；Host 据此生成最小调用授权 |
| `compatibility.seaShard` | 当前插件支持的 SeaShard semver 范围                           |

可用 `os` 和 `arch` 限制平台。清单采用严格校验，未知字段会直接拒绝。

每个启用的 binding 会产生一个全局运行实例；插件包不声明宿主内部的 Scope 或权限字段。

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

- `inject`：启动前必须已经发布的服务 Contract。
- `provides`：本入口承诺提供的服务 Contract；应与 `ctx.provide()` 保持一致。
- `Config`：可选的 [Standard Schema](https://standardschema.dev/) 校验器。校验失败时入口不会启动。
- `apply(ctx, config)`：入口函数，可以异步执行，也可以返回清理函数。

`inject` 负责启动依赖，`plugin.json.entries[].uses` 负责逐方法授权。需要调用一个 Service 时通常两者都要声明。

## 4. `PluginContext` 必知 API

| API                                                   | 用途                                                     |
| ----------------------------------------------------- | -------------------------------------------------------- |
| `ctx.runtimeId`                                       | 当前 binding 的稳定运行实例标识                          |
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

核心权威 SQLite 与托管插件存储分别由受保护的 Bootstrap Component 提供，都不是第三方插件可安装、禁用或替换的普通插件。当前第三方持久化接口只有 `ctx.storage`；SDK 不提供 `database.integrated`、原始 SQL 或数据库文件句柄。即使插件已获得完整机器访问信任，也不要直接打开或修改 `seashard.sqlite3`、`plugin-data/documents.sqlite3`，否则可能绕过生命周期、并发控制和备份边界并造成数据损坏。

## 5. 生命周期与停用、替换

不要在模块顶层创建监听器、定时器、进程或其他副作用。全部放进 `apply()`，并通过 `ctx.effect()` 或 `apply()` 返回的清理函数释放。`provide`、`contribute`、`on` 已自动关联 Cordis Fiber 生命周期。

清理可能发生在停用、启动失败或应用退出时；清理代码应可安全执行，并等待异步资源真正关闭。

启用插件时，SeaShard 创建 Cordis Fiber；关闭插件时，直接释放该 Fiber。替换版本采用“停止旧版本，再启动新版本”的顺序，因此替换期间插件功能可能短暂不可用，但软件进程不会重启。启动失败会报告错误，旧版本不会以热切换方式并行保留。

## 6. CLI 开发工作流

SeaShard CLI 直接复用 Plugin Installer 与实际 Desktop Host：

```text
seashard plugin validate [directory]
seashard plugin build [directory]
seashard plugin pack [directory]
seashard plugin install <package-or-directory>
seashard plugin dev [directory]
seashard plugin reload [runtime-id]
seashard plugin logs [runtime-id]
```

- `validate` 校验 `plugin.json`、SeaShard 版本范围、包路径限制和全部入口文件，不执行插件代码。
- `build` 调用项目 `package.json` 中的 `scripts.build`，随后执行同一份包校验。
- `pack` 将已验证目录按稳定路径顺序写成确定性 `.seashard-plugin`，不会隐式忽略目录内容。应把 `node_modules` 和其他开发文件放在待打包目录之外。
- `install` 通过实际 Host 安装不可变插件包；传入目录时会先复制并重新校验私有快照，后续构建不会改变已授予精确摘要信任的代码。
- `dev` 在存在构建脚本时先构建，启动真实 Desktop Host，并监听项目变化执行构建、校验和 Host Runtime reload。
- `reload` 与 `logs` 连接当前用户启动的本地开发会话；不开放任意 Service 调用或远程控制。

按 `Ctrl+C` 可等待开发 Host、插件 Runtime 和文件监听器完成清理后退出。

### 查询可用 Service

```text
seashard inspect services
seashard inspect service seashard.server-runtime
seashard inspect service seashard.server-runtime --json
```

Inspect 将编译期 Service Catalog 与当前开发 Host 的 Service Registry 快照交叉，输出说明、方法签名、参数、返回值、引用类型、`uses` 示例、Provider Scope 和方法漂移。没有活动 Host 时，内建 Contract 仍会显示并标记为 `inactive`；第三方运行态 Service 缺少编译期文档时会明确显示 `signature unavailable`。

## 7. 打包与发布

`seashard plugin pack` 会在插件目录的同级目录生成 `<id>-<version>.seashard-plugin`。包根目录必须直接包含 `plugin.json`，全部入口产物和运行依赖都必须位于该目录内：

```text
acme-greeter.seashard-plugin
├─ plugin.json
└─ dist/host.js
```

当前限制：压缩包不超过 32 MiB，解压后不超过 128 MiB，最多 4096 个文件，单文件不超过 32 MiB；不允许符号链接或路径穿越。

第三方 Host 插件在独立 Node 子进程中运行，但不构成操作系统安全沙箱。安装时用户必须对该包的精确摘要授予“完整机器访问”信任；`uses` 只限制 SeaShard Service 调用，不能限制插件直接使用 Node.js、文件系统或网络。

发布前至少验证：

1. 全新安装和配置校验。
2. 所有 Service 参数与返回值均可 JSON 序列化。
3. 手动 reload 后，新 Runtime 正常发布，旧 Runtime 的资源全部释放。
4. 启动失败不会损坏持久数据或占用独占资源。
5. `compatibility.seaShard` 准确覆盖实际测试版本。
