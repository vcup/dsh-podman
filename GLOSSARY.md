<!--
SPDX-FileCopyrightText: 2026 dsh-podman contributors

SPDX-License-Identifier: MIT
-->

# dsh-podman 领域术语

本文统一工作区执行与 Workflow/PTC 讨论中使用的环境、资源和文件语义。

## Language

**DSH world（DSH 运行环境）**: 运行 Harness 编排逻辑的环境。 _Avoid_:
未限定的“host”或“宿主机”。

**Execution world（执行环境）**:
一次执行可见的文件、可执行程序与环境变量所构成的环境；路径按该环境解析。
_Avoid_: 未限定的“本地”。

**Workspace（工作区）**: 一个项目及其关联执行资源的工作范围。

**DSH profile（DSH 配置档）**: Harness 插件与配置的组合，用于定义 Harness
运行环境。 _Avoid_: “workspace image”。

**Workspace image（工作区镜像）**: 创建工作区容器文件系统的镜像。 _Avoid_:
未限定的“DSH image”。

**PTC worker（PTC 执行进程）**: 在选定 execution world 中执行程序并与 Harness
交换调用和结果的进程。 _Avoid_: 将 worker 与 workflow 编排逻辑统称为“workflow”。

**Execution scope（执行作用域）**: 一个 workflow invocation 在授权
workspace/container 中执行时所关联的目标上下文。

**Runtime closure（运行时闭包）**: 在一个 execution world 中启动 PTC worker
所需的兼容 Node、worker bundle、bootstrap 与依赖集合。

**Shared-file mapping（共享文件映射）**: DSH world 与 execution world
中的路径对应到同一共享文件的关系。 _Avoid_: 仅凭相同路径字符串称为共享文件。

**Materialized file（物化文件）**: 经授权复制到另一个 execution world
的文件副本，具有独立的文件身份。 _Avoid_: 将副本称为共享文件映射。

**Desktop reachability（桌面可达性）**: 桌面 client
可通过其授权文件引用访问目标文件的能力。 _Avoid_: 将 DSH 或 guest
路径直接称为桌面路径。
