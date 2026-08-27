# SeaShard 第三方插件开发指南

本文面向使用 `@seashard/plugin-sdk` 0.2.x、`@seashard/contracts` 0.2.x 与 `@seashard/ui-sdk` 0.2.x 开发 SeaShard 第三方插件的开发者。完成快速开始后，你将得到一个可以验证、热重载、打包、安装并跨应用重启运行的插件。

## 1. 当前开放范围

第三方安装包可以声明 `runtime: "host"` 的 Host Entry 和 `runtime: "client"` 的 Client Entry，也可以在同一个包中同时提供两者。

Host Entry 在独立 Node.js 子进程中执行，可以：

- 调用 SeaShard 公开 Service Contract；
- 向其他组件提供 JSON Service；
- 使用按 Runtime 隔离的托管存储；
- 注册 Agent Tool 和 Agent Resource；
- 订阅和发送插件事件；
- 注册具有完整生命周期清理语义的副作用。

Client Entry 在禁用 Node.js 集成的 Desktop Renderer 中执行，可以：

- 注册独立导航页面；
- 为指定工作区注册侧栏组件；
- 调用 Renderer 已公开的 SeaShard Service；
- 使用 Vue 3.5 构建交互界面；
- 随插件启停和开发刷新自动挂载、清理并重新加载。

第三方 Client 模块通过 `seashard-plugin://<digest>/...` 协议加载。URL 只包含整包摘要和包内路径，不会向 Renderer 暴露插件的本机安装目录。

### 安全边界

第三方插件包按完整摘要授予信任。Host Entry 拥有 Node.js 完整能力；Client Entry 与 SeaShard 界面共享 Renderer 页面，但该 Renderer 保持 `sandbox: true`、`contextIsolation: true` 和 `nodeIntegration: false`。

- 安装命令会对插件的精确摘要授予完整机器访问信任；
- `plugin.json` 中的 `uses` 只限制插件调用哪些 SeaShard Service 方法；
- `uses` 无法限制插件直接访问文件系统、网络、环境变量或启动子进程；
- Client Entry 是在 SeaShard 主 Renderer 中执行的可信脚本，可以影响应用界面并访问 Renderer 已暴露的 Preload API；
- 只安装你信任且已经审查过的插件；
- 插件不得直接修改 SeaShard 核心数据库或 `plugin-data/documents.sqlite3`。

## 2. 开发环境

准备以下环境：

- 已安装的 SeaShard；
- SeaShard 提供的 `seashard` CLI；
- Node.js 24.11.0 或更高版本；
- pnpm、npm、Yarn 或 Bun；
- TypeScript 5.9 或兼容版本。

确认 CLI 可用：

```bash
seashard --version
seashard plugin --help
```

如果你从 SeaShard 源码工作区使用 CLI，先在 SeaShard 仓库执行完整构建：

```bash
pnpm install
pnpm run build
node apps/cli/dist/index.js plugin --help
```

后续示例统一使用 `seashard`。源码工作区用户可以把它替换成 `node <SeaShard仓库>/apps/cli/dist/index.js`。

## 3. 十分钟快速开始

### 3.1 创建项目结构

将开发文件与最终插件包目录分开：

```text
acme-greeter/
├─ package.json
├─ tsconfig.json
├─ src/
│  └─ host.ts
└─ bundle/
   ├─ plugin.json
   └─ dist/
      └─ host.js
```

`bundle/` 是唯一交给 SeaShard 校验和打包的目录。这样 `node_modules`、TypeScript 源码、编辑器配置和测试文件不会进入插件包。

### 3.2 创建 `package.json`

```json
{
  "name": "acme-greeter-development",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "build": "pnpm run typecheck && esbuild src/host.ts --bundle --platform=node --format=esm --target=es2023 --outfile=bundle/dist/host.js",
    "watch": "esbuild src/host.ts --bundle --platform=node --format=esm --target=es2023 --sourcemap --watch --outfile=bundle/dist/host.js"
  },
  "devDependencies": {
    "@seashard/contracts": "^0.2.0",
    "@seashard/plugin-sdk": "^0.2.0",
    "@types/node": "^24.0.0",
    "esbuild": "^0.25.0",
    "typescript": "^5.9.0"
  }
}
```

示例使用 esbuild 将运行时依赖一起打进 `bundle/dist/host.js`。Host 不会为插件包安装 npm 依赖，因此入口产物不能依赖包外的 `node_modules`。

### 3.3 创建 `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "types": ["node"],
    "skipLibCheck": false
  },
  "include": ["src/**/*.ts"]
}
```

### 3.4 创建 `bundle/plugin.json`

```json
{
  "id": "acme.greeter",
  "version": "0.1.0",
  "publisher": "acme",
  "entries": [
    {
      "id": "greeter.host",
      "runtime": "host",
      "module": "./dist/host.js",
      "hostProfiles": ["electron"],
      "uses": {
        "seashard.runtime-diagnostics": ["getSnapshot"]
      }
    }
  ],
  "compatibility": {
    "seaShard": ">=0.0.0 <1.0.0"
  }
}
```

### 3.5 创建 `src/host.ts`

这个示例读取 SeaShard 运行状态，并向 Agent 注册 `acme_runtime-summary` 工具。

```ts
import { runtimeDiagnosticsContract, type RuntimeDiagnosticsService } from "@seashard/contracts";
import type { JsonValue, PluginContext } from "@seashard/plugin-sdk";

export const inject = [runtimeDiagnosticsContract] as const;

export async function apply(context: PluginContext, _config: JsonValue) {
  const diagnostics = context.service<RuntimeDiagnosticsService>(runtimeDiagnosticsContract);
  const initial = await diagnostics.getSnapshot();
  console.log(`[acme.greeter] active components=${initial.components.length}`);

  context.agentTool(
    {
      namespace: "acme",
      name: "runtime-summary",
      title: "读取 SeaShard 运行摘要",
      description: "读取当前 Host 状态以及 active 或 failed 组件数量。",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      outputDescription: "Host 状态和组件数量。",
      examples: [{}],
    },
    async () => {
      const snapshot = await diagnostics.getSnapshot();
      return {
        hostState: snapshot.state,
        componentCount: snapshot.components.length,
        failedCount: snapshot.components.filter((component) => component.phase === "failed").length,
      };
    },
  );
}
```

### 3.6 安装依赖并构建

```bash
pnpm install
pnpm run build
```

构建完成后，`bundle/` 中应只有需要随插件分发的文件：

```text
bundle/
├─ plugin.json
└─ dist/
   └─ host.js
```

### 3.7 校验插件包目录

```bash
seashard plugin validate ./bundle
```

成功输出包括插件 ID、版本、摘要、Entry 数量和文件数量。`validate` 不执行插件代码。

### 3.8 启动开发 Host

终端一持续构建入口：

```bash
pnpm run watch
```

终端二启动真实 SeaShard Desktop Host：

```bash
seashard plugin dev ./bundle
```

`plugin dev` 会：

1. 校验 `bundle/plugin.json` 和全部包文件；
2. 以当前目录摘要创建只存在于本次进程的开发包；
3. 启动真实 Desktop Host；
4. 激活 `dev:acme.greeter:greeter.host` Runtime；
5. 监听 `bundle/` 变化并在构建产物更新后停止旧 Runtime、启动新 Runtime。

打开 Agent 后，可以明确要求它调用 `acme_runtime-summary`。插件的 `console.log` 和异常会显示在运行 `plugin dev` 的终端。

按 `Ctrl+C` 会等待文件监听器、Plugin Runtime、Plugin Host 和 Desktop Host 完成清理后退出。开发覆盖不会写入正式插件数据库。

## 4. CLI 工作流

### 4.1 命令总览

```text
seashard plugin validate [directory]
seashard plugin build [directory]
seashard plugin pack [directory]
seashard plugin install <package-or-directory>
seashard plugin dev [directory]
seashard plugin reload [runtime-id]
seashard plugin logs [runtime-id]
```

| 命令       | 行为                                                                  |
| ---------- | --------------------------------------------------------------------- |
| `validate` | 校验 Manifest、兼容范围、路径、文件限制、Entry 模块和摘要，不执行代码 |
| `build`    | 执行目标目录 `package.json` 的 `scripts.build`，随后校验同一目录      |
| `pack`     | 把目标目录全部文件写入确定性 `.seashard-plugin` 压缩包                |
| `install`  | 通过真实 Host 安装并启用压缩包或目录快照                              |
| `dev`      | 启动真实 Desktop Host，监视目录并重建开发 Runtime                     |
| `reload`   | 手动重载活动开发会话中的 Host Runtime                                 |
| `logs`     | 读取有界的 Runtime 生命周期和失败记录                                 |

推荐使用“项目根目录 + 独立 `bundle/`”结构。此结构下由项目自己的 `pnpm run build` 或 `pnpm run watch` 生成产物，再把 `bundle/` 传给 SeaShard CLI。

`seashard plugin build` 适合开发根目录与分发根目录相同、且构建依赖位于其父级的特殊项目。普通独立项目把 `node_modules` 放在插件包根目录后，会被校验器视为包内容，因此不推荐这种布局。

### 4.2 在软件内管理插件

`plugin dev` 启动的 Desktop 会把当前目录显示在“软件设置 → 插件设置”中，并标记为“临时加载”。这里可以查看插件包、Host/Client Entry、Runtime ID、Service 权限、信任状态和 SHA-256 摘要。

插件卡片上的开关控制整个插件包：

- 已安装插件的状态会持久化，并在下次启动时恢复；
- 开发插件的状态只属于当前 `plugin dev` 进程，目录重建和刷新会保留当前开关状态；
- 开发进程退出后临时插件消失，下次执行 `plugin dev` 时重新以启用状态加载。

### 4.3 查看 Runtime 生命周期

保持 `plugin dev` 运行，在另一个终端执行：

```bash
seashard plugin logs
```

记录事件包括：

```text
preparing
starting
active
reload-requested
stopping
stopped
failed
```

只查看指定 Runtime：

```bash
seashard plugin logs dev:acme.greeter:greeter.host
```

`plugin logs` 展示生命周期和失败原因。插件自己的标准输出与标准错误仍在 `plugin dev` 终端中。

### 4.4 手动重载

```bash
seashard plugin reload dev:acme.greeter:greeter.host
```

省略 Runtime ID 时，命令会处理当前发现的全部插件开发会话。并行开发多个插件时应传入 Runtime ID。

### 4.5 查询公开 Service

列出 Service Catalog：

```bash
seashard inspect services
seashard inspect services --json
```

查看单个 Contract：

```bash
seashard inspect service seashard.runtime-diagnostics
seashard inspect service seashard.runtime-diagnostics --json
```

Inspect 会输出：

- Contract 名称、所有者和说明；
- 方法签名、参数、返回值和关联 JSON 类型；
- 可以直接复制进 `plugin.json` 的 `uses`；
- 活动 Host 中的 Provider；
- 编译期目录与运行时 Provider 的方法漂移。

没有活动 Host 时，编译期 Contract 仍可查询，状态显示为 `inactive`。

## 5. `plugin.json` 参考

### 5.1 顶层字段

| 字段                           | 必需 | 规则                                                                         |
| ------------------------------ | ---- | ---------------------------------------------------------------------------- |
| `id`                           | 是   | 稳定插件 ID，1 至 128 个字符，使用小写字母、数字、`.`、`-`，首尾为字母或数字 |
| `version`                      | 是   | 标准语义化版本，例如 `0.1.0`                                                 |
| `publisher`                    | 是   | 发布者标识，使用与插件 ID 相同的字符规则                                     |
| `entries`                      | 是   | 至少一个 Entry，Entry ID 在包内唯一                                          |
| `compatibility.seaShard`       | 是   | SeaShard 语义化版本范围                                                      |
| `compatibility.clientProtocol` | 否   | Client 协议范围；纯 Host 插件通常省略                                        |

Manifest 采用严格校验。拼错字段、未知字段、重复 Entry ID 和不合法范围都会导致整个包被拒绝。`atomic` 当前不作为第三方开发行为开关，第三方包应省略它。

### 5.2 Host Entry 字段

| 字段           | 必需 | 规则                                                             |
| -------------- | ---- | ---------------------------------------------------------------- |
| `id`           | 是   | 包内稳定 Entry ID，字符规则与插件 ID 相同                        |
| `runtime`      | 是   | `host`                                                           |
| `module`       | 是   | 以 `./` 开头的包内 ESM `.js` 或 `.mjs` 路径                      |
| `hostProfiles` | 是   | 非空数组，可选 `electron`、`node`、`docker`                      |
| `uses`         | 是   | Contract 到方法名数组的映射；不调用任何 Service 时使用 `{}`      |
| `os`           | 否   | `win32`、`darwin`、`linux`、`aix`、`freebsd`、`openbsd`、`sunos` |
| `arch`         | 否   | `x64`、`arm64`、`ia32`、`arm`、`riscv64`、`ppc64`、`s390x`       |

`module` 不允许绝对路径、反斜杠、空路径段、`..` 或非 JavaScript 扩展名。

### 5.3 Client Entry 字段

| 字段      | 必需 | 规则                                                        |
| --------- | ---- | ----------------------------------------------------------- |
| `id`      | 是   | 包内稳定 Entry ID，字符规则与插件 ID 相同                   |
| `runtime` | 是   | `client`                                                    |
| `module`  | 是   | 以 `./` 开头的包内浏览器 ESM `.js` 或 `.mjs` 路径           |
| `targets` | 是   | 非空数组；Desktop 页面使用 `desktop`                        |
| `uses`    | 是   | Contract 到方法名数组的映射；不调用任何 Service 时使用 `{}` |
| `os`      | 否   | 与 Host Entry 相同的操作系统过滤条件                        |
| `arch`    | 否   | 与 Host Entry 相同的处理器架构过滤条件                      |

Client Entry 不能声明 `hostProfiles`。需要 Client Entry 的插件应填写 `compatibility.clientProtocol`，当前 Desktop Client 协议使用范围 `>=1 <2`。

安装时，SeaShard 会为包中的每个 Entry 创建稳定 Binding：

```text
plugin:<plugin-id>:<entry-id>
```

开发会话使用：

```text
dev:<plugin-id>:<entry-id>
```

所有第三方 Binding 当前都是全局范围。被 `hostProfiles`、`targets`、`os` 或 `arch` 排除的 Entry 会保留在已安装包中，但不会在不兼容的 Host 或 Client 上激活。

### 5.4 `uses` 是方法级授权

调用一个 SeaShard Service 时，在 `uses` 中准确声明 Contract 和方法：

```json
{
  "uses": {
    "seashard.runtime-diagnostics": ["getSnapshot"],
    "seashard.server-runtime": ["get", "getLogs"]
  }
}
```

规则：

- Contract 必须使用公开 Catalog 中的稳定名称；
- 方法名区分大小写；
- 每个方法数组至少包含一个值且不能重复；
- 未声明的方法调用会被 Host 拒绝；
- `uses` 不会自动等待 Provider 启动，模块还需要通过 `inject` 声明启动依赖。

## 6. Host Entry 模块协议

Host Entry 是 ESM 模块。运行时读取以下命名导出：

```ts
import type { JsonValue, PluginContext, StandardSchema } from "@seashard/plugin-sdk";

export const inject: readonly string[] = [];
export const provides: readonly string[] = [];
export const Config: StandardSchema | undefined = undefined;

export async function apply(
  context: PluginContext,
  config: JsonValue,
): Promise<(() => Promise<void>) | void> {
  console.log(`[plugin] active runtime=${context.runtimeId}`);

  return async () => {
    console.log(`[plugin] stopped runtime=${context.runtimeId}`);
  };
}
```

- `inject`：本 Entry 启动前必须可用的 Service Contract；
- `provides`：本 Entry 承诺通过 `context.provide()` 发布的 Contract；
- `Config`：可选 Standard Schema 校验器；
- `apply(context, config)`：激活入口，可异步执行并返回清理函数。

运行时会拒绝没有 `apply` 函数的模块。

### 6.1 生命周期规则

不要在模块顶层启动定时器、监听器、服务器、文件句柄或子进程。模块顶层只声明常量、类型和纯函数。

把副作用放进 `apply()`，并使用 `context.effect()`：

```ts
import type { JsonValue, PluginContext } from "@seashard/plugin-sdk";

export function apply(context: PluginContext, _config: JsonValue) {
  context.effect(() => {
    const timer = setInterval(() => {
      console.log(`[heartbeat] ${context.runtimeId}`);
    }, 60_000);

    return () => clearInterval(timer);
  }, "heartbeat timer");
}
```

以下操作会自动绑定到当前 Runtime 生命周期：

- `context.provide()`；
- `context.contribute()`；
- `context.agentTool()`；
- `context.agentResources()`；
- `context.on()`。

reload、升级、停用、启动失败和应用退出都可能触发清理。清理函数必须幂等，并等待异步资源真正关闭。

替换顺序固定为停止旧 Runtime，再启动新 Runtime。插件功能在替换期间可能短暂不可用，同一 Binding 不会同时运行两个版本。

### 6.2 配置默认值

安装和开发首次激活时，第三方 Entry 收到的 Binding 配置是空对象 `{}`。当前开发 CLI 不提供任意 Binding 配置编辑命令。

如果模块导出 `Config`，校验器必须接受 `{}`，或把它转换成默认配置：

```ts
import type { JsonValue, PluginContext, StandardSchema } from "@seashard/plugin-sdk";

type GreeterConfig = {
  prefix: string;
};

export const Config = {
  "~standard": {
    version: 1,
    vendor: "acme",
    validate(input: unknown) {
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        return { issues: [{ message: "config must be an object" }] };
      }

      const prefix = (input as { prefix?: unknown }).prefix;
      if (prefix !== undefined && typeof prefix !== "string") {
        return { issues: [{ message: "prefix must be a string" }] };
      }

      return {
        value: {
          prefix: prefix ?? "SeaShard",
        } satisfies GreeterConfig,
      };
    },
  },
} satisfies StandardSchema;

export function apply(_context: PluginContext, config: JsonValue) {
  const normalized = config as GreeterConfig;
  console.log(`${normalized.prefix} plugin active`);
}
```

需要用户可修改的长期设置时，插件应通过自己的公开 Service、Agent Tool 或 Client Entry 修改 `context.storage`，不要直接修改 Binding 数据库。

## 7. Client Entry 模块协议

Client Entry 是浏览器 ESM 模块。模块在 SeaShard 主 Renderer 中运行，入口使用 `@seashard/ui-sdk` 的 `defineClientUiModule()` 定义：

```ts
import { runtimeDiagnosticsContract, type RuntimeDiagnosticsService } from "@seashard/contracts";
import { defineClientUiModule } from "@seashard/ui-sdk";
import { defineComponent, h, onMounted, ref } from "vue";

function createRuntimePage(diagnostics: RuntimeDiagnosticsService) {
  return defineComponent({
    name: "AcmeRuntimePage",
    setup() {
      const state = ref("loading");
      const componentCount = ref(0);

      onMounted(async () => {
        const snapshot = await diagnostics.getSnapshot();
        state.value = snapshot.state;
        componentCount.value = snapshot.components.length;
      });

      return () =>
        h("main", { class: "acme-runtime-page" }, [
          h("h1", "Runtime"),
          h("dl", [
            h("dt", "State"),
            h("dd", state.value),
            h("dt", "Components"),
            h("dd", String(componentCount.value)),
          ]),
        ]);
    },
  });
}

const clientModule = defineClientUiModule({
  apply(context) {
    const diagnostics = context.service<RuntimeDiagnosticsService>(runtimeDiagnosticsContract);
    context.slots.register(
      {
        name: "navigation.page",
        id: "acme-runtime",
        path: "/acme/runtime",
        label: "Runtime",
      },
      createRuntimePage(diagnostics),
    );
  },
});

export const apply = clientModule.apply;
```

对应的 Manifest Entry：

```json
{
  "id": "runtime.client",
  "runtime": "client",
  "module": "./dist/client.js",
  "targets": ["desktop"],
  "uses": {
    "seashard.runtime-diagnostics": ["getSnapshot"]
  }
}
```

在插件开发项目中安装前端依赖：

```bash
pnpm add -D @seashard/ui-sdk@^0.2.0 vue@^3.5.0
```

使用 esbuild 生成完整浏览器 ESM：

```json
{
  "scripts": {
    "build:client": "esbuild src/client.ts --bundle --platform=browser --format=esm --target=chrome142 --outfile=bundle/dist/client.js",
    "watch:client": "esbuild src/client.ts --bundle --platform=browser --format=esm --target=chrome142 --sourcemap --watch --outfile=bundle/dist/client.js"
  }
}
```

Client 包必须满足以下条件：

- 把 Vue、UI SDK 和其他运行时依赖打进产物，不能留下浏览器无法解析的裸 npm import；
- 不导入 Node.js、Electron、SeaShard 内部源码路径或只面向 Host 的模块；
- 每个前端页面作为独立组件包和独立 Client Entry 发布；
- 跨页面共享状态通过独立 shared 包和明确的 Service Contract 组织；
- `context.service()` 可以调用 Renderer 本地 Service 或 Host Service；每个方法都必须在当前 Client Entry 的 `uses` 中声明；
- 模块顶层不启动永久副作用，监听器和其他资源通过 `context.effect()` 注册清理函数。

### 7.1 加载与刷新

Main 根据当前激活 Client Entry 发布模块引用：

```text
seashard-plugin://<package-sha256>/dist/client.js
```

自定义协议只解析当前仍处于激活状态、摘要完全匹配的包。请求路径经过包根边界和 `realpath` 检查，停用或升级后，旧摘要立即失去资源访问权。

标准 URL 路径支持入口内部的相对 ESM import 和 `new URL("./asset.png", import.meta.url)`。单文件 bundle 仍是推荐发布形态，可以减少加载阶段的缺失资源和缓存问题。

`plugin dev` 检测到包文件变化后会生成新摘要、撤销旧 Entry、发布新模块 URL，再启动新 Entry。Client Runtime 会先执行旧清理函数并移除旧路由，然后加载新模块。

### 7.2 UI Slot

Client UI 使用带所有权的 Slot 树。`context.slots.register(options, component)` 是统一注册入口：

| 根 Slot             | 类型    | 注册字段                                      |
| ------------------- | ------- | --------------------------------------------- |
| `navigation.page`   | `list`  | `id`、`path`、`label`、可选导航位置和设置分组 |
| `workspace.sidebar` | `keyed` | `key`，取值为目标工作区 ID                    |

`navigation.page` 的页面 ID 和路径必须全局唯一。路径必须是非根绝对路径，例如 `/acme/runtime`。每个页面仍必须由独立组件包和独立 Client Entry 发布。

Slot 支持四种调度语义：

- `single`：整个 Slot 只启用最高优先级 Entry；
- `list`：按 `priority` 和注册顺序渲染全部 Entry；
- `keyed`：每个 `key` 启用最高优先级 Entry；
- `chain`：按优先级调用 `match(owner)`，首个返回非 `undefined` 的 Entry 接管。

较小的 `priority` 先执行。某个激活 Entry 渲染崩溃时，它会让出当前 cell，由下一优先级候选接管；故障只进入该 Client Entry 的 UI Runtime 诊断。

`register()` 返回幂等清理函数，同时自动归属于当前 Client Entry。插件停用、刷新、升级或 `apply()` 失败时，即使插件没有手动调用返回值，Runtime 也会撤销注册。

### 7.3 服务器侧栏页面与当前实例

第三方 Client Entry 使用 `placement: "server"` 把页面追加到服务器管理侧栏。页面路径必须位于 `/server/` 下，且不能占用 `/server/download`；同一 Entry 仍然只发布一个页面：

```ts
import { defineClientUiModule } from "@seashard/ui-sdk";
import { defineComponent, h, ref } from "vue";

export const apply = defineClientUiModule({
  apply(context) {
    const selectedInstanceId = ref(context.serverSelection.getCurrentInstanceId());
    context.serverSelection.subscribe((instanceId) => {
      selectedInstanceId.value = instanceId;
    });

    const page = defineComponent({
      name: "AcmeScheduledCommandsPage",
      setup: () => () =>
        h("main", [h("h1", "定时命令"), h("code", selectedInstanceId.value ?? "未选择服务器")]),
    });

    context.slots.register(
      {
        name: "navigation.page",
        id: "acme.scheduled-commands",
        path: "/server/acme-scheduled-commands",
        label: "定时命令",
        placement: "server",
        order: 100,
      },
      page,
    );
  },
}).apply;
```

`context.serverSelection.getCurrentInstanceId()` 同步读取当前值。`subscribe()` 注册时立即投递当前值，后续在用户切换服务器时继续通知；返回的 disposer 自动归属于当前 Client Entry，也可以由插件提前调用。该通道是 Renderer 本地 UI 状态，不需要写入 Manifest `uses`，也不跨 IPC 传递 Vue Ref。

当前值可能为 `undefined`，也可能在异步操作期间变化。它只表示 Desktop 当前选择，不承担实例存在性或操作授权；调用 Host Service 前应继续使用 `seashard.server-instance-manager.listForClient()` 等公开方法验证实例 ID。

`placement: "server"` 只追加页面导航项。`workspace.sidebar` 仍表示接管整个工作区侧栏，不应拿它模拟追加菜单。

### 7.4 扩展页面根区域

页面显示期间，Runtime 会动态声明 `page.<page-id>.root`。扩展方必须通过 `inject()` 等待声明，不能假定目标页面已经加载：

```ts
import { defineClientUiModule, pageRootSlot } from "@seashard/ui-sdk";
import { defineComponent, h, type PropType } from "vue";

const PageBadge = defineComponent({
  name: "AcmePageBadge",
  props: {
    pageId: { type: String, required: true },
    root: { type: Object as PropType<HTMLElement>, required: true },
  },
  setup: (props) => () => h("div", { class: "acme-page-badge" }, `Page: ${props.pageId}`),
});

const target = pageRootSlot("server-overview");

export const apply = defineClientUiModule({
  apply(context) {
    context.slots.inject(target, () =>
      context.slots.register(
        {
          name: target,
          id: "acme.server-overview.badge",
          mode: "overlay",
          priority: 100,
        },
        PageBadge,
      ),
    );
  },
}).apply;
```

页面根 Entry 收到：

```ts
interface PageRootExtensionProps {
  readonly pageId: string;
  readonly root: HTMLElement;
}
```

`mode` 决定托管位置：

| 模式      | 行为                                         |
| --------- | -------------------------------------------- |
| `prepend` | 渲染在原页面之前                             |
| `append`  | 渲染在原页面之后                             |
| `overlay` | 渲染在当前页面内容区域的覆盖层中             |
| `replace` | 最高优先级 Entry 替换原页面                  |
| `dom`     | 只挂载组件，由组件使用 `root` 处理原页面 DOM |

`prepend`、`append`、`overlay` 和 `replace` 的 Vue 节点由 Runtime 托管，页面离开后自动卸载。`dom` 仅提供生命周期宿主；组件如果直接添加节点、属性、事件或观察器，必须在自身 `onUnmounted()` 中恢复原页面。

`inject(name, setup)` 与加载顺序无关：

1. 目标 Slot 已存在时立即执行 `setup`；
2. 目标稍后出现时自动执行；
3. 目标消失时执行 `setup` 返回的清理函数；
4. 同名 Slot 再次出现时重新执行 `setup`；
5. 扩展插件先停用时，等待和已激活注册一起撤销。

### 7.5 声明子 Slot

任意 Entry 可以通过 `children` 声明自己的扩展点：

```ts
context.slots.register(
  {
    name: target,
    id: "acme.server-overview.panel",
    mode: "append",
    children: {
      "acme.server-overview.panel.actions": {
        kind: "list",
        scope: "page",
      },
    },
  },
  AcmePanel,
);
```

声明了 `children` 的组件会收到 `renderSlot(name, owner?, options?)` prop。组件只能渲染自己声明的子 Slot。其他 Client Entry 使用 `inject()` 和 `register()` 向该子 Slot 发布组件。

父 Entry 被替换、崩溃、页面离开或插件停用时，Runtime 会递归撤销子 Slot 声明、子 Entry、注入结果和它们的清理函数。第三方扩展无需维护跨插件卸载顺序。

## 8. 使用 Service Contract

### 8.1 调用 SeaShard Service

使用 `@seashard/contracts` 导出的类型化 Contract：

```ts
import { runtimeDiagnosticsContract, type RuntimeDiagnosticsService } from "@seashard/contracts";
import type { JsonValue, PluginContext } from "@seashard/plugin-sdk";

export const inject = [runtimeDiagnosticsContract] as const;

export async function apply(context: PluginContext, _config: JsonValue) {
  const diagnostics = context.service<RuntimeDiagnosticsService>(runtimeDiagnosticsContract);
  const snapshot = await diagnostics.getSnapshot();
  console.log(`Host state: ${snapshot.state}`);
}
```

要让这段代码运行，Manifest 同一个 Entry 中还必须声明：

```json
{
  "uses": {
    "seashard.runtime-diagnostics": ["getSnapshot"]
  }
}
```

`inject` 与 `uses` 职责不同：

- `inject` 决定启动依赖；Provider 不可用时 Entry 暂不启动；
- `uses` 决定调用权限；缺少方法授权时调用直接失败。

所有 Service 调用都是异步边界，即使 Provider 方法内部同步返回，也始终对代理调用使用 `await`。

### 8.2 提供自己的 Service

```ts
import type { JsonValue, PluginContext } from "@seashard/plugin-sdk";

export const provides = ["acme.greeter"] as const;

export function apply(context: PluginContext, _config: JsonValue) {
  context.provide("acme.greeter", {
    greet(name) {
      if (typeof name !== "string") {
        throw new TypeError("name must be a string");
      }
      return `Hello, ${name}`;
    },
  });
}
```

供其他插件使用时，应同时发布 TypeScript 接口和稳定 Contract 字符串：

```ts
import { defineServiceContract } from "@seashard/plugin-sdk";

export interface GreeterService {
  greet(name: string): Promise<string>;
}

export const greeterContract = defineServiceContract<GreeterService>("acme.greeter");
```

Service 参数和返回值必须是 JSON 值或 `void`。不能跨边界传递函数、类实例、`Buffer`、流、DOM 对象、Electron 对象、Node 句柄或循环引用。

### 8.3 从 Client 调用插件自己的 Host Service

同一个插件包可以由 Host Entry 提供业务 Service，再由 Client Entry 渲染页面并调用。Contract 放在前后端共同依赖的源码包中：

```ts
import { defineServiceContract } from "@seashard/plugin-sdk";

export interface GreeterService {
  greet(name: string): Promise<string>;
}

export const greeterContract = defineServiceContract<GreeterService>("acme.greeter");
```

Host Entry 发布 Service：

```ts
import type { JsonValue, PluginContext } from "@seashard/plugin-sdk";
import { greeterContract } from "./shared";

export const provides = [greeterContract] as const;

export function apply(context: PluginContext, _config: JsonValue) {
  context.provide(greeterContract, {
    async greet(name) {
      if (typeof name !== "string") throw new TypeError("name must be a string");
      return `Hello, ${name}`;
    },
  });
}
```

Client Entry 通过相同 Contract 调用：

```ts
import { defineClientUiModule } from "@seashard/ui-sdk";
import { greeterContract, type GreeterService } from "./shared";

const clientModule = defineClientUiModule({
  async apply(context) {
    const greeter = context.service<GreeterService>(greeterContract);
    console.log(await greeter.greet("SeaShard"));
  },
});

export const apply = clientModule.apply;
```

Client Entry 的 Manifest 必须授权准确方法：

```json
{
  "id": "greeter.client",
  "runtime": "client",
  "module": "./dist/client.js",
  "targets": ["desktop"],
  "uses": {
    "acme.greeter": ["greet"]
  }
}
```

调用经过固定链路：

```text
ClientUiContext Service Proxy
→ Preload 固定 IPC
→ 当前 Client Runtime 与包摘要校验
→ Manifest uses 方法授权
→ Main Service Registry
→ Host Entry Provider
```

Runtime ID 和包摘要必须同时匹配当前活动 Entry。插件刷新、升级或停用后，旧 Client 模块与旧 Service Proxy 会立即失效。参数和返回值在 IPC 两端按 JSON 边界校验；Provider 错误以 Promise rejection 返回 Client。

## 9. 托管存储

`context.storage` 为当前 Runtime 提供独立 JSON 文档空间：

```ts
import type { JsonValue, PluginContext } from "@seashard/plugin-sdk";

export async function apply(context: PluginContext, _config: JsonValue) {
  const current = await context.storage.get("settings");
  if (!current) {
    await context.storage.put(
      "settings",
      { enabled: true, greeting: "Hello" },
      { expectedRevision: null },
    );
  }
}
```

API：

```ts
import type { PluginContext } from "@seashard/plugin-sdk";

export async function replaceSettings(context: PluginContext) {
  const current = await context.storage.get("settings");
  const saved = await context.storage.put(
    "settings",
    { enabled: false, greeting: "Welcome" },
    { expectedRevision: current?.revision ?? null },
  );

  return context.storage.delete("settings", {
    expectedRevision: saved.revision,
  });
}
```

语义：

- `expectedRevision: null`：只在文档不存在时创建；
- `expectedRevision: number`：执行 CAS 更新或删除，版本不一致时拒绝；
- 省略 `expectedRevision`：无条件写入；
- `ttlMs`：设置最长 365 天的过期时间；
- key 最长 255 个字符，可使用字母、数字、`.`、`_`、`-`、`/`；
- key 不能包含空路径段、`.` 或 `..`；
- 单个 JSON 文档最大 1 MiB。

存储命名空间由插件 ID 和 Runtime ID 决定。插件不能指定其他命名空间，也不能读取另一个 Binding 的文档。

## 10. Agent 能力

### 10.1 Agent Tool

```ts
import type { JsonValue, PluginContext } from "@seashard/plugin-sdk";

export function apply(context: PluginContext, _config: JsonValue) {
  context.agentTool(
    {
      namespace: "acme",
      name: "sum",
      title: "计算两个数字的和",
      description: "接收 a 和 b，返回确定性的数值求和结果。",
      inputSchema: {
        type: "object",
        properties: {
          a: { type: "number" },
          b: { type: "number" },
        },
        required: ["a", "b"],
        additionalProperties: false,
      },
      outputDescription: "包含 result 数字的对象。",
      examples: [{ a: 2, b: 3 }],
    },
    async (input, execution) => {
      if (execution.signal?.aborted) {
        throw new Error("Agent tool call was cancelled");
      }
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new TypeError("input must be an object");
      }
      const { a, b } = input as { a?: unknown; b?: unknown };
      if (typeof a !== "number" || typeof b !== "number") {
        throw new TypeError("a and b must be numbers");
      }
      return { result: a + b };
    },
  );
}
```

模型看到的工具名是 `<namespace>_<name>`，示例得到 `acme_sum`。

- `namespace` 和 `name` 使用小写字母、数字、`-`，并以字母开头；
- `title` 面向用户；
- `description` 应完整解释工具适用条件和行为；
- `inputSchema` 使用 JSON Schema；
- `confirmationLevel` 可省略；省略或 `0` 表示无需确认，`1` 表示受限编辑或局部副作用，`2` 表示任意命令执行或可访问整机的 `file://` 能力；
- `只读` 模式自动执行零级工具，`编辑权限` 模式再自动执行一级工具，`YOLO` 模式自动执行全部级别；超过当前模式自动确认范围的工具会在发送框上方等待用户允许；
- Handler 必须再次检查输入并只返回 JSON 值；
- 长操作应响应 `execution.signal`。

工具注册随 Runtime 停止自动失效。已经取得旧快照的 Invocation 也不能继续穿透已销毁 Runtime。

### 10.2 Agent Resource

Resource 使用 URI 路由表示可读取能力。路径参数由资源注册时声明，资源专有输入放在 `inputSchema` 中。

```ts
import { defineAgentResource, type JsonValue, type PluginContext } from "@seashard/plugin-sdk";

type GreetingInput = {
  uppercase: boolean;
};

type GreetingOutput = {
  message: string;
};

export function apply(context: PluginContext, _config: JsonValue) {
  context.agentResources({
    "acme://greetings/{name}": defineAgentResource<GreetingInput, GreetingOutput>({
      description: "读取指定名字的问候语。",
      inputSchema: {
        type: "object",
        properties: {
          uppercase: { type: "boolean" },
        },
        required: ["uppercase"],
        additionalProperties: false,
      },
      outputDescription: "包含最终问候文本的 JSON 对象。",
      examples: [{ uppercase: false }],
      help: "name 来自 URI 路径；uppercase 控制结果是否转成大写。",
      presentation: {
        title: "读取问候语",
        icon: "help",
      },
      implementation: {
        read(request) {
          const rawMessage = `Hello, ${request.pathParams.name}`;
          return {
            mimeType: "application/json",
            content: {
              message: request.input.uppercase ? rawMessage.toUpperCase() : rawMessage,
            },
          };
        },
        presentRequest(request) {
          return [
            { label: "Name", value: request.pathParams.name },
            {
              label: "Uppercase",
              value: request.input.uppercase ? "Yes" : "No",
            },
          ];
        },
        presentResult(_request, result) {
          return [{ label: "Message", value: result.content.message }];
        },
      },
    }),
  });
}
```

模型可读取：

```text
acme://greetings/Steve
```

路由规则：

- URI 必须是 `<scheme>://<path>`；
- `{name}` 形式的参数必须独占完整路径段；
- Pattern 不能包含查询参数；
- 实际读取 URI 可以带不重复的查询参数，并通过 `request.uri.query` 读取；
- 同一结构路由不能重复注册；
- 更具体的静态路由优先于参数路由；
- `inputSchema` 由 Host 在调用实现前验证；
- `mimeType` 必须非空，`content` 必须是 JSON 值。

`presentRequest`、`presentResult` 和 `presentation` 只生成客户端工具卡片，不会进入模型上下文。资源的 `description`、`inputSchema`、`examples` 和 `help` 才负责向 Agent 解释如何使用能力。

### 10.3 模型供应商边界

模型供应商由 Core Host 内建组件统一注册，第三方插件不能注册或替换 Provider Type。Plugin Host 会拒绝第三方调用 `context.aiProviderType()`。

内建供应商驱动使用 `@earendil-works/pi-ai`，负责模型目录、协议适配、认证和流式响应。第三方插件需要扩展 Agent 能力时，应注册 Agent Tool 或 Agent Resource。

## 11. 事件与 Contribution

### 11.1 插件事件

```ts
import type { JsonValue, PluginContext } from "@seashard/plugin-sdk";

export function apply(context: PluginContext, _config: JsonValue) {
  context.on("acme.greeter.refresh", async (payload) => {
    console.log(`Refresh requested: ${JSON.stringify(payload)}`);
  });

  context.effect(() => {
    const timer = setTimeout(() => {
      void context.emit("acme.greeter.refresh", { source: "timer" });
    }, 1_000);
    return () => clearTimeout(timer);
  }, "refresh event timer");
}
```

事件名使用小写命名空间。payload 必须是 JSON 值。事件只投递给当前执行 Scope Chain 中匹配的订阅者；第三方 Binding 当前为 global Scope。

### 11.2 Contribution

`context.contribute(kind, value)` 发布随 Runtime 生命周期撤销的声明式 JSON 数据。只有已经定义消费者协议的 Contribution kind 才会产生产品行为。自定义 kind 不会自动创建菜单、命令、设置页或 UI。

跨插件公开能力优先使用 Service Contract；向 Agent 暴露能力使用 Agent Tool 或 Agent Resource。

## 12. 打包、安装与升级

### 12.1 打包

先执行正式构建和类型检查：

```bash
pnpm run build
seashard plugin validate ./bundle
```

删除同名旧归档后打包：

```bash
seashard plugin pack ./bundle
```

输出位于 `bundle/` 的父目录：

```text
acme.greeter-0.1.0.seashard-plugin
```

`pack` 不读取 `.gitignore`，也不隐式排除任何文件。`bundle/` 中的每个文件都会进入归档。

限制：

- 压缩包不超过 32 MiB；
- 解压后总大小不超过 128 MiB；
- 最多 4096 个文件；
- 单文件不超过 32 MiB；
- 不允许符号链接；
- 不允许绝对路径或路径穿越；
- 包根目录必须直接包含 `plugin.json`。

### 12.2 安装归档

```bash
seashard plugin install ./acme.greeter-0.1.0.seashard-plugin
```

安装成功后，CLI 输出插件 ID、版本、来源和摘要。Host 会选择该版本、为每个 Entry 创建自动 Binding，激活适用于当前环境的 Host Entry，并把 Client Entry 发布给 Desktop Renderer。

已经进入官方 Registry 的版本也可以在“软件设置 → 插件市场”中一键安装或更新。市场页面只向 Host 发送插件 ID 和版本；Host 会从当前 Catalog 重新解析下载地址，限制 GitHub Release 下载主机，并依次校验归档 SHA-256、包内 Manifest 身份和 `packageDigest`，通过后选择该版本、创建自动 Binding 并立即启用。页面会把摘要一致的版本标记为“已安装”；同 ID 的 `plugin dev` 开发版本生效时会禁用市场安装，避免正式包被开发覆盖后造成状态误判。

### 12.3 安装目录快照

开发者也可以显式安装目录：

```bash
seashard plugin install ./bundle
```

Installer 会先把目录复制到私有暂存区，对复制结果重新计算摘要，再把不可变快照持久化到插件存储。后续修改 `bundle/` 不会改变已经安装和授予信任的代码。

持续开发使用 `plugin dev`；需要持久化并跨重启验证时使用 `plugin install`。

### 12.4 升级

1. 修改 `plugin.json` 的语义化版本；
2. 重新构建；
3. 重新校验；
4. 删除同名旧归档；
5. 重新打包；
6. 安装新归档。

包选择和自动 Binding 替换在同一个数据库事务中提交。新版本激活失败时，Host 会恢复先前选择和自动 Binding。

当前开发 CLI 提供验证、开发、重载、日志、打包和安装能力；“软件设置 → 插件设置”可以停用或重新启用已安装插件与当前开发进程加载的临时插件。卸载尚未作为开发 CLI 或界面操作开放。

### 12.5 登记到官方插件市场

插件市场只读取官方注册仓库发布的静态 Catalog，不搜索 GitHub Topic，也不从插件源码默认分支读取 Manifest。发布者完成以下步骤后，通过注册仓库 PR 登记：

1. 使用 `seashard plugin pack ./bundle` 生成 `.seashard-plugin`；
2. 在公开源码仓库创建 GitHub Release，并上传该归档；
3. 计算 Release Asset 文件本身的 SHA-256；
4. 在 [`SeaShard-Plugin-Registry`](https://github.com/SeaLantern-Studio/SeaShard-Plugin-Registry) 的 `registry/plugins/<plugin-id>.json` 中登记插件及发布版本；
5. 提交 PR，并完成模板中的 CC0 1.0 Universal 注册数据贡献确认。

Registry CI 会下载指定 Release Asset，校验归档 SHA-256、安全解包、解析包内 `plugin.json`，并计算 SeaShard `packageDigest`。登记的插件 ID、版本和发布包 Manifest 必须完全一致。CI 不执行插件入口，格式验证也不代表安全审核结论。

注册记录合并后，CI 以 `catalog-<commit>` 标签创建不可变 Catalog Release。SeaShard 通过固定地址 `https://github.com/SeaLantern-Studio/SeaShard-Plugin-Registry/releases/latest/download/catalog-v1.json` 获取最新目录；该下载不调用 GitHub API。插件源码和 Release 制品继续遵循插件自己的许可证，CC0 只覆盖提交到注册仓库的注册数据和说明文字。

后续版本继续追加到同一个注册文件。已经登记的版本、标签、Asset 文件名和归档摘要不可修改；存在安全问题时应将版本标记为 `yanked`，并发布更高版本。

## 13. 常见错误

### `plugin package does not contain plugin.json`

传给 CLI 的目录层级错误。`plugin.json` 必须直接位于目标目录根部。

### `plugin entry module is missing`

先执行构建，并确认 `module` 指向目标目录内真实存在的 `.js` 或 `.mjs` 文件。

### `symbolic links are not allowed`

包目录中存在符号链接，常见来源是把 `node_modules` 放进包根目录。只把独立 `bundle/` 交给 CLI。

### `plugin package exceeds 4096 files`

包目录混入依赖、源码、缓存或构建中间文件。清理 `bundle/`，只保留 Manifest、入口产物和运行所需资产。

### `service call is not allowed`

检查当前 Entry 的 `uses` 是否包含准确 Contract 和方法名。修改 Manifest 后重新触发开发刷新。

### Entry 一直没有进入 `active`

执行：

```bash
seashard plugin logs dev:acme.greeter:greeter.host
```

重点检查：

- `inject` 中的 Service 是否存在；
- `uses` 是否完整；
- `Config` 是否接受初始 `{}`；
- 模块是否导出 `apply`；
- `hostProfiles`、`os`、`arch` 是否包含当前环境；
- `apply` 是否抛出异常。

### `Failed to fetch dynamically imported module`

确认 Client Entry 的 `module` 指向真实产物，浏览器 bundle 中没有裸 npm import，并检查入口引用的相对 chunk 和资产都在包内。开发刷新期间旧摘要会立即失效，不要在 Entry 清理后继续异步加载旧 URL。

### `client UI module must export an apply function`

入口必须导出命名 `apply`，或默认导出包含 `apply` 的对象。使用 `defineClientUiModule()` 时，按示例导出 `clientModule.apply`。

### `no active plugin development session was found`

先保持以下命令运行：

```bash
seashard plugin dev ./bundle
```

随后在另一个终端执行 `plugin logs` 或 `plugin reload`。

### 修改源码后没有 reload

确认源码构建器正在把新产物写入 Manifest 对应的 `bundle/dist/*.js`。`plugin dev ./bundle` 只监听 `bundle/`，不会监听它外部的 `src/`。

### 重新打包时报文件已存在

`pack` 不覆盖同名归档。删除或移动旧的 `<id>-<version>.seashard-plugin`，或提高 Manifest 版本后再次打包。

## 14. 发布检查清单

发布每个版本前完成以下检查：

- [ ] `id`、`publisher`、Entry ID 和 Contract 使用稳定命名空间；
- [ ] `version` 已按语义化版本更新；
- [ ] `compatibility.seaShard` 覆盖实际验证的 SeaShard 版本；
- [ ] 包含 Client Entry 时，`compatibility.clientProtocol` 覆盖实际验证的 Desktop Client 协议；
- [ ] `uses` 只包含实际调用的 Contract 方法；
- [ ] 所有运行依赖已经打进入口产物或作为包内相对模块存在；
- [ ] `bundle/` 不包含 `node_modules`、源码、密钥、日志、测试数据和编辑器配置；
- [ ] `seashard plugin validate ./bundle` 通过；
- [ ] `seashard plugin dev ./bundle` 首次激活通过；
- [ ] 修改产物后自动 reload 通过；
- [ ] Client Entry 刷新后旧页面、路由、监听器和其他副作用全部释放；
- [ ] `seashard plugin reload <runtime-id>` 通过；
- [ ] Runtime 停止后定时器、监听器、文件句柄和子进程全部释放；
- [ ] Service 参数和返回值全部可 JSON 序列化；
- [ ] Agent Tool 与 Resource 对输入进行业务校验并响应取消；
- [ ] 未声明 Service 方法的调用会被拒绝；
- [ ] 归档安装后功能正常；
- [ ] 重启 SeaShard 后已安装版本仍可恢复；
- [ ] 发布说明明确告知插件拥有完整机器访问能力。
- [ ] 如需进入插件市场，已发布与 Manifest 版本一致的 `.seashard-plugin` GitHub Release Asset；
- [ ] 如需进入插件市场，已计算归档 SHA-256，并向 `SeaShard-Plugin-Registry` 提交或更新注册文件；

## 15. 公开包与权威查询入口

- [`@seashard/plugin-sdk`](../packages/plugin-sdk/README.md)：PluginContext、Manifest、存储、Agent 能力和 JSON 边界类型；
- [`@seashard/contracts`](../packages/contracts/README.md)：SeaShard 公开 Service Contract 与数据类型；
- [`@seashard/ui-sdk`](../packages/ui-sdk/README.md)：Client Entry、递归 UI Slot、Slot 条目与渲染器协议；
- `seashard inspect services`：当前 CLI 附带的完整 Service Catalog；
- `seashard inspect service <contract> --json`：单个 Contract 的机器可读定义。

开发时以已安装 SDK 的类型和 CLI Service Catalog 为权威来源。不要导入 SeaShard 仓库中的内部组件路径、数据库实现、Cordis Context、Electron 对象或未公开模块。
