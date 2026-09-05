# Implement

All steps: RED (failing test, confirm it fails for missing behaviour) → GREEN → commit. One commit per step.

## 1. `threads.ts` tool-result cap (R4 / AC4)
- Test `threads.test.ts`: 32k `read` result → output ≤ 1_600 chars, contains truncation marker, head and tail preserved; 1k result unchanged.
- Impl: `TOOL_RESULT_CHAR_CAP`, head/tail slice.
- `pnpm exec vitest run src/agent/memory/threads.test.ts`

## 2. `buildPhaseTwoCorpus` (R3 / AC3)
- Test `pipeline.test.ts` (new describe): 3 artifacts with 8k raw each, `rawTokenLimit=3_000` (12k chars), `perArtifactRawChars=6_000`
  → raw contains newest two thread ids, not the oldest; summaries contains all three; per-artifact raw ≤ 6k + marker.
- Impl: exported pure function; wire into phase-2 path replacing the two `truncateByApproxTokens` calls.
- `pnpm exec vitest run src/agent/memory/pipeline.test.ts`

## 3. Prior memory input (R2 / AC2)
- Test: memoryRoot pre-seeded with `MEMORY.md`+`memory_summary.md` → phase-2 userText contains both texts and `Prior memory`; empty root → no `Prior memory`.
- Impl: `loadPriorMemory`, `consolidationUser` object signature.
- Same command as step 2.

## 4. Prompts (R1, R4 / AC1)
- Test `prompts.test.ts`: `consolidationUser` output contains taxonomy headings, exclusion words (`single-session`), `newest wins`, char target; `STAGE_ONE_SYSTEM` contains the shared taxonomy const.
- Impl: rewrite prompt text; `PHASE1_INPUT_TOKEN_LIMIT` → 12_000 and update the existing "4000-token budget" test to the new threshold.
- `pnpm exec vitest run src/agent/memory/prompts.test.ts src/agent/memory/pipeline.test.ts`

## 5. Guidance (R5 / AC5)
- Test `guidance.test.ts` (extend if exists): output lacks `memory_summary.md\` first`, includes `read memory://root/MEMORY.md` on-demand hint.
- Impl: RULES text.
- `pnpm exec vitest run src/agent/memory/guidance.test.ts`

## Validation before commit
```
pnpm typecheck && pnpm test && pnpm exec biome check src/agent/memory
```

## Manual check (AC7, non-blocking)
Restart app → `/memory rebuild` on enso-code → read new `memory_summary.md`; expect sectioned output without episodic sentences.

## Rollback points
Each step is one commit; revert individually. No disk-format migration involved.
