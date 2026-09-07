import type { HashlineIo } from './io';
import type { InMemorySnapshotStore } from './snapshots';
import { wrapHashlineEditDefinition } from './tools';
import { withHashlineGrep } from './withGrep';
import { withHashlineRead } from './withRead';

export function applyHashlineSessionTools<
  T extends { execute: (...args: never[]) => unknown },
>(options: {
  enabled: boolean;
  store: InMemorySnapshotStore;
  io: HashlineIo;
  read: T;
  grep: T;
  edit?: T;
  wrapOuterRead?: (read: T) => T;
}): { read: T; grep: T; edit?: T } {
  const wrapOuter = options.wrapOuterRead ?? ((read: T) => read);
  if (!options.enabled) {
    return {
      read: wrapOuter(options.read),
      grep: options.grep,
      edit: options.edit,
    };
  }
  const read = wrapOuter(withHashlineRead(options.read, options.store));
  const grep = withHashlineGrep(options.grep, options.store, options.io.readFileText);
  if (!options.edit) return { read, grep };
  return {
    read,
    grep,
    edit: wrapHashlineEditDefinition(options.edit, {
      store: options.store,
      readText: options.io.readText,
      writeText: options.io.writeText,
    }),
  };
}
