# @seashard/ui-sdk

SeaShard Client Entry 的受控 UI SDK，提供页面、工作区侧栏、Service 和生命周期 Contribution 类型。

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
    context.contribute("navigation.page", {
      id: "example.page",
      path: "/example",
      label: "Example",
      component: ExamplePage,
    });
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

SeaShard 只通过当前激活包的摘要协议加载模块和相对资源。插件刷新或升级会产生新摘要，Client Runtime 会清理旧 Contribution，再加载新模块。

一个 Client Entry 应只发布一个页面组件包。跨页面共享状态和代码应通过独立 shared 包与明确 Contract 组织。

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
