# Plan02 Task 2 实施报告

> 当前状态：Task 2 已通过规格与质量最终独立复审，结论均为 `APPROVED`；全部旧 finding 关闭，
> 最终新增 `0 Critical / 0 Important / 0 Minor`。Task 3 可按独立 brief 开始。

## 结果

Task 2 建立了唯一的内部 observed-I/O recorder、Linux no-follow 稳定文件/目录读取器，以及只消费
冻结 capture 的 typed authority inventory。没有进入 Task 3 context/seal、Task 4 SourceRef、root/CLI
export、旧 paths/execution 或 Task 1 provider 生产代码。

## 内部 API

- `createObservedIoRecorder()` 产生 capability-backed recorder；`snapshot()` 返回三张运行时不可变的
  `ReadonlyMap` 副本，保留真实 wrapper 调用顺序与次数。
- `captureStableBytes()` 返回冻结 `StableByteCaptureV1`。字节只通过 `copyBytes()` 的新
  `Uint8Array` 副本暴露；观察记录、capture 与返回 inventory 都深冻结。
- `observeStableDirectory()` 返回冻结 `ObservedDirectoryV1`，entry 使用 JavaScript UTF-16
  code-unit 顺序，inventory hash 使用长度帧定界。
- `buildAuthorityInventoryBase()` 先捕获 logical/archive 基础库存并返回 WeakMap-backed、不可伪造的
  `BASE` capability；`finalizeAuthorityInventory()` 只允许消费一次，并只捕获已验证 receipt reference
  精确匹配的 known auxiliary target。基础 capture、父目录观察与 identity 观察跨阶段复用且零重读。
- 同一 receipt 可引用多个不同目标；不同 receipt 可共享同一目标且只捕获一次。只有完全相同的
  `(receiptId, targetKey, relativePath)`、未知 target 或 target/path 冲突会在任何 auxiliary I/O 前拒绝。
- 生产模块不再导出 `*WithInternalSeamForTesting`；确定性竞态测试在隔离 child 中替换 Node builtin，
  仍调用真实 `FileHandle` syscall，并在退出前恢复 builtin。

## 安全与一致性

- root 必须是已包含的规范绝对路径；relative token 拒绝 absolute、empty、NUL、dot/dotdot、反斜线、
  percent、非 NFC、控制字符、空 segment、尾斜线和字节越界。
- root/逐层 parent 以 descriptor 锚定；每个 nested component 使用
  `/proc/self/fd/<dirfd>/<component>` 加 `O_DIRECTORY|O_NOFOLLOW` 打开。final file 使用
  `O_NOFOLLOW|O_NONBLOCK`，因此 FIFO 不等待 writer；final directory 额外要求 `O_DIRECTORY`。
- file/directory descriptor 前后均以 bigint `fstat` 比较 dev、ino、type、mode、size、mtime、ctime；
  final pathname 与每层 parent 再做 anchored bigint `lstat` identity 比较。任何 bytes、mode、entry、
  rename 或 parent-symlink swap 竞态都失败且不 retry。
- 每条关闭路径都尝试关闭全部已取得 FD；存在主失败时保留主失败，只有无主失败时才传播 close
  failure。
- inventory 在 I/O 前拒绝 duplicate logical/archive/auxiliary key、selected path collision、unknown/
  exact-duplicate/conflicting receipt ref；捕获后拒绝同一 `(nodeType,dev,ino)` 对应两个 content hash 或 mode。
  未被 receipt 选中的候选不参与 selected 跨域碰撞，也不为自身触发 directory read、file open 或
  stable capture；若与 selected target 共享 parent，该 parent 仍只按 selected manifest 观察一次。
- `ReadonlyMap` 只保存冻结的私有 entry array，不持有可由 `Map.prototype` 取得的 backing Map；跨阶段
  私有状态同样使用 entry array，WeakMap capability 访问绑定模块初始化时的原生 intrinsic。运行期替换
  `Map`/`WeakMap` prototype 不能取得或篡改 base state。
- 三个 Task2 生产模块在初始化时绑定 `Array.prototype.push` 与 `Reflect.apply`；counter、FD handles/
  anchors、readonly map、selected/inventory entries 及跨阶段 directory/identity 等私有数组均不再把
  receiver 交给运行期替换的 `Array.prototype.push`。生产源码的动态 `.push(` 扫描为零。
- `copyBytes()` 使用模块初始化时捕获的 `Uint8Array` 构造器并逐索引复制；不会把私有字节交给
  `Uint8Array.from`、`Buffer.from`、`subarray` 或后来替换的全局构造器；分配与循环只使用闭包中已认证
  标量 `total`，不会读取 private typed array 的继承 `length` accessor。
- `FrozenReadonlyMap.forEach()` 用初始化时绑定的 `Reflect.apply` 执行 callback，符合普通 Map 的内部
  Call 语义；callable 的自有 `call` 属性不能截获调用。
- observed counter 没有独立生产 mutator；执行真实 final open/readdir 的封装拥有相应计数更新。
  stable/inventory 的 request、array、target、key、reference 与 base 都在任何反射前拒绝 Proxy。
- inventory 模块不导入 `node:fs`，完成后的 validator 可只使用冻结 entries/maps/captures 和 defensive
  byte copies。

## TDD 证据

1. 初始测试先落盘；focused strict compile 真实退出 `2`，`TS2307` 精确指出三个生产模块不存在。
2. 目录竞态矩阵先以缺少 internal seam 的 `TS2305` 退出 `2`，随后 entries/mode/rename 三项转绿。
3. 伪造 recorder 测试先以 `Missing expected rejection` 退出 `1`，随后零目标 inventory 也验证真实
   recorder capability。
4. stable request/accessor 与未引用 auxiliary collision 两项同场先以两个真实失败退出 `1`；随后
   request descriptor-authenticated 且未引用候选与 selected inventory 隔离。
5. round 1 首批回归在 `2eac376` 生产实现上为 `22 pass / 4 fail`，真实暴露 Proxy、Map prototype、
   裸 counter mutator 与可替换 byte-copy helper；完整回归随后还以 focused compile exit `2` 暴露
   两阶段 API 缺失及旧 testing seam 仍导出。
6. 最终两个 focused suite 为 `33/33`，新增覆盖不可伪造/单次 finalize、基础零重读、receipt 多目标与
   共享目标、shared/new auxiliary parent、跨阶段 identity 冲突、transparent/throwing/revoked Proxy、
   intrinsic 隔离、生产导出面与带显式 mode 的 DIRECTORY target。
7. round 2 三项回归在 `0b45bc1` 生产实现上真实为 `33 pass / 3 fail`：替换后的 push 同时取得
   counter/directory/identity/handles/anchors/readonlyMap/inventory 七类私有 receiver，typed-array length
   getter 被读取 `5` 次，callable 自有 `call` 截获 `forEach`。修复后同一套件为 `36/36`。

## Fresh 验证

| 验证 | 结果 |
|---|---|
| Task2 五文件 focused strict `tsc --noEmit` | exit `0` |
| Task2 两个 focused suite（fresh focused emit 产物） | `36/36`，exit `0` |
| Task1 provider | `33/33`，exit `0` |
| Plan01 final 七文件 suite | `185/185`，exit `0` |
| diagnostic ownership | `25/25`，exit `0` |
| native workflow gate | `9/9`，exit `0` |
| recursive test discovery | `5/5`，exit `0` |
| package/version/pack surface | `5/5`，exit `0`；pack `819` files，root tests `88`、module-local tests `15` |
| repo `typecheck` | 预期 exit `2`；`888 diagnostics / 76 files`；Task2 `0` |
| repo `build` | native 成功后预期 exit `2`；`888 / 76`；Task2 `0` |
| native provider artifact | SHA-256 `05a9d0eddcd08e1fe9c1ee5d159b1833001b4c6f9cd2c19a8fcfa3ea9fceed99` |
| transition P01 | exit `0`；past/unowned/open `0`；`regressions=[]` |
| transition P02 | 预期 exit `1`；past `7/1`、open `31`；`regressions=[]` |
| diff / dependency hygiene | `git diff --check` 通过；dependencies 与 lockfile 无变化；无 Task3、root/CLI/旧 execution 变化 |

## 已知边界

- 读取协议是明确的 Linux `/proc/self/fd` + POSIX open flags 合同；没有 pathname 或跨平台 fallback。
- `containedRoot` 必须由上游 provider/context 先完成仓库包含认证；本层只拒绝 root 自身的非规范拼写、
  final symlink 和读取期间的 identity 漂移，不重新发现仓库。
- capture 是一次性受验快照，不声称阻止返回后的外部修改；Task 3 的 `MachineAuthoritySeal` 负责写前/
  提交时重新认证机器目标。
- receipt 的 schema/chain 认证属于 Task 3；本层只接受该认证之后的 refs，并执行 exact key/token
  discovery，不建立第二套 receipt 持久 schema。

## 独立审查 round 1

- 规格审查：`0 Critical / 2 Important / 1 Minor`，结论 `CHANGES_REQUESTED`。
- 防御性质量审查：`0 Critical / 5 Important / 2 Minor`，结论 `CHANGES_REQUESTED`；与规格审查的
  不可变性问题合并后处理。
- 必修项：两阶段 inventory/finalize 且基础 capture 零重读；允许一份 receipt 精确引用多个不同目标；
  私有条目 backing 的只读 map；不把私有字节交给可替换复制内建；真实 I/O 封装拥有 counter 更新；
  stable/inventory 边界先拒绝 Proxy；测试 seam 不进入发布 API。
- 补测项：DIRECTORY inventory target；以上每项都须先有在 `2eac376` 上失败的回归证据。

## Round 1 修复结论

- 上述必修项与补测项均已实现并通过 fresh 验证；生产 API 改为不可伪造的两阶段 base/finalize，
  base capability 在进入任何异步 I/O 前即原子消费。
- 全部私有 inventory/counter backing 改为 entry array；跨阶段 WeakMap 访问与 byte constructor 均绑定
  模块初始化 intrinsic。隔离 child 证明 finalize 前替换 `Map`/`WeakMap` prototype、capture 返回后替换
  `globalThis.Uint8Array` 均不能影响结果或取得 backing。
- 当前状态仅为“round 1 修复完成，待独立复审”。没有将 Task 2 标记为最终批准，也没有开始 Task 3。

## 独立审查 round 2 与质量修复

- 规格复审结论为 `APPROVED`；质量复审确认 I2/I3 尚未完全闭合，因此 Task 2 整体仍不得批准。
- I2：虽已移除 Map backing，多个私有 entry/state arrays 仍通过动态 `.push()` 把 receiver 交给可替换
  `Array.prototype.push`。隔离 RED 证明七类 Task2 私有数组全部可被取得。
- I3：`copyBytes()` 虽绑定构造器，仍从 private typed array 读取继承的 `length`；隔离 RED 精确记录
  `5` 次 getter 访问。质量候选 Minor 同时指出 `forEach()` 不应读取 callback 的自有 `.call`。
- 修复后所有 Task2 生产 `.push(` 均由模块初始化捕获的 intrinsic + `Reflect.apply` 取代；copy 分配/
  循环只消费认证标量 `total`；`forEach()` 同样使用捕获的 `Reflect.apply`。三个 RED 均转绿。
- 当前状态仅为“round 2 质量修复完成，待独立质量复审”。规格批准不等于 Task 2 最终批准，Task 3
  仍未开始。

## 最终独立复审

- 规格审查先在 `2eac376..0b45bc1` 批准两阶段交接、receipt 基数和 DIRECTORY/read-once，不回归
  复审再于 `0b45bc1..b07c38c` fresh 验证 strict compile 与 Task2 `36/36`；两轮均 `APPROVED`。
- 质量最终复审逐项关闭 private array `push`、private typed-array `length` 与 `forEach` Call 三项；
  fresh strict compile/emit、Task2 `36/36`、test-discovery/package-version `10/10`、pack layout 与生产
  导出扫描全部通过。
- 最终结论：`APPROVED`，新增 `0 Critical / 0 Important / 0 Minor`。Task 2 正式完成。
