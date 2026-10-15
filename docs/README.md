<!--
SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>

SPDX-License-Identifier: MIT
-->

# Documentation

[English](#english) | [中文](#中文)

## English

- [Install DeepSeek Harness & dsh-podman with rootless Podman](install-dsh-and-dsh-podman.md)
  — install dsh and dsh-podman as rootless Podman Quadlet services and verify
  the setup.
- [Update](update.md) — pull new images, restart the services, and set up
  automatic updates.
- [Architecture](architecture.md) — the plugin, the orchestrator and the guest
  agents, and how workspaces map to pods and containers.
- [Configuration](configuration.md) — the `DSH_PODMAN_*` environment variables
  per component, and the plugin's UI settings.
- [Usage](usage.md) — the model-facing tools, the Podman page, and the image
  model.
- [Development](development.md) — build the plugin from this repository and run
  it from a development checkout.
- [Workflow control transport](workflow-control.md) — control channels,
  regression tests, deployment, and transport limits.
- [Development container setup prompt](development-prompt.md) — the prompt that
  creates the development image, volume and container.
- [Uninstall](uninstall.md) — remove dsh-podman and the Quadlet units, and run
  dsh without it.

## 中文

- [使用 rootless Podman 安装 DeepSeek Harness 与 dsh-podman](install-dsh-and-dsh-podman.zh.md)
  — 以 rootless Podman 的 Quadlet 服务安装 dsh 与 dsh-podman，并验证安装。
- [更新](update.zh.md) — 拉取新镜像、重启服务，并配置自动更新。
- [架构](architecture.zh.md) — 插件、orchestrator 与 guest
  agent，以及工作区如何映射到 pod 与容器。
- [配置](configuration.zh.md) — 各组件读取的 `DSH_PODMAN_*`
  环境变量，以及插件的界面设置。
- [使用](usage.zh.md) — 面向模型的工具、Podman 页面以及镜像模型。
- [开发](development.zh.md) — 从本仓库构建插件，并在开发检出环境中运行。
- [工作流控制通道](workflow-control.zh.md) —
  控制通道、回归测试、部署与传输限制。
- [开发容器设置提示词](development-prompt.zh.md) —
  用于创建开发镜像、卷与容器的提示词。
- [卸载](uninstall.zh.md) — 移除 dsh-podman 与 Quadlet
  单元，并在没有它的情况下运行 dsh。
