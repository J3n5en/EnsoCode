import type { HashlineIo } from './io';
import type { InMemorySnapshotStore } from './snapshots';
import { wrapHashlineEditDefinition } from './tools';
import { withHashlineGrep } from './withGrep';
import { withHashlineRead } from './withRead';
import { withHashlineWrite } from './withWrite';

export function applyHashlineSessionTools<
  T extends { execute: (...args: never[]) => unknown },
>(options: {
  enabled: boolean;
  store: InMemorySnapshotStore;
  io: HashlineIo;
  read: T;
  grep: T;
  edit?: T;
  write?: T;
  wrapOuterRead?: (read: T) => T;
}): { read: T; grep: T; edit?: T; write?: T } {
  const wrapOuter = options.wrapOuterRead ?? ((read: T) => read);
  if (!options.enabled) {
    return {
      read: wrapOuter(options.read),
      grep: options.grep,
      edit: options.edit,
      write: options.write,
    };
  }
  const read = wrapOuter(withHashlineRead(options.read, options.store));
  const grep = withHashlineGrep(options.grep, options.store, options.io.readFileText);
  const write = options.write ? withHashlineWrite(options.write, options.store) : undefined;
  if (!options.edit) return { read, grep, write };
  return {
    read,
    grep,
    write,
    edit: wrapHashlineEditDefinition(options.edit, {
      store: options.store,
      readText: options.io.readText,
      writeText: options.io.writeText,
    }),
  };
}
