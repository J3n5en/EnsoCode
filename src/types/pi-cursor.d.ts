// @rahularya01/pi-cursor 无类型声明；仅用其 default 导出（接收 ExtensionAPI shim）
declare module '@rahularya01/pi-cursor' {
  const extension: (api: unknown) => void;
  export default extension;
}
