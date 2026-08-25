# @seashard/ui-sdk

SeaShard Client Entry 的受控 UI SDK，提供页面、工作区侧栏、Service 和生命周期 Contribution 类型。

## 安装

```bash
pnpm add @seashard/ui-sdk @seashard/contracts @seashard/plugin-sdk vue
```

运行环境要求 Node.js 24.11.0 或更高版本，并要求 Vue 3.5。

## Client Entry

Client Entry 只能使用 `ClientUiContext` 暴露的受控能力，不会获得 Main Context、Node.js 或 Electron 对象。

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

一个 Client Entry 应只发布一个页面组件包。跨页面共享状态和代码应通过独立 shared 包与明确 Contract 组织。

## License

[GNU Affero General Public License v3.0 only](https://www.gnu.org/licenses/agpl-3.0.html)
