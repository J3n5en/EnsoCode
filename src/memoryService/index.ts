/**
 * 记忆服务进程入口：utilityProcess（生产）或 child_process.fork（测试）运行。
 * better-sqlite3 / sqlite-vec / node-llama-cpp 全在本进程，Main 只做转发，
 * 检索 / 写入 / 本地推理不再阻塞渲染。
 */
import path from 'node:path';
import { initMemoryService } from '../main/services/memoryServiceCore';
import { createMemoryServiceBridge, type MemoryServicePort } from './bridge';
import { dispatchMemoryOp } from './ops';

const memoryRoot = process.env.ENSO_MEMORY_ROOT;
const sessionDir = process.env.ENSO_MEMORY_SESSION_DIR;
if (!memoryRoot || !sessionDir) {
  throw new Error('ENSO_MEMORY_ROOT and ENSO_MEMORY_SESSION_DIR are required');
}

function workerPort(): MemoryServicePort {
  const parent = process.parentPort;
  if (parent) {
    return {
      postMessage: (message) => parent.postMessage(message),
      onMessage: (listener) => parent.on('message', (event) => listener(event.data)),
    };
  }
  if (typeof process.send === 'function') {
    const send = process.send.bind(process);
    return {
      postMessage: (message) => {
        send(message);
      },
      onMessage: (listener) => process.on('message', listener),
    };
  }
  throw new Error('memory service has no parent channel');
}

const wport = workerPort();
const bridge = createMemoryServiceBridge(wport, dispatchMemoryOp);

initMemoryService({
  paths: { memoryRoot: path.resolve(memoryRoot), sessionDir: path.resolve(sessionDir) },
  postEvent: (event) => wport.postMessage(event),
  remoteComplete: bridge.remoteComplete,
  transcriptReader: bridge.requestTranscript,
});

wport.postMessage({ type: 'ready' });
