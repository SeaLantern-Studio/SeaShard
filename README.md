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

## 安装

### Desktop Controller

前往 [GitHub Releases](https://github.com/SeaLantern-Studio/SeaShard/releases) 下载 SeaShard，并按照对应 Release 中的平台选择表获取安装包。

安装完成后，可在 **设置 → 关于** 中手动检查新版本。Windows 与 Linux 安装包可以直接下载、安装和重启；macOS 会打开对应的 GitHub Release 下载页。

### Server Controller

Server Controller 提供以下三种命令行安装方式，请根据运行环境选择其中一种。卸载默认保留 Host、服务器实例和 Controller 用户数据。

#### 安装脚本

适用于 Linux 和 macOS。脚本会下载当前 Release 对应的 Server Runtime，校验文件后登记并启动当前用户的后台服务。

安装：

```sh
curl -fsSL https://github.com/SeaLantern-Studio/SeaShard/releases/latest/download/install-server.sh | sh
```

卸载：

```sh
server_command="${XDG_BIN_HOME:-$HOME/.local/bin}/seashard-server"
case "$(uname -s)" in
  Linux) installation_root="${XDG_DATA_HOME:-$HOME/.local/share}/SeaShard/server" ;;
  Darwin) installation_root="$HOME/Library/Application Support/SeaShard/server" ;;
  *) echo "Unsupported operating system: $(uname -s)" >&2; exit 1 ;;
esac
"$server_command" service uninstall
rm -f "$server_command"
rm -rf "$installation_root"
```

#### npm

需要 Node.js `>= 24.11.0`。全局安装时会登记并启动当前用户的后台服务。

安装：

```sh
npm install --global @seashard/server
```

卸载：

```sh
npm uninstall --global @seashard/server
```

#### Homebrew

适用于 Linux 和 macOS。安装 Formula 后，通过 Homebrew Services 启动后台服务。

安装：

```sh
brew tap sealantern-studio/seashard https://github.com/SeaLantern-Studio/SeaShard.git
brew install seashard-server
brew services start seashard-server
```

卸载：

```sh
brew services stop seashard-server
brew uninstall seashard-server
brew untap sealantern-studio/seashard
```

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
- 事件、托管存储、Agent Tool 和 Agent Resource。

公开开发包包括：

- `@seashard/plugin-sdk`
- `@seashard/contracts`
- `@seashard/ui-sdk`

完整的插件项目结构、Manifest、开发刷新、打包、安装和接口说明见 [SeaShard 第三方插件开发指南](./docs/plugin-development.md)。

## 本地开发

### 环境要求

- Node.js `>= 24.11.0`；
- pnpm `10.13.1`；
- Desktop 开发需要 Windows、macOS 或 Linux 桌面环境；
- Server Controller 可以在无桌面环境中开发和运行。

### 启动开发环境

```bash
corepack enable
pnpm install
```

启动 Desktop：

```bash
pnpm run dev:desktop
```

启动 Server Controller：

```bash
pnpm run dev:server
```

Server Web 默认只监听 `http://127.0.0.1:18127`。首次打开时需在本机设置管理员，密码长度为 12～128 个字符。浏览器刷新或事件流重连后会重新读取 Host、实例、运行任务和控制台状态；“软件设置”同时提供个性化、插件市场、插件设置、Host 连接和关于页面，个性化配置保存在 Server Controller 的专用 SQLite 表中，同一 Server 的不同浏览器会读取同一份配置。

需要从其他设备访问时，先通过本机监听完成管理员设置，再同时配置 TLS 和非本机监听地址：

```bash
pnpm run start:server -- --web-host=0.0.0.0 --tls-cert=/path/fullchain.pem --tls-key=/path/private-key.pem
```

Server Controller 会拒绝未配置 TLS 或尚未设置管理员的非本机监听。

### 代码检查

```bash
pnpm run check
pnpm test
pnpm run smoke
pnpm run smoke:server-host
pnpm run smoke:server-web
```

`dev:desktop` 保留原有 Electron 开发流程；`dev:server` 会监听 Server 后端、Server Web、Host、Plugin Host 和 Database Worker，并始终启动当前工作区刚构建的源码 Host。开发 Host 与正式安装的 Host 使用不同数据目录，二者可以同时运行；只重建 Server 时保留开发 Host 进程并重新连接。

## 许可证与版权

SeaShard 公开 SDK 包以 [GNU Affero General Public License v3.0 only](./packages/sdk-license/LICENSE) 发布。仓库内其他内容的许可范围以对应 Package 元数据和许可证文件为准。

Copyright © SeaLantern Studio.
