# @seashard/contracts

SeaShard 面向插件和 Client Entry 发布的稳定 Service Contract、事件名称及 JSON 数据类型。

## 安装

```bash
pnpm add @seashard/contracts @seashard/plugin-sdk
```

运行环境要求 Node.js 24.11.0 或更高版本。

## 使用

Contract 常量用于定位 Service，配套接口描述该 Service 的公开方法和返回值。

```ts
import { runtimeDiagnosticsContract, type RuntimeDiagnosticsService } from "@seashard/contracts";
import type { PluginContext } from "@seashard/plugin-sdk";

export async function readRuntimeSnapshot(context: PluginContext) {
  const diagnostics = context.service<RuntimeDiagnosticsService>(runtimeDiagnosticsContract);
  return diagnostics.getSnapshot();
}
```

插件必须在 `plugin.json` 对应 Entry 的 `uses` 中声明实际调用的方法：

```json
{
  "uses": {
    "seashard.runtime-diagnostics": ["getSnapshot"]
  }
}
```

只依赖公开导出；`desktopChannels` 等由具体运行环境消费的常量仍遵循对应 Host 边界。

## License

[GNU Affero General Public License v3.0 only](https://www.gnu.org/licenses/agpl-3.0.html)
