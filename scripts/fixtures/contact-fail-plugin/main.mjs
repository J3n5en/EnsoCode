// 已连接、发送一律失败：错误带 code 与给用户看的提示，模拟 Clawbot 的会话过期
export async function activate(enso) {
  await enso.contact.register('wechat', {
    caps: {
      buttons: false,
      urlButtons: false,
      edit: false,
      typing: false,
      format: 'plain',
      maxChars: 2000,
      commandMenu: false,
    },
    async sendText() {
      throw Object.assign(new Error('sendmessage ret=-2 prepare failed'), {
        code: 'SESSION_EXPIRED',
        userMessage: '微信会话已过期，请在微信里给机器人发任意一条消息',
      });
    },
  });
  await enso.contact.setStatus('wechat', { status: 'connected', peers: ['wx-verify'] });
}
