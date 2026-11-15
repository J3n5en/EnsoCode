export function activate(enso) {
  enso.tools.register('echo', async (args) => ({ content: `echo:${String(args.text ?? '')}` }));
  enso.tools.register('poke', async (args) => ({ content: `poked:${String(args.text ?? '')}` }));
}
