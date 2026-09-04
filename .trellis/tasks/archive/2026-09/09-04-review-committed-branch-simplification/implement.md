# Implementation plan

## Baseline and guardrails

- Baseline range: `aad25f2..29542e5`.
- Do not use the moving `origin/dev` ref to decide editable lines.
- Before each simplification edit, confirm the target current line appears as added/modified in `git diff --unified=0 aad25f2..29542e5 -- <path>`; the added provider identity file is fully editable. Out-of-range edits are allowed only for the approved `SubagentModelsSettings.tsx` UX, minimal internal `ModelPicker` normalization/display support, and focused tests.
- Do not edit tests merely to make the refactor pass. Existing tests are the behavior contract.

## Steps

1. Simplify provider identity logic in `src/shared/providerGroups.ts` and `src/shared/providerIdentity.ts`.
2. Run:
   ```bash
   pnpm exec vitest run src/shared/providerGroups.test.ts src/shared/providerIdentity.test.ts
   ```
3. Add the narrow child-thinking input resolver in `src/agent/childReasoning.ts`; replace duplicate parsing/precedence/validation blocks in `src/agent/subagent.ts` and `src/agent/coworker.ts`.
4. Run:
   ```bash
   pnpm exec vitest run src/agent/childReasoning.test.ts src/agent/subagent.test.ts src/agent/coworker.test.ts
   ```
5. Remove the separate subagent text selector and wire the existing row `ModelPicker` to inherited defaults plus independent entry overrides. Add optional normalization callbacks so automatic capability correction does not materialize inherited values; derive capability-clamped display values for no-op normalization.
6. Run focused renderer/shared checks:
   ```bash
   pnpm exec vitest run src/shared/modelThinking.test.ts src/renderer/components/chat/ModelPicker.test.ts src/renderer/components/settings/SubagentModelsSettings.test.ts src/renderer/stores/settings/defaultModel.test.ts
   pnpm typecheck
   ```
7. Audit the final working-tree patch against the immutable baseline. Confirm every simplification edit originated in the range and every out-of-range edit is limited to the approved subagent UX, minimal `ModelPicker` support, and focused tests.
8. Run the full quality gate:
   ```bash
   pnpm typecheck
   pnpm lint
   pnpm test
   git diff --check
   command grep -rn "TEMP-DEBUG\|remote-debugging-port\|console.log(" src/
   ```
9. Perform final review against the PRD. Record the Antigravity production-path coverage gap and unchanged model-metadata documentation tension as deferred findings, not code changes.

## Review gates

- Provider identity focused tests after step 2.
- Child thinking focused tests after step 4.
- Typecheck after renderer edits.
- Full test/lint/typecheck before completion.

## Rollback points

- Provider simplifications are one independent rollback unit.
- Child-thinking extraction is one independent rollback unit.
- Renderer interaction and normalization support is one independent rollback unit.
