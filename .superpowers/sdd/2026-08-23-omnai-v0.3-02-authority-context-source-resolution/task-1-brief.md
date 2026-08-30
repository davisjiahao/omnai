### Task 1: 实现 VERIFIED_FD_EXECVEAT_V1 原生 provider

**Files:**

- Create: `binding.gyp`
- Create: `native/verified-fd-provider/verified_fd_provider.c`
- Create: `scripts/build-native-provider.mjs`
- Create: `src/core/git-provider/native-binding.ts`
- Create: `src/core/git-provider/provider.ts`
- Create: `src/core/git-provider/types-internal.ts`
- Create: `src/core/git-provider/test/provider.test.ts`
- Create: `src/core/git-provider/test/provider-race-harness.ts`
- Modify: `package.json`

**Interfaces:**

- Internal `acquireGitProvider(): FrozenGitProviderBindingV1`.
- Internal `runGit(binding, { repositoryRoot, args }): GitCommandResultV1`.
- Native binding exposes only bounded `acquire`/`execute`; it owns descriptor validation, pipes, fork, child cwd `/`, fd closure, `execveat(AT_EMPTY_PATH)`, wait and post-child reopen.
- `npm run build:native` compiles the N-API source for the current supported Linux target and copies the exact `.node` artifact to `dist/native/verified_fd_provider.node`；`npm run build` depends on it，`npm pack` includes it through `dist`，Plan 07再把其raw hash绑定到frozen bundle manifest。

- [ ] **Step 1: 写 provider gate RED 测试**

Cover absent candidates, symlink/magic-link component, non-root owner, group/world writable file, non-regular node, invalid version framing, missing syscall, swap before exec, swap during child and poisoned parent environment. Assert before-owner result is exactly `GIT_PROVIDER_UNAVAILABLE` and no observation callback fires.

```ts
const expectedEnvironment = {
  GIT_ATTR_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_NO_LAZY_FETCH: '1',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  HOME: '/nonexistent',
  LANG: 'C',
  LC_ALL: 'C',
  TZ: 'UTC',
  XDG_CONFIG_HOME: '/nonexistent',
} as const;
```

Run:

```bash
npm run build:native
npm run build
node --test dist/src/core/git-provider/test/provider.test.js
```

Expected RED: native target/module and provider functions are absent.

- [ ] **Step 2: 实现 native descriptor protocol**

In C, encode explicit phases `OPEN_CANDIDATE -> VERIFY_METADATA -> HASH_BYTES -> EXECUTE_FD -> WAIT -> REOPEN_AND_COMPARE -> ACCEPT_OUTPUT`. The executed call is structurally:

```c
execveat(executable_fd, "", argv, envp, AT_EMPTY_PATH);
```

Use `openat2` with `RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS`, require uid 0, regular file, executable mode and `(mode & 0022) == 0`. Stable-read verifies pre/post `fstat` identity/size/mtime/ctime. After wait, reopen and compare device/inode/mode/uid/hash before returning any child bytes. Bound stdout/stderr and reject overflow.

- [ ] **Step 3: 实现 TypeScript binding/hash/error map**

```ts
export function freezeProvider(native: NativeProviderResult): FrozenGitProviderBindingV1 {
  const body = frozenGitProviderBindingBodySchema.parse({
    schemaVersion: 1,
    environmentProtocol: 'SANITIZED_GIT_ENV_V1',
    executionProtocol: 'VERIFIED_FD_EXECVEAT_V1',
    executableCandidatePath: native.candidatePath,
    executableRealPath: native.realPath,
    executableRawBytesHash: native.bytesHash,
    gitVersion: decodeCanonicalVersion(native.stdout),
  });
  return { ...body, bindingHash: hashStrictObject(body) };
}
```

The JS wrapper never decodes/uses output until native postcheck success. Owner-family mapping is passed only after a trusted matching owner has been selected; before that every provider failure is `GIT_PROVIDER_UNAVAILABLE`.

- [ ] **Step 4: GREEN、trace assertion 和提交**

```bash
npm run build:native
npm run typecheck
npm run build
node --test dist/src/core/git-provider/test/provider.test.js
rg -n "execFile|spawn|execSync|spawnSync|PATH" src/core/git-provider native/verified-fd-provider
git add binding.gyp native/verified-fd-provider scripts/build-native-provider.mjs src/core/git-provider package.json
git commit -m "实现：增加受验文件描述符 Git provider"
```

Expected: race harness shows only `execveat(..., AT_EMPTY_PATH)` for Git; malicious sentinel never executes; source scan has no pathname Git launch/fallback.
---
