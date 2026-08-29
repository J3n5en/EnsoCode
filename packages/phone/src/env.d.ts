/// <reference types="vite/client" />

// 复用桌面组件时会引用 window.electronAPI；直接沿用 preload 的真实类型声明，
// 避免自造类型与桌面漂移（运行时由 src/stubs/electron-api.ts 提供降级实现）。
import '../../../src/preload/types';
