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

## 执行位置

Contract 描述稳定的 JSON Service 边界，但不保证每个 Provider 同时存在于 Controller 与 Host。Controller Entry 可以使用 Controller 领域 Service；Host Worker 只能使用其执行位置实际提供的机器 Service 或其他 Worker Service。需要同时覆盖两端时，将目标机器操作放入 Host Worker，通过 `context.provide()` 发布 JSON Service，再由声明准确 `uses` 的 Controller Entry 或 Client Entry 调用。Host Worker Service 会由 Controller 代理，Client 不直接连接 Host。

`seashard.server-*` 服务器领域 Contract 由 Controller 提供。Host Worker 不应依赖这些领域 Service，也不应在 Host 复制服务器业务状态。

## License

[GNU Affero General Public License v3.0 only](https://www.gnu.org/licenses/agpl-3.0.html)
