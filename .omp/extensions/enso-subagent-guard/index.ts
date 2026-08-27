/**
 * Project-local OMP overlay. Not listed in `.trellis/.template-hashes.json`,
 * so `trellis update` does not restore or overwrite it.
 *
 * Sibling of the hashed `.omp/extensions/trellis` template. After that
 * template is restored, this overlay still strips `trellis-workflow-state`
 * for Trellis subagents. Does not subscribe to `session_start`.
 */
import {
  EXTENSION_RUNNER_SPECIFIERS,
  installExtensionRunnerGuard,
  type ExtensionRunnerLike,
} from '../../../src/tooling/trellisSubagentGuard';

export default async function (_pi: unknown): Promise<void> {
  for (const spec of EXTENSION_RUNNER_SPECIFIERS) {
    try {
      const mod = (await import(spec)) as { ExtensionRunner?: ExtensionRunnerLike };
      if (mod.ExtensionRunner) {
        installExtensionRunnerGuard(mod.ExtensionRunner);
        return;
      }
    } catch {
      // Host package is not installed in this runtime; try the next specifier.
    }
  }
}
