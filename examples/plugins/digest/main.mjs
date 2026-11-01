let sessions = 0;

export function activate(enso) {
  enso.events.on('session_start', () => {
    sessions += 1;
  });
  enso.schedules.register('sweep', () => {
    sessions += 0;
  });
  enso.tools.register('summarize', async (args, ctx) => {
    const text = String(args.text ?? '');
    await ctx.progress('正在摘要');
    const digest = text.slice(0, 80);
    const file = await enso.artifacts.write({
      name: 'digest.txt',
      text: digest,
      mime: 'text/plain',
    });
    return {
      content: `${digest}\n会话开始 ${sessions} 次`,
      details: { sessions, artifactId: file.id },
    };
  });
}
