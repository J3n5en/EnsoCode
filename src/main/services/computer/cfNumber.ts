/** CFNumberGetValue 的类型参数。6 = kCFNumberFloat64Type；4 是 SInt64，不能把那些字节按 double 读。 */
export const kCFNumberFloat64Type = 6;

export function decodeCfNumberAsFloat64(bytes: Buffer): number {
  return bytes.readDoubleLE(0);
}
