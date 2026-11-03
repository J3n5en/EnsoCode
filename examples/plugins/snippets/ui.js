/** @param {import('../../../types/enso-plugin').EnsoUi} enso */
export function onLoad(enso) {
  const h = enso.React.createElement;
  const call = (method, args) => enso.dispatch('plugin.call', { method, args });

  const button = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: 28,
    minWidth: 28,
    padding: '0 6px',
    borderRadius: 6,
    border: 'none',
    background: 'transparent',
    color: 'var(--muted-foreground)',
    cursor: 'pointer',
    fontSize: 12,
  };

  enso.slots.register({
    slot: 'composer.right',
    component: () =>
      h(
        'button',
        {
          type: 'button',
          title: '插入时间戳',
          style: button,
          onMouseDown: (event) => event.preventDefault(),
          onClick: () => void call('insertTimestamp').catch((error) => console.warn(error)),
        },
        '⏱'
      ),
  });

  enso.slots.register({
    slot: 'message.action',
    position: 'right',
    component: ({ text }) =>
      h(
        'button',
        {
          type: 'button',
          title: '引用到输入框',
          style: { ...button, height: 24, minWidth: 24 },
          onClick: () => void call('quote', { text }).catch((error) => console.warn(error)),
        },
        '❝'
      ),
  });
}
