# SDD ledger — plan: docs/superpowers/plans/2026-08-23-omnai-v0.3-02-authority-context-source-resolution.md

# Plan02 SDD 进度台账

## 执行身份

- 工作区：`/workspace/scratch/390b31f21497/omnai-v0.3-native-pipeline-convergence`
- 分支：`feat/omnai-v0.3-native-pipeline-convergence`
- Plan02 基线：`b4c12c15ab74a3a5063ebcf3ae70e7308241b604`
- 执行计划：`docs/superpowers/plans/2026-08-23-omnai-v0.3-02-authority-context-source-resolution.md`
- 状态：Task 1–Task 4 已完成并通过最终独立复审；Task 5 未开始。

## 绑定资料与优先级

1. `docs/superpowers/specs/2026-08-27-omnai-v0.3-native-pipeline-convergence-design.md`
2. `docs/superpowers/plans/2026-08-27-omnai-v0.3-native-pipeline-convergence.md`
3. `docs/superpowers/plans/2026-08-23-omnai-v0.3-01-native-schema-catalog.md`
4. `docs/superpowers/plans/2026-08-23-omnai-v0.3-02-authority-context-source-resolution.md`
5. 与 final-v0.3 兼容的 `docs/superpowers/specs/2026-08-22-omnai-v0.3-change-authority-integrity-repair-design.md` 不变量。

Plan02 所称“主规范第 20 节”等原始资料在当前仓库不可达，故不得凭空补写。发生歧义时按上述优先级裁决，并把未决项留在台账。

## 已验证进入门

- Plan01 聚焦测试：185/185 通过。
- 诊断归属聚焦测试：25/25 通过。
- P01 transition gate：888 diagnostics / 76 files；past-owner=0、unowned=0、regression=0；Execution=109/8。
- 17 个跨计划重叠均已有显式归属。
- P09 零诊断门仍因 337 个 open ownership entries 预期失败。
- Plan02 进入门预期为 RED：pastOwner=7/1、openOwnership=31；这些是本计划应逐任务消化的归属债务，不是用断言隐藏的失败。
- `codegraph` 在环境中不可用；依赖面调查退回只读 `rg` 与 Git，禁止因此扩大任务范围。

## 预检裁决

| 冲突面 | 裁决 |
|---|---|
| 旧 0.2/中间模型与 final-v0.3 | 收敛设计和 Plan01 final catalog 优先；不得重引入旧 Schema。 |
| 全仓当前 888 条诊断与任务验证 | Plan07 前采用 focused compile/tests + transition owner gate；不得宣称全仓绿色。 |
| Plan01 catalog 注入/外部门 | final catalog 的测试注入和外部 native gate 均保持关闭。 |
| Task 1 Git provider | 只允许 native fixed-candidate FD provider；无 JS fallback、PATH、调用方路径选项或公开 adapter。 |
| Task 4 SourceRef | 复用 domain 的严格 SourceRef union，不建立第二套公共类型。 |
| Task 5 公共面 | 只建立 Core public facade；root/CLI 导出留到 Plan07。 |
| native 构建 | 保留 `binding.gyp`；因环境无 node-gyp，可由脚本直接调用固定编译器和系统头，不新增依赖。 |
| provider 持久化边界 | `RepositoryWorkBasis` 等公共/持久对象不得含 provider 字段；仅规范闭合的 owner/payload 可保存 binding。 |

## 任务状态

| Task | 状态 | 提交 | 审查 | 备注 |
|---|---|---|---|---|
| 1. VERIFIED_FD_EXECVEAT_V1 provider | 已完成 | `bc275dc`、`66d2d5a`、`ecf9b14`、`078566c`、`5267e11` | round 3 最终独立复审 `APPROVED` | I1–I5、N1 与 packed runner 兼容问题全部关闭；最终审查 `0 Critical / 0 Important / 0 Minor`。 |
| 2. observed I/O / inventory | 已完成 | `2eac376`、`0b45bc1`、`b07c38c` | 规格与质量最终复审均 `APPROVED` | focused `36/36`；全部旧 finding 关闭，最终新增 `0 Critical / 0 Important / 0 Minor`。 |
| 3. ChangeAuthorityContext / seal | 已完成 | `b3bafe8`、`3ed8955`、`248a110` | fix round 1 scoped re-review `APPROVED` | 9/9 finding 全部关闭；无新增 Critical/Important/Minor；未提前实现 Plan03 chain/Genesis。 |
| 4. strict SourceRef | 已完成 | `5616a70`、`806785b` | fix round 1 scoped re-review `APPROVED` | 4/4 blocking finding 关闭；复用 domain union；1 项 Minor 留待 Plan02 final review 分流。 |
| 5. linkage / Core facade | 未开始 | — | — | 不提前进入 root/CLI。 |

## Task 1 完成证据要求

- 真实 RED：native target/module/provider 缺失或新增 gate 按预期失败。
- fresh `npm run build:native`。
- focused TypeScript compile / build 与 provider 测试。
- 对应 Plan02 transition owner gate。
- 源码扫描确认无 `execFile`、`spawn`、shell、PATH 或 pathname Git fallback。
- 打包检查确认 `.node` 通过 `dist` 进入包；不得新增依赖。
- 实现者自审、独立规格/质量审查均通过后，Task 1 才可标记完成。

## Task 1 当前 RED 证据

- 2026-08-27 在 `b4c12c15ab74a3a5063ebcf3ae70e7308241b604` 干净代码基线先写入 provider gate 与竞态 harness 测试；生产实现尚未创建。
- `npm_config_offline=true /opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/npm run build:native`：退出 `1`，精确原因为 `Missing script: "build:native"`。
- 当前 `npm run build -- --pretty false` 的 Task 1 新增失败为 `TS2307`：`../native-binding.js` 与 `../provider.js` 均不存在；全仓其余诊断仍是进入门已记录的迁移债务。
- 环境裁决：`unshare -Ur true` 与 `unshare -m true` 均以 `Operation not permitted` 失败；测试因此采用同一 C 源的私有构建期固定候选 harness。生产候选仍只能是 `/usr/local/bin/git`、`/usr/bin/git`，私有 addon 只能写入临时目录且不得进入 `dist` 或 npm pack。

## Task 1 后续 RED 与自审修正

- strict unknown-key 测试首次执行退出 `1`，原因为 native `execute` 接受了额外候选位置字段并出现 `Missing expected exception`；随后把 native 输入收紧为精确 own keys `repositoryRoot`、`args`。
- fd 回收测试首次执行退出 `1`，实际 `/proc/self/fd` 从 `20` 增长到 `32`；随后统一收拢 overflow、timeout、wait failure 的父进程 pipe 关闭路径。
- 最终自审新增“直接 child 已结束但 descendant 仍持 pipe”场景；修正前约 `619 ms` 后返回成功并报 `Missing expected exception`，修正后约 `215 ms` 以 `VERIFIED_PROVIDER_WAIT` 拒绝。总超时现同时约束 child 与全部 pipe 生命周期，且已回收 child 的 PID 不会再次被 `kill`。
- native embedded-NUL 测试首次执行退出 `1` 并报 `Missing expected exception`；N-API 字符串当时会在 argv 边界被静默截断。通用 native 字符串读取器现于调用 `execveat` 前拒绝 embedded NUL。

## Task 1 fresh 完成证据（2026-08-27）

- `npm run build:native` 连续两次成功，`dist/native/verified_fd_provider.node` 两次 SHA-256 均为 `0446bb385e2784d287be5bbbc0e00c8ef5ea01743ef9e8278bd795a7a50197a5`。
- Task 1 五文件 focused TypeScript compile：通过；provider 测试：`23/23` 通过。
- Plan01 final schema/catalog/compiler 聚焦套件：`185/185` 通过；诊断归属套件：`25/25` 通过；相关 native workflow gate：`9/9` 通过。
- repo-wide `typecheck` 与 `build` 均按基线退出 `2`、`888 diagnostics / 76 files`，其中 `src/core/git-provider/**` 新诊断为 `0`，未以断言掩盖迁移债务。
- P01 transition owner gate：退出 `0`，past-owner `0/0`、unowned `0/0`、open ownership `0`、regressions `[]`；P02 完整门因 Task 2–5 尚未实施而按预期退出 `1`，past-owner `7/1`、open ownership `31`。
- 生产源码禁用模式扫描无 `execFile`、`spawn`、shell、`PATH` 或 pathname fallback；执行族只有 `execveat(3, "", ..., AT_EMPTY_PATH)`，动态执行符号也只有 `execveat@GLIBC_2.34`。
- `strace` 因运行环境 `PTRACE_TRACEME: Operation not permitted` 无法使用；替代证据由源码/符号扫描和恶意替换 sentinel race 测试共同提供，限制已在 Task 1 报告记录。
- `npm pack --dry-run --json` 包含 `dist/native/verified_fd_provider.node`，私有 test addon/fixture 为 `0`；`ldd` 仅链接 `libc`，无 RPATH/RUNPATH、无新增依赖，`package-lock.json` 未变化。

## Task 1 独立审查 round 1 修复

- I1：真实无 writer FIFO 证明旧 `O_RDONLY openat2` 可越过 500 ms bound；现以 `O_NONBLOCK` 打开并由 metadata gate 在约 52 ms 拒绝。
- I2：测试态持续 drain marker 证明旧 overflow 路径约 531 ms 不返回；现首次 overflow 立即回外层做 group cleanup，约 58 ms 返回 output-limit。
- I3：隔离构建 `HEAD` 旧 provider 后，descendant 在 provider timeout 返回后仍写入 sentinel，真实 RED；现 start barrier + 独立 process group，pipe 未闭合前保留 group leader，所有 overflow/timeout/wait failure 先杀组再 reap，sentinel GREEN。
- I4：waitpid EINTR 原返回 errno `4`，error record EINTR+partial 原被丢弃；现 exact write、EINTR-safe wait/reap、first errno 保存，结果字节/errno/reap identity 全绿。
- I5：raw native 与 TypeScript hidden/symbol own key 原被忽略；现 Node-API v6 all-own API 与 `Reflect.ownKeys` 一致收紧，dense args 精确允许 `length + 0..n-1`，其余 own key fail closed。
- 首次完整 suite 的旧 PID-only `/proc` 断言无法区分未回收与 PID reuse，未将重复通过视为结论；现记录 PID + starttime + 真实 waitpid reap PID，同一 child 身份仍存在必失败。
- 真实 non-root `chown` 在当前 `/tmp` 文件系统返回 `EINVAL`，已记录后使用 testing-only fallback；world-writable 使用真实 chmod。

round 1 fresh：native 双构建 hash `cb152aaeb07933ad7b9200ea14cbb9dbd016f1d26a240ac4b95977fa0fa51cd2`；provider `30/30`、Plan01 `185/185`、ownership `25/25`、native workflow `9/9`；typecheck/build 均保持基线 `888/76` 且 provider `0`；P01 exit `0`、P02 按 Task 2–5 未实施 exit `1`；analyzer/linkage/symbol/strings/pack/diff checks 通过。Task 1 继续等待控制器复审，不开始 Task 2。

## Task 1 独立审查 round 2 修复

- 复审结果为 `0 Critical / 1 Important`：旧逻辑在 pipes 全闭后用 `waitpid(WNOHANG)` 提前 reap leader，signal failure 与 normal-exit postcheck failure 都可能让 closed-pipe descendant 在 provider 返回后继续。
- RED A：signal-terminated leader 精确返回 WAIT 且 leader identity 已 reap，但延迟 sentinel 存在。RED B：受控 normal leader 触发精确 REOPEN_AND_COMPARE 且 leader已 reap，但 postcheck sentinel 存在。
- 现以 `waitid(P_PID, ..., WEXITED | WNOHANG | WNOWAIT)` EINTR-safe 非回收观察并严格分类 `CLD_EXITED` 与 signal termination；所有 failure 先杀 group 后 exact reap。normal path 也先终止 residual group，再 postcheck，最后 exact reap；all-pipes-closed/live leader 仍受同一 deadline。
- A/B 与额外 normal-success residual-group 测试均在 500 ms 返回后观察窗证明 sentinel 不存在，PID + starttime + reap record 证明 direct leader 回收；waitid + waitpid 双 EINTR 与 exec setup exact errno/reap 同场保持 GREEN。

round 2 fresh：native 双构建 hash `05a9d0eddcd08e1fe9c1ee5d159b1833001b4c6f9cd2c19a8fcfa3ea9fceed99`；provider `33/33`、Plan01 `185/185`、ownership `25/25`、native workflow `9/9`；typecheck/build 保持基线 `888/76` 且 provider `0`；P01 exit `0`、P02 按 Task 2–5 未实施 exit `1`；analyzer/source/ABI/strings/linkage checks 通过。原 pack check 只证明 private native harness 不进入包，未检查 `dist` 内 compiled tests，后续复审 N1 已取代该结论。

## Task 1 round 2 pack hygiene 补充修复

- 复审状态曾更新为 `ROUND 2 CHANGES REQUESTED / FIX PENDING`：`package.json.files` 整体包含 `dist`，使 provider test/harness/maps 及 waitid/sentinel testing strings 进入 npm pack。
- 新 package-surface gate 对真实 `npm pack --dry-run --json` 最终清单及内容做断言。RED 为 813 files、315 个 compiled test artifacts、6 个 provider test/harness artifacts，并检出 testing marker/sentinel。
- allowlist 最小增加 `!dist/test/**` 与 `!dist/src/**/test/**`。GREEN 为 498 files；production addon 精确 `1`，private/test addon、compiled tests、provider harness/maps 与 marker/sentinel leaks 全部 `0`；index/main/provider runtime JS/d.ts/maps 保留。
- fresh：native 双 hash `05a9d0eddcd08e1fe9c1ee5d159b1833001b4c6f9cd2c19a8fcfa3ea9fceed99`；provider `33/33`、Plan01 `185/185`、ownership `25/25`、native workflow `9/9`、package-version `5/5`；typecheck/build 基线 `888/76` 且本轮文件 diagnostics `0`；P01 exit `0`、P02 预期 exit `1`；analyzer/source/symbol/exports/strings/linkage/diff checks 通过。

Task 1 round 2 finding 已修复待复审，不开始 Task 2。

## Task 1 独立审查 round 3 packed runner 兼容修复

- round 3 I1 指出 broad `!dist/test/**` / `!dist/src/**/test/**` 让已打包 runner 的递归 manifest 变为 `0`，违反 Plan01 保留 root 与 module-local 两族 `.test.js` 的合同；N1 的 provider testing controls 不进包约束继续有效。
- RED：真实 final pack 为 `498` files，runner 存在，但 root/module-local/total `.test.js` 均为 `0`，扩展 gate 精确报 `packed root test layout is missing`。
- 修复：发布清单只排除 `dist/src/core/git-provider/test/**` 与含 marker 字面量的 `dist/test/package-version.test.*`。GREEN final pack 为 `804` files，root tests `88`、module-local tests `13`、总 tests `101`；稳定代表文件与 runner 均存在。
- N1 hygiene 仍为 GREEN：provider test/harness JS/d.ts/maps、package-version compiled variants、private/test addon、全 pack waitid/waitpid/A/B/success/timeout/overflow/setup/PID marker leaks 均为 `0`；production addon 精确 `1`，runtime JS/d.ts/maps 保留。
- fresh：native 双 hash `05a9d0eddcd08e1fe9c1ee5d159b1833001b4c6f9cd2c19a8fcfa3ea9fceed99`，private/focused compile 通过；test-discovery `5/5`、package-version `5/5`、provider `33/33`、Plan01 `185/185`、ownership `25/25`、native workflow `9/9`；typecheck/build 保持基线 `888/76` 且 Task1 `0`；P01 exit `0`、P02 预期 exit `1`；analyzer/source/symbol/exports/strings/linkage/pack/diff checks 通过。

Task 1 round 3 finding 已修复并通过最终独立复审。

## Task 1 最终独立复审（2026-08-27）

- scoped 范围为 `078566c97af0b8ad7840dee16398cbbf9b67657c..5267e1177f3b47e725420cf3c76aa73f5a8d7cb5`，审查结论为 `APPROVED`，新发现 `0 Critical / 0 Important / 0 Minor`。
- I1 已关闭：fresh final pack 为 `804` files，runner `1`，root tests `88`、module-local tests `13`、总 `.test.js` `101`；对实际 `dist` 清单逐项比对后 unexpected exclusions 为 `0`。
- N1 继续关闭：provider test/harness、package-version compiled variants、private/test addon 与全部约定 control/sentinel 内容命中均为 `0`；production addon 精确 `1`，runtime exports/bin/JS/d.ts/maps 保留。
- fresh targeted 复审：package-version `5/5`、test-discovery `5/5`；reviewer 独立核对真实 npm pack 清单、逐文件内容、精确 negation 语义、依赖/lockfile 与范围卫生。
- Task 1 正式关闭；Task 2 可按独立 brief 开始，不得回写 Task 1 的公开/持久边界。

## Task 2 初始实现证据（2026-08-27）

- 初始 RED 在生产文件不存在时真实执行：focused strict compile 以 `TS2307` 报告
  `observed-io.js`、`stable-bytes.js`、`inventory.js` 缺失。目录 seam、伪造 recorder、request
  accessor/extra key 与未引用 auxiliary collision 的后续 RED 也都先于对应生产修正。
- 初始实现 focused strict compile exit `0`；全仓 build 产物上的 Task2 suite `22/22`，覆盖真计数/顺序、
  decoy、file/directory symlink、FIFO、nested swap、bytes/mode/rename/entry race、UTF-16、FD cleanup、
  immutable map/bytes/inventory 与 logical/archive/receipt 冲突。
- fresh 回归：provider `33/33`、Plan01 `185/185`、ownership `25/25`、native workflow `9/9`。
- repo typecheck/build 都保持已登记基线 `888 diagnostics / 76 files`，Task2 文件 diagnostics 为 `0`；
  native artifact hash 仍为 `05a9d0eddcd08e1fe9c1ee5d159b1833001b4c6f9cd2c19a8fcfa3ea9fceed99`。
- transition P01 exit `0`，past/unowned/open 均为 `0`；P02 因 Task3–5 尚未实施按预期 exit `1`，
  past `7/1`、open `31`，两者 `regressions=[]`。
- `inventory.ts` 无原始 fs import；没有 Task3、root/CLI export、依赖或 lockfile 变化。
  详细 API、TDD 和风险见 `task-2-report.md`。

## Task 2 独立审查 round 1（2026-08-27）

- 规格审查与防御性质量审查均为 `CHANGES_REQUESTED`；当前 Task 2 不得标记完成，也不得开始 Task 3。
- Important：当前单阶段 API 要求 inventory 读取前已有 `verifiedReceiptReferences`，与 Task 3 固定
  `inventory → chain/payload` 顺序矛盾；须改为基础 inventory 与辅助目标 finalize 两阶段，基础 capture
  不得重读。同一 receipt 不得被猜测为只能引用一个辅助目标，重复判定应落在精确 reference/target 上。
- Important：`FrozenReadonlyMap` 与 `StableByteCaptureV1.copyBytes()` 的底层状态仍可受运行时可变内建
  影响；须改为不向可替换内建传递私有 backing state 的实现，并增加回归测试。
- Important：observed counter 的写入口不得作为独立生产 mutator；须由执行真实 open/readdir/capture 的
  封装更新。stable/inventory 请求在任何 prototype/key/descriptor 反射前须拒绝 Proxy。
- Minor：测试专用 seam 不得成为发布 API；补充 inventory `DIRECTORY` target 正例。

## Task 2 round 1 修复（2026-08-27，待独立复审）

- 完整新增回归在 `2eac376` 旧生产实现上真实 RED：首批 `26` 项为 `22 pass / 4 fail`，暴露 Proxy、
  Map prototype、裸 counter mutator 与可替换 byte-copy helper；完整测试随后以 focused compile exit `2`
  暴露两阶段 API 缺失及 production testing seam 仍存在。
- inventory 已改为 `buildAuthorityInventoryBase()` + `finalizeAuthorityInventory()`：WeakMap-backed base
  capability 不可伪造、只消费一次；base capture 零重读，shared parent 与 identity observation 跨阶段复用，
  新 auxiliary parent 只读一次。相同 receipt 多目标与不同 receipt 共享目标合法，只有 exact duplicate、
  unknown、target/path conflict 在 auxiliary I/O 前拒绝。
- map/counter/base 私有 backing 使用 entry array；WeakMap 操作绑定模块初始化 intrinsic。`copyBytes()`
  使用捕获的 `Uint8Array` 构造器逐索引复制。隔离 child 覆盖运行期替换 Map/WeakMap prototype 与全局
  Uint8Array；stable/inventory 各层 Proxy 在任何反射前拒绝。
- 已删除裸 counter mutator 与全部生产 `*WithInternalSeamForTesting` 导出；真实 final open/readdir wrapper
  自持计数。竞态测试在隔离 child 中替换并恢复 builtin，同时仍调用真实 `FileHandle` syscall。
- DIRECTORY target 正例以显式 `0750` mode 验证 entries/hash、`observedDirectories` 同一 observation，且
  map 在运行时不可变。
- fresh：focused strict compile exit `0`；Task2 `33/33`、provider `33/33`、Plan01 `185/185`、ownership
  `25/25`、native workflow `9/9`、test-discovery `5/5`、package-version `5/5`。final pack 为 `819` files，
  root tests `88`、module-local tests `15`，runner、两种 test layout 与 Task2 发布入口均存在。
- repo typecheck/build 仍精确为预期 `888 diagnostics / 76 files`、Task2 diagnostics `0`；P01 exit `0`，
  P02 按既有 `7/1` 与 open `31` 失败关闭，均 `regressions=[]`；native artifact hash 保持
  `05a9d0eddcd08e1fe9c1ee5d159b1833001b4c6f9cd2c19a8fcfa3ea9fceed99`。
- 当前仅标记“修复完成待独立复审”；Task 2 未最终批准，Task 3 未开始。

## Task 2 round 2 质量修复（2026-08-27，待独立复审）

- round 2 规格复审为 `APPROVED`；质量复审坐实 I2/I3 尚未完全闭合，Task 2 整体仍不得标记批准。
- 严格 TDD RED 基于 `0b45bc1` 旧生产实现：focused strict compile/emit exit `0`，两个 suite 为
  `36 tests / 33 pass / 3 fail`。替换后的 `Array.prototype.push` 取得 counter、directory、identity、
  handles、anchors、readonlyMap、inventory 七类私有 receiver；`Uint8Array.prototype.length` getter 被
  `copyBytes()` 读取 `5` 次；callable 自有 `call` 截获 readonly map `forEach()`。
- 三个生产模块均在初始化时捕获 `Array.prototype.push` 与 `Reflect.apply`，全部私有数组写入改走捕获
  intrinsic；生产 `.push(` 扫描为零。`copyBytes()` 分配与循环只使用认证标量 `total`；`forEach()`
  使用捕获 `Reflect.apply`，不读取 callback 自有 `.call`。
- 隔离 child 均在 `finally` 恢复被替换内建并清理 fixture；GREEN focused strict compile/emit exit `0`，
  同一套件 `36/36`。
- fresh：provider `33/33`、Plan01 `185/185`、ownership `25/25`、native workflow `9/9`、test-discovery
  `5/5`、package-version `5/5`；workflow lock 未残留。repo typecheck/build 保持预期 `888/76` 且
  Task2 diagnostics `0`；P01 exit `0`，P02 按既有 past `7/1`、open `31` 失败关闭，均无 regressions。
- final pack 仍为 `819` files、root tests `88`、module-local tests `15`；runner、两种 test layout、Task2
  生产/测试入口齐全，production testing seam 扫描为零。native artifact hash 保持
  `05a9d0eddcd08e1fe9c1ee5d159b1833001b4c6f9cd2c19a8fcfa3ea9fceed99`。
- 当前仅标记“round 2 质量修复完成待复审”；规格批准不等于 Task 2 整体批准，Task 3 未开始。

## Task 2 最终独立复审（2026-08-27）

- round 1 规格复审范围 `2eac376..0b45bc1` 最终为 `APPROVED`；两阶段 base/finalize、receipt
  多目标/共享目标、DIRECTORY 与跨阶段 identity/read-once 均关闭，新增 `0/0/0`。
- round 2 无回归规格复审范围 `0b45bc1..b07c38c` 为 `APPROVED`；focused strict compile 与独立
  临时 emit 后 Task2 suite `36/36`，两阶段与持久语义未改变。
- round 2 质量最终复审为 `APPROVED`：私有 array backing、typed-array `length` 与 `forEach` Call
  三项全部 `CLOSED`；生产 testing seam、裸 counter mutator 与动态 `.push(` 扫描均为零。
- 最终质量复审新增 `0 Critical / 0 Important / 0 Minor`；fresh pack `819` files、root tests `88`、
  module-local tests `15`，runner 与 Task2 生产/测试布局完整，依赖/lockfile/root/CLI diff 为零。
- Task 2 正式关闭；生成的 `task-2-review-package.md` 已删除，不进入提交。Task 3 可按独立 brief 开始。

## Task 3 初始实施证据（2026-08-27，待独立审查）

- Task3 初始 focused compile 真实 exit `2`：缺少 `context-builder/context/machine-seal` 生产模块且
  `typedEntries` 尚不存在；没有把一个已修正的测试 `.then` 误写计作生产 RED。
- 实现已建立 name+nodeType directory hash、WeakMap single-use base/prepared capability、自加载
  catalog/WorkflowLock/records 的 builder、SEALED 零 I/O getter、冻结 identity/event/archive/transaction
  indexes、preflight projection 与独立 second-recorder post-commit seal；verifier 自动求 untouched
  complement，失败不 repair、不 retry、不传播 partial seal。
- semantic completed consumer 已删除 optional raw fallback；pure indexes 递归 runtime import closure 不含
  fs/raw store/query helper。`flow-assessment.ts` 7 条到期 P02 诊断已清零；没有触碰 Plan03/04 owner、
  execution、root/CLI、依赖、lockfile 或生产 provider。
- 实现者自审的两个追加 finding 均按真实 RED→GREEN 关闭：反转物理路径时 ordered Decision/Evidence
  为 `8/9` 后转 `9/9`；archive RevisionId Proxy 触发 trap 时为 `8/9` 后转 `9/9`。
- final fresh：focused strict compile exit `0`，Task2+Task3 `67/67`；provider `33/33`、Plan01 `185/185`、
  ownership `25/25`、native workflow `9/9`、test-discovery `5/5`、package-version `5/5`。
- repo typecheck/build 精确为预期 `881 diagnostics / 75 files`，Task3/flow/semantic diagnostics `0`；
  P01 exit `0`，P02 按 Task4–5 open `31` 预期 exit `1`，past `0/0`、`regressions=[]`。
- final pack `837` files，tests `105`（root `88`、module-local `17`），runner/addon 各 `1`，provider testing
  与 package gate variants 均 `0`；native artifact hash 保持
  `05a9d0eddcd08e1fe9c1ee5d159b1833001b4c6f9cd2c19a8fcfa3ea9fceed99`。
- 当前仅为“实现与实现者 fresh matrix 完成，待独立规格/质量审查”；不得标记 Task3 最终完成或
  `APPROVED`。完整证据、边界和后续 owner 见 `task-3-report.md`。

## Task 3 独立审查 round 0（2026-08-28，CHANGES_REQUESTED）

- 规格与质量结论均未批准：`3 Critical / 3 Important / 3 Minor`；Task 3 不得标记完成，也不得开始 Task 4。
- Critical：`context.ts` 导出 mint 函数，使内部调用方可用伪造 state 获得 WeakMap 登记的 base capability；
  默认 `TextDecoder` 去除 UTF-8 BOM，导致 `a` 与 `\\uFEFFa` 的 typed directory hash 碰撞；request callback
  可替换实时 `Object.freeze`，使随后登记的 SEALED context 可变。
- Important：prepared capability 在 context mismatch 前未消费，违反失败后不可 retry；semantic mutation
  correlation index 未从单次捕获 events 内部派生，仍接受 caller `ReadonlyMap`；多个 authority 模块仍把
  private backing 交给运行时可替换的 `Object.freeze`/hash update intrinsic。
- Minor：target set hash 未 canonicalize caller mutation 顺序；缺少携正确 parent target 的 child topology
  正例；实施报告“第一次 await 前 descriptor-authenticate”与真实时序不符。
- 裁决：所有 Critical/Important 进入 SDD fix round 1，并同时处理三项同域 Minor；修复必须逐项先复现根因、
  写真实 RED、确认预期失败，再最小 GREEN，追加 fresh 证据到 `task-3-report.md` 后执行 scoped re-review。

## Task 3 fix round 1 与最终独立复审（2026-08-28）

- fix range：`b3bafe8..248a110`；实现提交 `3ed8955`，fresh 证据提交 `248a110`。
- RED：focused strict compile exit `0` 后，fresh emit 四文件 suite 为 `68/81`，13 个行为失败精确覆盖
  direct mint、U+FEFF typed inventory、callback freeze、wrong-context consume、semantic correlation view、
  private backing、canonical target hash 等审查 finding；不是测试编译错误。
- GREEN：同一 focused compile exit `0`，fresh emit suite `81/81`；semantic completed consumer gate、provider
  `33/33`、Plan01 `185/185`、ownership `25/25`、native workflow `9/9`、discovery/package `5/5` 全部通过。
- 迁移基线保持诚实：repo typecheck/build 仍为预期 `881 diagnostics / 75 files`，Task3/flow/semantic
  diagnostics 为 `0`；transition P01 exit `0`，P02 仅因 Task4–5 open `31` 预期 exit `1`，past `0/0`、
  `regressions=[]`。
- scoped re-review 对原 `3 Critical / 3 Important / 3 Minor` 逐项裁决为 `9/9 ADDRESSED`；fix diff 未引入
  新 Critical、Important 或 Minor，out-of-scope observation 为零。
- Task 3: fix round 1/5 (9 addressed, 0 open; commits `b3bafe8..248a110`).
- Task 3: complete (commits `b08dd3f..248a110`, review clean).
- Task 3 的完成仅表示 context、frozen indexes 与 physical seal foundation 关闭；Plan03 owner chain、Plan04
  public writer closure 与 Plan08 ordered outbox 仍由各自计划持有。Task 4 可按独立 brief 开始。

## Task 4–5 续执行预检（2026-08-29）

| 任务/接缝 | 产出与消费关系 | 预检结果 |
|---|---|---|
| Task 4 内部 | 计划要求创建 source types，但 final-v0.3 已由 `src/domain/change.ts` 定义唯一持久 `SourceRef` union | 复用 domain union；source types 只定义 locator/session/result 等 Core 内部类型，不建第二套 `SourceRef`/schema。 |
| Task 3 → Task 4 | Task 3 封印后零 I/O；Task 4 需要解析当前 source | 当前 source 在 seal 前捕获；`sealForNewMutation()` 把一次性 `SourceCaptureSession` 交给 callback，resolver 只接受该 session。 |
| Task 4 code capture | Git provider 排序与 repository containment/source bytes 捕获 | resolver 先获受验 provider，再从会话私有状态取 root 并做 containment/discovery；所有读取共用 context recorder。 |
| Task 4 → Task 5 | resolver 产出已冻结 ref/observation；Flow/public facade 消费 | fresh inspection/new mutation 在 capture session 内解析并在 callback 返回前冻结；matching PENDING recovery 只读历史冻结 ref，不创建 session。 |
| Task 5 内部 | Flow Decision linkage、public safe projection 和 observed-I/O 退出门 | 与 Task 4 session API 一致，不暴露 provider/root/recorder；CLI 仍归 Plan07。 |

- Ruling: Task 4 复用 `src/domain/change.ts` 的唯一严格 `SourceRef` union，不按旧计划复制持久类型 — 收敛设计与 Plan01 final catalog 的优先级更高，且用户已批准 — 如果错误，代价是 source 模块需重做类型边界。
- Ruling: `resolveCurrentSource` 只接受 seal 前、WeakMap 认证且一次性的 `SourceCaptureSession`，不接受 `SEALED ChangeAuthorityContext` — 这同时满足当前源必须捕获与 seal 后零 I/O，且用户已批准方案 1 — 如果错误，代价是 Task 5 调用面与 recovery 分支需重构。
- Ruling: `sealForInspection()` 保持零当前源读取；public fresh inspection 使用新的 capture session 路径，matching PENDING inspection/recovery 仍只消费冻结 ref — 避免恢复路径二读 — 如果错误，代价是 public inspection 的命名/API 需在 Plan07 前调整。

- Task 4 续执行基线：`db87bcb`；focused strict TypeScript compile exit `0`，被忽略的 `dist/task4-baseline.*` fresh emit 后 Task2+Task3 四文件 suite `81/81`、fail `0`；`git diff --check` 通过。首次放到 `/tmp` 的 emit 因 ESM 无法向上解析本仓 `node_modules` 而未启动测试，改为仓库内忽略目录后同一代码全绿。

## Task 4 独立审查 round 0（2026-08-29，CHANGES_REQUESTED）

- 审查范围：`db87bcb..5616a70`；规格未批准，质量为 `Needs fixes`。
- `1 Critical / 3 Important / 1 Minor`：可替换 array/hash prototype 能污染 policy/structured hash；未 await 的失败 capture 仍可封印；Git worktree discovery 与稳定读之间未绑定同一目录身份；按 kind/行为的 negative matrix 不完整。
- Task 4: minor (deferred): `context-read-once` 的 callback-failure 用例未在 retained session 上实际调用 resolver 断言 `AUTHORITY_SOURCE_SESSION_INVALID`；交由 Plan02 final review 决定是否必须在合并前补齐。
- 裁决：Critical 和全部 Important 进入 fix round 1；必须逐项增加真实 RED，记录 covering tests 的命令/输出，修复后做 scoped re-review。

## Task 4 fix round 1 与最终独立复审（2026-08-29）

- fix commit：`806785b`（`5616a70..806785b`）。
- RED 逐项证明：policy/hash prototype attack `0/2`；dropped rejected capture 报 `Missing expected rejection`；worktree whole-root replacement 报 `Missing expected rejection`。
- GREEN：focused strict compile `0 diagnostics`；fresh emit 后 source/context/stable-bytes/machine-seal/provider 六套 `116/116`、fail `0`。
- scoped re-review 对 `1 Critical / 3 Important` 逐项裁决为 `4/4 ADDRESSED`；fix diff 新增 `0 Critical / 0 Important / 0 Minor`，out-of-scope 阻断项为零。
- Task 4: fix round 1/5 (4 addressed, 0 open; commits `5616a70..806785b`).
- Task 4: complete (commits `db87bcb..806785b`, review clean; 1 deferred Minor 交 Plan02 final review 分流).
- Task 4 只关闭 strict current resolution、session lifetime、provider-aware code capture 与 internal inspection projection；Flow/public facade、matching PENDING 零当前源读取由 Task 5 持有。

## Task 5 执行预检（2026-08-29）

- Task 5 基线：`f059acd`；Task 4 已提供 session-scoped resolver/inspection，且工作区除本台账外干净。
- 接缝风险：旧 `flow-assessment.ts` 仍是 Plan04 之前的 durable writer，而 Task 5 只能接入 current source/linkage 与 read-only facade；不得提前生成 Plan03 `AuthorityEnvelope` 或 Plan04 `WriterFence`/owner closure。
- 执行要求：新请求在任何 transaction/semantic owner allocation 前从 locator 解析真实 ref；matching PENDING/recovery 必须先分支并只消费冻结 ref。如果现有 context request/layout 不足以在不越过 Plan03/04 边界的前提下实现，实现者必须先返回精确 blocker，不得凭空补写 owner/layout ABI。

## Task 5 blocker 裁决（2026-08-29）

- Ruling: 采用最小 Plan02 Context/layout 接缝：新增 recorder-owned 的真实 Change builder，以
  `<repoRoot>/.omnai` 作为 project authority root 读取 WorkflowLock，以唯一匹配 `changeId` 的
  `<repoRoot>/.omnai/changes/<id-slug>` 作为 Change contained root 读取 inventory、artifact 与 source；
  Change 目录发现、recognized optional/collection target 发现、稳定目录观察和文件 capture 必须共用同一
  private recorder。重复 ChangeId、缺少 required target、未知/重复 recognized target、目录身份变化均 fail
  closed。允许为此最小修改 `context.ts`、`context-builder.ts`、`inventory.ts` 及相应测试，但不得创建
  AuthorityEnvelope、owner/global chain、WriterFence 或第二套持久 schema — 如果错误，代价是 Plan03 canonical
  context facade 前需重做 layout adapter，而不会污染持久 authority ABI。
- Ruling: Flow mutation 唯一入口改为非持久、strict 的 locator-only
  `FlowAssessmentMutationRequestV1`（Change/Revision/Baseline、assessment 分类字段与 `decisionIds`、有序
  `sources: SourceLocator[]`）；旧的 caller-hash `FlowAssessmentProposal` 不再作为公开 mutation input，且不得
  保留第二条可写路径。Core 在一次认证 session 内解析全部 locator，之后才构造并冻结既有 durable
  `FlowAssessmentProposal`。matching PENDING 在任何 session/source read 前，以分类字段、版本字段、
  `decisionIds` 与从 frozen SourceRef 去除 `contentHash` 后得到的有序 locator identity 做 exact match；匹配时
  只使用 transaction 内冻结 proposal，非匹配时 fail closed — 如果错误，代价是 Plan04 WriterFence 接入时
  调整非持久 request adapter，durable transaction schema 无需迁移。
- Ruling: assessment `decisionIds` 的 exact expected set 是当前认证 Context 中状态为 `OPEN` 或 `BLOCKED`
  的全部 Decision ID，按 code-unit sorted unique；对应的 Decision SourceLocator/SourceRef 集合必须一一完全
  相等。缺少任一 live Decision、额外/未知 ID，或引用 `RESOLVED`/`REJECTED`/`SUPERSEDED` Decision 均以
  stable mismatch 拒绝；full Flow `decisionIds/decisionBindings` 仍保留完整 Decision inventory，不改变既有历史
  identity 语义 — 如果错误，代价是 Plan04 route activation 前需重写 assessment linkage oracle 与 focused tests。
- Ruling: 允许 Task5 最小修正 `reconcile-internal.ts` 的两处旧 public `loadFlowPlan()` 调用，改用已有
  `flow-store-internal.ts::loadFlowPlanInternal()`（若现有验证契约确实不足，才可在同模块增加等价的
  within-lock read-only helper）；不得重开 public raw reader、不得新增 writer/owner capability。该接缝只让已持有
  Change lock 与 transaction fences 的内部 Reconcile consumer 读取并验证 Flow，matching PENDING 仍须在进入
  Context/source capture 前完成 frozen identity 匹配 — 如果错误，代价是 Plan04 sealed-context reader 接入时替换
  此内部调用点，不影响 durable Flow/transaction schema。
- Ruling: 不在 Task5 迁移 legacy Reconcile signal/writer；`createReconcileSignal` 的旧字段到 final-v0.3
  `ReconcileSignalV2`、owner-neutral outcome 与后续 writer recovery 明确属于 Plan04 Task3–4。Task5 的
  PENDING 退出证据限定为：编辑当前 source 后，exact locator-only retry 在任何 Context/source read 前命中
  frozen proposal identity，并到达已知 Plan04 downstream closed gate；非 exact 请求在同样零 source read 下以
  `FLOW_TRANSACTION_PENDING` 拒绝。测试必须区分这两条分支并断言 current-source reads 为零，报告中明确
  “source/authentication recovery seam complete，durable writer recovery deferred”，不得把 downstream gate
  叙述成成功完成 Reconcile — 如果错误，代价是 Plan04 完成 writer migration 后把该 gate expectation 改为
  completed recovery，而 locator/frozen identity 与零二读实现无需重做。

## Task 5 独立审查 round 0（2026-08-29，CHANGES_REQUESTED）

- 审查范围：`f059acd..443b1ff`；规格为 `CHANGES_REQUESTED`，质量为 `NEEDS_FIXES`，Task5 不得标记完成。
- `2 Critical / 2 Important / 1 Minor`：caller-writable ChangeRef 未绑定唯一认证 Change root，lock/transaction
  可选错目录；Decision/Evidence/Run 目录 observation 与后续 pathname file capture 未保持同一 descriptor
  身份；await 后仍使用 live RegExp/String/Map/Set；PENDING frozen identity 未把 locator 内嵌 Change/Revision
  绑定到顶层 request；Plan04 downstream gate 测试的错误断言过宽。
- 裁决：五项全部进入 fix round 1，逐项真实 RED→GREEN。Critical 2 的生命周期修复还必须覆盖
  `buildChangeBaseContext()` 返回到 session source capture 之间的 Change-root replacement；Flow 修复还必须
  证明 stale top-level Revision/Baseline 不能由 no-op 快捷返回绕过，且 no-op 不能跳过既有 semantic PENDING
  preflight。若这些 controller reproduction 不成立，报告必须给出实际命令/输出，而不是静态推断。
- Plan04 Reconcile signal/writer migration继续 deferred；修复不得以恢复 public raw reader、创建 owner/fence 或
  扩到 `src/execution/**` 来关闭 finding。完整审查证据见 `task-5-review-round0.md`。

## Task 5 fix round 1 独立复审（2026-08-29，CHANGES_REQUESTED）

- fix commit：`2b559c9`（`443b1ff..2b559c9`）；实现者 fresh 证据为 Plan02 九套 `167/167`、
  native schema/hash/Decision–Flow identity/workflow `101/101`、touched diagnostics `0`。
- scoped re-review 判定 C1、C2、I2、Plan04 精确 closed-gate oracle 与 controller A/B/C 均
  `ADDRESSED`；same-lock concurrent PENDING 和 frozen retry 零 current-source read 保持成立。
- I1 仍为唯一 `OPEN Important`：`buildAuthorityInventoryBaseFromDiscovery()` 的真实 discovery await 后，
  `inventory.ts::collectObservedDirectoryPaths()` 仍调用 live `split/slice/join/sort`。独立最小 repro 在
  await 后替换 `String.prototype.split`，合法 `decisions/DEC-0001.yaml` 稳定抛
  `LIVE_SPLIT_REACHED`；既有 oracle 只匹配以 `DEC-` 开头的 token，漏掉真实
  `decisions/DEC-…`，构成假绿。
- Task 5: fix round 1/5（7 addressed，1 open；commit `2b559c9`）。进入 fix round 2；必须一次性收口
  同一 after-await 可达链的 live split/slice/join/sort/map/some/includes/startsWith、RegExp/String
  normalization 与 array spread/iteration，并让联合 poison oracle 匹配真实完整路径。不得改变 schema、
  refinement、catalog/hash、Git binding ABI/order、SourceRef/request 或 Plan03/04 deferred 边界。
