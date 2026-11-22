import { installElectronApiShim } from './electron-api';

// 须是 main.tsx 的第一个导入：ESM 先求值完整个依赖图才跑入口正文，写在正文里就晚于所有复用组件
installElectronApiShim();
