<!--
SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>

SPDX-License-Identifier: MIT
-->

# Workflow/PTC 执行环境分析与修复提案

状态：设计讨论，尚未实现。本文区分可检查的代码行为、部署前提与拟议改动。Harness
运行时、配置档和发布产物均须按部署所用的确切版本复核。本文引用的仓库实现以代码基线
`5221fff3d5e08b1e54ab349a67db82d245dc73ac`
为准。术语见[词汇表](../GLOSSARY.md)。

## 1. 结论

建议以**目标绑定的执行作用域**作为完整方案的核心，并配套运行时供应与目标化文件访问。PTC
worker
在选定工作区容器中执行；执行作用域固定目标，并管理可执行文件、bootstrap、最终环境、沙箱、文件引用和进程生命周期。

同质镜像部署可显式设置 guest `nodeExecutable` 与 `bootstrapPath`
作为迁移配置。完整方案为文件使用方提供目标感知接口：接口接收执行作用域和授权文件引用，分别提供共享映射、guest
内物化副本和桌面端访问；每项请求按目标校验，并在目标缺少相应能力时返回可区分的结果。

将职责拆分为两个模块，并通过执行作用域组合：

- **执行模块**：绑定执行目标、校验实例身份、准备和启动进程，并管理取消、失效和清理。
- **运行时供应模块**：按作用域和版本要求提供兼容的 Node、PTC worker/bootstrap
  及依赖闭包。工作区镜像和只读运行时资源挂载是两种可替换的供应适配器，均返回带版本信息的资源租约。

首批支持矩阵需列出工作区操作系统、CPU 架构、libc、Node
版本和沙箱模式，并通过真实目标镜像与桌面客户端验收。矩阵外的组合保持待验证状态。

## 2. 代码事实与故障推断

### 2.1 启动资产的路径契约与故障条件

DSH 运行环境承载 Harness
编排逻辑；执行环境包含工作区容器中子进程实际可见的文件、程序和环境。两边分别解析绝对路径；共享挂载中的文件身份须按目标验证。

仓库[控制通道文档](workflow-control.zh.md#同步部署两端)将工作区容器内的 Node
可执行文件、工作流 bootstrap 及其配置路径列为部署前提。PTC worker 由子进程
provider 按工作目录送入工作区执行。若运行时提供的可执行文件或 bootstrap 路径来自
DSH 运行环境，而目标容器没有对应资产，guest 会在执行程序或加载 bootstrap
时失败。

Harness 运行时决定默认可执行文件和 bootstrap
的选择，行为随版本变化。集成应固定具体版本，并核对该版本的默认路径、配置项、built/source/package
运行模式和发布闭包。DSH 镜像与工作区镜像分别提供 Node 及其模块，须各自确认。

### 2.2 现有接口缺少稳定的目标绑定

- [`SubprocessProvider.resolveExecutable`](../src/subprocess.ts#L19-L57)不接收工作区或
  cwd：绝对路径原样返回，裸命令报告未找到。`spawn(spec)` 才按 `spec.cwd`
  选择工作区，因此路径解析器无法在目标执行环境中验证返回路径。
- [`WorkspaceBinding`](../src/workspace-binding.ts#L16-L27)没有容器代际字段；重建流程保留
  agent 令牌，见
  [`ensureAgentToken`](../internal/orchestrator/grpcserver/container-lifecycle.go#L51-L64)。执行作用域需要额外携带实例代际，以区分重建前后的容器。
- [`FilesystemProvider.processPathFromHostPath`](../src/fs-provider.ts#L138-L142)只接收路径字符串并同步返回结果；当前适配器对绝对路径原样返回。目标化共享映射需要挂载身份、源路径解析结果和执行代际，此接口未提供这些输入。
- Guest
  [在创建命令后构造子进程环境](../internal/guestagent/exec/exec.go#L63-L71)；[`childenv`](../internal/guestagent/childenv/childenv.go#L78-L143)随后生成最终环境。因此裸命令的查找使用
  guest-agent 的 PATH，而子进程接收后构造的
  PATH。执行准备需先构造最终环境，再按该 PATH 解析
  Node，并以相同环境启动；`NODE_OPTIONS` 和加载器变量也须在 Node
  启动前纳入策略。
- [`remoteArgv`](../src/guest-rpc.ts#L785-L801)会解开 Landlock
  包装器；现有[只读工具门控](../src/read-only-shell.ts#L21-L35)不包含
  Workflow/PTC。PTC 的文件访问约束取决于执行环境中的 guest 策略，启动结果应报告
  guest 实际执行的策略。

以上结论限于引用的仓库代码基线。部署中生效的配置档、镜像和实际加载的 PTC
运行时版本须另行核实。

### 2.3 控制通道与路径问题相互独立

Workflow/PTC 的子进程 provider 需要 `control`、`stdout` 和 `stderr`
通道。[控制通道文档](workflow-control.zh.md)与[真实 guest 测试](../scripts/test-workflow-control.mjs)覆盖这项传输契约；目标环境中的
Node 与 bootstrap 由另一组检查验证。

现有真实传输测试覆盖 guest
gRPC、数据流、EOF、取消和控制协议。跨容器运行时供应及文件路径语义需使用不同文件系统和目标镜像的测试夹具。

## 3. 设计目标与不变量

1. 一个工作流的 Node、worker、bootstrap、沙箱、cwd
   和子进程均属于已授权绑定的执行实例。
2. 每次调用通过明确的工作区/容器引用和代际路由；并发调用各自保留目标绑定。
3. 准备阶段固定目标代际和最终环境；可执行文件解析、资产查找、沙箱准备与 `spawn`
   使用同一组值。
4. 容器重建或有效配置变化会使尚未启动的执行计划失效；guest
   在接受启动时校验代际。启动确认丢失时，按启动 ID
   查询结果；确认进程尚未启动后才允许重试。
5. 共享映射要求两端指向同一文件；物化副本具有独立文件身份；桌面打开依赖目标客户端能否访问文件。三种能力分别使用有类型的文件引用。
6. 每种受支持的附件、图片溢出和文件打开场景都声明所需的文件能力；能力不可用时，返回该调用方能够识别的错误或回退结果。
7. Guest 对实际运行 Node
   的进程强制执行沙箱策略并报告执行状态；目标无法执行所请求的策略时拒绝启动。
8. 运行时供应固定版本并记录来源；验收同时检查静态清单与 guest 实际加载的内容。

## 4. 推荐的模块与接口

外部接口边界位于执行目标选择处。调用方根据已授权的会话/工作区引用解析工作区和容器，并将
cwd 解释为目标内路径；选择具名容器时执行权限检查。

下面的 TypeScript 展示拟议接口的职责和生命周期：

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

PTC
运行时持有程序、bindings、帧协议、时限、输出限制和结果类型，并通过执行接口获取
worker。Podman 执行模块负责绑定目标、准备并启动进程。普通 shell/子进程仍使用现有
subprocess 接口；需要在同一目标内完成解析和启动的调用使用执行作用域。

### 4.1 执行作用域的身份与生命周期

`bind` 返回的作用域固定工作区容器、cwd、guest
实例和生效配置。内部实例身份至少包含工作区代际、容器代际、guest
启动标识和实际镜像摘要；影响可见文件或进程环境的挂载、环境变量与路径变更，均须推进代际或配置修订号。调用方只收到不含凭据的不透明引用；`agentToken`、socket
路径等秘密不得出现在模型可见结果中。

推荐执行顺序：

```text
授权目标 → 绑定作用域 → 获取匹配运行时 → 固定 guest 环境
→ 准备（可执行文件、bootstrap、沙箱、stdio）→ 一次性启动
→ ready/control 协议 → 运行/取消/退出 → 关闭作用域并释放资产
```

`PreparedExecution` 封装已固定的 cwd、env、可执行文件、运行时、沙箱和
stdio，只能由创建它的作用域消费一次。`spawn` 仅接收准备好的执行计划。`close`
可重复调用，并清理未消费的计划、释放资产租约、终止该作用域拥有的运行中进程。
控制面签发代际，guest
在握手和接受启动请求时校验。容器重建与进程准入按代际协调；即使令牌、socket
或容器名复用，新实例也只接受新代际的启动请求。确认消息丢失时，调用方按启动 ID
查询原代际的结果；结果仍未知时保持未知，确认尚未启动后才允许重试。

代际标识容器配置版本；可写项目挂载中的文件仍按工作区语义变化。若需保证 worker
闭包不可替换，应通过受保护的只读方式供应完整资产；哈希/文件状态预检仍存在检查与执行之间的竞态。`RuntimeLease`
表示运行时资产，不包含项目代码快照。

### 4.2 运行时供应与平台支持

`RuntimeSupply` 接收 PTC 运行时声明的
`RuntimeRequirement`，按版本清单为绑定目标选择资产租约。`RuntimeRequirement`
标识 PTC 发布版本、worker 协议版本和目标平台；清单列出：

- PTC 软件包/发布版本标识、worker 协议版本及 bootstrap/依赖闭包摘要；
- Node 版本或兼容范围、操作系统、CPU 架构、libc/动态加载器及所需系统库；
- 入口布局、只读属性和资产版本；存在原生扩展时，还需列出相应 ABI。

按支持矩阵构建并测试工作区镜像，提供匹配的 Node 与 worker
闭包；只读运行时镜像挂载可作为另一种供应适配器。Node
发布物须匹配操作系统、架构、libc、动态加载器和原生 ABI。发布 CI
在干净的目标镜像中验证实际发布闭包及启动行为。

现有
[`image_build` 参数](../src/tool-params.ts#L127-L139)只接受父镜像和系统包；[镜像构建器](../internal/orchestrator/images/images.go#L88-L150)按发行版包管理器生成安装步骤，目前未定义
PTC 运行时清单或供应协议。现有
[`DSH_PODMAN_BASE_IMAGE_PREFIX`](../internal/orchestrator/grpcserver/image-resolve.go#L22-L103)为固定基础镜像短名称添加镜像仓库前缀，使用
`:latest`，且影响整组基础镜像。新增托管资产需要配套构建配方/清单、不可变摘要值、升级规则，以及派生镜像和现有容器的迁移方案。

`RuntimeSupply`
在已绑定的作用域内提供资产。若更新需要重建容器，应在工作流启动前完成，再绑定新代际。运行中的工作流保持其容器和权限配置。无网络、无供应权限、版本不兼容或闭包缺失时，返回可诊断错误；工作流运行期间不安装运行时。

### 4.3 文件访问：映射、物化和桌面打开

`processPathFromHostPath(hostPath)`只接收路径字符串，不含目标或授权信息。各文件使用方应迁移到执行作用域内的文件接口，并选择所需能力：共享映射、物化或桌面访问。

- **共享映射**：只有挂载与源文件身份、所选工作区作用域、解析后的路径及当前代际共同证明两端指向同一文件时才成功。实现需覆盖嵌套工作区、符号链接、子挂载遮蔽、overlay
  文件系统和容器重建。无法证明时，该请求返回 `shared mapping unavailable`。
- **物化副本**：`materialize` 将经授权读取的文件复制到目标执行环境，并返回独立的
  guest
  文件引用。接口限制文件大小，并规定只读属性、生命周期、缓存键、配额和清理方式。
- **桌面打开/Reveal**：`DesktopOpener` 接收授权文件引用，并把打开或 Reveal
  操作交给能够访问该文件的桌面客户端。适配器解析客户端可用的引用，并报告目标不可达。

LLM 附件及 worker
需要读取的图片可由作用域提供只读物化引用。物化不可用时，文件使用方采用已验证的内联回退，或返回明确错误。文本
spill 继续使用 guest 本地的有界文件句柄；打开文件由 `DesktopOpener`
处理。每个使用方分别验收其配额、清理、回退和桌面目标。

文件使用方分批迁移；每批实现所需的作用域内映射、物化或桌面访问能力。确认所有调用点均改用目标化能力后，再移除旧的同步方法。

### 4.4 最终环境、可执行文件与沙箱

Guest 先构造唯一的最终环境，并明确继承规则、显式覆盖、删除标记以及 Node/loader
变量的处理方式。随后在相同 cwd、uid 和最终 PATH
下将可执行文件解析为绝对路径，并使用同一环境启动。

Guest
强制执行沙箱策略，并在握手和启动结果中报告实际执行状态。[`remoteArgv`](../src/guest-rpc.ts#L785-L801)会解开
Landlock 包装器，因此目标 guest
需实现所请求的模式；不支持时返回明确错误。只读运行时挂载保护运行时资产，工作流沙箱则单独约束项目文件访问。

## 5. 候选方案与取舍

| 方案                                    | 提供能力                                                                            | 限制                                                                             | 定位             |
| --------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------- |
| 显式 `nodeExecutable` + `bootstrapPath` | 为镜像布局固定的部署指定 guest 运行时入口                                           | 适用于同质工作区镜像；异构目标选择、通用可执行文件验证和目标化文件能力需另行设计 | 兼容/过渡模式    |
| 目标绑定的执行作用域                    | 统一目标、准备、环境、沙箱、文件和进程生命周期；支持并发工作区与具名容器            | 需扩展 Harness 接口、Podman 控制/guest 协议并协调代际                            | 推荐的执行核心   |
| `RuntimeSupply`                         | 按目标操作系统/架构提供精确版本的运行时闭包；工作区镜像与只读资源挂载均可作为适配器 | 需要清单、发布验证及镜像/资产升级流程                                            | 与执行作用域配套 |

建议以 `ExecutionScope` 作为启动主路径，由 `RuntimeSupply`
为该作用域提供运行时租约。前者负责目标选择、校验、准备、启动和释放；后者选择兼容闭包并记录版本。工作区镜像和只读资源挂载使用同一启动流程。

## 6. 错误、取消和兼容规则

为作用域失效、目标不匹配、运行时不可用、平台不兼容、共享映射无法证明、物化超限、沙箱不支持、guest
缺少能力以及启动结果未知分别定义稳定错误。错误类型须区分权限拒绝、取消、文件不存在和能力不可用，并与对应的
PTC 运行时版本配套。

`spawn(prepared)` 保持子进程调用约定：调用方开始写入前即可使用
`control`、`stdout` 和 `stderr`
句柄；远端启动失败通过句柄完成状态报告。取消操作须终止 guest
进程组并释放作用域资源。真实传输契约测试继续覆盖 control 通道 EOF、背压、旧
guest 的能力协商与退出清理。

过渡适配器将显式 Node 路径与 bootstrap
路径成组接收，并在同一作用域内验证。升级时保留上一兼容的运行时/镜像组合；容器重建后绑定新代际，再验证资产和传输。

## 7. 分阶段实施与验收

按阶段扩大支持矩阵；每项记录既有测试覆盖情况和新增测试结果。

| 阶段               | 交付内容                                                       | 关键验收标准                                                                                        |
| ------------------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1. 接口与协议设计  | 目标作用域、代际、已准备的启动计划、能力协商和错误语义         | 两个并发工作区不会串用目标；容器重建或配置变化后，guest 拒绝旧计划；确认丢失不会触发重复执行        |
| 2. `RuntimeSupply` | 版本清单、受控镜像配方或只读运行时资源                         | 在不挂载 DSH 模块的干净容器中通过闭包检查；覆盖操作系统/架构/libc/动态加载器、不兼容版本和升级/重建 |
| 3. 环境与沙箱      | guest 端最终环境、使用同一 PATH 解析可执行文件、目标内沙箱隔离 | Node 启动前控制 guest 独有的 `NODE_OPTIONS`/加载器注入；实际文件访问符合策略；不支持的模式被拒绝    |
| 4. 文件使用方迁移  | 分别提供共享映射、物化和桌面打开适配器                         | 分别验证附件读取、图片提示输入/溢出、内联回退和打开/Reveal；未经验证的映射不泄露路径                |
| 5. 端到端支持矩阵  | PTC 工作流、控制通道、工作区镜像与部署流程                     | 覆盖不同 DSH/guest 文件系统、真实目标镜像、容器重建、取消、失败和回滚                               |

已有 [`make test-workflow-control`](workflow-control.zh.md#回归检查)真实 guest
测试覆盖
gRPC、数据流、EOF、取消和控制协议。新增跨环境测试须使用不同文件系统和目标镜像，并覆盖多个工作区并发、同名异内容路径、符号链接/子挂载/overlay、代际失效、环境优先级、Node
ABI/动态加载器、附件配额与清理、桌面能力、沙箱拒绝、控制通道背压及升级回滚。

实现后运行 `make test`、`make vet` 和
`make fmt-check`；跨环境验收还须使用声明支持的真实镜像和发布运行时。格式检查验证文档与源码格式，集成测试验证运行行为。

## 8. 需要评审决定的问题

1. 执行作用域的持有者和调用方如何传递可信的工作区/容器引用，同时不向 PTC
   程序暴露控制面凭据？
2. 容器代际由谁签发？哪些挂载、环境或镜像变更需要推进代际？guest
   如何在接受启动请求时与容器重建协调校验？
3. 首批支持哪些操作系统、CPU、libc、Node 版本和沙箱模式？如何根据实际发布包生成
   worker 清单并验证依赖闭包？
4. 选择工作区镜像、受管运行时镜像挂载，还是两者并用，才能满足升级、只读性、体积和管理员控制要求？现有基础镜像前缀机制使用全局短名称与
   `:latest`；是否需要增加受控清单和不可变摘要值？
5. `processPathFromHostPath` 如何平滑迁移？附件和图片是否允许配额受限的 guest
   物化？文件打开/Reveal 应使用哪个桌面客户端，失败时如何回退？
6. 首批由 guest
   强制执行哪些沙箱模式？模式不受支持时返回什么错误？验收如何区分程序沙箱与只读运行时资产挂载？
7. 旧配置保留多久？如何把显式路径限制在已选执行实例内？是否需要提供迁移诊断工具？

## 9. 事实与验证边界

Harness
运行时的默认选择、部署中实际加载的版本和发布闭包随软件包版本变化。应从当前生效的配置档确认确切软件包，再验证默认路径、配置项和闭包。仓库源码、Containerfile
和软件包布局无法表明某次部署实际加载的内容。当前部署使用的镜像与桌面拓扑也属于部署输入，须单独核验。

本文提出的接口、代际协议、`RuntimeSupply`
清单、目标化文件能力和新增验收均属设计提案。引用的仓库代码描述现有提供器与传输契约；部署包行为和端到端结果仍待在相应环境中验证。
