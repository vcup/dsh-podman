<!--
SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>

SPDX-License-Identifier: MIT
-->

# 工作流子进程控制通道

[English](workflow-control.md) | 中文

Harness 工作流请求 `stdio.control: "pipe"` 后会立即建立通信通道。Podman provider
必须同步返回独立的 `Duplex`，以及 stdout/stderr；否则 Harness
会在执行工作流代码或调用模型之前报错：

```text
subprocess provider did not supply the requested control and output pipes
```

[subprocess.ts](../src/subprocess.ts) 在解析工作区前创建输入句柄。
[exec-inputs.ts](../src/exec-inputs.ts) 缓存早期写入，区分 stdin 与 control
数据，并分别转发 EOF。写入按 32 KiB
分帧，等待传输层写入回执后再发下一帧，因此单次写入可以超过 gRPC 默认的 4 MiB
消息上限。control 的读取端支持背压，不会回显调用方写入的数据。

Guest 用 Unix socket pair 建立通道，将子端作为 fd 7 传给子进程，并设置
`DSH_SUBPROCESS_CONTROL=pipe`，与 `@deepseek-ai/dsh-subprocess/control`
一致。这个标记由 guest 管理；未请求控制通道时会移除它。首条进程 ID 响应确认
control 支持。新版插件遇到旧 guest
时会明确提示重新构建并重建容器，而不是一直等待 worker 握手。不使用 control
的命令保留原有的 stdin EOF 约定。

## 传输限制

两路 EOF 独立，但共享 gRPC 背压。Guest
串行写入收到的数据：子进程不读取某一路输入时，阻塞的写入会挡住两路后续数据。
调用方不能先填满 stdin，再发送让子进程开始读取 stdin 的 control
命令；反向依赖同理。Harness 工作流使用
`stdin: "ignore"`，不会形成这种跨输入依赖。

Guest 读完 stdout、stderr 和 control
后才报告退出。因此，即使直接子进程已退出，继承 fd 7
的后代仍可能延迟退出报告，与继承 stdout/stderr
管道的情况相同。子进程必须关闭不使用的继承描述符；取消 RPC 会关闭 guest
端点，并取消命令所在的进程组。

## 回归检查

运行 TypeScript、Go 测试及检查：

```bash
pnpm install --frozen-lockfile
make test
make vet
make fmt-check
```

在 Linux 上运行[真实传输测试](../scripts/test-workflow-control.mjs)：

```bash
make test-workflow-control
```

测试会构建 Go guest，在私有 Unix socket 上启动它，再通过 provider 运行 Node
子进程。覆盖超过 4 MiB 的二进制往返、诊断流隔离、独立的 stdin/control
EOF、终止和启动失败，无需 Podman daemon 或模型端点。原生 ARM64 机器应传入
`GOARCH=arm64`；默认目标是 Linux amd64。

如需同时测试 Harness 随附的工作流 worker，请指向**同一 Harness 版本**的
`@deepseek-ai/dsh-ptc-runtime-node/process` bundle：

```bash
DSH_PODMAN_TEST_PTC_BOOTSTRAP=/absolute/path/to/process.js make test-workflow-control
```

这会增加 `ready → boot → done` 和 `ready → boot → call → reply → done`
两项检查。第二项回显绑定参数；两者均不调用 LLM，也不能证明模型路由或 provider
可用。未设置该变量时，只注册四项 Node 传输测试。

## 同步部署两端

测试通过或修改检出目录并不会更新运行中的插件。将新的 npm 包安装到实际使用的 DSH
profile，并构建、配置匹配的 guest-agent 镜像；参见
[本地部署](development.zh.md#安装本地插件构建)。切换 guest
镜像后须重建工作区容器：复用本地镜像标签不会更新容器中已经运行的 agent。

子进程可执行文件和工作流 bootstrap 必须存在于**工作区容器内**。Node 运行时应设置
`nodeExecutable`；若宿主机路径未挂载，还应将 `bootstrapPath`
设为容器内路径。使用运行中 Harness 对应版本的 bootstrap。仅安装 Node
不会让容器看到宿主机的 npm 模块。

然后通过原始 Harness 工具运行最小工作流：

```javascript
return { transportCheck: "ok", modelCalls: 0, fileWrites: 0 };
```

成功后再检查模型分派。独立测试验证传输与 worker
协议；原始工具还会检查已安装的插件、guest 镜像、运行时路径及 Harness 配置。
