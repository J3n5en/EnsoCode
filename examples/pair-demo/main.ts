import {
  type BoxedContentKey,
  boxContentKey,
  buildPairUri,
  fromBase64Url,
  generateContentKey,
  generatePairKeypair,
  openBoxedContentKey,
  openFrame,
  parsePairUri,
  sealFrame,
  toBase64Url,
} from '@enso/pair';

const RELAY_HTTP = 'http://127.0.0.1:8787';
const RELAY_WS = 'ws://127.0.0.1:8787';

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const log = (id: string, s: string) => {
  $(id).textContent += `${s}\n`;
};
const addMsg = (id: string, text: string, cipherB64: string, mine: boolean) => {
  const d = document.createElement('div');
  d.className = 'msg';
  d.innerHTML = `<div>${mine ? '→ ' : '← '}${text}</div><div class="cipher">🔒 ${cipherB64.slice(0, 44)}… （密文 ${cipherB64.length} 字符）</div>`;
  $(id).appendChild(d);
};

function encodeBoxed(b: BoxedContentKey): string {
  return [toBase64Url(b.ephPublicKey), toBase64Url(b.nonce), toBase64Url(b.boxed)].join('.');
}
function decodeBoxed(s: string): BoxedContentKey {
  const [a, b, c] = s.split('.');
  return { ephPublicKey: fromBase64Url(a), nonce: fromBase64Url(b), boxed: fromBase64Url(c) };
}

let inviteUri = '';

const host = {
  kp: generatePairKeypair(),
  contentKey: null as Uint8Array | null,
  ws: null as WebSocket | null,
  pairId: '',
  hostToken: '',
  async start() {
    const pk = toBase64Url(this.kp.publicKey);
    const r = await fetch(`${RELAY_HTTP}/v1/pair/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicKey: pk }),
    });
    const j = await r.json();
    this.pairId = j.pairId;
    inviteUri = buildPairUri({ relay: RELAY_HTTP, publicKey: this.kp.publicKey });
    const invite = $('h-invite');
    invite.hidden = false;
    invite.textContent = inviteUri;
    log('h-log', `pairId = ${this.pairId}  (= sha256(公钥))`);
    (document.getElementById('p-scan') as HTMLButtonElement).disabled = false;
    $('h-status').textContent = '⏳ 等待手机扫码…';
    void this.poll();
  },
  async poll() {
    const pk = toBase64Url(this.kp.publicKey);
    for (let i = 0; i < 120; i++) {
      const r = await fetch(`${RELAY_HTTP}/v1/pair/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ publicKey: pk }),
      });
      const j = await r.json();
      if (j.state === 'authorized') {
        this.contentKey = openBoxedContentKey(decodeBoxed(j.response), this.kp.secretKey);
        this.hostToken = j.hostToken;
        log('h-log', `✅ 解开 box，contentKey = ${toBase64Url(this.contentKey).slice(0, 16)}…`);
        this.connect();
        return;
      }
      await new Promise((res) => setTimeout(res, 400));
    }
  },
  connect() {
    this.ws = new WebSocket(
      `${RELAY_WS}/v1/pair/${encodeURIComponent(this.pairId)}?role=host&token=${this.hostToken}`
    );
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => {
      $('h-status').textContent = '🟢 已连接';
      (document.getElementById('h-input') as HTMLInputElement).disabled = false;
    };
    this.ws.onmessage = async (e) => {
      if (typeof e.data === 'string') {
        log('h-log', `[控制帧] ${e.data}`);
        return;
      }
      const cipher = new Uint8Array(e.data);
      const obj = (await openFrame(this.contentKey as Uint8Array, cipher)) as { text: string };
      addMsg('h-msgs', obj.text, toBase64Url(cipher), false);
    };
  },
  async send(text: string) {
    const frame = await sealFrame(this.contentKey as Uint8Array, { text });
    (this.ws as WebSocket).send(frame);
    addMsg('h-msgs', text, toBase64Url(frame), true);
  },
};

const phone = {
  contentKey: null as Uint8Array | null,
  ws: null as WebSocket | null,
  pairId: '',
  deviceToken: '',
  async scan() {
    $('p-status').textContent = '📷 读取配对码…';
    const invite = parsePairUri(inviteUri);
    log('p-log', `扫到 relay = ${invite.relay}`);
    this.contentKey = generateContentKey();
    const boxed = boxContentKey(this.contentKey, invite.publicKey);
    const r = await fetch(`${invite.relay}/v1/pair/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        publicKey: toBase64Url(invite.publicKey),
        boxedKey: encodeBoxed(boxed),
        deviceName: 'Chrome-Phone',
      }),
    });
    const j = await r.json();
    if (j.error) {
      $('p-status').textContent = `❌ ${j.error}`;
      return;
    }
    this.pairId = j.pairId;
    this.deviceToken = j.deviceToken;
    log('p-log', '✅ 生成 contentKey 并 box 给 host 公钥，claim 成功');
    this.connect();
  },
  connect() {
    this.ws = new WebSocket(
      `${RELAY_WS}/v1/pair/${encodeURIComponent(this.pairId)}?role=guest&token=${this.deviceToken}`
    );
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => {
      $('p-status').textContent = '🟢 已连接';
      (document.getElementById('p-input') as HTMLInputElement).disabled = false;
    };
    this.ws.onmessage = async (e) => {
      if (typeof e.data === 'string') {
        log('p-log', `[控制帧] ${e.data}`);
        return;
      }
      const cipher = new Uint8Array(e.data);
      const obj = (await openFrame(this.contentKey as Uint8Array, cipher)) as { text: string };
      addMsg('p-msgs', obj.text, toBase64Url(cipher), false);
    };
  },
  async send(text: string) {
    const frame = await sealFrame(this.contentKey as Uint8Array, { text });
    (this.ws as WebSocket).send(frame);
    addMsg('p-msgs', text, toBase64Url(frame), true);
  },
};

$('h-start').addEventListener('click', () => void host.start());
$('p-scan').addEventListener('click', () => void phone.scan());
$('h-input').addEventListener('keydown', (e) => {
  const t = e.target as HTMLInputElement;
  if ((e as KeyboardEvent).key === 'Enter' && t.value) {
    void host.send(t.value);
    t.value = '';
  }
});
$('p-input').addEventListener('keydown', (e) => {
  const t = e.target as HTMLInputElement;
  if ((e as KeyboardEvent).key === 'Enter' && t.value) {
    void phone.send(t.value);
    t.value = '';
  }
});
