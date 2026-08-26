# @seashard/ui-sdk

SeaShard Client Entry 的受控 UI SDK，提供可级联清理的 Slot、页面、工作区侧栏、Service 和生命周期类型。

## 安装

```bash
pnpm add @seashard/ui-sdk @seashard/contracts @seashard/plugin-sdk vue
```

运行环境要求 Node.js 24.11.0 或更高版本，并要求 Vue 3.5。

## Client Entry

Client Entry 通过 `ClientUiContext` 使用受控 UI 能力，不会获得 Main Context、Node.js 或 Electron 对象。模块仍与 SeaShard 界面共享 Renderer 全局环境，因此安装包必须按可信代码审查。

```ts
import { defineClientUiModule } from "@seashard/ui-sdk";
import ExamplePage from "./ExamplePage.vue";

const clientModule = defineClientUiModule({
  apply(context) {
    context.slots.register(
      {
        name: "navigation.page",
        id: "example.page",
        path: "/example",
        label: "Example",
      },
      ExamplePage,
    );
  },
});

export const apply = clientModule.apply;
```

第三方包在 `plugin.json` 中声明 Desktop Client Entry：

```json
{
  "id": "example.client",
  "runtime": "client",
  "module": "./dist/client.js",
  "targets": ["desktop"],
  "uses": {}
}
```

入口必须构建成完整浏览器 ESM，不能留下裸 npm import：

```bash
esbuild src/client.ts --bundle --platform=browser --format=esm --target=chrome142 --outfile=bundle/dist/client.js
```

SeaShard 只通过当前激活包的摘要协议加载模块和相对资源。插件刷新或升级会产生新摘要，Client Runtime 会级联清理旧 Slot 注册，再加载新模块。

一个 Client Entry 应只发布一个页面组件包。跨页面共享状态和代码应通过独立 shared 包与明确 Contract 组织。

## UI Slot

全部 UI 通过 `context.slots.register(options, component)` 注册。当前根声明包括：

| Slot                | 类型    | 用途                   |
| ------------------- | ------- | ---------------------- |
| `navigation.page`   | `list`  | 注册页面和导航元数据   |
| `workspace.sidebar` | `keyed` | 按工作区键注册完整侧栏 |

每个活动页面还会声明 `page.<page-id>.root`。扩展插件使用 `inject()` 跟随页面声明期，不依赖插件加载顺序：

```ts
import { defineClientUiModule, pageRootSlot } from "@seashard/ui-sdk";
import ServerOverviewOverlay from "./ServerOverviewOverlay.vue";

const target = pageRootSlot("server-overview");

export const apply = defineClientUiModule({
  apply(context) {
    context.slots.inject(target, () =>
      context.slots.register(
        {
          name: target,
          id: "example.server-overview-overlay",
          mode: "overlay",
        },
        ServerOverviewOverlay,
      ),
    );
  },
}).apply;
```

页面根扩展支持 `prepend`、`append`、`overlay`、`replace` 和 `dom`。组件收到 `pageId` 与稳定的 `root: HTMLElement`。托管模式随页面、插件停用和升级自动卸载；`dom` 模式直接修改原节点时必须自行恢复修改。

一个 Slot Entry 可在 `children` 中声明子 Slot。父 Entry 消失时，子声明、子注册和等待中的注入会按同一所有权树级联清理。`single`、`list`、`keyed` 和 `chain` Slot 分别覆盖独占、顺序列表、按键分派和选择器接管场景。

## 调用插件 Host Service

Host Entry 通过 `context.provide()` 发布 JSON Service 后，Client Entry 可以使用同一类型化 Contract：

```ts
import { defineServiceContract } from "@seashard/plugin-sdk";

interface GreeterService {
  greet(name: string): Promise<string>;
}

const greeterContract = defineServiceContract<GreeterService>("example.greeter");

const clientModule = defineClientUiModule({
  async apply(context) {
    const greeter = context.service<GreeterService>(greeterContract);
    console.log(await greeter.greet("SeaShard"));
  },
});

export const apply = clientModule.apply;
```

Client Entry 必须在 `plugin.json` 的 `uses` 中声明准确 Contract 和方法。调用通过固定 Preload IPC 进入 Main Service Registry；Main 复核当前 Runtime、包摘要和 `uses`。刷新、升级或停用后，旧模块持有的 Service Proxy 会立即失效。参数和结果只能是 JSON 值或 `void`。

## License

[GNU Affero General Public License v3.0 only](https://www.gnu.org/licenses/agpl-3.0.html)
