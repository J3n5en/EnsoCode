// agent worker 入口：跑在 utilityProcess 里，与 Main 通过 parentPort 通信。
// 当前为通路验证的 echo 实现，后续由 SessionSupervisor 接管。
const port = process.parentPort;

port.on('message', (event) => {
  port.postMessage({ type: 'echo', payload: event.data });
});

port.postMessage({ type: 'ready' });
