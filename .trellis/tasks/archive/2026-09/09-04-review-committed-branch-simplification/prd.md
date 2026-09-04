# Review committed branch changes for simplification

## Goal

Review the code committed by DejaVu93 on `fix/provider-thinking-antigravity`, correct the requested subagent thinking-control UX, and apply clear simplifications that improve readability and remove redundant logic.

## Background

- The immutable review range is `aad25f2..29542e5`: six DejaVu93-authored commits and 29 changed paths.
- `origin/dev` has advanced since the branch forked, so the moving remote ref must not redefine the review scope.
- The committed branch is already green under focused tests, typecheck, and diff checks.
- Research found a small safe simplification surface; protocol-sensitive Antigravity and provider behavior should otherwise remain unchanged.

## Requirements

1. Review all 29 paths in the immutable branch range, while modifying only concrete simplification candidates.
2. Restrict simplification-only product edits to current lines introduced or modified by the six reviewed commits. The requested subagent thinking-control UX may additionally edit `SubagentModelsSettings.tsx`, make the minimal internal `ModelPicker` callback/display changes required to preserve inheritance semantics, and add focused component tests; other unchanged surrounding lines remain read-only.
3. Outside the explicitly requested thinking-control UX change, preserve runtime behavior, persisted data shape, public APIs, error messages, ordering, and identity rules.
4. Simplify provider identity logic by:
   - using the existing `vendorOf()` catalog precedence instead of maintaining a second catalog-bucket implementation;
   - removing the catalog special case already covered by the general truthy `catalogId` branch;
   - removing the identical conditional return in model union while retaining fresh-array behavior.
5. Consolidate the duplicated child model/thinking input resolution shared by `subagent` and `coworker` into a narrow domain helper, while preserving:
   - explicit `thinking` precedence over a `model:level` suffix;
   - empty-model handling;
   - exact validation behavior and error text;
   - tool-specific model-list and locked-agent checks.
6. Remove the separate subagent-model text selector and wire each row's existing `ModelPicker` to the entry's reasoning state and thinking level, giving users the same switch-and-slider interaction as the main Agent while preserving independent per-model adjustment.
7. Stabilize renderer thinking-level derivation where it is used as an effect dependency, and apply only guard-proven micro-simplifications.
8. Retain comments that explain identity, precedence, fallback, protocol, or persistence rationale.
9. Do not compress tests merely to reduce line count; existing scenario-oriented tests are valuable documentation.

## Out of Scope

- Fixing the Antigravity production-path coverage gap where `narrowLoadCodeAssist()` strips alternate project-ID shapes before discovery.
- Rebasing or merging the newer `origin/dev` commits.
- Changing provider identity dimensions, `added` semantics, model precedence, OAuth/proxy behavior, thinking-level support semantics, or supervisor propagation.
- Correcting unchanged documentation outside the six-commit diff.
- Refactoring unchanged code, even when it could make an in-scope simplification broader.

## Acceptance Criteria

- [x] Every simplification-only product edit is within a line or added file from `aad25f2..29542e5`; edits outside that range are limited to the approved subagent UX, the minimal internal `ModelPicker` normalization/display support it requires, and focused tests.
- [x] Provider grouping/deduplication and model-union tests pass without changed expectations.
- [x] Subagent and coworker explicit/suffix thinking precedence, invalid-value errors, model validation, and locked-agent behavior remain covered and pass.
- [x] Subagent model configuration no longer uses a separate text selector; its existing `ModelPicker` exposes the same reasoning switch and capability-filtered slider as the main Agent, with freely adjustable per-model values.
- [x] Inherited settings are visually clamped to model capability without being persisted as per-entry overrides; explicit overrides continue to accept automatic normalization.
- [x] Renderer capability filtering and normalization still respect each selected model while avoiding dependency churn from newly allocated derived arrays.
- [x] No Antigravity, proxy, provider storage, public type, IPC, or supervisor behavior is changed.
- [x] `pnpm typecheck`, targeted Biome checks for all task files, and `pnpm test` pass. Full `pnpm lint` was run and only reports pre-existing out-of-scope repository findings.
- [x] `git diff --check` passes and the final summary records worthwhile findings that were intentionally left out of scope.

## Blocking Open Questions

None.
