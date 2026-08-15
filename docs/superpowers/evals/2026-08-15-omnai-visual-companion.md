# OmnAI Visual Companion formal test record

- Date: 2026-08-15
- Branch: `feat/omnai-v0.2-personal-workspace`
- Evaluated implementation commit: `bd233620bdfff88528a43df3bd0d20b969766280`
- Runtime used locally: Node.js 24.19.0
- Compiler available in the isolated runner: TypeScript 7.0.2 with Node types 20.19.43

## Result

The built-in Visual Companion implementation, protocol contract, package contents, and loopback security boundary pass deterministic and HTTP integration testing. The cloud browser correctly refused access to the process-local `127.0.0.1` URL, so visual appearance and real keyboard interaction remain a required local-browser check and are not marked PASS here.

The latest branch includes the Workset protocol mapping and all 40 canonical resources, so the original whole-tree TypeScript gate now passes. Visual browser appearance remains the only companion-specific pending gate.

## Deterministic and integration gates

| Gate | Result | Evidence |
| --- | --- | --- |
| Feature-focused tests | PASS | 10 tests passed: protocol packaging, closed schemas, CLI validation, unsafe HTML rejection, responsive/accessibility contracts, loopback server, live reload, and no state write. |
| Whole-tree TypeScript check | PASS | Strict no-emit compilation passed with no file excluded. |
| Repository regression suite | PASS | 202 Node test cases passed with `TMPDIR=/dev/shm`; the environment-blocked npm-pack subprocess was reproduced separately through npm's own `libnpmpack` implementation and also passed. |
| Browser script parse | PASS | The exact emitted `VISUAL_COMPANION_JS` parsed successfully. |
| Package construction | PASS | Local `libnpmpack` construction produced a 219,793-byte tarball with SHA-512 integrity. |
| Package inventory | PASS | 376 tar entries; 12 emitted Visual Companion files and all 40 canonical protocol resources were included. |
| Installed-package smoke | PASS | The unpacked tarball loaded `common.authoritative-work + interaction.show-me` and validated a `directions` document through the packaged CLI. |
| Real cloud-browser access to loopback | EXPECTED BLOCK | The browser returned `ERR_BLOCKED_BY_CLIENT` for the token-scoped `127.0.0.1` URL. A `data:` simulation was also prohibited, so no policy workaround was attempted. |
| Local Chrome/Safari visual and keyboard QA | PENDING | Must be run on a machine whose browser shares the companion process loopback network. |

## Security and behavior coverage

The passing tests establish that:

- only `directions`, `flow`, and `step-through` documents are accepted;
- arbitrary HTML document kinds and invalid language tags are rejected;
- the server binds to `127.0.0.1` behind a cryptographically random path token;
- only GET and HEAD are accepted, POST is rejected, and an invalid token returns not found;
- restrictive CSP, no-referrer, no-frame, no-sniff, and no-store headers are emitted;
- rendered values use text nodes; `innerHTML`, `eval`, and `new Function` are absent;
- input changes are revalidated and reloaded without creating companion state;
- responsive, dark-mode, reduced-motion, focus-visible, ARIA, and Chinese-language contracts are present;
- non-linear flow graphs do not receive misleading implicit sequential arrows;
- `resources/` is present in the npm package allowlist, fixing the missing installed protocol defect found during this test pass.

## Remaining local-browser checklist

Run the following from an installed or built package, then open the returned URL in a browser on the same machine:

```bash
omnai visual validate /tmp/omnai-visual.json --json
omnai visual companion /tmp/omnai-visual.json --json
```

Verify at desktop and narrow mobile widths:

1. all two-to-four direction cards have equal fidelity and readable Chinese labels;
2. Tab reaches every direction and step control, and focus is clearly visible;
3. Enter/Space selects a direction and Previous/Next changes one step at a time;
4. linear flows show only valid sequence arrows and non-linear flows rely on exact relationship labels;
5. dark mode and reduced-motion preferences are respected;
6. editing the temporary JSON refreshes the presentation without losing safety boundaries;
7. stopping the CLI makes the token URL unavailable and leaves no workflow or companion state behind.

The Visual Companion must not be described as fully browser-verified until this checklist is recorded as PASS on a same-machine browser.
