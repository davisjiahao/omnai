# VS Code 多仓库 Codex Worktree 工作区插件设计

- 状态：已确认设计
- 日期：2026-08-14
- 名称：AI Workspace

## 1. 背景

一个业务需求经常同时涉及多个独立 Git 仓库，例如后端服务、前端工程和公共组件。目标不是为每个仓库启动一个 Codex，而是在 VS Code 中用一个命令为所有相关仓库创建隔离的 Git worktree，再把这些 worktree 放入同一个需求目录。VS Code 打开这个父目录后，一个 Codex 会话即可分析和修改所有子项目。

每个子项目仍然是独立 Git 仓库，独立提交、推送和创建 PR；插件不伪造跨仓库原子提交。

## 2. 目标

1. 一个需求对应一个聚合工作区和一个 VS Code 窗口。
2. 一个 Codex 会话能够搜索、分析和修改需求涉及的全部仓库。
3. 每个仓库使用独立 worktree，避免污染日常开发目录。
4. 所有仓库使用相同的需求分支名，但允许分别选择不同的基线分支。
5. 每个基线选择器默认指向该仓库的远程主干。
6. 仓库列表和业务域预设支持团队共享，同时允许个人本地覆盖。
7. 重复输入同一需求编号时恢复已有工作区，不重复创建。
8. 创建、恢复和清理过程可诊断、可恢复，不破坏已有代码或分支。

## 3. 非目标

首版不包含：

- 自动提交代码；
- 自动推送分支；
- 自动创建或合并 PR；
- 多 Agent 调度；
- Jira、Linear 等需求平台集成；
- 自动克隆尚未存在于本机的仓库；
- 跨仓库原子提交或统一 Git 历史；
- 后台服务、常驻守护进程或 WSM 依赖。

## 4. 核心概念

- **源仓库**：开发者本机已经存在的普通 Git 仓库。
- **需求工作区**：以需求编号命名的父目录，包含状态文件、Codex 上下文和多个 worktree。
- **需求分支**：根据统一模板生成的分支，例如 `feature/REQ-123`。同一需求的所有仓库使用相同名称。
- **基线引用**：某个仓库创建需求分支时使用的远程分支，例如 `origin/main`。
- **业务域预设**：一组经常共同修改的仓库，例如“车险核心域”。

## 5. 工作区结构

默认工作区根目录为 `~/ai-workspaces`：

```text
~/ai-workspaces/REQ-123/
├── AGENTS.md
├── .ai-workspace.json
├── quote-service/
├── order-service/
└── frontend-web/
```

其中：

- `AGENTS.md` 提供需求说明、仓库关系和跨仓库工作约束；
- `.ai-workspace.json` 保存本次工作区的可恢复状态；
- 每个项目目录都是对应源仓库的 Git worktree；
- VS Code 打开 `REQ-123` 父目录，而不是分别打开各仓库，也不依赖 multi-root `.code-workspace` 文件。

## 6. 用户体验

### 6.1 创建需求

用户从命令面板执行：

```text
AI Workspace: New Requirement
```

向导顺序固定为：

1. 手工输入需求编号，例如 `REQ-123`；
2. 手工输入需求标题；
3. 选择一个业务域预设，随后增删本次实际涉及的仓库；
4. 为每个仓库确认基线引用，默认值为该仓库远程主干；
5. 查看工作区目录、统一分支名、仓库与基线汇总；
6. 确认创建。

创建成功后，插件用新的 VS Code 窗口打开需求父目录，并尽可能自动打开 Codex 面板。

### 6.2 恢复需求

以下两种入口行为一致：

- 在 `New Requirement` 中输入已经存在的需求编号；
- 执行 `AI Workspace: Open Requirement` 并选择已有需求。

插件读取 `.ai-workspace.json`，校验各 worktree 后直接打开工作区，不重复创建。如果状态文件存在但部分 worktree 丢失，则展示差异并允许从已有需求分支恢复缺失项。

需求编号在同一个 `workspaceRoot` 内唯一。输入已有编号时，以已有状态中的标题、仓库集合、基线和分支为准，不静默改写。

### 6.3 查看状态

插件侧边栏及 `AI Workspace: Refresh Status` 按仓库展示：

```text
REQ-123  车险报价流程优化

✓ quote-service     feature/REQ-123
● order-service     3 个文件未提交
↑ frontend-web      2 个提交未推送
```

状态至少区分：正常、未提交、未推送或未设置 upstream、worktree 缺失、分支冲突、无法访问。

### 6.4 结束需求

用户执行：

```text
AI Workspace: Finish Requirement
```

插件按以下规则处理：

1. 刷新所有仓库的 Git 状态；
2. 任一仓库存在未提交变更时禁止清理；
3. 存在领先 upstream 的提交，或者需求分支尚无 upstream 时，明确警告并要求二次确认；
4. 用户确认后逐个执行非强制 worktree 删除；
5. 不自动推送，不删除源仓库中的需求分支；
6. 将状态标记为 `finished`，保留 `AGENTS.md` 和 `.ai-workspace.json`；
7. 以后重新打开该需求时，可基于保留的需求分支重新建立 worktree。

## 7. 命令范围

首版包含四个核心工作流命令和一个配置辅助命令：

- `AI Workspace: New Requirement`
- `AI Workspace: Open Requirement`
- `AI Workspace: Refresh Status`
- `AI Workspace: Finish Requirement`
- `AI Workspace: Edit Configuration`

## 8. 配置设计

### 8.1 配置来源与优先级

配置分为三层，后者覆盖前者：

```text
团队共享配置 < 本地个人配置 < 本次向导选择
```

建议位置：

- 本地配置：`~/.config/ai-workspace/config.yaml`
- 团队配置：团队配置仓库中的 `ai-workspace.yaml`

本地配置通过 `sharedConfig` 指向团队配置文件。团队配置可以正常提交到 Git；本地配置保存个人机器上的绝对路径和偏好，不要求提交。

### 8.2 团队共享配置示例

```yaml
version: 1

repositories:
  quote-service:
    displayName: 报价服务
    cloneUrl: git@example.com:auto/quote-service.git
    remote: origin

  order-service:
    displayName: 订单服务
    cloneUrl: git@example.com:auto/order-service.git
    remote: origin

  frontend-web:
    displayName: 车险前端
    cloneUrl: git@example.com:auto/frontend-web.git
    remote: origin

presets:
  auto-insurance:
    name: 车险核心域
    repositories:
      - quote-service
      - order-service
      - frontend-web
```

`cloneUrl` 仅用于识别和提示；首版不自动克隆。

### 8.3 本地配置示例

```yaml
version: 1
sharedConfig: ~/code/team-dev-config/ai-workspace.yaml
workspaceRoot: ~/ai-workspaces
branchPattern: feature/{requirementId}

repositories:
  quote-service:
    path: ~/code/quote-service
  order-service:
    path: ~/code/order-service
  frontend-web:
    path: ~/code/frontend-web
```

团队配置定义仓库标识和业务域；本地配置通过同一个仓库标识补充真实路径。若某个选中仓库没有本地路径，向导要求用户定位已有仓库，并可选择把路径写回本地配置。

配置中不得保存 Git 凭证、访问令牌或 SSH 私钥。

## 9. 远程主干识别

每个仓库的基线选择器独立工作，按以下优先级确定默认值：

1. `refs/remotes/<remote>/HEAD` 指向的分支；
2. 通过 `git ls-remote --symref <remote> HEAD` 获得的远程 `HEAD` 符号引用；
3. `<remote>/main`；
4. `<remote>/master`；
5. 无法识别时要求用户手工选择远程分支。

默认远程来自仓库配置，未配置时使用 `origin`。用户确认后，插件对选中仓库执行 `git fetch --prune <remote>`，再校验基线引用仍然存在。任何仓库校验失败都会在创建 worktree 前停止整个操作。

## 10. Git 创建算法

### 10.1 全量预检查

在产生 worktree 或分支之前，插件先完成全部仓库的预检查：

- Git CLI 可用，并支持插件需要的 `worktree`、`symbolic-ref` 和 `check-ref-format` 命令；
- 源路径存在并且是有效 Git 仓库；
- 配置的远程存在；
- 目标需求目录没有不受管理的同名文件冲突；
- 基线远程引用存在；
- 需求分支没有被其他 worktree 占用；
- 各目标 worktree 路径可以创建。

### 10.2 分支和 worktree

对于每个仓库：

- 如果需求分支不存在，基于所选远程基线创建分支和 worktree；
- 如果需求分支已存在但未被其他 worktree 使用，向用户显示其现有提交点，经确认后使用该分支创建 worktree；
- 如果需求分支已被其他 worktree 使用，则停止并展示占用路径，不强制移动或删除；
- 同一需求的所有仓库使用由 `branchPattern` 生成的相同分支名。

完成远程刷新后，插件先把每个 `baseRef` 解析成不可变的 `baseCommit`，再使用该提交创建需求分支，避免创建过程中远程跟踪分支再次变化。已有需求分支不会被重置到所选基线；插件必须在确认页明确展示“复用已有分支”及其当前提交。

概念上等价于：

```text
git -C <sourceRepo> worktree add -b <branch> <targetPath> <baseCommit>
```

实际实现必须使用参数数组启动 Git 进程，不通过 Shell 拼接命令。

### 10.3 并发策略

首版顺序创建各仓库 worktree，以便提供确定的日志、取消和回滚行为。远程刷新可以受控并发，但必须限制并发数量，避免同时触发过多认证请求。

## 11. 状态文件

`.ai-workspace.json` 是本地运行状态，不包含凭证。建议结构：

```json
{
  "version": 1,
  "status": "ready",
  "requirement": {
    "id": "REQ-123",
    "title": "车险报价流程优化"
  },
  "branchName": "feature/REQ-123",
  "createdAt": "2026-08-14T00:00:00.000Z",
  "repositories": [
    {
      "id": "quote-service",
      "sourcePath": "/Users/me/code/quote-service",
      "worktreePath": "/Users/me/ai-workspaces/REQ-123/quote-service",
      "remote": "origin",
      "baseRef": "origin/main",
      "baseCommit": "0123456789abcdef0123456789abcdef01234567",
      "branch": "feature/REQ-123",
      "branchExistedBefore": false,
      "branchCreatedByOperation": true,
      "branchInitialCommit": "0123456789abcdef0123456789abcdef01234567",
      "worktreeCreated": true
    }
  ]
}
```

状态值包括 `creating`、`ready`、`recoveryRequired` 和 `finished`。写入使用临时文件加原子替换，确保 VS Code 或系统异常退出后仍可恢复。

## 12. AGENTS.md 生成规则

父目录的 `AGENTS.md` 至少包含：

- 需求编号和标题；
- 涉及的仓库、用途、基线和需求分支；
- 提醒 Codex 这是多个独立 Git 仓库；
- 要求修改前识别跨仓库影响；
- 要求在每个仓库分别运行适用的测试；
- 要求分别提交，不假设存在跨仓库原子提交；
- 保留各仓库内部已有 `AGENTS.md` 的局部规则。

它只提供任务和仓库上下文，不复制凭证、环境变量或其他敏感信息。

## 13. Codex 与 VS Code 集成边界

插件保证：

1. 打开包含所有 worktree 的共同父目录；
2. 生成父级 `AGENTS.md`；
3. 一个 VS Code 窗口只对应当前需求工作区；
4. 一个 Codex 会话可以访问父目录下的全部子仓库。

插件仅调用 VS Code 或 Codex 已公开且当前可用的命令来打开 Codex 面板。若没有稳定的公开命令，创建工作区仍视为成功，并显示一次性操作提示让用户点击 Codex 图标。核心工作流不得依赖未公开的 Codex API。

## 14. 插件架构

```text
VS Code Commands / Tree View
              │
              ▼
     Workspace Orchestrator
       ├── Config Service
       ├── Repository Service
       ├── State Store
       ├── Context Generator
       └── Workspace View
```

模块职责：

- **Commands / Tree View**：向导、进度、状态展示和用户确认；
- **Workspace Orchestrator**：编排预检查、创建、恢复、回滚和结束流程；
- **Config Service**：加载、验证并合并团队与本地 YAML；
- **Repository Service**：封装所有 Git 查询和变更操作；
- **State Store**：原子写入状态、工作区锁和恢复日志；
- **Context Generator**：生成父级 `AGENTS.md`；
- **Workspace View**：汇总多个仓库的工作区状态。

插件使用 TypeScript、VS Code Extension API、Node.js 进程 API 和 YAML 解析库实现，不运行额外后端服务。

## 15. 锁、取消与回滚

### 15.1 工作区锁

创建或结束流程开始时，以独占方式创建需求级锁文件。锁包含操作类型、进程标识和开始时间。检测到锁时禁止重复执行；确认原进程不存在后才允许用户清理陈旧锁。

### 15.2 操作日志

每完成一个可变更步骤就更新状态文件，记录：

- worktree 是否由本次操作创建；
- 分支是否由本次操作创建；
- 分支在操作前是否已经存在；
- 基线提交和分支创建完成时的初始提交；
- 当前成功步骤和失败原因。

### 15.3 回滚原则

任一仓库失败或用户取消时：

1. 停止后续仓库创建；
2. 逆序删除本次创建且仍然干净的 worktree；
3. 仅当分支由本次操作新建、当前提交仍等于记录的 `branchInitialCommit` 且未被其他 worktree 使用时，才删除该分支；
4. 绝不删除操作前已经存在的分支；
5. `fetch` 更新的远程跟踪引用不回滚；
6. 回滚不完整时保留状态文件并标记 `recoveryRequired`，提供继续回滚或恢复创建入口。

## 16. 安全与错误处理

- 需求编号只允许字母、数字、点、下划线和连字符，禁止路径分隔符与目录穿越；
- 分支名通过 `git check-ref-format --branch` 验证；
- 所有路径先规范化，并校验目标位于配置的 `workspaceRoot` 下；
- Git 调用使用可执行文件和参数数组，不使用 `shell: true`；
- 不执行强制 worktree 删除；
- 不修改源仓库工作区、暂存区或当前分支；
- 错误通知显示失败仓库、失败阶段和可操作建议；
- Git 原始错误写入专用 Output Channel，敏感 URL 中的凭证必须脱敏；
- 重试从已记录状态继续，不重复执行已经成功的破坏性步骤。

## 17. 测试策略

### 17.1 单元测试

- 团队与本地配置合并优先级；
- 配置 schema 校验；
- 需求编号、分支名和路径校验；
- 分支模板渲染；
- 远程主干识别优先级；
- 状态迁移和恢复决策；
- Git 错误分类与脱敏。

### 17.2 Git 集成测试

使用临时本地仓库和 bare remote 执行真实 Git 命令，覆盖：

- 多仓库成功创建；
- 每个仓库使用不同基线；
- 已有分支复用；
- 分支被其他 worktree 占用；
- 中途失败和逆序回滚；
- 中途取消和再次恢复；
- 脏 worktree 禁止结束；
- 无 upstream、领先 upstream 和已完全推送三种结束状态；
- 完成后保留分支并可重建 worktree。

### 17.3 VS Code 扩展测试

- 命令注册和向导主路径；
- 新窗口打开正确的父目录；
- Tree View 状态刷新；
- 配置编辑入口；
- Codex 命令存在和不存在时的两种行为。

CI 覆盖 macOS、Linux 和 Windows。涉及路径、进程启动和原子文件替换的行为必须分别验证。

## 18. 验收标准

1. 用户可在 VS Code 内通过一次向导选择多个独立仓库。
2. 每个仓库的基线默认是其远程主干，并允许单独修改。
3. 确认后，所有选中仓库在同一需求父目录下生成 worktree。
4. 所有仓库使用相同需求分支名，且分别基于用户选择的基线。
5. 新 VS Code 窗口打开共同父目录，一个 Codex 会话可以读取和修改全部子项目。
6. 重复输入需求编号不会产生重复 worktree，而是恢复已有需求。
7. 任一仓库创建失败时，插件不会留下无法解释的半成品；回滚失败则提供明确的恢复状态。
8. 存在未提交内容时不能结束需求；默认不推送、不删除需求分支。
9. 团队配置可以提交共享，本地路径可以个人覆盖，配置中不保存凭证。

## 19. 设计决策总结

采用轻量自研 VS Code 插件直接调用 Git，而不是组合多个现有插件或引入独立工作区管理器。该方案用最少的组件实现核心体验：一个需求、多个 worktree、一个父目录、一个 VS Code 窗口和一个 Codex 会话，同时完整保留各仓库的 Git 独立性。
