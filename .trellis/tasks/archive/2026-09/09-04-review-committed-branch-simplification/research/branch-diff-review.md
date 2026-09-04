# Committed branch diff review

## Scope and boundary

- Compared `origin/dev...HEAD` (`merge-base aad25f2ad2cd06d93b65194e693e66f4669bd685`) on branch `fix/provider-thinking-antigravity`.
- Reviewed all 6 commits in `origin/dev..HEAD`; every commit is authored by `DejaVu93 <dv93@n.mail>`.
- Aggregate: **29 paths, 886 insertions, 185 deletions**.
- Only committed diff lines were treated as editable scope. The untracked task/workspace files were not treated as product scope. The committed `.trellis/spec/big-question/dedupe-identity.md` line was reviewed because it is part of the branch diff.
- Added files `src/shared/providerIdentity.ts` and `src/shared/providerIdentity.test.ts` are fully in scope. Unchanged surrounding lines in modified files remain read-only.

## Conclusion

The branch already contains several good extractions (`commitPendingModel`, `visibleThinkingLevels`, `providerIdentity`, `childReasoning`). The safe simplification surface is small. The best changes are localized to redundant provider identity branches and duplicated child-thinking input parsing. Antigravity discovery, proxy readiness, model-capability clamping, and the supervisor propagation chain are correctness-sensitive and should not be simplified without stronger integration tests.

## Recommended behavior-preserving simplifications

### S1 — Collapse redundant provider bucket logic (high confidence, very small)

**Current lines:**
- `src/shared/providerGroups.ts:72-74`
- `src/shared/providerIdentity.ts:13-20,29-31`

1. In `vendorOf`, `if (provider.catalogId === CUSTOM_VENDOR_ID)` is subsumed by the following `if (provider.catalogId) return provider.catalogId`; remove the special-case branch while retaining the explanatory comment.
2. `catalogBucket()` repeats `vendorOf()`'s newly added catalog precedence. Since `providerDedupeKey()` already exits for OAuth entries, its API-key branch can use `vendorOf(provider)` directly and delete `catalogBucket()`.

This preserves Custom, official catalog, hostname-derived, and OAuth identities while eliminating two parallel definitions of catalog precedence.

**Smallest validation:**

```bash
pnpm exec vitest run src/shared/providerGroups.test.ts src/shared/providerIdentity.test.ts
```

### S2 — Remove the identical conditional return in model union (high confidence, one line)

**Current lines:** `src/shared/providerIdentity.ts:35-41`

`unionProviderModels()` returns a fresh array in both branches. Replace:

```ts
return extra.length === 0 ? [...current] : [...current, ...extra];
```

with:

```ts
return [...current, ...extra];
```

This preserves values, ordering, and the current fresh-array behavior for no-op unions.

**Smallest validation:**

```bash
pnpm exec vitest run src/shared/providerIdentity.test.ts
```

### S3 — Share explicit-thinking precedence/validation between subagent and coworker (medium-high confidence)

**Current lines:**
- `src/agent/childReasoning.ts:10-38` (added file logic available for a shared helper)
- `src/agent/subagent.ts:214-222`
- `src/agent/coworker.ts:205-213`

Both tools independently perform the same sequence:

1. parse `model:level`;
2. let explicit `thinking` win over the suffix;
3. validate explicit `thinking`;
4. normalize empty model name to `undefined`;
5. render the same allowed-level error.

Add a narrowly named helper in the branch-added `childReasoning.ts` that returns `{ modelName?: string, thinking?: ChildThinkingLevel }` or throws the existing error. Keep model-list lookup and locked-agent validation local because those differ between tools. Do **not** generalize the whole tool schema; the descriptions intentionally differ between one-shot runs and coworker spawn.

This reduces duplicated control flow and prevents future precedence drift while preserving the exact suffix/explicit-parameter behavior.

**Smallest validation:**

```bash
pnpm exec vitest run src/agent/childReasoning.test.ts src/agent/subagent.test.ts src/agent/coworker.test.ts
```

### S4 — Stabilize derived visible-level arrays used as effect dependencies (medium confidence)

**Current lines:**
- `src/renderer/components/chat/ModelPicker.tsx:559-562,578-596`
- `src/renderer/components/settings/SubagentModelsSettings.tsx:60-76`

`visibleThinkingLevels()` always allocates a new array. Both new normalization effects depend on that array, so they rerun after every render even when model metadata is unchanged. Memoize each call from its `thinkingLevels` input. This is behavior-preserving and makes the effect dependency express the actual capability change rather than allocation identity.

In `ModelPicker`'s already guarded `visibleLevels.length > 0` render branch, two micro-simplifications are also safe:

- `max={visibleLevels.length - 1}` instead of `Math.max(0, ...)`;
- `visibleLevels[index] ?? visibleLevels[0]` instead of the unreachable final `?? 'medium'` fallback.

The memoization is the useful part; the two JSX reductions are optional.

**Smallest validation:**

```bash
pnpm exec vitest run src/shared/modelThinking.test.ts src/renderer/components/chat/ModelPicker.test.ts
pnpm typecheck
```

`SubagentModelsSettings` has no direct component test, so typecheck plus a focused manual render of a model whose catalog levels are `[]`, four standard levels, and standard levels plus `max` remains appropriate.

### S5 — Optional test-only table compression (low priority)

**Current lines:**
- `src/agent/childReasoning.test.ts:41-64`
- `src/shared/providerIdentity.test.ts` (entire added file)
- `src/shared/providers/antigravity.test.ts:63-120`

The suffix parser cases and project-id field variants can be expressed with `it.each`. This would reduce repetitive setup without reducing assertions. Do not compress the provider merge scenarios: their distinct identity/merge intent is valuable documentation, and the 180-line added test file is not excessive relative to the identity risk.

## Risky areas to leave untouched

### R1 — Antigravity discovery is protocol-sensitive and its new tests do not cover the production narrowing path

**Current lines:** `src/shared/providers/antigravity.ts:56,70-75,84-88,372-435,505-529,607`

Do not simplify the endpoint order, OAuth scopes, metadata fields, fallback UUID algorithm, onboard retry/fallback flow, or broad response-shape parser merely to reduce line count. They encode externally observed Google behavior and have no end-to-end OAuth test.

A concrete coverage gap exists: `loadCodeAssist()` still passes raw responses through `narrowLoadCodeAssist()`, which preserves only `cloudaicompanionProject` among project-id shapes. The newly added `extractAntigravityProjectId()` supports `antigravityProjectId`, `projectId`, `backendProjectId`, `userDefinedCloudaicompanionProject`, nested `project`, and project arrays, but production `discoverProject()` normally receives the narrowed object, so most of those shapes are stripped before the helper sees them. Direct helper tests pass but do not prove the production path. This should be resolved as a correctness task (preserve/test the relevant raw fields), not folded into a simplification pass.

Also retain caution around the catch-all `onboardUser` error suppression: cancellation, timeout, region rejection, and server errors currently converge on fallback/reload behavior. Narrowing that catch changes behavior.

### R2 — Proxy readiness and its dynamic import are deliberate dependency-boundary code

**Current lines:**
- `src/main/services/oauthProviders.ts:477-480`
- `src/main/services/oauthProviders.refresh.test.ts:31-33`
- `src/main/services/oauthProviders.test.ts:25-27`

Keep the dynamic import and both local mocks. A static import would reintroduce the documented `oauthProviders -> proxyConfig -> agentHost` chain and global Undici dispatcher side effects into unrelated tests. Waiting before Google OAuth is the actual behavior fix, not incidental ceremony.

### R3 — Provider identity dimensions and `added` semantics require caller-level review

**Current lines:**
- `src/shared/providerIdentity.ts:22-78`
- `src/renderer/stores/settings/index.ts:246-250`
- `src/renderer/stores/settings/types.ts:218`
- `src/renderer/components/settings/ProviderSetupWizard.tsx:258-265`
- `src/shared/types/llm.ts:55-60`
- committed spec line `.trellis/spec/big-question/dedupe-identity.md:30`

Do not remove `catalogId`, API-key trimming, trailing-slash normalization, OAuth account identity, or existing-model precedence. Do not rename/redefine `added` as “number of providers appended”: it intentionally increments for either a new provider or a successful model merge. Callers currently mix count-based and ID-presence behavior; in particular, local import configuration follows newly inserted IDs, not merged existing rows. Any semantic cleanup needs a separate caller audit.

`unionProviderModels()` also intentionally keeps the existing entry (including user overrides) and appends only unseen IDs. Replacing it with generic object merging would change behavior.

### R4 — Thinking-level filtering must retain `undefined`/`[]` and pi clamp semantics

**Current lines:**
- `src/shared/modelThinking.ts:45-55`
- `src/renderer/components/chat/ModelPicker.tsx:549-565,578-596,789-828`
- `src/renderer/components/settings/SubagentModelsSettings.tsx:41-124`

Do not collapse `visibleThinkingLevels`, `supportedProjectThinkingLevels`, and `clampProjectThinkingLevel` into a generic truthy fallback. `undefined` means unknown/default-four in this branch, while `[]` means no supported reasoning levels. The installed pi 0.84.3 implementation confirms that `xhigh`/`max` require explicit declaration and clamping searches upward before downward.

There is an existing documentation tension outside the editable diff: `src/shared/types/modelMeta.ts` says missing `thinkingLevels` means “all levels open,” while this branch intentionally treats missing metadata as pi's default four. Because that line is unchanged/read-only under the user's boundary, do not “fix” it in this pass; flag it for a later spec/doc task.

The model suffix parser's `lastIndexOf(':')` plus valid-suffix check should remain. A simpler `split(':')` can corrupt provider/model identifiers containing colons.

### R5 — Supervisor propagation is verbose but each hop establishes precedence

**Current lines:** `src/agent/supervisor.ts:69-73,139-140,1153-1167,1292-1301,1329-1338,1720-1722,1771`

Keep the `thinkingOverride` propagation through `SubagentDeps`/`CoworkerToolDeps`, `SessionFactory`, and `spawnCoworker`. It ensures dispatch-time thinking wins over the selected model preset and parent conversation. The `undefined` positional placeholder in the coworker spawn call is aesthetically awkward, but converting the private method to an options object would require editing the unchanged resume call, which is outside the strict committed-line boundary.

### R6 — Small focused fixes are already minimal

Leave these unchanged:

- `src/shared/modelEntry.ts:37-43` and `src/renderer/components/settings/ProviderApiForm.tsx:387`: pending model commit is a clear shared helper and save-time call.
- `src/main/services/sshProbe.test.ts:60-63`: the `arrayContaining` plus length assertion is the minimal locale-independent assertion that still catches missing/extra entries.
- `src/renderer/components/settings/ProviderSetupWizard.tsx:258-265`: persisting `catalogId` is required identity data.
- `.trellis/spec/big-question/dedupe-identity.md:30`: concise committed contract update.

## All 29 paths reviewed

| Path | Disposition |
|---|---|
| `.trellis/spec/big-question/dedupe-identity.md` | Keep; required identity-contract update. |
| `src/agent/childReasoning.test.ts` | Keep coverage; optional `it.each` only. |
| `src/agent/childReasoning.ts` | Host S3 shared input-resolution helper; retain suffix safety. |
| `src/agent/coworker.test.ts` | Keep explicit suffix propagation assertion. |
| `src/agent/coworker.ts` | S3 candidate; otherwise keep tool-specific schema wording. |
| `src/agent/subagent.test.ts` | Keep explicit-parameter precedence and invalid-level tests. |
| `src/agent/subagent.ts` | S3 candidate; otherwise keep model/agent lock checks local. |
| `src/agent/supervisor.ts` | R5; leave propagation chain untouched. |
| `src/main/services/oauthProviders.refresh.test.ts` | R2; keep proxy mock. |
| `src/main/services/oauthProviders.test.ts` | R2; keep proxy mock. |
| `src/main/services/oauthProviders.ts` | R2; keep dynamic readiness wait. |
| `src/main/services/sshProbe.test.ts` | R6; already minimal and portable. |
| `src/renderer/components/chat/ModelPicker.tsx` | S4 candidate; preserve capability/clamp semantics. |
| `src/renderer/components/settings/ProviderApiForm.tsx` | R6; keep save-time pending commit. |
| `src/renderer/components/settings/ProviderSetupWizard.tsx` | R3/R6; keep `catalogId`. |
| `src/renderer/components/settings/SubagentModelsSettings.tsx` | S4 candidate; preserve Follow/Off/level state mapping. |
| `src/renderer/stores/settings/index.ts` | R3; keep shared identity application and merge count. |
| `src/renderer/stores/settings/types.ts` | Keep; documents changed return semantics. |
| `src/shared/modelEntry.merge.test.ts` | Keep focused pending-model cases. |
| `src/shared/modelEntry.ts` | Keep; helper is already concise. |
| `src/shared/modelThinking.test.ts` | Keep `undefined`, `[]`, and explicit-max cases. |
| `src/shared/modelThinking.ts` | Keep semantic boundary; S4 belongs at effect call sites. |
| `src/shared/providerGroups.test.ts` | Keep catalog precedence cases. |
| `src/shared/providerGroups.ts` | S1 candidate. |
| `src/shared/providerIdentity.test.ts` | Keep scenario detail; validates S1/S2. |
| `src/shared/providerIdentity.ts` | S1 and S2 candidates; otherwise R3. |
| `src/shared/providers/antigravity.test.ts` | R1; helper tests pass but production-path coverage is incomplete. |
| `src/shared/providers/antigravity.ts` | R1; leave protocol flow untouched in simplification pass. |
| `src/shared/types/llm.ts` | R3; keep persisted `catalogId` contract. |

## Validation performed on the current committed branch

```bash
pnpm exec vitest run \
  src/agent/childReasoning.test.ts \
  src/agent/coworker.test.ts \
  src/agent/subagent.test.ts \
  src/main/services/oauthProviders.refresh.test.ts \
  src/main/services/oauthProviders.test.ts \
  src/main/services/sshProbe.test.ts \
  src/shared/modelEntry.merge.test.ts \
  src/shared/modelThinking.test.ts \
  src/shared/providerGroups.test.ts \
  src/shared/providerIdentity.test.ts \
  src/shared/providers/antigravity.test.ts
# 11 files passed, 210 tests passed

pnpm exec vitest run \
  src/renderer/components/chat/ModelPicker.test.ts \
  src/renderer/stores/settings/defaultModel.test.ts
# 2 files passed, 10 tests passed

pnpm typecheck
# passed

git diff --check origin/dev...HEAD
# passed

git diff --name-only origin/dev...HEAD -z -- '*.ts' '*.tsx' | xargs -0 pnpm exec biome check
# no errors; one informational suggestion at antigravity.ts:1019 is on an unchanged, out-of-scope line
```

No product code, tests, specs, or task files outside this research artifact were modified.
