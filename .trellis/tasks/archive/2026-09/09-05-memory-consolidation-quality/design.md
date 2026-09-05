# Design

## Boundaries

All changes stay inside `src/agent/memory/` (+ `threads.ts` in the same dir). No IPC / renderer / supervisor changes;
`MemoryCompleteSimple` contract, `.jobs.json`, `stage1_outputs.json` shape and the JSON output schemas of both phases are unchanged.

## Data flow (after)

```
sessions/*.jsonl ──extractPersistableMessages (tool result ≤1.5k)──▶ items JSON
        └─ truncateByApproxTokens(12k tok) ──▶ STAGE_ONE_SYSTEM' + stageOneUser ──▶ artifact

artifacts ──buildPhaseTwoCorpus(budget) ──▶ raw (per-artifact quota) + summaries (all)
MEMORY.md + memory_summary.md ──truncate──▶ prior
                        └──▶ CONSOLIDATION_SYSTEM' + consolidationUser(prior, raw, summaries) ──▶ MEMORY.md / summary / skills
```

## Contracts

### `prompts.ts`
- `STAGE_ONE_SYSTEM`: adds the shared taxonomy + "explain why, not just what"; keeps JSON keys.
- `CONSOLIDATION_SYSTEM`: unchanged intent (strict JSON).
- `consolidationUser(input: { prior?: { memoryMd: string; summary: string }; rawMemories: string; rolloutSummaries: string })`
  — signature changes from positional strings to an object. Body sections:
  1. Prior memory (only when present) + merge rule: baseline, revise/append/expire; never drop for absence.
  2. New raw memories / rollout summaries.
  3. Taxonomy (keep) / exclusions (drop) / conflict rule (newest wins, mark superseded in memory_md).
  4. Output targets: `memory_summary` sectioned by taxonomy, ~1500–4000 chars, most behavior-changing first;
     `memory_md` structured headings, anchors preserved.
  5. JSON schema block (unchanged).
- Shared taxonomy text lives in one const so stage 1 and phase 2 cannot drift.

### `pipeline.ts`
- New exported pure function `buildPhaseTwoCorpus(artifacts, { rawTokenLimit, perArtifactRawChars })`
  → `{ raw: string; summaries: string }`.
  Algorithm: sort by `sourceUpdatedAt` desc; cap each `raw_memory` at `perArtifactRawChars` (head/tail);
  accumulate raw blocks while cumulative chars ≤ `rawTokenLimit*4`; artifacts that no longer fit
  contribute only to `summaries`. `summaries` covers every artifact only up to `summaryTokenLimit`
  (newest-first; oldest artifacts are evicted once the bounded budget is exhausted — this is
  best-effort breadth, not an unconditional per-artifact guarantee). Replaces the two
  `truncateByApproxTokens` calls on the phase-2 path.
- New helper `loadPriorMemory(memoryRoot)` → `{ memoryMd, summary } | undefined` (both files read, missing → `''`;
  undefined when both empty). Each side truncated with `truncateByApproxTokens(PRIOR_*_TOKEN_LIMIT)`.
- Constants: `PHASE1_INPUT_TOKEN_LIMIT = 12_000`, `PHASE2_RAW_TOKEN_LIMIT = 20_000` (unchanged),
  `PER_ARTIFACT_RAW_CHARS = 6_000`, `PRIOR_MD_TOKEN_LIMIT = 10_000`, `PRIOR_SUMMARY_TOKEN_LIMIT = 2_000`.
  Rough phase-2 budget: prior 12k + raw 20k + summaries ≤12k + prompt ≈ 45k tokens — inside 128k models.

### Lease clock (jobs.ts / pipeline.ts)
- `claimStage1` / `tryClaimPhase2` take an explicit `nowSec` and are pure — unit tests in `jobs.test.ts`
  call them directly with a fixed timestamp and stay deterministic.
- `runMemoryPipeline` no longer reuses the single `opts.nowSec` snapshot for every claim inside the run.
  A multi-batch stage-1 pass (or a slow model) can burn hundreds of real seconds before phase 2 claims
  its lease; claiming with the stale start-of-run `nowSec` would compute `leaseUntil` from a timestamp
  that is already stale, silently shrinking the intended 300s-timeout cushion.
  `runMemoryPipeline` now takes an optional `clockSec?: () => number`, defaulting to a wall-clock function
  anchored at `opts.nowSec` (`opts.nowSec + elapsed real seconds since the call started`), and uses it for
  every in-run claim (`claimStage1` batches, `tryClaimPhase2`). Callers/tests can inject a fake `clockSec`
  to assert lease behaviour under simulated elapsed time without depending on real wall time.

### `threads.ts`
- `extractPersistableMessages`: tool result text > `TOOL_RESULT_CHAR_CAP` (1_500) → head 900 + `\n…[tool output truncated]…\n` + tail 600.
  Drop rule (`> 32_000`) becomes the cap; allowed tool list unchanged.

### `guidance.ts`
- Rule 1 replaced by: "Summary below is already loaded. Before working in an area it mentions, `read memory://root/MEMORY.md` for the full section."
  Rules 2–6 renumbered.

## Trade-offs
- Per-artifact quota keeps breadth at the cost of depth for old threads; prior memory compensates because
  depth already consolidated earlier is carried forward.
- Prior memory makes phase 2 sticky: a wrong fact can persist. Mitigated by the newest-wins rule and the existing
  guidance that repo state wins; `/memory clear` remains the hard reset.
- Raising stage-1 to 12k tokens raises cost ×3 per thread (≤64 threads/startup). Acceptable; tool-result cap
  offsets most of it by removing dead weight.

## Compatibility / rollback
- No on-disk format change; old `stage1_outputs.json` artifacts still consolidate.
- Rollback = revert the commits; nothing to migrate.
