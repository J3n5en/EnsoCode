# Subagent: extension isolation + run footer

## Problems (from reviewing subagent session jsonl, 2026-09-04)
1. Typed children (scout/reviewer/worker/tester) loaded project extensions → got `trellis_subagent` and the "Active task" dispatch rule; a readonly reviewer wasted its first step trying to delegate.
2. Reports gave no way to tell whether the subagent verified anything (reviewer: 0 bash) or hit the output limit.

## Changes
- `createSessionResourceLoader` gains `noExtensions`; set for `resolved || agentType` children (mirrors `noSkills`). General (untyped) children unchanged.
- `src/agent/runFooter.ts`: `[label · model · elapsed · tool counts (bash 0 explicit) · ctx% · INCOMPLETE]` appended to subagent reports; kept after async-notice truncation.

## Verified
- 1550 tests, typecheck clean, biome clean on touched files.
- On device with the Trellis extension present: main 33 tools incl. trellis_subagent; scout child 4 tools, none; general child keeps them.
