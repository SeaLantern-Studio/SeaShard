# @seashard/plugin-sdk

SeaShard Host 插件的公开开发 SDK，提供插件清单、生命周期、Service、Contribution、资源、Agent 能力和 JSON 数据类型。

## 安装

```bash
pnpm add @seashard/plugin-sdk @seashard/contracts
```

运行环境要求 Node.js 24.11.0 或更高版本。

## 插件清单

第三方插件必须在每个 Entry 的 `uses` 中声明可能调用的 Contract 方法。Scope 与内部权限元数据由 SeaShard Host 管理，不属于第三方清单。

```json
{
  "id": "example.hello",
  "version": "0.1.0",
  "publisher": "example",
  "entries": [
    {
      "id": "hello.host",
      "runtime": "host",
      "module": "./dist/host.js",
      "hostProfiles": ["electron", "node", "docker"],
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

## Host Entry

Host Entry 以命名导出提供 `apply`。所有生命周期资源都应通过 `PluginContext` 注册，由 Host 在 Entry 停用时统一释放。

```ts
import { runtimeDiagnosticsContract, type RuntimeDiagnosticsService } from "@seashard/contracts";
import type { JsonValue, PluginContext } from "@seashard/plugin-sdk";

export async function apply(context: PluginContext, _config: JsonValue) {
  const diagnostics = context.service<RuntimeDiagnosticsService>(runtimeDiagnosticsContract);
  const snapshot = await diagnostics.getSnapshot();

  context.contribute("example.runtime-count", {
    count: snapshot.components.length,
  });
}
```

具体 Contract 名称、方法和数据类型由 `@seashard/contracts` 提供。Client Entry 使用 `@seashard/ui-sdk`。

## License

[GNU Affero General Public License v3.0 only](https://www.gnu.org/licenses/agpl-3.0.html)
