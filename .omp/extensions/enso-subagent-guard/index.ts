/**
 * Project-local OMP overlay. Not listed in `.trellis/.template-hashes.json`,
 * so `trellis update` does not restore or overwrite it.
 *
 * Self-contained: imports only this directory and host packages.
 * After the hashed `.omp/extensions/trellis` template is restored, this
 * still strips `trellis-workflow-state` for Trellis subagents.
 * Does not subscribe to `session_start`.
 */
import { installHostExtensionRunnerGuard } from "./guard";

export default async function (_pi: unknown): Promise<void> {
   await installHostExtensionRunnerGuard();
}
