# Verification record

## Baseline (before final fixes)

- Focused initial tests: 6 files, 56 tests passed. This does not cover full feature acceptance.
- Full initial suite: 224 passed files, 3 failed files, 1 skipped; 2021 passed tests, 16 failed, 4 skipped. Log: `/tmp/enso-files-full-tests.log`.
- `browserHost.test.ts` import failure is a feature regression; assigned to browser implementation owner.
- Clean HEAD was exported with `git archive HEAD` to `/tmp/enso-files-baseline`, using the same installed dependencies. Its TypeScript check reproduces errors in agent learn/memory/messageCoworker, session stallTimeout tests, and missing AGENT_MEMORY capability disposition. Log: `/tmp/enso-files-baseline-types.log`.
- Baseline supervisor test comparison: `/tmp/enso-files-baseline-tests.log`.

## Final validation

- Independent backend and UI/browser re-review completed; all reported blockers fixed, including reveal-label localization.
- Final focused gate: 12 files / 95 tests passed (main filesystem IPC/services, clipboard, browser authority/security/persistence, renderer lifecycle helpers, i18n, capability coverage).
- Changed-file Biome: 15 tracked + 10 new TypeScript/TSX files clean; `git diff --check` clean.
- Final `pnpm build` exited 0; log `/tmp/enso-files-final-build.log`.
- Full rerun after shell-test timeout isolation: 230 passed test files, 2 failed supervisor files, 1 skipped; 16 failing tests. Log `/tmp/enso-files-backend-full-tests.log`. The same two supervisor files fail on clean HEAD using the same dependencies.
- Typecheck remains blocked by reproduced clean-HEAD errors in agent learn/memory/messageCoworker and session stallTimeout tests; no feature-file diagnostics. Log `/tmp/enso-files-final-types.log`.
- No commit: repository commit discipline requires green full tests/typecheck; unrelated baseline repairs are outside this task.

## Additive: Markdown preview raw HTML support (files-only)

- New deps: `rehype-raw`, `rehype-sanitize`, `hast-util-sanitize` (pnpm).
- New/changed files:
  - `src/shared/markdownPreviewImage.ts` (+test): remote/data URL detection, workspace-relative image path resolution (`..` allowed within root, escapes rejected), bitmap-extension → mime allowlist (svg excluded).
  - `src/renderer/components/sidepanel/filePreviewSanitize.ts` (+test): `buildFilePreviewSanitizeSchema()` extends hast-util-sanitize's GitHub-style default schema, only adding `data:` to the `img.src` protocol allowlist; `href` protocols unchanged (no `javascript:`), `script`/`style` still stripped.
  - `src/renderer/components/sidepanel/filePreviewMarkdown.tsx`: `FileMarkdownPreview` — `ReactMarkdown` + `remarkGfm` + `[rehypeRaw, [rehypeSanitize, schema]]`, reuses chat's `markdownComponents`/`MarkdownCtx` (exported, chat behavior unchanged) with a custom `img` renderer that resolves relative src via IPC and swaps in the returned data URL; non-relative/unsupported src pass through untouched (blocked by existing CSP as before, no regression).
  - `src/main/services/filesWorkspace.ts` (+test): `readLocalImage(abs, mime, maxBytes)` reads local files bounded by `PREVIEW_IMAGE_MAX_BYTES` (5MB) and returns a data URL.
  - `src/main/ipc/filesWorkspace.ts` (+test in `filesWorkspace.test.ts`): new `FILES_READ_IMAGE` handler mirrors the existing `FILES_READ_REL` local/SSH branching (`resolveLocalUnderCwd` / `resolveRemoteUnderCwd`), rejects unsupported extensions before touching disk, and reads SSH bytes via `base64 < "$1"` over stdin (avoids BSD vs GNU `base64` positional-arg incompatibility caught by the new SSH test).
  - `src/shared/types/{ipc,filesWorkspace}.ts`, `src/preload/index.ts`: new `files:read-image` channel + `workspaceFiles.readImage` + `FilesReadImageResult` type.
  - `src/renderer/components/sidepanel/FilesView.tsx`: both preview render paths (standalone preview tab and same-tab source/preview toggle) now use `FileMarkdownPreview` with `baseDirRel = dirOf(fromPreviewKey(active.rel))` and a `resolvePreviewImage` callback wrapping `workspaceFiles.readImage`.
  - `src/renderer/components/chat/Markdown.tsx`: exported `markdownComponents`/`MarkdownCtx` for reuse (no behavior change; chat still uses the same component, no raw-HTML/rehype-raw wiring there).
  - `src/tooling/productCapabilityCoverage.fixture.ts`: added `FILES_READ_IMAGE` disposition entry (required by the coverage fixture type).
- TDD: red confirmed for `markdownPreviewImage.test.ts`, `filePreviewSanitize.test.ts`, and the `readLocalImage` cases in `filesWorkspace.test.ts` (missing module / `is not a function`) before implementing; green after.
- Gates run: `pnpm exec vitest run src/shared/markdownPreviewImage.test.ts src/renderer/components/sidepanel/filePreviewSanitize.test.ts src/main/services/filesWorkspace.test.ts src/main/ipc/filesWorkspace.test.ts src/shared/browser/urlPolicy.test.ts src/shared/browser/tabPersist.test.ts` — 6 files / 61 tests passed. Full `pnpm exec vitest run` — same 2 pre-existing `supervisor.coworkerWait.test.ts` failures reproduced on clean HEAD (unrelated, not touched). `pnpm exec tsc --noEmit` — no diagnostics in any file touched by this change (remaining errors are pre-existing baseline, reproduced without this change). `pnpm exec biome check` clean on all touched/new files. `pnpm run build` exits 0.
- Manual limitations: not verified against a running Electron window (no CDP session in this pass); SVG images in Markdown are intentionally not rendered (unsupported extension, avoids embedding scriptable SVG content) — scope decision, not a bug.

## Follow-up: remote (http/https) Markdown preview images, with SSRF guard

The README acceptance case includes remote badge images (`https://img.shields.io/...`), which the first pass left CSP-blocked. Fixed with a bounded, SSRF-hardened main-process proxy — chat rendering still untouched.

- New files:
  - `src/shared/remoteImageGuard.ts` (+test): `isAllowedRemoteImageUrl` (protocol allowlist http/https only, rejects userinfo, `localhost`/`*.local`, literal private/reserved IPv4 — RFC1918, loopback, link-local incl. `169.254.169.254` cloud metadata, CGNAT, `0.0.0.0/8` — and IPv6 — loopback, link-local, unique-local `fc00::/7`, IPv4-mapped).
  - `src/main/services/remoteImageFetch.ts` (+test): `fetchRemoteImageDataUrl` — resolves the hostname once via `dns.lookup`, re-validates the **resolved IP** with the same guard before connecting (closes the DNS-rebinding gap: a domain that answers with a public IP on lookup but a private IP at connect time), then connects directly to that pinned IP (`Host`/SNI still set to the original hostname). Redirects are followed up to 3 hops, each hop re-validated (URL string + resolved IP) the same way as the first. Response `Content-Type` is checked against a bitmap allowlist (no `image/svg+xml`), size is capped both via `Content-Length` and a running byte counter during streaming (5MB, same cap as local images), and a request timeout applies. All external checks (`isAllowedUrl`, `isAllowedAddress`, `resolveHost`) are injectable for deterministic testing without depending on live DNS/network.
  - Test approach: real `node:http` test servers on `127.0.0.1` prove (a) a literal-private-IP URL is rejected before connecting, (b) a "looks public" hostname that resolves to `127.0.0.1` is rejected (DNS-rebinding case, verified red without the resolved-IP check before re-adding it), (c) a legit bitmap response round-trips to the expected data URL, (d) non-bitmap `Content-Type` (incl. `image/svg+xml`) is rejected, (e) oversized bodies are rejected, (f) a redirect to a private target is not followed.
- Wiring: `IPC_CHANNELS.FILES_FETCH_REMOTE_IMAGE` (`files:fetch-remote-image`), `FilesFetchRemoteImageResult` type, `workspaceFiles.fetchRemoteImage` in preload, handler in `src/main/ipc/filesWorkspace.ts` (gated the same way as other `files:*` channels — requires an active conversation/project). Returns a `data:` URL, so no CSP change was needed (renderer already allows `data:` for `img-src`; `connect-src` still has no `http(s)`, so the renderer itself could never have fetched these directly — the main-process proxy is the only path, by design).
- `src/shared/markdownPreviewImage.ts`: added `classifyPreviewImageSrc` (local/remote/data/unsupported) and `normalizeRemoteImageUrl` (protocol-relative `//host/x` → `https://host/x`), both covered in `markdownPreviewImage.test.ts`.
- `src/renderer/components/sidepanel/filePreviewMarkdown.tsx`: `PreviewImage` now dispatches on `classifyPreviewImageSrc` — `local` → existing workspace `readImage` path, `remote` → new `resolveRemoteImage` (wraps `fetchRemoteImage`), `data` → used as-is (already validated by the sanitizer stage below), `unsupported` → not rendered.
- `src/renderer/components/sidepanel/FilesView.tsx`: added `resolveRemotePreviewImage` callback, passed to `FileMarkdownPreview` alongside the existing local `resolvePreviewImage`.

### Also fixed: sanitizer tests were schema-shape-only; now run the real HTML pipeline, and closed a real gap it found

- Rewrote `src/renderer/components/sidepanel/filePreviewSanitize.test.ts` to run actual malicious HTML strings through `unified().use(rehypeParse).use(rehypeSanitize, schema).use(rehypeStringify)` (new devDependencies: `unified`, `rehype-parse`, `rehype-stringify`; `hast-util-sanitize`/`rehype-raw`/`rehype-sanitize` were already added). Covers: README layout preserved (`p align`, `h1`, `b`, `img width`, `details`/`summary`); `<script>` stripped with its content; `onerror`/event-handler attributes stripped; `javascript:` hrefs rejected; legitimate `data:image/png` allowed; **`data:image/svg+xml` rejected**; `<svg onload><script>` fully stripped; `<img srcset="javascript:...">` stripped; `<iframe>`/`<object>`/`<embed>` rejected; `<style>` tag and inline `style=` attribute rejected.
- The `data:image/svg+xml` case was a genuine gap: `rehype-sanitize`'s protocol allowlist only inspects the URI *scheme* (`data:`), not the MIME subtype inside it — so allowing `data:` for `img.src` (needed so our own resolved bitmap data URLs render) also let an attacker-authored `<img src="data:image/svg+xml;base64,...">` straight through, since SVG is executable XML (can carry `<script>`/`onload`). Verified red (confirmed the assertion genuinely failed) before adding the fix, then green after: `src/renderer/components/sidepanel/filePreviewSanitize.ts` now exports `rehypeRejectUnsafeImageSrc`, a small post-sanitize rehype plugin that strips any `img.src` whose `data:` payload isn't one of the allowed bitmap MIME types (png/jpeg/gif/webp/bmp/x-icon). Wired into `filePreviewMarkdown.tsx`'s `rehypePlugins` chain, after `rehypeSanitize`.
- Also tightened the schema itself: `source` tag's `srcSet` attribute allowance (present in hast-util-sanitize's default GitHub-style schema for responsive `<picture>` images, not needed by this feature) is now overridden to an empty allowlist, closing an unused attack-surface corner.

### Re-verified gates after these fixes

- `pnpm exec vitest run <all touched test files>` (10 files) — 89 tests passed.
- Full `pnpm exec vitest run` — 234 passed / 2 failed test files (`supervisor.agentDispatch.test.ts`, `supervisor.coworkerWait.test.ts`), same pre-existing, unrelated agent-supervisor failures as the baseline noted above; no file/markdown-preview test is among the failures.
- `pnpm exec tsc --noEmit` — no diagnostics in any file touched by this change.
- `pnpm exec biome check --write` clean on all touched/new files.
- `pnpm run build` exits 0, no errors in the build log.

### Remaining manual limitation (updated)

- Not verified against a running Electron window (no CDP session in this pass) — in particular, the README's shields.io badges rendering correctly end-to-end (network-dependent, sandboxed test environment) was validated at the unit level (guard + fetch logic against local test servers) but not against the real `img.shields.io` host.
- SVG images (local or remote) are intentionally never rendered as images — scope decision for script-injection safety, not a bug.
- The remote-image proxy's SSRF guard blocks private/reserved/loopback/link-local/CGNAT ranges and re-validates the resolved IP before connecting (closing DNS rebinding), but does not attempt more exotic mitigations (e.g. per-request egress network namespace, allowlist-only domains) — judged proportionate to the threat (rendering an image, not exfiltrating data back to the attacker) and consistent with the project's effort/scope for this task.

## Follow-up: content-sniffing (don't trust extension / declared Content-Type)

Both the local-file `previewImageMime()` (extension-derived) and the remote fetch's `Content-Type` response header are attacker-influenced inputs (a workspace file can be named `logo.png` while containing SVG/HTML; a malicious/compromised remote server can declare `Content-Type: image/png` for an SVG body). Declaring a MIME type does not make the bytes that type. Added a magic-number check so the declared/derived MIME must match the actual content before it's ever turned into a `data:` URL:

- `src/shared/imageSniff.ts` (+test): `sniffImageMime(bytes)` reads file-format magic numbers for PNG/JPEG/GIF/WEBP/BMP/ICO; anything else (including SVG/HTML text) returns `null`.
- `readLocalImage()` (`src/main/services/filesWorkspace.ts`) now rejects with `unsupported` when `sniffImageMime(buf) !== mime`.
- The SSH branch of the `FILES_READ_IMAGE` handler (`src/main/ipc/filesWorkspace.ts`) applies the same check after decoding the `base64` output (previously unchecked — this branch didn't call `readLocalImage` at all).
- `fetchRemoteImageDataUrl()`'s success path (`src/main/services/remoteImageFetch.ts`) applies the same check against the fully-buffered response body before accepting the server's declared `Content-Type`.
- Updated `filesWorkspace.test.ts`, `main/ipc/filesWorkspace.test.ts`, and `remoteImageFetch.test.ts` fixtures to use real format magic bytes (previously arbitrary bytes like `[1,2,3,4]`, which would now correctly fail the new check), and added explicit "renamed/mislabeled SVG" regression cases for all three paths (local, SSH, remote).
- Re-ran the full gate list after this change: same 8 test files / 94 tests green, `tsc --noEmit` clean on touched files, `biome check` clean, `pnpm run build` exits 0, full `pnpm exec vitest run` — 235 passed / 2 failed files (same pre-existing unrelated agent-supervisor failures).

## Follow-up: peer review found two real correctness/coverage gaps — both fixed

### P0: reusing chat's `p`/`h1-h3`/`ul`/`ol`/`th`/`td` dropped README's `align`/`colSpan` etc.

`src/renderer/components/chat/Markdown.tsx`'s `markdownComponents.p` (and `h1`–`h3`, `ul`, `ol`, `th`, `td`) only destructure `{ children }` — correct for chat (mdast never carries HTML attributes there), but `FileMarkdownPreview` spread `...markdownComponents` wholesale, so any raw-HTML attribute rehype-sanitize explicitly allows (`<p align="center">`, `<h1 align>`, native-HTML-table `colSpan`) was silently dropped once it reached these shared components. This is exactly the README's most common layout pattern (centered images/headings) and native HTML tables.

- Fix: `filePreviewMarkdown.tsx` now defines its own `p`/`h1`/`h2`/`h3`/`ul`/`ol`/`th`/`td` overrides (`Components['p']` etc., properly typed against `react-markdown`'s per-tag prop shape) that destructure `{ children, node, ...rest }` and spread `rest` onto the element, then merges them **after** `...markdownComponents` so they take precedence. Chat's `Markdown.tsx` is untouched — still only exports `markdownComponents`/`MarkdownCtx` (already exported for reuse in the first pass), no behavior change there.
- The `img` override similarly now captures and forwards `...rest` (width/height/align/title) instead of only `src`/`alt`.
- Added `src/renderer/components/sidepanel/filePreviewMarkdown.test.tsx`: a `renderToStaticMarkup`-based regression test (new file type — `vitest.config.ts`'s `include` now also matches `src/**/*.test.tsx`; `environment: 'node'` already works fine for `renderToStaticMarkup`, no jsdom needed). The chat `Markdown` module is mocked (it has renderer-only top-level side effects — `window.electronAPI...` — that crash under plain Node; the mock replicates chat's *real*, currently-buggy* `p`/`h1`/`th`/`td` implementations so the test actually exercises the reported bug, not a strawman). Verified genuinely red (3 of 4 assertions failed) with the merge order reverted to `...markdownComponents` only, before restoring the fix and confirming green.
- Data-URL images (`data:image/png;base64,...`) are used in the test specifically because `renderToStaticMarkup` doesn't run `useEffect`, so local/remote image resolution (async) can't be observed synchronously — the `data:` case resolves in the `useState` initializer instead.

### A second, independent bug the regression test surfaced: react-markdown's own `urlTransform` blanks `data:` URIs

Writing the `data:` image test above initially failed with an *empty* `<img>` even after the P0 fix, tracing to `react-markdown`'s `defaultUrlTransform` (`node_modules/react-markdown/lib/index.js`): it applies its own protocol allowlist (`/^(https?|ircs?|mailto|xmpp)$/i`) to every `img`/`a` URL attribute on the hast tree, **after** our rehype pipeline (`rehypeRaw` → `rehypeSanitize` → `rehypeRejectUnsafeImageSrc`) has already run and explicitly allowed it, and **before** handing off to our React components. Since `data:` isn't in that list, any directly-authored `data:image/...` in a file's raw HTML (a valid, if uncommon, pattern) silently rendered as `<img src="">`. This did **not** affect our own async-resolved images (local workspace files, remote-fetched images) since those are set via React state and rendered as a brand-new `<img>` element outside react-markdown's tree-walk, bypassing `urlTransform` entirely — so the previously-reported "remote images now work" claim for the async path was unaffected, but a literal inline `data:` image in a file would have been broken.

- Fix: pass `urlTransform={(url) => url}` (identity) to `<ReactMarkdown>` in `filePreviewMarkdown.tsx`, with a comment explaining that URL/protocol safety is already fully handled earlier in the pipeline (rehype-sanitize's schema + `rehypeRejectUnsafeImageSrc`), so disabling this redundant, overly-strict layer doesn't reduce security — it only stops it from wrongly blanking URIs we've already vetted and intentionally allow.
- Confirmed via the same regression test (red before the fix with the exact `data:` URL scenario, green after).

### SVG support (the actual missing piece for README's shields.io badges)

Separately raised: shields.io serves badges as `image/svg+xml` by default (confirmed — that's the actual content type of the README's badge URLs), so the "remote images now render" fix from the previous round was **incomplete**: SVG was explicitly excluded everywhere (local `previewImageMime`, remote `ALLOWED_CONTENT_TYPES`, `sniffImageMime`, and the sanitizer's `rehypeRejectUnsafeImageSrc`), so badges would still have silently failed to render, contradicting the earlier claim that README rendering was fixed.

Re-examined the actual browser security model: SVG loaded via a real `<img>` element (including `<img src="data:image/svg+xml;base64,...">`) is rendered by browsers in a distinct **"SVG-as-image" security context** — scripting, external resource fetches, and interactivity are all disabled by the browser regardless of the SVG's content, *as long as it's never parsed into a live DOM node* (i.e., never via `dangerouslySetInnerHTML`, inline `<svg>` elements, `<object>`, `<embed>`, or `<iframe>`). This project's implementation structurally guarantees that: `<svg>` is not in `hast-util-sanitize`'s `tagNames` whitelist (so raw `<svg>...</svg>` HTML blocks are stripped/unwrapped, never rendered as live DOM), and every resolved image (local, remote, or literal data URI) is rendered exclusively through a real React `<img>` element, never `dangerouslySetInnerHTML`. This is the same pattern used by GitHub, npm, and effectively every site that renders user-supplied SVG badges/avatars safely.

- `src/shared/imageSniff.ts`: added `looksLikeSvg()` (+test) — tolerant of BOM/leading whitespace/XML prolog/comments before the `<svg` root, deliberately conservative (SVG must be at the very start of the sniff window, not merely present somewhere in arbitrary text) so unrelated HTML/text isn't misidentified as an image. `sniffImageMime()` now returns `'image/svg+xml'` for content that passes this check.
- `src/shared/markdownPreviewImage.ts`: `previewImageMime()` now maps `.svg` → `image/svg+xml`, with an updated comment explaining the SVG-as-image safety rationale.
- `src/main/services/remoteImageFetch.ts`: `ALLOWED_CONTENT_TYPES` now includes `image/svg+xml`.
- `src/renderer/components/sidepanel/filePreviewSanitize.ts`: `rehypeRejectUnsafeImageSrc`'s allowlist regex now includes `svg\+xml`; doc comments rewritten to state the safety rationale precisely (real `<img>` DOM element only, `<svg>` tag itself excluded from `tagNames`) rather than a blanket "svg is dangerous" claim.
- Content-sniffing enforcement (added in the previous round) still applies uniformly: declared/extension-derived mime must match the actual magic bytes/SVG-root check for **all three** read paths (local, SSH, remote) — so a file named `logo.png` that's actually SVG (or vice versa) is still rejected as a mismatch; only a correctly-labeled SVG (`.svg` extension locally, or `Content-Type: image/svg+xml` remotely, matching sniffed content) is accepted.
- Updated all previously-added "svg is rejected" test cases across `imageSniff.test.ts`, `markdownPreviewImage.test.ts`, `filesWorkspace.test.ts`, `main/ipc/filesWorkspace.test.ts`, `remoteImageFetch.test.ts`, and `filePreviewSanitize.test.ts` to reflect the new policy (svg supported when declared/sniffed consistently; still rejected on mismatch; raw inline `<svg>` HTML *tags* remain fully blocked, independent of this change, since that's a different code path — tag whitelisting, not image `src` mime policy).

### Re-verified gates after all of the above

- `pnpm exec vitest run <15 touched test files>` — 96 tests passed, including the new `filePreviewMarkdown.test.tsx`.
- Full `pnpm exec vitest run` (no `git stash` used this round, per instruction) — 236 passed / 2 failed test files (`supervisor.agentDispatch.test.ts`, `supervisor.coworkerWait.test.ts`), same pre-existing failures noted throughout this task, unrelated to this work.
- `pnpm exec tsc --noEmit` — no diagnostics in any touched file.
- `pnpm exec biome check --write` — clean on all touched/new files.
- `pnpm run build` — exits 0.
- `vitest.config.ts` change: `include` now also matches `src/**/*.test.tsx` (previously only `.test.ts`), needed for the new `renderToStaticMarkup`-based regression test. This is the only test-infra change; no jsdom/RTL dependency was added.

### Manual limitation (updated again)

- Still not verified against a live Electron window / real `img.shields.io` host. The specific claim now is narrower and verified: badges served as `image/svg+xml` (confirmed actual shields.io behavior) will be fetched, content-sniffed, and rendered via `<img src="data:image/svg+xml;base64,...">` — exercised at the unit level (remote fetch against local test servers returning real SVG bytes with matching `Content-Type`, and the `renderToStaticMarkup` regression test for the DOM-attribute path) but not against the live badge host or inside a real renderer process.

## Remaining acceptance limits

- Native Finder/Explorer clipboard paste, reveal and actual Electron menu/browser interaction were not manually verified.
- Realpath checks reject static symlink escapes, but filesystem mutation concurrent with validation/open retains a TOCTOU window.
- File-page navigation history is deliberately cleared for safety; file tabs are neither persisted nor hibernated.
- Implementation and automated scoped validation are complete; repository-wide acceptance and native manual checks remain outstanding.
