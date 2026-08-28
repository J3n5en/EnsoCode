/**
 * Project-local OMP overlay. Not listed in `.trellis/.template-hashes.json`,
 * so `trellis update` does not restore or overwrite it.
 *
 * Self-contained: imports only this directory and host packages.
 * After the hashed `.omp/extensions/trellis` template is restored, this
 * still strips `trellis-workflow-state` for Trellis subagents.
 * Does not subscribe to `session_start`.
 */
import type { HostPackageExports } from "./guard";
import { installHostExtensionRunnerGuard } from "./guard";

type ExtensionApiLike = {
   pi?: HostPackageExports;
};

export default function (pi: ExtensionApiLike): void {
   installHostExtensionRunnerGuard(pi.pi);
}
