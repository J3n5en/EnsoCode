# Design: committed branch simplification review

## Scope boundary

The review baseline is the immutable commit range `aad25f2..29542e5`, not the current value of `origin/dev`. Simplification-only edits must be a subset of the current lines introduced or modified by that range. The two files added by the range are fully editable. The approved UX correction may additionally change `SubagentModelsSettings.tsx`, make minimal internal `ModelPicker` callback/display changes, and add focused component tests.

No architectural or data-contract changes are planned. Most work is a green-to-green refactor; the subagent settings interaction is the one approved UI behavior change.

## Simplification areas

### 1. Provider identity

- Keep `vendorOf()` as the single catalog/hostname precedence function.
- Remove `catalogBucket()` and call `vendorOf(provider)` from the API-key dedupe-key path.
- Collapse the redundant Custom-only catalog branch into the general `catalogId` return while preserving the rationale comment.
- Return `[...current, ...extra]` unconditionally from `unionProviderModels()` so the no-extra path still produces a fresh array.

Compatibility constraints: dedupe-key text, API-key trimming, trailing-slash normalization, OAuth account identity, model order, and existing-model precedence remain unchanged.

### 2. Child thinking input

Add one narrow helper in `childReasoning.ts` to resolve the two raw tool inputs:

```ts
resolveChildThinkingInput(modelName?: string, thinkingRaw?: string)
  -> { modelName?: string; thinking?: ChildThinkingLevel }
```

The helper parses the suffix, applies explicit-parameter precedence, validates explicit input, normalizes an empty model name to `undefined`, and throws the current error text. `subagent.ts` and `coworker.ts` retain their distinct model lookup, agent-type checks, and tool wording.

This extraction centralizes a domain rule rather than generalizing the two tools.

### 3. Subagent thinking interaction and renderer derivation

Remove the separate `ThinkingControls` selector from `SubagentModelsSettings.tsx`. The row's existing `ModelPicker` becomes the single interaction surface, exactly as in `DefaultModelPicker`:

- `reasoningEnabled` resolves an explicit entry override first and otherwise reflects the main/default reasoning setting;
- `thinkingLevel` resolves the entry's independent override first and otherwise displays the main/default level;
- toggling the switch writes an explicit per-entry `on`/`off` override;
- moving the slider writes the entry's independent level;
- turning reasoning off retains the last level, matching the main Agent interaction and allowing it to be restored when re-enabled;
- `ModelPicker` continues to filter and clamp against the selected model's actual capabilities.

This removes the duplicate text-based control, model-meta lookup, normalization effect, label map, and Select imports from the settings component.

`ModelPicker` receives optional internal normalization callbacks that default to the existing user-change callbacks, preserving every existing caller. User Switch/Slider operations continue through `onReasoningChange`/`onThinkingChange`; metadata arrival and post-selection capability clamping use the normalization callbacks. `SubagentModelsSettings` ignores automatic normalization for inherited values and accepts it only for explicit overrides. Derived display values still show inherited settings clamped to current model capability without materializing an override.

Also memoize `visibleThinkingLevels(...)` from its metadata input before using it as an effect dependency, and remove only bounds logic proven redundant by the existing non-empty render guard.

## Explicit non-changes

- Antigravity discovery and onboarding remain untouched.
- Proxy readiness and dynamic imports remain untouched.
- Supervisor propagation remains untouched.
- Existing tests retain their scenario structure.
- No public types, IPC channels, or persisted schemas change.

## Rollback

Each area is independent. If focused tests or review reveal drift, revert that area without affecting the others. The immutable baseline makes scope violations detectable from the working-tree patch.
