# Plan02 Task 1 实施报告

## 结论

最终结论：**APPROVED / TASK 1 COMPLETE**。Task 1 已在基线 `b4c12c15ab74a3a5063ebcf3ae70e7308241b604` 上完成初始实现，并关闭独立审查 round 1 的五项 Important、round 2 process-group Important 及其复审发现的 pack hygiene N1；round 3 I1 所指出的 Plan01 packed-install runner 合同回归也已按真实 RED→GREEN 修复。最终独立复审给出 `0 Critical / 0 Important / 0 Minor` 与 `APPROVED`；Task 2–5 尚未开始。

生产面只新增内部 `VERIFIED_FD_EXECVEAT_V1` provider；没有公开 adapter、调用方候选路径、JavaScript Git fallback、Plan01 catalog 注入或外部 native gate。

## 实际实现

### Native descriptor protocol

- 生产候选在 C 源中固定且仅为 `/usr/local/bin/git`、`/usr/bin/git`；运行时 `acquire()` 零参数，`execute()` 只接受精确 own keys `repositoryRoot` 与 `args`。
- `openat2` 使用 `RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS`；无 syscall/pathname fallback。
- 接受条件为 root owner、regular file、至少一个 executable bit、group/world 不可写、最大 256 MiB。
- acquire 与每次 execute 均执行稳定 `fstat -> raw SHA-256 -> fstat`；执行前比较 retained fd，child 完成后重新打开固定候选并比较 dev/inode/mode/uid/hash，比较通过前不向 JS 返回 child bytes。
- child 先把受验 executable fd 固定到 fd 3，把错误 pipe 固定到 fd 4；关闭其余 fd、`chdir("/")`，再执行 `execveat(3, "", argv, sanitized_environment, AT_EMPTY_PATH)`。
- child 环境精确为简报规定的 13 项；stdout/stderr 各限 8 MiB，production wait 限 30 秒。overflow、timeout、wait failure 均关闭父进程 pipe。
- 自审补齐“直接 child 已退出但 descendant 仍持 pipe”的总等待上界，并避免对已回收、可能复用的 PID 再次发送信号。
- native 字符串读取器拒绝 embedded NUL，避免 repository root 或 argv 在 `execveat` 边界被静默截断。

### TypeScript boundary

- 内部接口为 `acquireGitProvider(): FrozenGitProviderBindingV1` 与 `runGit(binding, { repositoryRoot, args })`。
- native module 导出必须精确为 `acquire`、`execute`；native 输入/输出与 frozen binding 全部 strict parse，unknown key fail closed。
- version 只接受规范单行 `git version x.y.z[.w]\n`；raw executable hash 独立校验测试与 native 结果一致。
- frozen binding 包含 schema/environment/execution protocol、固定 candidate/real path、raw bytes hash、canonical version 与 `hashStrictObject(body)`；对象被冻结，每次 execute 前重验全部字段、binding hash 与当前 retained descriptor 对应的 active binding。
- owner 选择前的所有错误精确映射为 `GitProviderError.code === "GIT_PROVIDER_UNAVAILABLE"`；本任务没有提前建立 Task 2+ owner-family 映射。

### Build 与测试边界

- 保留 `binding.gyp`；`scripts/build-native-provider.mjs` 只用固定 `/usr/bin/cc` 和系统 ABI 编译，不新增 npm 依赖。
- `npm run build:native` 只生成 `dist/native/verified_fd_provider.node`；`npm run build` 先依赖该步骤。
- `npm run build:native:test` 对同一 C 源使用构建期宏固定私有候选，并把 private addon/safe/malicious fixtures 写入 `/tmp/omnai-verified-fd-provider-<worktree>/`。运行时 acquire/execute 仍不接收 path。
- production build 不携带测试宏或 control marker；private addon/fixtures 不进入 `dist` 或 npm pack。

## TDD 证据

| 阶段 | 命令/测试 | 真实结果 |
|---|---|---|
| 初始 RED | `npm run build:native` | exit `1`：`Missing script: "build:native"`。 |
| 初始 RED | `npm run build -- --pretty false` | Task 1 新增 `TS2307`：`native-binding.js`、`provider.js` 不存在；其余为既有迁移诊断。 |
| strict boundary RED | caller candidate-location unknown-key 测试 | exit `1`：`Missing expected exception`；native execute 尚未严格拒绝额外 key。 |
| fd cleanup RED | bounded failure fd-count 测试 | exit `1`：`descriptor count grew from 20 to 32`。 |
| bounded wait RED | descendant 持 pipe 测试 | exit `1`：约 `619 ms` 后 `Missing expected exception`。 |
| native string RED | embedded-NUL root/argument 测试 | exit `1`：`Missing expected exception`；N-API 输入会在 argv 边界截断。 |
| GREEN | provider suite | `23/23` 通过；上述 strict input、fd cleanup、descendant wait 与 embedded-NUL 均转绿。 |

所有 RED 均在相应最小生产修正前实际运行；环境离线前丢失的旧工作树结果没有作为本报告证据。

## 环境事实与裁决

- `/usr/local/bin/git`：regular、uid `0`、mode `755`、Git `2.51.1`、SHA-256 `2dae8066ef4d6a926561b4b0eaca7b458d4f5b56bb83760656e6baa7fc3e974f`。
- `/usr/bin/git`：regular、uid `0`、mode `755`、Git `2.43.0`、SHA-256 `2a8c18fbf43da9f692d75474c72bea9dfd796c260b0f3dfe456376abc3bbd668`。
- `unshare -Ur true` 无法写 `/proc/self/uid_map`，`unshare -m true` 也以 `Operation not permitted` 失败。因此 adversarial candidate 不能用 mount/user namespace 覆盖生产绝对路径，采用上节限定的私有构建期固定候选 harness。
- `/usr/bin/strace` 存在，但实际运行以 exit `1` 失败：`PTRACE_TRACEME: Operation not permitted`。没有把该环境限制伪装为 trace 通过；替代证据为源码执行族唯一性、`nm -D` 唯一执行符号、生产 strings 与 race/sentinel 测试。

## Fresh 验证结果

| 验证 | 结果 |
|---|---|
| `npm run build:native` 连续两次 | 两次均 exit `0`；artifact SHA-256 均为 `0446bb385e2784d287be5bbbc0e00c8ef5ea01743ef9e8278bd795a7a50197a5`。 |
| Task 1 五文件 focused `tsc --noEmit` | exit `0`。 |
| `node --test dist/src/core/git-provider/test/provider.test.js` | `23/23`，fail `0`。 |
| Plan01 final schema/catalog/compiler 7 文件 suite | `185/185`，fail `0`。 |
| `node --test dist/src/tooling/test/diagnostic-ownership.test.js` | `25/25`，fail `0`。 |
| `node --test dist/src/core/test/native-workflow-gate.test.js` | `9/9`，fail `0`；`resources/authority/workflow.lock.yaml` 仍不存在。 |
| `npm run typecheck -- --pretty false` | 预期 exit `2`：`888 diagnostics / 76 files`；provider diagnostics `0`。 |
| `npm run build -- --pretty false` | native build 成功后，TS 预期 exit `2`：`888 diagnostics / 76 files`；provider diagnostics `0`。 |
| transition `completed-through=P01` | exit `0`；future `888/76`、past `0/0`、unowned `0/0`、Execution `109/8`、open `0`、regressions `[]`。 |
| transition `completed-through=P02` | 预期 exit `1`；future `881/75`、past `7/1`、unowned `0/0`、Execution `109/8`、open `31`、regressions `[]`；Task 2–5 尚未实施。 |
| 禁用模式与执行族扫描 | 无 execFile/spawn/shell/PATH/pathname fallback；C 执行族唯一命中 `execveat(..., AT_EMPTY_PATH)`；`nm -D` 唯一执行符号为 `execveat@GLIBC_2.34`。 |
| production addon surface | exports 精确 `['acquire','execute']`；strings 精确含两个 production candidates，无 testing/control marker。 |
| `/usr/bin/cc ... -fanalyzer -fsyntax-only` | exit `0`。 |
| `ldd` / `readelf -d` | 仅 `libc` 与 loader；无非系统动态库、RPATH 或 RUNPATH。 |
| `npm pack --dry-run --json` | exit `0`；813 files；包含 `dist/native/verified_fd_provider.node`；private addon/fixtures `0`；`package-lock.json` 未变化。 |
| public/persistent scan | `src/core/git-provider/**` 外无 provider 字段；没有进入公共或持久对象。 |

repo-wide typecheck/build 的 888 条诊断是台账已登记的跨计划迁移债务；本任务遵循 focused compile/tests 与 transition owner gate，没有扩大范围或用断言隐藏。

## 实际变更文件

- `binding.gyp`
- `native/verified-fd-provider/verified_fd_provider.c`
- `scripts/build-native-provider.mjs`
- `src/core/git-provider/native-binding.ts`
- `src/core/git-provider/provider.ts`
- `src/core/git-provider/types-internal.ts`
- `src/core/git-provider/test/provider.test.ts`
- `src/core/git-provider/test/provider-race-harness.ts`
- `package.json`
- `.superpowers/sdd/2026-08-23-omnai-v0.3-02-authority-context-source-resolution/task-1-brief.md`
- `.superpowers/sdd/2026-08-23-omnai-v0.3-02-authority-context-source-resolution/progress.md`
- `.superpowers/sdd/2026-08-23-omnai-v0.3-02-authority-context-source-resolution/task-1-report.md`

没有修改 package-lock、public root exports、persistent schemas 或 Task 2–5 文件。

## 独立审查 round 1 修复（2026-08-27）

独立审查给出 `0 Critical / 5 Important`。五项均已按真实 RED→GREEN 修复；Task 1 仍处于实施中，等待控制器复审，不据此提前开始 Task 2。

| Finding | RED 证据 | 修复 | GREEN 证据 |
|---|---|---|---|
| I1 FIFO open 阻塞 | 旧实现对无 writer 的真实 FIFO 在 `openat2(O_RDONLY)` 阻塞，500 ms deadline 后约 515 ms 才由夹具释放并以 bounded assertion 失败。 | 固定候选使用 `O_RDONLY | O_CLOEXEC | O_NONBLOCK`，随后仍由真实 `fstat` regular-file gate 拒绝 FIFO。 | focused 约 52 ms 返回 `VERIFIED_PROVIDER_VERIFY_METADATA`；完整 provider suite 同场景通过。 |
| I2 overflow 饥饿 timeout | 测试态精确 marker 令旧 `drain_pipe` 在首次 overflow 后若继续 drain 就等待 release，约 531 ms 报 bounded assertion 失败。 | 首次超过 8 MiB 即设置 overflow 并立刻返回外层；外层先杀 process group、回收 child、关闭三条父 pipe，再返回 output-limit。 | focused 约 58 ms 返回 `VERIFIED_PROVIDER_OUTPUT_LIMIT`；总 deadline 不再被持续 drain 饥饿。 |
| I3 timeout 后代存活 | 用 `HEAD` 旧 provider 构建隔离 addon、复用带 sentinel 的真实 safe fixture；直接 child 已结束后，旧逻辑只按 child PID 清理，450 ms descendant 成功写入 `descendant-survived-timeout`，`assert.rejects` 真实 RED。 | fork 后 child 由 start pipe 阻塞；parent 成功 `setpgid(child, child)` 后才 release。stdout/stderr/error pipes 未全闭合前不 reap group leader，保留 PGID 身份；overflow、timeout、wait failure 均先 `kill(-pgid, SIGKILL)`，再 EINTR-safe 回收直接 child。all-pipes-closed 但 child 仍运行时只做 `WNOHANG`，继续受同一总 deadline 约束。group release 失败若 PGID 已建立也先杀组。 | descendant 测试约 736 ms 完成（含返回后 500 ms sentinel 观察窗），返回 `VERIFIED_PROVIDER_WAIT` 且 sentinel 不存在。 |
| I4 EINTR/partial error record 与 reap | 半补丁下 waitpid EINTR 返回 `VERIFIED_PROVIDER_WAIT (errno=4)`；child error write 经 EINTR+partial 注入后没有 exact errno record，测试报 `Missing expected exception`。 | child error record 使用 exact write loop，重试 EINTR 与 partial write并恢复调用方 errno；所有 wait/reap 统一使用 EINTR-safe `waitpid_retry`。每个 cleanup 入口先保存 first failure errno，pipe/fork/group setup errno 不再被 close/kill/wait 覆盖。 | success result 在两次 waitpid EINTR 后字节不变；setup failure 精确返回 `VERIFIED_PROVIDER_EXECUTE_FD ... errno=95`。测试态记录 child PID、启动时 `/proc` starttime 及真实 waitpid reap PID，证明返回时原 child 身份已回收。focused 连续五轮 `2/2`。 |
| I5 hidden/symbol strict keys | raw native execute 与 TypeScript execute/binding/native-result 输入加入 non-enumerable 或 symbol own key 后，旧实现均报 `Missing expected exception`。 | native 改用 Node-API v6 `napi_get_all_property_names(env, object, napi_key_own_only, napi_key_all_properties, napi_key_numbers_to_strings, result)`；symbol key 因非 string fail closed，non-enumerable key进入计数并拒绝。参数数组要求 own keys 精确为 `length + 0..n-1`，因此正常 dense args 不误拒，hidden/symbol/额外索引/洞均拒绝。TypeScript module/result/binding/execute input 与 args array 全部用 `Reflect.ownKeys` 精确检查。 | raw native 与 TypeScript strict focused 两项转绿；完整 provider suite 的正常 args、hidden/symbol object/array、binding 与 freeze result 均通过预期分支。Node `>=20` 契约满足：该 all-own API 自 Node-API v6（Node v10.20.0 起）稳定。 |

### PID/reap 证据调查

初次完整 `30` 项 suite 曾有一次旧 `/proc/<pid>/stat` “必须 ENOENT”断言失败。该断言只记录 PID，无法区分“原 child 未回收”和“PID 已回收后被复用”，因此没有用后续重复通过掩盖它。夹具现于 child 被 start barrier 固定时记录 PID 与自身 `/proc/self/stat` starttime，并仅在 `waitpid_retry` 实际返回同一 PID 后写入 reap record；返回后允许 PID path 不存在或 starttime 已变化，但同一 starttime 身份仍存在（包括 zombie）必失败。强化后 I4 focused 连续五轮 `2/2`，fresh 完整 provider suite `30/30`。

### C 资源与错误路径自审

- stdout/stderr/error/start 四组 pipe 全部以 `-1` 初始化；任一 partial creation failure 关闭所有已建端点，并在清理前保存 pipe errno。
- fork failure 在关闭 parent endpoints 前保存 errno；child/parent 各自关闭 start pipe 的相反端。child 未收到合法 release token 时 exact 报错后 `_exit`。
- `setpgid` 失败关闭 release writer、杀直接 child并 EINTR-safe reap；PGID 已建立后的 release failure 先杀组再 reap。负 PGID 只使用已验证的正 child PID。
- group leader 在 descendant 仍持 pipe 时不提前 reap，避免 `child_done` 后的 PID/PGID reuse 窗口；all-pipes-closed 但 child 未退出时 `poll` 零 fd 仅等待 10 ms，仍每轮检查总 deadline。
- overflow、timeout、wait failure 都先杀组、再 EINTR-safe reap直接 child、再关闭全部 parent pipe；wait failure 先保存 first errno。
- child error pipe reader累积 exact `sizeof(int)`，读到完整 record 后关闭；read/poll EINTR 不转写为业务失败。
- test marker、FIFO、PID identity、EINTR/partial hooks 都仅存在于 `VERIFIED_PROVIDER_TESTING` 私有构建；production strings 不含 marker/control/tmp path。

### round 1 fresh 验证

| 验证 | 结果 |
|---|---|
| `npm run build:native` 连续两次 | 两次 exit `0`，SHA-256 均为 `cb152aaeb07933ad7b9200ea14cbb9dbd016f1d26a240ac4b95977fa0fa51cd2`。 |
| `npm run build:native:test` | exit `0`；真实 FIFO fixture 为 `fifo`，private addon 为 regular `0755`。 |
| Task 1 五文件 focused strict `tsc --noEmit` 与 emit | 均 exit `0`，包含 `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`。 |
| provider suite | `30/30`，fail `0`。 |
| Plan01 final schema/catalog/compiler 7 文件 suite | `185/185`，fail `0`。 |
| diagnostic ownership suite | `25/25`，fail `0`。 |
| native workflow gate | `9/9`，fail `0`；`resources/authority/workflow.lock.yaml` 不存在。 |
| `npm run typecheck -- --pretty false` | 预期 exit `2`：`888 diagnostics / 76 files`；provider diagnostics `0`。 |
| `npm run build -- --pretty false` | native build 成功后预期 exit `2`：`888 diagnostics / 76 files`；provider diagnostics `0`。 |
| transition P01 | exit `0`；future `888/76`、past `0/0`、unowned `0/0`、Execution `109/8`、open `0`、regressions `[]`。 |
| transition P02 | 预期 exit `1`；future `881/75`、past `7/1`、unowned `0/0`、Execution `109/8`、open `31`、regressions `[]`。 |
| source / exports / symbols / strings | 生产执行族只有 `execveat(3, "", ..., AT_EMPTY_PATH)`；exports 精确 `acquire/execute`；动态执行符号唯一 `execveat@GLIBC_2.34`；strict key 符号为 `napi_get_all_property_names`；仅含两个 production candidates，无测试 marker。 |
| analyzer / linkage | production 与 safe fixture 的 `-fanalyzer -fsyntax-only` 均 exit `0`；`ldd` 仅 `libc` 与 loader；无 RPATH/RUNPATH。 |
| pack | `npm pack --dry-run --json` exit `0`；813 files；包含 production `.node`；private addon/safe/malicious/FIFO/control files 为 `0`。 |
| hygiene | `package-lock.json` 无 diff；public/persistent provider field scan 无命中；`git diff --check` 通过。 |

`strace` 限制仍沿用已审环境事实：`PTRACE_TRACEME: Operation not permitted`，本轮不伪造重复 trace。真实 non-root `chown(1,1)` 在当前 `/tmp` 文件系统返回 `EINVAL`，测试记录该精确结果后才使用 testing-only metadata fallback；world-writable 使用真实 `chmod` 并被拒绝。

### round 1 变更文件

- `native/verified-fd-provider/verified_fd_provider.c`
- `scripts/build-native-provider.mjs`
- `src/core/git-provider/native-binding.ts`
- `src/core/git-provider/provider.ts`
- `src/core/git-provider/test/provider-race-harness.ts`
- `src/core/git-provider/test/provider.test.ts`
- `.superpowers/sdd/2026-08-23-omnai-v0.3-02-authority-context-source-resolution/task-1-report.md`
- `.superpowers/sdd/2026-08-23-omnai-v0.3-02-authority-context-source-resolution/progress.md`

未跟踪的 `task-1-review-package.md` 是控制器审查输入，不属于修复提交。

## 独立审查 round 2 修复（2026-08-27）

round 1 复审给出 `0 Critical / 1 Important`：三个 pipe 全闭合后，旧逻辑以 `waitpid(..., WNOHANG)` 直接回收 process-group leader。若 leader 被 signal 终止，后续 WAIT failure 已失去安全 PGID；若 leader 正常退出但 reopen/hash postcheck 失败，也会在清理同组 closed-pipe descendant 前失去 PGID 锚点。Task 1 因此继续保持实施中，本轮不推进 Task 2。

### RED 与 GREEN

| 场景 | round 2 RED（原 `66d2d5a` 生产逻辑） | 修复与 GREEN |
|---|---|---|
| A：signal-terminated leader | fixture fork descendant 后，descendant 立即关闭 stdout/stderr，延迟 450 ms 写 `descendant-survived-signaled-leader`；leader 以 `SIGTERM` 终止。provider 精确返回 `VERIFIED_PROVIDER_WAIT`，PID + `/proc` starttime + waitpid reap record 证明 leader 已回收，但约 519 ms 后 sentinel 存在，测试以 `Missing expected rejection` 真实失败。 | `waitid(P_PID, child, ..., WEXITED | WNOHANG | WNOWAIT)` 只观察不回收；signal 状态先 `kill(-pgid, SIGKILL)`，再 EINTR-safe exact `waitpid`。同测试约 517 ms GREEN，500 ms 返回后观察窗内 sentinel 不存在且 leader reap identity 成立。 |
| B：normal leader + postcheck failure | leader 受控正常完成，closed-pipe descendant 延迟写 `descendant-survived-postcheck`；测试在 release 前替换 fixed candidate。provider 精确返回 `VERIFIED_PROVIDER_REOPEN_AND_COMPARE` 且 leader 已回收，但约 584 ms 后 sentinel 存在，测试真实失败。 | 正常终态先保留未回收 leader，杀同组残余进程，再执行 reopen/hash postcheck，最后 exact reap。postcheck failure 仍保留其 first phase/errno。约 583 ms GREEN，500 ms 观察窗 sentinel 不存在，leader PID/starttime/reap record 一致。 |

额外 success-path 回归复用 closed-pipe descendant：candidate 未替换时精确接受空 stdout/stderr、exit `0`，但只在先终止残余 group、postcheck 成功并回收 leader 后返回；500 ms 观察窗 sentinel 不存在。A/B focused 连续五轮均 `2/2`，没有用重复运行掩盖 `/proc` 身份问题。

### waitid 事实与清理次序

- 本机 glibc `sys/wait.h` 的稳定签名为 `int waitid(idtype_t, id_t, siginfo_t *, int)`；POSIX/Open Group 与 Linux man-pages 均规定 `P_PID` 精确选择 child、`WNOWAIT` 保持 waitable 状态、`WNOHANG` 无可用状态时立即返回。实现每次调用前清零 `siginfo_t`，以 `si_pid == 0` 判断 leader 仍运行。
- 只请求 `WEXITED`；`CLD_EXITED` 的 `si_status` 解释为 exit code，`CLD_KILLED`/`CLD_DUMPED` 解释为 termination signal，其他 `si_code` fail closed 为 `EPROTO`。exact reap 后再次核对 `WIFEXITED/WEXITSTATUS` 或 `WIFSIGNALED/WTERMSIG` 与非回收观察一致。
- all-pipes-closed 但 leader 仍活时继续 `waitid(...WNOHANG)` + 10 ms bounded poll，并逐轮检查原总 deadline；没有引入 blocking wait。leader 终态、pipe 闭合、状态分类及 postcheck 完成前均不 reap。
- overflow、timeout、wait/exec-record failure 均先保存业务 first failure，再杀 group、exact reap、关闭父 pipe；正常路径先杀残余 group，再 postcheck，最后 reap。group signal、postcheck 或 reap 的首个失败会拒绝输出，后续 cleanup 不覆盖已有 phase/errno。
- testing-only `interrupt-waitid-twice` 与既有 `interrupt-waitpid-twice` 同场证明观察和最终回收都可重试 EINTR；exec setup failure 仍精确保留 errno `95` 并证明 direct child 已回收。production strings 不含任一测试 marker、fixture sentinel 或 control path。

### round 2 fresh 验证

| 验证 | 结果 |
|---|---|
| `npm run build:native` 连续两次 | 两次 exit `0`，SHA-256 均为 `05a9d0eddcd08e1fe9c1ee5d159b1833001b4c6f9cd2c19a8fcfa3ea9fceed99`。 |
| `npm run build:native:test` | exit `0`。 |
| Task 1 五文件 focused strict `tsc --noEmit` 与 emit | 均 exit `0`，包含 `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`。 |
| provider suite | `33/33`，fail `0`；包含 A/B、normal success residual-group、waitid+waitpid EINTR 与 exec error exact reap。 |
| Plan01 final schema/catalog/compiler 7 文件 suite | `185/185`，fail `0`。 |
| diagnostic ownership suite | `25/25`，fail `0`。 |
| native workflow gate | `9/9`，fail `0`；`resources/authority/workflow.lock.yaml` 不存在。 |
| `npm run typecheck -- --pretty false` | 预期 exit `2`：`888 diagnostics / 76 files`；provider diagnostics `0`。 |
| `npm run build -- --pretty false` | native build 成功后预期 exit `2`：`888 diagnostics / 76 files`；provider diagnostics `0`。 |
| transition P01 | exit `0`；future `888/76`、past `0/0`、unowned `0/0`、Execution `109/8`、open `0`、regressions `[]`。 |
| transition P02 | 预期 exit `1`；future `881/75`、past `7/1`、unowned `0/0`、Execution `109/8`、open `31`、regressions `[]`。 |
| analyzer / source / ABI | production 与 safe fixture `-fanalyzer -fsyntax-only` 均 exit `0`；源码执行族唯一为 `execveat(3, "", ..., AT_EMPTY_PATH)`；production exports 精确 `acquire/execute`；动态执行符号唯一 `execveat@GLIBC_2.34`，并解析系统 `waitid@GLIBC_2.2.5`、`waitpid@GLIBC_2.2.5`。 |
| strings / linkage | 生产 artifact 仅含两个固定 candidates，不含 testing/control/sentinel marker；`ldd` 仅 `libc` 与 loader，`readelf` 无 RPATH/RUNPATH。 |
| pack / hygiene（历史结果，已由 N1 取代） | `npm pack --dry-run --json` 当时为 813 files；只验证 production addon `1`、`/tmp` private addon/fixture/control `0`，未检查 `dist` 内 compiled tests，因此不足以证明 test-only marker 不进 pack。 |

round 2 变更文件：

- `native/verified-fd-provider/verified_fd_provider.c`
- `src/core/git-provider/test/provider.test.ts`
- `.superpowers/sdd/2026-08-23-omnai-v0.3-02-authority-context-source-resolution/task-1-report.md`
- `.superpowers/sdd/2026-08-23-omnai-v0.3-02-authority-context-source-resolution/progress.md`

未跟踪的 `task-1-review-package.md` 仍是控制器审查输入，不属于 round 2 修复提交。

## 独立审查 round 2 发布卫生补充修复（2026-08-27）

round 2 复审确认 process-group finding 已关闭，同时给出 `0 Critical / 1 Important` N1 与一个报告状态 Minor。N1 指出 `package.json.files` 整体包含 `dist`，导致 compiled provider tests/harness/maps 及其 testing marker/sentinel 进入最终 npm pack；此前只检查 private native harness 没有进入 `dist`，验证边界不完整。

### N1 RED→GREEN

| 阶段 | 真实结果 |
|---|---|
| RED | 新增 package-surface gate 真实执行 `npm pack --dry-run --json` 并读取最终清单内容。旧 allowlist 产生 813 files，其中 compiled test artifacts `315`、provider test/harness d.ts/JS/maps `6`；内容扫描命中 `interrupt-waitid-twice`、`interrupt-waitpid-twice`、A/B/timeout descendant sentinel、overflow/setup/PID testing markers。测试精确以非空泄露清单失败。 |
| 最小修复 | `package.json.files` 保留 `dist`，仅增加 `!dist/test/**` 与 `!dist/src/**/test/**`。没有改变构建产物位置、运行时导出或依赖。 |
| GREEN | 同一 gate 通过：pack `498` files；production `dist/native/verified_fd_provider.node` 精确 `1`，private/test addon/fixture `0`，全部 compiled test artifacts `0`，provider test/harness/maps `0`，marker/sentinel content leaks `0`。`dist/src/index.js`、`dist/src/main.js`、provider runtime JS/d.ts/maps 均仍存在。完整 package-version suite `5/5`。 |

### N1 fresh 验证

| 验证 | 结果 |
|---|---|
| native build | production 连续两次 exit `0`，SHA-256 均为 `05a9d0eddcd08e1fe9c1ee5d159b1833001b4c6f9cd2c19a8fcfa3ea9fceed99`；private build 与 Task 1 focused strict compile/emit 通过。 |
| focused suites | provider `33/33`、Plan01 `185/185`、diagnostic ownership `25/25`、native workflow `9/9`、package-version `5/5`。 |
| repo baseline | typecheck/build 均保持预期 exit `2`、`888 diagnostics / 76 files`；provider 与新 package gate diagnostics `0`。 |
| transitions | P01 exit `0`：future `888/76`、past/unowned `0/0`、open `0`；P02 按 Task 2–5 未实施预期 exit `1`：future `881/75`、past `7/1`、open `31`；均无 regressions。 |
| native/source/linkage | production 与 fixture analyzer 通过；执行族唯一 `execveat`，exports 精确 `acquire/execute`；production strings 无 testing markers；`ldd/readelf` 仅 libc/loader、无 RPATH/RUNPATH。 |
| hygiene | pack production addon `1`、private/test addon `0`、compiled tests/provider harness/maps/marker leaks 均 `0`；`package-lock.json` 无 diff，workflow lock 不存在，`git diff --check` 通过。 |

本补充修复变更文件：

- `package.json`
- `test/package-version.test.ts`
- `.superpowers/sdd/2026-08-23-omnai-v0.3-02-authority-context-source-resolution/task-1-report.md`
- `.superpowers/sdd/2026-08-23-omnai-v0.3-02-authority-context-source-resolution/progress.md`

未跟踪的 `task-1-review-package.md` 仍为控制器审查输入，不属于提交。

## 独立审查 round 3 packed runner 兼容修复（2026-08-27）

round 3 给出 `0 Critical / 1 Important` I1：round 2 N1 的 broad `!dist/test/**` 与 `!dist/src/**/test/**` 虽然阻止了 provider testing controls 进入 npm pack，却同时清空 Plan01 要求的 packed-install recursive test manifest。N1 的安全约束仍然有效；本轮只把发布清单收窄到真正携带 provider hooks/sentinels 的路径，不恢复 provider 测试资产。

### I1 RED→GREEN

| 阶段 | 真实结果 |
|---|---|
| RED | 先扩展 `test/package-version.test.ts` 的真实 `npm pack --dry-run --json` gate，再保持 broad exclusions 运行。最终 pack 为 `498` files，`scripts/run-native-tests.mjs` 存在，但 root `.test.js`、module-local `.test.js` 与全部 `.test.js` 均为 `0`；测试精确以 `packed root test layout is missing` 失败。 |
| 最小修复 | 用 `!dist/src/core/git-provider/test/**` 排除整个 provider test/harness 编译目录，并用 `!dist/test/package-version.test.*` 排除携带 marker 字面量的 package-surface gate 自身编译 variants；删除两条全局 test exclusions。没有改变生产构建、runtime exports、依赖或 lockfile。 |
| GREEN | 同一 gate 通过：最终 pack 为 `804` files，runner 存在；root `.test.js` `88` 个、module-local `.test.js` `13` 个、总计 `101` 个。稳定代表 `dist/test/scenarios.test.js` 与 `dist/src/domain/test/scalars.test.js` 均存在，因此 recursive manifest 非空且两族布局都保留。 |

最终内容 gate 同时证明 N1 继续关闭：provider test/harness JS、d.ts、maps 为 `0`，`dist/test/package-version.test.*` variants 为 `0`，production addon 精确 `1`、private/test addon `0`；waitid/waitpid EINTR hooks、A/B/success/timeout descendant sentinels、overflow/setup/PID controls 及其 control-record 字面量在全 pack 中命中 `0`。`dist/src/index`、`main`、`native-binding`、`provider` 的 JS/d.ts/maps 与 `scripts/run-native-tests.mjs` 全部保留。

### round 3 fresh 验证

| 验证 | 结果 |
|---|---|
| native build | production 连续两次 exit `0`，SHA-256 均为 `05a9d0eddcd08e1fe9c1ee5d159b1833001b4c6f9cd2c19a8fcfa3ea9fceed99`；private test-harness build exit `0`。 |
| focused compile | provider 五文件 strict `tsc --noEmit` 为 `0 diagnostics`；package-surface gate 独立 no-check emit exit `0`。 |
| focused suites | test-discovery `5/5`、package-version `5/5`、provider `33/33`、Plan01 final suite `185/185`、diagnostic ownership `25/25`、native workflow `9/9`；workflow lock 不存在。 |
| repo baseline | typecheck/build 均保持预期 exit `2`、`888 diagnostics / 76 files`；provider 与 package gate diagnostics `0`。 |
| transitions | P01 exit `0`：future `888/76`、past/unowned `0/0`、open `0`；P02 按 Task 2–5 未实施预期 exit `1`：future `881/75`、past `7/1`、open `31`；均无 regressions。 |
| native/source/linkage | production 与 safe fixture analyzer 通过；源码执行调用唯一为 `execveat(3, "", ..., AT_EMPTY_PATH)`，TS production provider 无 child-process API；exports 精确 `acquire/execute`；动态执行符号唯一 `execveat@GLIBC_2.34`，并保留系统 `waitid`/`waitpid`；production strings 仅含两个固定 candidate 且无 testing controls；`ldd/readelf` 仅 libc/loader、无 RPATH/RUNPATH。 |
| pack / hygiene | 最终 pack `804` files、runner `1`、tests `101`（root `88`、module-local `13`）；production addon `1`，private/test addon、provider test/harness、package-version compiled variants、marker leaks 均 `0`；runtime JS/d.ts/maps 全部保留。`package-lock.json` 与 dependencies 无变化，workflow lock 不存在，`git diff --check` 通过。 |

本轮变更文件：

- `package.json`
- `test/package-version.test.ts`
- `.superpowers/sdd/2026-08-23-omnai-v0.3-02-authority-context-source-resolution/task-1-report.md`
- `.superpowers/sdd/2026-08-23-omnai-v0.3-02-authority-context-source-resolution/progress.md`

生成的 `task-1-review-package.md` 仅为控制器审查输入，不属于 round 3 修复提交，并已在最终复审后删除。

## 最终独立复审（2026-08-27）

- 复审范围：`078566c97af0b8ad7840dee16398cbbf9b67657c..5267e1177f3b47e725420cf3c76aa73f5a8d7cb5`。
- I1：`CLOSED`。fresh final pack 为 `804` files，runner `1`，root tests `88`、module-local tests `13`、总 `.test.js` `101`；实际 `dist` 逐项比对没有意外排除。
- N1：仍为 `CLOSED`。provider test/harness、package-version compiled variants、private/test addon 与全部指定 testing controls/sentinels 的 pack 命中均为 `0`；production addon 精确 `1`，公开 runtime、bin、声明和 source maps 保留。
- reviewer fresh 运行 package-version `5/5` 与 test-discovery `5/5`，并独立检查最终 npm pack 清单、逐文件内容、negation 语义、依赖/lockfile 与修改范围。
- 新发现：`0 Critical / 0 Important / 0 Minor`。结论：`APPROVED`，Task 1 正式完成。
