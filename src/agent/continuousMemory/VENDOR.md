# pi-observational-memory 3.1.3

Vendored from `npm:pi-observational-memory@3.1.3` (MIT).

Do not edit `vendor/` to add Enso behavior. Wrap in `extension.ts`:
- map Enso `smartCompactModel` onto `runtime.config.model`
- empty/error compact → Enso verified fallback (never `undefined` on overflow)

Backported from 3.1.4: `agents/worker-stream.ts` keeps the `ModelRegistry` receiver.

Local divergence (approved exception, token cost): the reflector skips when observation coverage has not moved past the latest reflection, and over-budget reflections (`reflectionsPoolMaxTokens`) are rewritten by `agents/reflector/consolidate.ts` into an `om.reflections.consolidated` entry that supersedes them in fold/projection while staying recallable. `session-ledger/active-reflections.ts` caps the rest at twice the budget as a fallback.
