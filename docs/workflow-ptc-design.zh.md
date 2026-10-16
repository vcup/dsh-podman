<!--
SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>

SPDX-License-Identifier: MIT
-->

# Workflow/PTC 执行环境分析与修复提案

状态：设计讨论，未实现。本文把可检查的行为、部署前提和拟议改动分开；具体 Harness
runtime、profile
和发布产物必须按部署使用的精确版本复核。本文引用的仓库实现以代码基线
`5221fff3d5e08b1e54ab349a67db82d245dc73ac`
为准。术语见[词汇表](../GLOSSARY.md)。

## 1. 结论

建议以**目标绑定的执行
scope**作为完整方案的核心，并配套运行时供应与目标化文件访问。PTC worker 在选定
workspace/container 执行；scope 固定执行目标，并管理
executable、bootstrap、最终环境、sandbox、文件引用和进程生命周期。

同质镜像部署可显式设置 guest `nodeExecutable` 与 `bootstrapPath`
作为迁移配置。完整方案把文件 consumer 接入目标感知接口：接口以 execution scope
和授权文件引用为输入，分别提供经同一文件证明的共享映射、guest
内物化和桌面端访问；每项请求按其目标校验，并在缺少相应能力时返回可区分的结果。

将职责拆分为两个 module，并通过 execution scope 组合：

- **Execution
  module**：绑定执行目标，校验实例身份，准备和启动进程，并管理取消、失效和清理。
- **Runtime supply module**：按 scope 和版本要求提供兼容的 Node、PTC
  worker/bootstrap 及依赖闭包。workspace 镜像和只读 runtime artifact mount
  是两种可替换的供给 adapter，均返回带版本信息的 lease。

首批支持矩阵需列出 workspace OS、CPU 架构、libc、Node 与 sandbox
mode，并通过真实目标镜像和桌面 client 验收。矩阵外的组合保持待验证状态。

## 2. 代码事实与故障推断

### 2.1 启动资产的路径契约与故障条件

DSH world 运行 Harness 编排逻辑；execution world 是 workspace/container
中子进程实际可见的文件、程序和环境。两边各自解析绝对路径；共享挂载的文件身份需要按目标验证。

仓库[控制通道文档](workflow-control.zh.md#同步部署两端)将 workspace 容器内的
Node executable、workflow bootstrap 及其配置路径列为部署前提。PTC worker 由
subprocess provider 按工作目录送入 workspace 执行。若 runtime 提供的 executable
或 bootstrap 路径来自 DSH world，而目标容器没有相应资产，guest 会在 exec 或加载
bootstrap 时失败。

Harness runtime 决定默认 executable/bootstrap
的选择，行为随版本变化。集成应固定具体版本，并核对该版本的默认路径、配置项、built/source/package
运行模式和发布闭包。DSH 镜像与 workspace 镜像分别供给 Node
及其模块，须各自确认。

### 2.2 现有 interface 缺少稳定的目标绑定

- [`SubprocessProvider.resolveExecutable`](../src/subprocess.ts#L19-L57)不接收
  workspace/cwd：绝对路径原样返回，bare command 报告未找到。`spawn(spec)` 才按
  `spec.cwd` 选择 workspace，因此 resolver 无法在目标执行环境中验证返回路径。
- [`WorkspaceBinding`](../src/workspace-binding.ts#L16-L27)没有容器代际字段；重建流程保留
  agent token，见
  [`ensureAgentToken`](../internal/orchestrator/grpcserver/container-lifecycle.go#L51-L64)。执行
  scope 需要额外携带实例代际，才能区分重建前后的容器。
- [`FilesystemProvider.processPathFromHostPath`](../src/fs-provider.ts#L138-L142)只接收路径字符串并同步返回结果；当前
  adapter 对绝对路径原样返回。目标化共享映射需要 mount
  identity、源路径解析结果与执行代际，此 interface 没有这些输入。
- Guest
  [在创建命令后构造子进程环境](../internal/guestagent/exec/exec.go#L63-L71)；[`childenv`](../internal/guestagent/childenv/childenv.go#L78-L143)随后生成最终环境。因此
  bare command 的查找使用 guest-agent PATH，而子进程接收后构造的
  PATH。执行准备需先构造最终环境，再按该 PATH 解析
  Node，并以同一环境启动；`NODE_OPTIONS` 和 loader 变量也需在 Node
  启动前纳入策略。
- [`remoteArgv`](../src/guest-rpc.ts#L785-L801)会解开 landlock
  wrapper；现有[只读工具 gate](../src/read-only-shell.ts#L21-L35)不包含
  Workflow/PTC。PTC 的 confinement 状态因此取决于 execution world 的 guest
  policy，启动结果应报告 guest 实际执行的策略。

以上结论限定于引用的仓库代码基线。profile、live image 和实际加载的 PTC runtime
版本须在具体部署中核实。

### 2.3 控制通道与路径问题相互独立

Workflow/PTC 的 subprocess provider 需要 control/stdout/stderr
通道。[控制通道文档](workflow-control.zh.md)和[真实 guest 测试](../scripts/test-workflow-control.mjs)覆盖这项传输契约；Node/bootstrap
的目标内供应由另一组检查验证。

现有真实传输测试覆盖 guest gRPC、数据流、EOF、取消和控制协议。跨容器 runtime
供应及文件路径语义需要使用不同文件系统和目标镜像的测试夹具。

## 3. 设计目标和不变量

1. Workflow 的 Node、worker、bootstrap、sandbox、cwd 和 subprocess
   都属于授权绑定的 execution instance。
2. 每次调用通过显式 workspace/container
   引用和代际路由；并发调用各自保持目标绑定。
3. Prepare 冻结目标代际与最终环境；executable 解析、资产查找、sandbox 准备和
   spawn 使用同一组值。
4. Container recreate 或有效配置变化会使未启动的 prepared execution 失效；guest
   在接受启动时校验代际。启动 acknowledgement 丢失时，以 launch ID
   查询结果；只有确认未启动后才允许重试。
5. 共享映射要求两端指向同一文件；物化副本具有独立文件身份；桌面打开依赖目标
   client 的文件可达性。三种能力分别使用有类型的文件引用。
6. 每个受支持的附件、图片 spill
   和文件打开场景声明对应的文件能力；缺少能力时返回该 consumer
   可识别的错误或回退结果。
7. Guest 对实际执行 Node 的 sandbox policy 实施强制，并报告 enforcement
   状态；目标无法执行所请求的策略时拒绝启动。
8. Runtime supply 固定版本并记录来源；验收同时检查静态 manifest 与 guest
   实际加载结果。

## 4. 推荐 module 与 interface

外部 seam 位于执行目标选择处。调用方从已授权的 session/workspace 引用解析
workspace 和容器，并将 cwd 解释为该目标内的路径；命名容器在选择时执行权限检查。

下面的 TypeScript 展示拟议 interface 的职责和生命周期：

```ts
interface ExecutionWorlds {
  bind(
    target: AuthorizedExecutionTarget,
    signal?: AbortSignal,
  ): Promise<ExecutionScope>;
}

interface RuntimeSupply {
  acquire(
    scope: ExecutionScope,
    requirement: RuntimeRequirement,
    signal?: AbortSignal,
  ): Promise<RuntimeLease>;
}

interface ExecutionScope {
  prepare(
    request: LaunchRequest & { runtime: RuntimeLease },
    signal?: AbortSignal,
  ): Promise<PreparedExecution>;
  spawn(prepared: PreparedExecution): SubprocessHandle;
  readonly files: ScopedFileAccess;
  close(): Promise<void>;
}

type SharedMappingResult =
  | { kind: "mapped"; file: WorldFileRef }
  | { kind: "unavailable"; reason: "not-shared" | "unverifiable" };

interface ScopedFileAccess {
  mapShared(source: AuthorizedFileRef): Promise<SharedMappingResult>;
  materialize(
    source: AuthorizedFileRef,
    options: { maxBytes: number; readOnly: true },
    signal?: AbortSignal,
  ): Promise<WorldFileLease>;
}
```

PTC runtime 持有程序、bindings、帧协议、时限、输出限制和结果类型，并通过
execution interface 获取 worker。Podman 的 Execution module
负责目标绑定、准备和启动。普通 shell/子进程继续使用现有
subprocess；需要在同一目标中解析并启动的调用使用 execution scope。

### 4.1 Execution scope 的身份与生命周期

`bind` 返回的 scope 固定 workspace/container、cwd、guest incarnation
与有效配置。内部实例身份至少应覆盖 workspace epoch、容器代际、guest boot
identity 和实际 image digest；所有影响可见文件或进程环境的 mounts/env/paths
改动都须推进代际或配置
revision。对调用方只给不含凭据的不透明引用；agentToken、socket
等秘密不进入模型可见结果。

推荐执行顺序：

```text
授权目标 → bind scope → 取得匹配 runtime → 冻结 guest 环境
→ prepare（executable、bootstrap、sandbox、stdio）→ 一次性 spawn
→ ready/control 协议 → 运行/取消/退出 → close 并释放资产
```

`PreparedExecution` 封装已冻结的 cwd、env、executable、runtime、sandbox 与
stdio，且只能由创建它的 scope 消费一次。`spawn` 只接收 prepared
execution。`close` 幂等，并清理未消费计划、释放资产 lease、终止该 scope
拥有的运行中进程。

控制面签发 generation，guest 在 handshake 和 launch 接受点校验。Recreate
与进程准入按 generation 协调；即使 token、socket
或容器名复用，新实例也只接受新代际的 launch。Ack 丢失时，调用方按 launch ID
查询原代际结果；结果仍未知时保持未知状态，确认未启动后再允许重试。

Generation 标识容器配置代际；可写项目 mount 中的文件仍按 workspace
语义变化。需要保证 worker
闭包不可替换时，应以只读、受保护的方式供应完整资产；hash/stat
预检仍留下检查与执行之间的竞态。RuntimeLease
描述运行时资产，不包含项目代码快照。

### 4.2 Runtime supply 及平台支持

RuntimeSupply 接受 PTC runtime 声明的 `RuntimeRequirement`，并按版本 manifest
为绑定目标选择资产 lease。Requirement 标识 PTC release、worker protocol
和目标平台；manifest 涵盖：

- PTC package/release 身份、worker protocol 版本及 bootstrap/依赖闭包摘要；
- Node 版本或兼容范围、操作系统、CPU 架构、libc/动态加载器及必要系统库；
- 入口布局、只读属性和资产版本；存在 native addon 时还要说明对应 ABI。

按支持矩阵构建并测试 workspace 镜像，供给匹配版本的 Node 与 worker 闭包；只读
runtime image mount 可作为另一供给 adapter。Node 发布物需匹配
OS、架构、libc、loader 和原生 ABI。Release CI
在干净目标镜像中验证实际发布闭包及启动行为。

现有
[`image_build` 参数](../src/tool-params.ts#L127-L139)只收父镜像与系统包；[镜像 builder](../internal/orchestrator/images/images.go#L88-L150)生成发行版包管理器安装步骤，当前没有
PTC runtime manifest/供应协议。现有
[`DSH_PODMAN_BASE_IMAGE_PREFIX`](../internal/orchestrator/grpcserver/image-resolve.go#L22-L103)为固定基础镜像短名增加
registry 前缀，使用 `:latest` 并作用于整个基础镜像集合。新增托管资产需定义
recipe/manifest、不可变 digest、升级规则及派生镜像和现存容器的迁移流程。

RuntimeSupply 在已绑定的 scope 中提供资产。若更新需要重建容器，应在 workflow
启动前完成，并针对新代际重新 bind。运行中的 workflow
保持其容器和权限配置。无网络、无供应权限、版本不兼容或闭包缺失时返回可诊断错误；workflow
执行期间不安装 runtime。

### 4.3 文件访问：映射、物化和桌面打开

`processPathFromHostPath(hostPath)`只接收路径字符串，不携带目标或授权。文件
consumer 应逐项迁移到 scope
内的文件接口，并按共享映射、物化或桌面访问选择具体能力。

- **共享映射**：成功条件是 mount/source 身份、所选 workspace
  scope、解析后的路径和有效代际共同证明两端指向同一文件。实现需覆盖嵌套
  workspace、symlink、子挂载遮蔽、overlay 与 recreate；证明失败时，该请求返回
  shared mapping unavailable。
- **物化副本**：`materialize` 将授权文件复制到目标 execution world，并返回独立的
  guest file reference。接口约束字节数、只读属性、生命周期、缓存键、配额和清理。
- **桌面打开/Reveal**：`DesktopOpener` 接收授权文件引用，并将打开或 Reveal
  操作交给具有该文件可达性的桌面 client。Adapter 负责解析 client
  可用的引用，并报告目标不可达的结果。

LLM 附件及 worker 读取的图片可使用 scope
提供只读物化引用。物化不可用时，consumer 使用已验证的 inline fallback
或返回明确错误。文本 spill 继续通过 guest-local 有界文件句柄访问；文件打开由
DesktopOpener 处理。各 consumer 的配额、清理、降级与桌面目标分别验收。

文件 consumer 分批迁移；每个迁移同时实现所需的 scoped mapping、materialization
或 desktop access。确认所有调用点都使用目标化能力后，移除旧同步方法。

### 4.4 最终环境、可执行程序与 sandbox

Guest 先构造唯一的 effective environment，并明确继承、显式覆盖、tombstone 与
Node/loader 变量的处理规则。随后在同一 cwd、uid 和 effective PATH 下解析
executable 为绝对路径，并使用相同环境启动。

Guest 强制执行 sandbox policy，并在 handshake 与启动结果中报告实际
enforcement。[`remoteArgv`](../src/guest-rpc.ts#L785-L801)会解开 landlock
wrapper，因此目标 guest 需实现所请求的 mode，并在不支持时返回明确错误。只读
runtime mount 保护运行时资产；workflow sandbox 另行约束项目文件访问。

## 5. 候选方案与取舍

| 方案                                    | 能力                                                                                              | 限制                                                                                  | 定位                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------- |
| 显式 `nodeExecutable` + `bootstrapPath` | 为镜像布局固定的部署指定 guest runtime 入口                                                       | 适用于同质 workspace 镜像；异构目标选择、通用 executable 验证与目标化文件能力另行设计 | 兼容模式/过渡           |
| 目标绑定 execution scope                | 将目标、准备、环境、sandbox、文件与进程生命周期统一，支持并发 workspace 和具名容器                | 需推进 Harness 接口、Podman 控制/guest 协议与代际协调                                 | 推荐的执行核心          |
| RuntimeSupply                           | 按目标 OS/架构提供精确版本的 runtime 闭包；workspace image 与只读 artifact mount 均可作为 adapter | 需要 manifest、release 验证和镜像/资产升级流程                                        | 与 execution scope 配套 |

建议以 ExecutionScope 作为启动主路径，RuntimeSupply 按 scope 提供 runtime
lease。前者负责目标选择、校验、prepare、spawn
和释放；后者选择兼容闭包并记录版本。Workspace image 与只读 artifact mount
作为可替换 adapter，共用同一启动流程。

## 6. 错误、取消和兼容规则

为 scope 失效、目标不匹配、runtime
不可用、平台不兼容、共享映射无法证明、物化超限、sandbox 不支持、guest
缺能力和启动结果未知分别定义稳定错误。错误类型须区分权限拒绝、取消、文件不存在与能力不可用，并与对应
PTC runtime release 配套。

`spawn(prepared)` 保持子进程调用约定：control/stdout/stderr
句柄在调用者开始写入前可用，远端启动失败通过 handle completion
报告；取消必须终止 guest 进程组并释放 scope 资源。Control 通道的 EOF、背压、旧
guest 能力协商与退出清理继续由真实 transport contract tests 覆盖。

过渡 adapter 将显式 Node 与 bootstrap 路径作为一组输入，并在同一 scope
内验证两者。升级保留上一兼容 runtime/image 组合；容器重建后绑定新
generation，再验证资产和 transport。

## 7. 分阶段落地和验收

验收分阶段扩大支持矩阵；每项记录既有测试覆盖与新增测试结果。

| 阶段                  | 交付                                                                | 关键验收                                                                                               |
| --------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1. Interface/协议设计 | target scope、generation、prepared launch、能力协商与错误语义       | 两个并发 workspace 不串用；recreate/配置变更使旧 plan 被 guest 拒绝；丢失 ack 不触发重复执行           |
| 2. RuntimeSupply      | 版本 manifest、受控镜像 recipe 或只读 runtime artifact              | 干净容器无 DSH module mount 仍通过闭包检查；覆盖 OS/arch/libc/loader、错误版本和升级/recreate          |
| 3. 环境与 sandbox     | guest 侧最终 env、同 PATH executable resolution、目标内 confinement | guest-only `NODE_OPTIONS`/loader 注入在 Node 启动前受控；实际文件访问符合 policy；不支持的 mode 被拒绝 |
| 4. 文件 consumer 迁移 | shared map、materialization、desktop open 各自的 adapter            | 附件读、图片 prompt/spill、inline fallback、open/reveal 分开通过；未验证映射不泄漏路径                 |
| 5. 端到端支持矩阵     | PTC workflow、control transport、workspace images 与部署流程        | 不同 DSH/guest 文件系统、真实目标镜像、container recreate、取消/失败/回滚均覆盖                        |

已有 [`make test-workflow-control`](workflow-control.zh.md#回归检查)真实 guest
测试覆盖
gRPC、流、EOF、取消和控制协议。新增跨环境测试使用不同文件系统和目标镜像，并覆盖多
workspace 并发、同名异内容路径、symlink/子挂载/overlay、generation
失效、环境优先级、Node ABI/loader、附件配额与清理、桌面能力、sandbox
拒绝、control 背压及升级回滚。

实现后运行 `make test`、`make vet` 和
`make fmt-check`；跨环境验收再使用声明支持的真实镜像与发布
runtime。格式检查覆盖文档和源文件排版，集成测试验证运行行为。

## 8. 需要评审决定的问题

1. Execution scope 的持有者和调用者如何传递可信 workspace/container
   引用，同时不把控制面凭据暴露给 PTC 程序？
2. 容器代际由谁签发、哪些挂载/环境/image 变更必须推进它，guest
   怎样在启动接受点与 recreate 串行协调？
3. 第一批承诺支持哪些 OS、CPU、libc、Node 版本和 sandbox mode？worker manifest
   如何从实际发布包生成并保证闭包？
4. Workspace image、managed runtime image mount
   或二者并用，哪种供应方式满足升级、只读性、体积及管理员控制要求？现有基础镜像
   prefix 的全局短名/`:latest`机制是否需新增受控 manifest/immutable digest
   路径？
5. `processPathFromHostPath` 如何兼容期迁移？附件/图片是否允许有配额的 guest
   物化？桌面 open/reveal 的目标 client 与失败回退各是什么？
6. 首批 guest-enforced sandbox mode
   与不支持时的错误语义是什么？验收结果如何区分程序 confinement 和只读 runtime
   asset mount？
7. 旧配置支持多久、显式路径如何限定到一个已选执行实例、是否提供迁移诊断工具？

## 9. 事实与验证边界

Harness runtime 的默认选择、部署实际加载版本和发布闭包随 package
版本变化。应从生效 profile 确认确切
package，再验证默认路径、配置与闭包；仓库源码、Containerfile 和 package layout
本身不记录部署中的加载状态。live image 与桌面拓扑同样属于部署输入，须单独核验。

本文的 interface、generation 协议、RuntimeSupply
manifest、目标化文件能力和新增验收均为提案。引用的仓库代码提供现有 provider 与
transport contract；部署包行为和端到端结果尚待相应环境验证。
