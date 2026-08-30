### Task 2: 建立 observed I/O、稳定读取和封闭 inventory builder

**Files:**

- Create: `src/core/authority/observed-io.ts`
- Create: `src/core/authority/stable-bytes.ts`
- Create: `src/core/authority/inventory.ts`
- Create: `src/core/authority/test/observed-io.test.ts`
- Create: `src/core/authority/test/stable-bytes.test.ts`

**Interfaces:**

- Produces `ObservedIoCountersV1`, `ObservedFileV1`, `ObservedDirectoryV1`, `StableByteCaptureV1`.
- Inventory supports typed archive keys and exact receipt-referenced auxiliary target discovery.
- Every capture records actual syscall-level wrapper invocation and detects read races/type/symlink/mode changes.

- [x] **Step 1: 写 read-once/race RED tests**

Construct a fixture with metadata/tasks/flow/decisions/evidence/runs/transactions/progress plus an unreferenced decoy. Assert each declared path is read exactly once, decoy is not read, and replacing bytes/mode between descriptor reads fails without retry.

- [x] **Step 2: 实现 no-follow stable readers**

```ts
export type ObservedIoCountersV1 = Readonly<{
  fileOpens: ReadonlyMap<string, number>;
  directoryReads: ReadonlyMap<string, number>;
  stableCaptures: ReadonlyMap<string, number>;
}>;
```

Readers accept already-contained roots/normalized relative tokens, open final nodes without following symlinks, validate regular-file/directory type, bytes and mode, then return immutable bytes plus observation. Directory inventories are code-unit sorted.

- [x] **Step 3: 实现 typed archive/receipt inventory**

Reject duplicate logical keys, same logical identity with two hashes, unknown auxiliary targets and archive-key collision. No validator may call `readFile/readdir/stat` directly after receiving inventory.

- [x] **Step 4: GREEN 和提交**

```bash
npm run build
node --test dist/src/core/authority/test/observed-io.test.js dist/src/core/authority/test/stable-bytes.test.js
git add src/core/authority/observed-io.ts src/core/authority/stable-bytes.ts src/core/authority/inventory.ts src/core/authority/test/observed-io.test.ts src/core/authority/test/stable-bytes.test.ts
git commit -m "实现：建立可观测的一次性权限库存读取"
```

Expected GREEN: 两个 focused tests退出 0；读取次数来自真实 wrapper observation；commit只包含本任务文件。

---

## 执行结果（2026-08-27）

- 真实初始 RED：focused strict `tsc` 退出 `2`，新增测试精确报告
  `observed-io.js`、`stable-bytes.js`、`inventory.js` 不存在；生产实现尚未创建。
- 后续行为 RED：目录竞态 seam 缺失、空 inventory 接受伪造 recorder、stable request 接受
  accessor/额外 own key、未引用辅助候选参与 selected path collision，均先由真实失败证明再修正。
- 最终 focused strict compile 退出 `0`；全仓 build 产物上的两个 suite 为 `22/22`，fail `0`。
- inventory fixture 覆盖 metadata/tasks/flow/decisions/evidence/runs/transactions/progress/archive 与
  receipt 选中的 auxiliary；未引用 decoy 没有 file open 或 stable capture。
- fresh 回归：provider `33/33`、Plan01 `185/185`、ownership `25/25`、native workflow `9/9`；
  repo typecheck/build 均保持预期 `888 diagnostics / 76 files`，Task2 diagnostics 为 `0`。
- transition P01 exit `0`；P02 因 Task3–5 尚未实施预期 exit `1`，`regressions=[]`。
