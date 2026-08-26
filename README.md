<div align="center">

# SeaShard

**插件化、原生支持智能助手的 Minecraft 服务端桌面管理器。**

[![Latest Release](https://img.shields.io/github/v/release/SeaLantern-Studio/SeaShard?display_name=tag&sort=semver)](https://github.com/SeaLantern-Studio/SeaShard/releases)

</div>

## 项目简介

SeaShard 是一个以插件系统为核心、原生支持智能助手的 Minecraft 启动器、整合包管理器和服务器管理工具。项目当前以 Electron Desktop 为主要交付形态，将服务器运行、资源下载、插件扩展和 Agent 操作纳入统一的组件生命周期。

SeaShard 希望把常见的服务端管理流程集中到一套桌面界面中，同时保留清晰、稳定的扩展边界：内置功能、官方扩展和第三方插件遵循同一种 Package、Entry、Contract 与生命周期模型；SeaShard 应用插件与 Minecraft Mod、服务端插件、资源包和数据包分别管理。

## 功能概览

### 服务器管理

- 创建、选择并管理多个 Minecraft 服务器实例；
- 启动、停止服务器，查看实时状态和运行日志；
- 通过控制台发送命令，并使用常用命令快捷入口；
- 管理服务器启动参数、`server.properties` 和插件配置文件；
- 查看、切换服务器存档，管理已安装的 Mod；
- 扫描和管理本机 Java 运行环境。

### 资源获取

- 浏览并下载服务器核心；
- 搜索 Mod、整合包、数据包和世界资源；
- 根据游戏版本、加载器和资源来源筛选结果；
- 在统一下载任务中查看进度、取消任务并校验制品。

### 插件系统

- 内置组件与第三方插件共享统一的 Manifest、Contract 和生命周期模型；
- 支持 Host Entry 与 Client Entry，分别扩展后台能力和桌面页面；
- 支持插件市场搜索与安装，以及已安装插件的启停和卸载；
- 插件可以发布 Service、Event、UI Contribution、Agent Tool 和 Agent Resource；
- 开发目录支持刷新，正式插件以 `.seashard-plugin` 归档分发。

### 智能助手

- 提供 Chat 与 Agent 两种会话模式；
- 支持流式响应、会话记录、取消生成和多步工具调用；
- 模型供应商、凭据和模型可以在界面中统一配置；
- Agent Tool 用于执行操作，Resource URI 用于按需读取领域信息；
- 工具、资源及其帮助信息随所属组件和插件的生命周期动态更新。

## 下载与安装

前往 [GitHub Releases](https://github.com/SeaLantern-Studio/SeaShard/releases) 下载 SeaShard，并按照对应 Release 中的平台选择表获取安装包。

## 快速开始

1. 安装并启动 SeaShard；
2. 在 **设置 → Java** 中扫描并选择 Minecraft 服务端使用的 Java 运行环境；
3. 创建或选择一个服务器实例，配置核心、版本和启动参数；
4. 进入服务器工作区，通过 **启动** 页面运行服务器；
5. 在 **控制台** 中查看日志、发送命令，并在其他页面继续管理配置、Mod 与存档。

需要使用智能助手时，先进入 Agent 的 **供应商** 页面添加模型供应商和凭据，再在 **对话** 页面选择模型及会话模式。Agent 模式只会使用当前已经注册并可用的工具与资源。

## Agent

SeaShard Agent 是普通的 Host 组件。服务器、Java、下载和第三方插件等能力由各自的所有者声明，Agent Runtime 只负责模型交互、会话管理和能力调度。

这套机制为模型提供两类入口：

- **Tool**：执行启动服务器、停止服务器、发送命令等会产生操作结果的任务；
- **Resource**：通过统一的 `read` 工具读取服务器实例、运行状态、日志等信息。

每次调用开始时，Agent 都会取得当前有效的工具与资源快照。组件停用或插件卸载后，其能力会自动从后续调用中移除；帮助内容直接由注册信息生成，无需额外维护第二份工具说明。

模型配置统一保存在 SeaShard 用户数据目录下的 `agent/models.yml`。你可以通过界面管理配置，也可以直接编辑该文件；两种方式操作的是同一份配置。

## 插件生态

SeaShard 插件安装到应用本身，可以同时服务多个服务器实例。插件包可以包含：

- 在独立 Node.js 子进程中运行的 Host Entry；
- 在 Desktop Renderer 中注册页面或侧栏的 Client Entry；
- 面向其他组件和插件的类型化 Service Contract；
- 事件、托管存储、Agent Tool、Agent Resource 和模型供应商类型。

公开开发包包括：

- `@seashard/plugin-sdk`
- `@seashard/contracts`
- `@seashard/ui-sdk`

完整的插件项目结构、Manifest、开发刷新、打包、安装和接口说明见 [SeaShard 第三方插件开发指南](./docs/plugin-development.md)。

## 本地开发

### 环境要求

- Node.js `>= 24.11.0`；
- pnpm `10.13.1`；
- Windows、macOS 或 Linux 桌面环境。

### 启动开发环境

```bash
corepack enable
pnpm install
pnpm run dev
```

### 代码检查

```bash
pnpm run check
pnpm test
pnpm run smoke
```

`pnpm run dev` 会启动 SeaShard Desktop 的本地开发环境。首次安装依赖后无需单独安装各 Workspace Package。

## 许可证与版权

SeaShard 公开 SDK 包以 [GNU Affero General Public License v3.0 only](./packages/sdk-license/LICENSE) 发布。仓库内其他内容的许可范围以对应 Package 元数据和许可证文件为准。

Copyright © SeaLantern Studio.
