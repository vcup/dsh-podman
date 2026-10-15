<!--
SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>

SPDX-License-Identifier: MIT
-->

# dsh-podman

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/@exagone313/dsh-podman)](https://www.npmjs.com/package/@exagone313/dsh-podman)
[![GitHub release](https://img.shields.io/github/v/release/Exagone313/dsh-podman)](https://github.com/Exagone313/dsh-podman/releases)
[![dsh](https://img.shields.io/badge/dsh-GHCR-blue)](https://github.com/Exagone313/dsh-podman/pkgs/container/dsh-podman%2Fdsh)
[![orchestrator](https://img.shields.io/badge/orchestrator-GHCR-blue)](https://github.com/Exagone313/dsh-podman/pkgs/container/dsh-podman%2Forchestrator)
[![guest-agent](https://img.shields.io/badge/guest--agent-GHCR-blue)](https://github.com/Exagone313/dsh-podman/pkgs/container/dsh-podman%2Fguest-agent)
[![gateway](https://img.shields.io/badge/gateway-GHCR-blue)](https://github.com/Exagone313/dsh-podman/pkgs/container/dsh-podman%2Fgateway)

[English](README.md) | 中文

基于 [Podman](https://podman.io/) 的
[DeepSeek Harness](https://deepseek.com/harness)（`dsh`）执行后端。

dsh-podman 将所有的 shell 执行与文件访问都路由到一次性、按项目隔离的 Podman
容器中。

## 特性

- 一次性、按项目隔离的容器
- 每个工作区可添加额外的容器
- 创建基于 Arch Linux、Ubuntu 和 Alpine Linux 的容器镜像
- 感知审批的权限提升
- 在容器中运行进程（守护进程）
- 在容器中运行终端

## 文档

- **[使用 rootless Podman 安装 DeepSeek Harness 与 dsh-podman](docs/install-dsh-and-dsh-podman.zh.md)**
- [更新](docs/update.zh.md)
- [架构](docs/architecture.zh.md)
- [配置](docs/configuration.zh.md)
- [使用](docs/usage.zh.md)
- [开发](docs/development.zh.md)
- [工作流控制通道](docs/workflow-control.zh.md)
- [卸载](docs/uninstall.zh.md)

## AI 使用声明

本仓库的大部分代码由 AI 模型编写：

- DeepSeek Flash
- 早期提交使用 OpenAI GPT-5.6 Luna
- 少量修复由 Anthropic Claude Opus 5 完成

## 许可证

[MIT](./LICENSE)
