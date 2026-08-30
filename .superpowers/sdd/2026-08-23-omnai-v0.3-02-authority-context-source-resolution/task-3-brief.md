# Plan02 Task 3 独立实施 Brief

> 状态：执行中
>
> 日期：2026-08-27
>
> 基线：`eeca66e63a6695f6c61454b0f8888ecbc605db6e`
>
> 目标：建立 final-v0.3 的一次性 `ChangeAuthorityContext`、冻结索引、机器投影与提交后物理 seal；不提前实现 Plan03 的全局权限链。

## 1. 权威顺序与本轮裁决

发生冲突时按以下顺序执行：

1. `2026-08-27-omnai-v0.3-native-pipeline-convergence-design.md`。
2. `2026-08-27-omnai-v0.3-native-pipeline-convergence.md`。
3. Plan01 final-v0.3 Schema/catalog 与已经批准的 Task1/Task2 生产边界。
4. `2026-08-23-omnai-v0.3-02-authority-context-source-resolution.md` Task 3。
5. 与 final-v0.3 兼容的 `2026-08-22-omnai-v0.3-change-authority-integrity-repair-design.md` 不变量。

Plan02 引用的“主规范第 20 节”等原始资料在当前仓库不可达，不得凭空补写。旧 RecoveryAuthority
文档只提供“不二读、不修复、精确前缀”等需求证据，不提供本轮可移植的持久 Schema 或实现。

## 2. 已核实的代码事实

- Task2 已提供不可伪造、只消费一次的两阶段库存：
  `buildAuthorityInventoryBase()` → `finalizeAuthorityInventory()`。基础 capture、父目录观察和 inode
  identity 观察可以跨阶段复用且不重读。
- final catalog 仍只能由测试 lease 注入；生产 `requireVerifiedAuthorityCatalog()` 必须继续 fail closed。
- 当前没有 final `AuthorityEnvelope`、`AuthorityRecord`、Genesis、PENDING owner、全局 chain inventory 或
  exact Change lock/ResolvedChangeHandle 实现；这些由 Plan03/Plan04 明确拥有。
- 当前 `ObservedDirectoryV1.inventoryHash` 只覆盖 entry name。Plan01 catalog 的 machine directory contract
  是 `ENTRY_NAMES_AND_NODE_TYPES`，所以现实现无法识别同名 `FILE ↔ DIRECTORY` 或 symlink 替换。
- 原计划所称“四个 completed validators”并不位于列出的四个文件中。规范完成态校验主要集中在
  `transaction-lineage-integrity.ts`、`flow-terminal-authority.ts` 和
  `semantic-mutation-journal.ts`；真实 public completed retry 还经过 `decisions.ts`、
  `ordinary-reconcile-recovery.ts` 等模块。一次性迁移整条调用链会越过 Plan03/Plan04 owner 边界。
- P02 当前到期诊断只有 `src/core/flow-assessment.ts` 的 7 条异步 catalog 错误。Task3 必须关闭这 7 条，
  但不得借此迁移 Plan04 writer。

## 3. 本轮完成边界

### 3.1 必须完成

- 扩展稳定目录观察，使 inventory hash 覆盖 code-unit sorted 的 `(entryName, nodeType)`。
- 建立 WeakMap capability-backed 的 `BASE_LOADING → BASE_AUTHENTICATED → REQUEST_CAPTURED → SEALED`
  生命周期；伪造、clone、重复消费和失败后 retry 都在零 I/O 下拒绝。
- builder 在内部拥有 Task2 base capability；外部永远拿不到未完成的 base inventory。
- builder 只从稳定 capture 严格解析当前 final-v0.3 domain records，建立冻结 Decision、Evidence、Task、
  Run、progress、archive 和物理 transaction-capture 索引。
- `ChangeAuthorityContext` 的全部 getter 在 `SEALED` 后只访问冻结内存；删除或改写源文件不影响返回值，
  preflight observed-I/O counters 不再变化。
- 建立 preflight `MachineAuthorityProjectionV1`，每行比较
  `(relativePath,nodeType,mode,rawBytesHash|inventoryHash)`。
- 建立一次性 prepared commit capability。target rows 来自冻结目标；untouched rows 必须由 context
  preflight projection 自动求补集，调用方不能删减或伪造。
- `verifyCommitSeal()` 使用独立的第二个 recorder 重开每个 expected final row，区分 target mismatch 与
  untouched drift；失败不 chmod、不写入、不删除、不修复、不 retry。
- 把 completed validation 的纯计算入口放入 no-I/O import closure；混合 writer 模块不得以可选
  `context?` + raw fallback 伪装迁移完成。
- 修复 `flow-assessment.ts` 的 7 条 `getScenario()` Promise 诊断；非 completed writer 的行为不在本轮重写。

### 3.2 明确不完成

- 不定义或持久化 `AuthorityEnvelope`、Genesis、PENDING/COMPLETED owner、request/payload/record hash、
  predecessor/sequence 或全局 tail selector。
- 不把旧 semantic/reconcile transaction Schema 冒充 final chain record，也不增加兼容 reader。
- 不声明公共 writer 已接入 context；完整 Decision/Flow/ordinary/Scenario owner 与 recovery 调用链由
  Plan03 Task6 和 Plan04 收口。
- 不修改 `src/execution/**`、root exports、CLI、依赖、lockfile 或生产 native provider。
- 不把 post-commit machine seal 塞进 preflight context。context 持有的是 preflight machine projection；
  `MachineAuthoritySealV1` 只能由 `verifyCommitSeal()` 成功后生成。

## 4. 文件范围

计划内创建：

- `src/core/authority/context.ts`
- `src/core/authority/context-builder.ts`
- `src/core/authority/machine-seal.ts`
- `src/core/authority/indexes.ts`
- `src/core/authority/test/context-read-once.test.ts`
- `src/core/authority/test/machine-seal.test.ts`

为关闭已证实缺口允许窄改：

- `src/core/authority/observed-io.ts`
- `src/core/authority/stable-bytes.ts`
- `src/core/authority/inventory.ts`
- `src/core/authority/test/observed-io.test.ts`
- `src/core/authority/test/stable-bytes.test.ts`
- `src/core/flow-assessment.ts`
- `src/core/semantic-mutation-journal.ts`（仅纯 completed consumer seam；不得改 writer/outbox）

只有在 RED 证明纯 consumer 无法接入时，才可窄改：

- `src/core/decision-reconcile-transaction.ts`
- `src/core/ordinary-reconcile-transaction.ts`

本轮不得为了宣称“完整 public retry 零 I/O”扩大到 Plan03/04 的
`transaction-lineage-integrity.ts`、`flow-terminal-authority.ts`、`decisions.ts`、
`ordinary-reconcile-recovery.ts`、`ordinary-reconcile-orchestration.ts`。相关剩余调用链必须在报告中如实列为
后续 owner 接入项，而不是保留隐式 fallback。

## 5. 类型与 API 约束

### 5.1 可直接复用的 final 类型

- Catalog：`StageAuthorityCatalogV1`、`requireVerifiedAuthorityCatalog()`、`hashStrictObject()`。
- Workflow：`StrictWorkflowLockV2` / `WorkflowLock`。
- Domain：`ChangeMetadata`、`TaskFile`、`DecisionRecordV2`、`FlowPlanV2`、`EvidenceRecord`、
  `StageRunManifestV3`、`Revision`、`ReconcileSignal`、`ProgressEventV1`。
- Scalars：`ChangeId`、`RevisionId`、`DecisionId`、`EvidenceId`、`RunId`、`TaskId`、`Sha256`。
- Physical：Task2 inventory、stable capture、typed observations 和 immutable readonly-map primitive。

不得以 `ChangeRef`、`src/core/files.ts` 的 raw reader、legacy transaction union 或普通 `string` 别名建立
新的 context authority contract。

### 5.2 Phase capability

推荐形状如下；具体私有 state 可以调整，但安全语义不可削弱：

```ts
export type BuildBaseContextRequestV1 = Readonly<{
  expectedChangeId: ChangeId;
  // internal-only；Plan04 以 opaque ResolvedChangeHandle/contained-root capability 取代。
  containedRoot: NormalizedAbsoluteRealPath;
  logicalTargets: readonly AuthorityLogicalTargetV1[];
  archiveTargets: readonly AuthorityArchiveTargetV1[];
  knownAuxiliaryTargets: readonly AuthorityAuxiliaryTargetV1[];
}>;

export type ContextPhase =
  | 'BASE_LOADING'
  | 'BASE_AUTHENTICATED'
  | 'REQUEST_CAPTURED'
  | 'SEALED';

export interface BaseContextHandleV1 {
  readonly phase: 'BASE_AUTHENTICATED';
}

export interface ChangeAuthorityContext {
  readonly phase: 'SEALED';
  readonly changeId: ChangeId;
  readonly revisionId: RevisionId;
  readonly workflowLock: DeepReadonly<StrictWorkflowLockV2>;
  readonly authorityCatalog: DeepReadonly<StageAuthorityCatalogV1>;
  readonly authorityCatalogHash: Sha256;
  readonly baseContextDigest: Sha256;
  readonly machineProjection: MachineAuthorityProjectionV1;
  readonly observedIo: ObservedIoCountersV1;
  requireDecision(id: DecisionId): DecisionRecordV2;
  requireEvidence(id: EvidenceId): EvidenceRecord;
}
```

- caller 不得传 catalog、WorkflowLock parsed object/hash、recorder/counters、stable capture、inventory、
  domain records、indexes 或 authority digest；这些都由 builder 从固定 loader/path 与稳定 inventory 内部产生。
- 当前 internal contained root 必须是规范 repository authority root，所有 targets 都是相对该根的 token；
  Plan04 会把 raw root 输入替换为规范身份/锁 capability，Task3 不得 root-export 该 construction API。
- `baseContextDigest` 只表示本轮冻结的物理/domain base context，不得命名或解释为最终 chain authority
  digest。Plan03 负责把它组合进唯一 owner/envelope。
- base handle、prepared commit projection 都必须是 WeakMap-backed capability；仅冻结一个 structural object
  不足以证明真实性。
- 进入异步 request capture 或 verifier I/O 前先原子消费 capability。capture/verifier 失败后同一 capability
  仍不可重试。
- matching frozen recovery 与 new mutation 必须是两个明确分支；禁止一个可选 callback/fallback 在运行时
  猜测是否读取 current source。
- 生产 API 不得导出 `*ForTesting` seam。测试通过真实 fixture、隔离子进程或已批准 catalog test lease
  构造状态。

### 5.3 Context 固定顺序

当前可实现顺序为：

1. verified catalog/workflow binding；
2. 已认证 contained root、identity 与锁内 lease 输入；
3. 创建 preflight recorder；
4. `buildAuthorityInventoryBase()`；
5. 从 base bytes 严格解析已存在 final domain records；
6. 对当前尚无 final Schema 的 owner/chain/Genesis 分支 fail closed，不创建 placeholder；
7. `finalizeAuthorityInventory()` 只消费已经认证的 receipt refs；当前没有认证器时只允许空集合；
8. 解析 auxiliary、建立 indexes 与 preflight projection；
9. 公开 `BASE_AUTHENTICATED` handle；
10. new request capture 或 frozen inspection/recovery 分支；
11. snapshot preflight counters 并进入 `SEALED`。

Plan03 增加 final chain parser 后，应在步骤 5 与 7 之间提供真实 receipt/tail 认证，不改变 Task2 的基础
capture，也不增加第二次读取。

## 6. 冻结索引

`indexes.ts` 只做纯计算，禁止导入 `node:fs`、`files.ts`、`paths.ts`、raw store、decision/flow store 或
transaction query helper。至少提供：

- ordered Decisions + `DecisionId` exact lookup；
- ordered Evidence + `EvidenceId` exact lookup；
- Tasks/Run manifests 的 exact ID lookup；
- ordered progress events、event kind、operation request 和语义 mutation correlation 的进程内索引；
- archive cache keyed by `(RevisionId, logical key)`；
- transaction physical captures keyed by declared transaction identity；
- duplicate identity、duplicate sequence/event/request key 和不一致 Change/Revision binding 的 fail-closed 检查。

尚无 final owner record Schema 时，不得从 legacy JSON/YAML 猜 `PENDING`、sequence、request digest 或
receipt。可以保留严格绑定到 inventory hash 的 opaque physical capture，但不能把它标记为已认证 chain row。

返回 map 不得使用 `Object.freeze(new Map())`；复用 Task2 的 entry-array readonly map 或等价不可取得 backing
实现。返回 domain values、arrays、rows 和 byte copies 必须深度不可变，且不能把私有 backing 交给运行时
可替换的内建方法。

## 7. 目录观察、机器投影与 seal

### 7.1 Typed directory inventory

在 Task2 observation 上增加：

```ts
export type ObservedDirectoryEntryV1 = Readonly<{
  name: string;
  nodeType:
    | 'FILE'
    | 'DIRECTORY'
    | 'SYMBOLIC_LINK'
    | 'FIFO'
    | 'SOCKET'
    | 'BLOCK_DEVICE'
    | 'CHARACTER_DEVICE'
    | 'UNKNOWN';
}>;
```

- descriptor `readdir` 必须一次真实调用同时取得 buffer name 与 node type；不得另建 names-only
  machine bypass。
- 保留 fatal UTF-8、NFC/segment 检查、code-unit order、descriptor before/after fstat 与 anchored identity。
- `inventoryHash` 对每个 `(length-framed UTF-8 name, fixed node-type token)` 哈希。
- 普通物理观察可以记录 `UNKNOWN`；machine-owned exact directory 遇到 `UNKNOWN`、symlink 或其他未授权
  node type时失败关闭。
- 新测试必须证明 names-only hash 相同的 file→directory、file→symlink 攻击被新 hash/验证拒绝。

### 7.2 Projection

```ts
export type MachineAuthorityRowV1 =
  | Readonly<{
      relativePath: string;
      nodeType: 'FILE';
      mode: number;
      rawBytesHash: Sha256;
    }>
  | Readonly<{
      relativePath: string;
      nodeType: 'DIRECTORY';
      mode: number;
      inventoryHash: Sha256;
    }>;
```

projection rows 按 relative path 的 UTF-16 code-unit 顺序唯一排列。dev/ino/mtime/ctime 只用于单次稳定读取
的竞态认证，不进入允许原子替换后的跨时刻比较。preflight 必须验证实际 mode 等于已认证 machine manifest
的 expected mode，不能把攻击者预先设置的错误 mode 当成合法基线。

### 7.3 Prepared capability 与 terminal verifier

prepared 私有 state 至少绑定：

- exact context identity / contained root / preflight projection hash；
- frozen target rows；
- 自动计算的 untouched complement；
- expected final projection/hash；
- machine manifest target membership；
- child add/remove 对 exact-owned parent directory target 的闭包；
- consumed flag。

`verifyCommitSeal()`：

1. I/O 前原子消费 prepared capability；
2. 新建独立 post-commit recorder；
3. 按路径稳定顺序对 FILE 调 `captureStableBytes()`，对 DIRECTORY 调增强后的
   `observeStableDirectory()`；
4. target mismatch → `AUTHORITY_SEAL_MISMATCH`；untouched mismatch → `AUTHORITY_TARGET_DRIFT`；
5. missing/symlink/FIFO/type/race failure按 target/untouched 归一化并保留安全 cause；
6. 不传播 partial seal，不 repair，也不在同一 capability 上 retry；
7. 成功返回可哈希 seal 与单独的 post-commit observed counters。

建议 seal 只承载物理事实：preflight/target/untouched/final projection hashes、actual ordered read set 与
`sealHash`。`operationRequestId`、pending record、predecessor 等 owner 字段留给 Plan03 组合。

## 8. Completed validator 收口方式

- 纯 completed validator 必须只接受 sealed indexes/records；不可选地回读 filesystem。
- mixed writer 模块可以继续包含合法写入和 pending/new 查询，但 completed pure logic 应委托给
  `authority/indexes.ts`（或同一 no-I/O closure）。
- 静态门检查纯模块的递归 import closure，不对整个 mixed writer 文件粗暴禁止 `files.ts`。
- 本轮至少关闭 semantic completed validator 的 optional raw fallback，并用 explicit indexed input。
- `transaction-lineage-integrity.ts` 的 archive/current-terminal 二读与 public retry 全链迁移记录为
  Plan03/04 接入项；不得在 Task3 报告中声称已经完成。
- `ensureSemanticMutationAudits()` 的逐事件读写属于 Plan08 exact ordered outbox，不在本轮改写。

## 9. TDD 顺序

### RED 1：typed directory

- 同名 file→directory 与 file→symlink 在旧 names-only observation 下 hash 不变。
- 增强后 typed hash/机器规则必须拒绝。
- directory add/remove/rename、mode-only、unknown type、读取竞态和 counter 恰好一次。

### RED 2：context phase/read-once

- 生产文件缺失的初始 compile RED。
- logical/archive 每条一次；unreferenced decoy/auxiliary 零读取。
- base clone/forge、二次 seal、capture 失败后 retry、late archive/source/helper rescan 均零 I/O 拒绝。
- sealed 后删除/改写源文件，所有 getter 仍返回冻结值且 preflight counters逐字不变。
- returned map/array/domain object/bytes runtime immutable；duplicate identities fail closed。
- frozen recovery branch 当前 source capture 为零；new branch capture 恰好一次。

### RED 3：machine seal

- file bytes、file mode-only、file→directory、missing、symlink、FIFO。
- directory add/remove/rename、directory mode-only、同名 node-type swap。
- untouched file bytes/mode 与 untouched directory inventory/mode drift。
- caller 无法遗漏 untouched row；target/untouched overlap 不可表达。
- child add/remove 未携 exact-owned parent target 时零 I/O 拒绝。
- verifier每个 row恰好一次真实读取，使用第二 recorder；context counters 不变。
- mismatch 后攻击态 bytes/mode/directory remains，证明无 repair；二次 verifier 零 I/O 失败。
- production machine-seal 源码禁止 `chmod/writeFile/rename/unlink/mkdir`。

### RED 4：pure validator/static closure

- pure index/validator closure 出现 `node:fs`、raw store reader、decision/flow store 或 transaction query
  helper 时失败。
- semantic completed validator 不提供 indexes 时 compile 或运行期 fail closed，不能 fallback rescan。
- `flow-assessment.ts` 7 条 P02 diagnostic 全部清零。

## 10. GREEN 与回归矩阵

Task3 不能把 repo-wide RED 描述为 GREEN。至少运行并记录：

- Task3 + 被扩展 Task2 文件的 focused strict `tsc --noEmit`。
- fresh 临时 emit 后 Task2/Task3 focused suites。
- Task1 provider `33/33`。
- Plan01 final suites `185/185`。
- diagnostic ownership `25/25`。
- native workflow gate `9/9`。
- recursive test discovery、package/version/pack surface。
- repo `typecheck` 与 `build`：预期从 `888/76` 下降到 `881/75`；Task3 文件 diagnostics `0`。
- transition P01 exit `0`；P02 仍因 Task4–5 open entries预期 exit `1`，但 past-owner 应从 `7/1`
  清到 `0/0`，`regressions=[]`。
- native provider artifact hash保持
  `05a9d0eddcd08e1fe9c1ee5d159b1833001b4c6f9cd2c19a8fcfa3ea9fceed99`。
- `git diff --check`；dependencies/lockfile/root/CLI/`src/execution/**` 无变化。

若 fresh 数字与上述期望不一致，先生成新的精确 ledger 并解释差异，不以断言、skip、类型强转或 baseline
改写吞掉。

## 11. 审查与完成定义

实现提交后依次进行：

1. 实现者自审与 fresh matrix。
2. 独立规格审查：重点检查 phase、read-once、Plan03 边界、typed directory、untouched complement 和
   post-commit 时序。
3. 独立防御性质量审查：重点检查 capability 伪造/重复消费、private backing、运行时内建替换、Proxy/
   accessor、FD cleanup、错误归一化与无 repair。
4. 任一审查 `CHANGES_REQUESTED` 时先 RED→GREEN 修复，再由独立 reviewer 复审。

只有两类审查都 `APPROVED` 且所有旧 finding 关闭后，Task3 才能在 progress 中标记完成。Task3 完成只
表示 context/physical seal foundation 完成，不表示 final global owner chain 或 public writer closure 完成。
