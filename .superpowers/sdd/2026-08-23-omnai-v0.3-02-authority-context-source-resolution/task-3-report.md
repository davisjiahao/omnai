# Plan02 Task 3 实施报告

> 当前状态：生产实现与实现者 fresh 验证已完成，等待独立规格审查和防御性质量审查。
>
> 本报告不构成 `APPROVED`，Task 3 尚未在总进度中标记最终完成。
>
> 实施基线：`b08dd3f`

## 结果

本轮建立了 final-v0.3 内部 `ChangeAuthorityContext`、纯冻结索引、typed directory inventory、
preflight `MachineAuthorityProjectionV1` 与独立 post-commit `MachineAuthoritySealV1`。同时关闭
`flow-assessment.ts` 的 7 条到期 P02 诊断，并把 semantic completed consumer 的 optional raw rescan
改成必须显式提供 inventory 的纯计算入口。

没有定义 `AuthorityEnvelope`、`AuthorityRecord`、Genesis、最终 receipt/owner chain、PENDING 持久对象、
request digest、predecessor 或 sequence；没有修改 Plan03/04 owner 文件、`src/execution/**`、root/CLI、
依赖、lockfile 或生产 native provider。

## 实施内容

### Typed directory inventory

- descriptor `readdir` 现在以一次真实调用同时取得 buffer name 与 `Dirent` node type。
- `ObservedDirectoryV1` 增加深冻结的 `typedEntries`；普通观察可保留 `UNKNOWN`、FIFO、socket、device 等
  物理事实。
- `inventoryHash` 按 UTF-16 code-unit 排序后的条目，对长度帧 UTF-8 name 和固定 node-type token 哈希。
- Task2 父目录与目标存在性检查同时比较 entry name 和预期 node type；同名 file→directory/symlink
  不再通过 names-only 观察。
- machine-owned exact directory 只接受 FILE/DIRECTORY child；`UNKNOWN`、symlink、FIFO 等均失败关闭。

### Context phase 与冻结索引

- `buildBaseContext()` 在第一次 `await` 前认证并深复制 caller target declaration；随后通过 awaited
  descriptor I/O 自行加载 verified catalog、固定 `workflow.lock.yaml`、Task2 base/final inventory 和
  final-v0.3 current domain records。
- builder 内部持有 Task2 base capability；调用方只得到 WeakMap-backed `BASE_AUTHENTICATED` handle。
  clone、structural forge、Proxy、重复 seal 和 capture 失败后的 retry 都在新 I/O 前拒绝。
- `sealForInspection()` 明确表示 frozen inspection/recovery，不捕获 current mutable source；
  `sealForNewMutation()` 是独立的一次 callback phase seam，并在异步 callback 前原子消费 base。
- SEALED context 的 metadata/tasks/Flow/Decision/Evidence/Run/progress/archive/transaction getter 只读取
  冻结内存；源文件删除或改写后结果与 preflight counters 均不变。
- Decision、Evidence、Run 公开 view 按身份 code-unit 排序；exact ID maps、Task map、event-kind、
  operation-request、archive `(RevisionId, logical key)` 和 transaction physical-capture maps 使用私有
  entry-array readonly map，不持有可取得的 backing `Map`。
- archive/transaction byte getter 每次返回 defensive copy；domain object、array、row 和 directory entry
  均深冻结。archive logical key 和 RevisionId 的 Proxy/accessor/非法标量在零 trap、零 I/O 下拒绝。
- 当前没有 final owner/receipt parser，因此 `finalizeAuthorityInventory()` 只消费空的已认证 receipt refs；
  legacy transaction 文件只保留为绑定 inventory hash 的 opaque physical capture，不标记为 chain row。

### Preflight projection 与 post-commit seal

- projection 行精确绑定 `(relativePath,nodeType,mode,rawBytesHash|inventoryHash)`，按 code-unit path
  唯一排序；FILE 固定 `0644`、DIRECTORY 固定 `0755`。
- `prepareCommitProjection()` 返回 WeakMap-backed、只消费一次的 capability。调用方只声明 target
  UPSERT/REMOVE；untouched complement 始终由完整 preflight projection 自动计算，无法由 caller 省略。
- child add/remove/node-type change 必须同时声明 exact parent DIRECTORY target；duplicate、unknown、
  wrong mode、forge、clone、Proxy 和 context mismatch 均在 verifier I/O 前拒绝。
- `verifyCommitSeal()` 先原子消费 prepared capability，再创建独立 recorder，按 expected final path
  稳定顺序逐行重开。target mismatch 归一为 `AUTHORITY_SEAL_MISMATCH`，untouched drift 归一为
  `AUTHORITY_TARGET_DRIFT`，同时保留安全 cause。
- verifier 不暴露 partial seal、不 retry、不 chmod、不写入、不删除、不 rename、不创建目录；攻击后的
  bytes、mode、missing、directory、symlink、FIFO 和目录拓扑均保持原状。
- post-commit seal 只包含物理 preflight/target/untouched/final hashes、actual ordered read set 和 seal hash，
  没有提前加入 operation owner、request、predecessor 或 sequence。

### Pure completed consumer 与 P02 诊断

- `authority/indexes.ts` 的递归 runtime import closure 不含 `node:fs`、raw files/path/store、Decision/Flow
  store 或 transaction query helper。
- `assertCompletedSemanticMutationLineage()` 不再接受 optional inventory，也不再漏传后回读磁盘；它只
  委托给 `assertCompletedSemanticMutationInventory()`。
- mixed writer 的 legitimate writes、pending/new query 和 outbox 仍留在原模块；没有用一个可选
  `context?` 伪装完整 public retry 已迁移。
- `flow-assessment.ts` 的 7 个 `getScenario()` 调用改为真实 await；P02 归属诊断从 `7/1` 清到 `0/0`。

## TDD 证据

1. 初始 Task3 测试先落盘；focused strict compile 真实 exit `2`。生产 RED 主要是 `TS2307`：
   `context-builder.js`、`context.js`、`machine-seal.js` 不存在，以及 `typedEntries` 尚不存在。期间一个
   测试自身误写的 `.then` 类型错误单独修正，没有把它计作生产缺口。
2. 第一轮实现后 focused suite 为 `46/47`：唯一失败来自测试期望 duplicate-index error，但生产在更早的
   Decision physical-key binding 已正确失败关闭。测试改为断言该更强边界；随后为 `61/61`。
3. typed directory、phase/read-once、machine drift、independent recorder、no-repair、pure closure、Proxy、
   private array/WeakMap intrinsic 等矩阵逐步扩展到 `66/66`。
4. 实现者自审新增 canonical ordering RED：旧实现受反转物理路径影响，为 `8 pass / 1 fail`，actual
   Decision 顺序为 `DEC-0002, DEC-0001`；纯索引改为 captured intrinsic 的 code-unit identity order 后
   同一 suite `9/9`。
5. 实现者自审新增 archive RevisionId Proxy RED：旧实现为 `8 pass / 1 fail`，在 framing 时触发
   `String.prototype.toString`，没有给出权限边界错误；增加零 trap scalar authentication 后同一 suite
   `9/9`。
6. 最终 fresh focused strict compile exit `0`；全新 `/tmp` emit 后 Task2+Task3 四文件 suite
   `67/67`，fail `0`。

## Fresh 验证

| 验证 | 最终结果 |
|---|---|
| Task2+Task3 focused strict `tsc --noEmit` | exit `0` |
| fresh focused emit 后四文件 suite | `67/67`，exit `0` |
| Task1 provider | `33/33`，exit `0` |
| Plan01 final 七文件 suite | `185/185`，exit `0` |
| diagnostic ownership | `25/25`，exit `0` |
| native workflow gate | `9/9`，exit `0`；workflow lock 残留 `0` |
| recursive test discovery | `5/5`，exit `0` |
| package/version/pack surface | `5/5`，exit `0` |
| repo `typecheck` | 预期 exit `2`；`881 diagnostics / 75 files`；Task3/flow/semantic `0` |
| repo `build` | native build 成功后预期 exit `2`；`881 / 75`；Task3/flow/semantic `0` |
| transition P01 | exit `0`；past/unowned/open `0/0/0`；`regressions=[]` |
| transition P02 | 预期 exit `1`；past `0/0`；open `31`；`regressions=[]` |
| npm pack dry run | exit `0`；`837` files；`.test.js` `105`（root `88`、module-local `17`） |
| pack hygiene | runner `1`、production addon `1`、provider testing artifacts `0`、package gate variants `0` |
| native provider artifact | `05a9d0eddcd08e1fe9c1ee5d159b1833001b4c6f9cd2c19a8fcfa3ea9fceed99` |
| diff hygiene | `git diff --check` 通过；依赖/lockfile/root/CLI/`src/execution/**`/provider 生产源码无变化 |

pack 从 Task2 的 `819` 增至 `837` 是预期差异：新增 4 个生产模块的 JS/d.ts/maps 共 `12` 个 artifact，
两个 module-local compiled tests，以及对应 test declaration/source-map variants；发布 gate 仍排除 provider
testing controls 和 package-version gate 自身。

## 已知边界与后续 owner

- packaged final catalog 尚未发布时，生产 `requireVerifiedAuthorityCatalog()` 继续 fail closed；测试只使用
  Plan01 已批准的 generation lease，不增加 Task3 testing seam。
- `sealForNewMutation()` 当前只证明 phase callback 被调用一次、base 在 callback 前消费；它不声称已完成
  Task4 六类 strict SourceRef/current capture，也不把 callback 结果或 callback 内 I/O 冒充已认证 source。
  Task4 必须以真实 resolver/capture 取代该 phase seam。
- raw `containedRoot` 与 logical target construction 仍是非 root-export 的内部过渡输入。Plan04 必须用
  repository identity、exact lock 和 opaque `ResolvedChangeHandle` 取代它；本轮没有提前创建该 handle。
- 当前没有 final receipt/AuthorityRecord/Genesis Schema，所以 auxiliary receipt 集合只能为空，transaction
  只能是 opaque physical capture；Plan03 负责在固定顺序的 parse 与 finalize 之间增加真实 chain parser。
- `transaction-lineage-integrity.ts`、`flow-terminal-authority.ts`、Decision/ordinary/Scenario public retry 的
  completed/current-terminal 二读仍由 Plan03/04 接入；`ensureSemanticMutationAudits()` 的逐事件 outbox
  读写归 Plan08。本报告不声称这些链路已零 I/O。
- preflight projection 是本轮 context 已声明 inventory 的 exact machine manifest。新增/删除 child 还必须
  携 exact-owned parent target；没有 contained-root directory row 的顶层拓扑变化失败关闭。Plan04 的最终
  writer target compiler 将进一步用 opaque handle/catalog token 生成 mutations，而不是开放 raw path。

## Fix Round 1：确定性、不变性与 API 边界

### 根因与修复

1. `context.ts` 为了让 builder 登记 WeakMap state，直接导出了
   `createAuthenticatedBaseContextHandle()`。现将 base 与 sealed lifecycle 共置到唯一
   `context-builder.ts`，mint/consume 均为模块私有函数；`context.ts` 只转出 seal/verifier runtime API，
   两个 runtime module surface 都不能直接 mint 或抽取 authenticated base state。
2. 目录名使用默认 `TextDecoder`，会把 entry bytes 开头的 UTF-8 BOM 解码状态误用于物理文件名，吞掉
   U+FEFF。现使用初始化时固定的 decoder/`decode` primitive 与 `ignoreBOM: true`，保留 U+FEFF 身份数据；
   `a` 与 `U+FEFF+a` 的 typed inventory/hash 不同，rename 后 terminal seal 报 mismatch。
3. new-mutation callback 返回后，context 与 observed-I/O snapshot 仍动态查找 `Object.freeze`。现将
   context builder、indexes、machine seal、observed-I/O 与 stable capture 所需 freeze primitive 全部在
   模块初始化时固定；callback 或 caller 后续替换全局属性不能观察或软化 SEALED backing。
4. prepared commit 的 context identity 检查先于消费，wrong-context 失败后同一 handle 仍可成功重用。
   现先以 WeakMap 确认真实性并立即设置 consumed，再验证 context identity；第二次调用在创建 recorder
   或任何 I/O 前返回 `AUTHORITY_PREPARED_COMMIT_CONSUMED`。
5. semantic completed consumer 直接接受 caller `eventsByMutationId` Map。现新增 WeakMap-authenticated
   `SemanticMutationLineageViewV1`：从一次深复制、深冻结的 events capture 内部派生私有 correlation，
   completed consumer 只接受登记 view；caller Map、Proxy、clone 与结构伪造均不能成为真实性来源。
6. 三个模块的 readonly-map/private rows 仍会传给运行时替换的 `Object.freeze`，stable bytes 还直接传给
   动态 `hash.update`。现全部使用初始化时固定的 freeze/Hash update/digest primitive；测试在 import 后
   替换 primitive，确认 hook 得不到 indexes、seal、counter backing 或 stable private bytes。
7. `targetSetHash` 按 caller mutation 顺序哈希。现先按 `relativePath` 的 UTF-16 code-unit order
   canonicalize target tokens；另补 child add/remove/node-type 三个携正确 parent DIRECTORY target 的
   正向测试，parent/现存 child 或新 child 均保持 exact-once terminal observation。
8. 已把“第一次 await 前 descriptor authenticate”的不准确表述改为“第一次 await 前认证并深复制 caller
   declaration，随后执行 awaited descriptor I/O”。

### RED → GREEN 证据

- RED compile：四个 Task2/Task3 test 文件 focused strict `tsc --noEmit`，exit `0`，证明 RED 不是测试
  编译错误。
- RED runtime：fresh `/tmp` emit 后运行四文件，`81` tests 中 `68 pass / 13 fail`。失败精确覆盖 direct
  mint、callback freeze、semantic view、indexes backing、U+FEFF observation/terminal seal、target hash
  顺序、machine/observed backing、stable hash update 与 wrong-context consume；child add/remove/node-type
  三个正向用例在旧生产实现上已通过。
- GREEN runtime：同一 focused strict compile exit `0`；另一全新 `/tmp` emit 后 `81/81`，fail `0`。
- semantic completed consumer：对 build emit 运行 focused behavior gate，证明 empty caller Map 不能隐藏
  captured event，伪造 non-empty Map 不能补足 empty captured events，exit `0`。

### Fix Round 1 fresh matrix

| 验证 | 结果 |
|---|---|
| Task2+Task3 focused strict compile | exit `0` |
| fresh focused emit 四文件 suite | `81/81`，exit `0` |
| semantic completed consumer behavior gate | exit `0` |
| private native test-harness build / Task1 provider | exit `0` / `33/33` |
| Plan01 final suite | `185/185`，exit `0` |
| diagnostic ownership | `25/25`，exit `0` |
| native workflow gate | `9/9`，exit `0`；workflow lock 残留 `0` |
| recursive test discovery | `5/5`，exit `0` |
| package/version/pack surface | `5/5`，exit `0`；pack `837` files、tests `105`（root `88`、module-local `17`） |
| repo `typecheck` | 预期 exit `2`；`881 diagnostics / 75 files`；Task3/flow/semantic `0` |
| repo `build` | native build 成功后预期 exit `2`；`881 / 75`；Task3/flow/semantic `0` |
| transition P01 | exit `0`；past/unowned/open `0/0/0`；`regressions=[]` |
| transition P02 | 预期 exit `1`；past `0/0`；open `31`；`regressions=[]` |
| native provider artifact | `05a9d0eddcd08e1fe9c1ee5d159b1833001b4c6f9cd2c19a8fcfa3ea9fceed99` |
| pack hygiene | runner `1`、production addon `1`、provider testing artifacts `0`、package gate variants `0` |
| diff hygiene | `git diff --check` 通过；依赖/lockfile/root/CLI/`src/execution/**`/provider 生产源码无变化 |

Fix Round 1 实现 commit SHA：`3ed8955694cf4451cbba25eef7067b9336d84d04`。除原报告已登记的
Plan03/04/08 owner 接入项与 repo-wide 迁移基线外，无新增 concern。

## 实现者自审

- canonical ordered Decision/Evidence 与 archive RevisionId Proxy 两项自审 finding 均已按真实
  RED→GREEN 关闭。
- allowed-file、pure import closure、WeakMap single-use、untouched complement、independent recorder、
  no-repair、Proxy/accessor、deep freeze/defensive copy、动态生产 `.push(` 和 testing seam 扫描均未发现
  未关闭的本轮 blocker。
- 实现者自审不是独立批准。下一步必须分别执行规格审查和防御性质量审查；任一
  `CHANGES_REQUESTED` 都须新增 RED、修复并由独立 reviewer 复审，之后才能更新为最终 `APPROVED`。
