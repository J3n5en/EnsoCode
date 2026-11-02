// 拉取已签名的插件市场索引写入 builtinMarket.ts，发版前运行：
// node scripts/update-builtin-market.mjs [base，默认 GitHub dist 分支]
import { writeFileSync } from 'node:fs';

const base = process.argv[2] ?? 'https://raw.githubusercontent.com/J3n5en/enso-plugins/dist/v1/';
const get = async (name) => {
  const res = await fetch(new URL(name, base));
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.text();
};
const [index, signature] = await Promise.all([get('index.json'), get('index.json.sig')]);
writeFileSync(
  new URL('../src/main/services/extensionPlugins/builtinMarket.ts', import.meta.url),
  `/** 随安装包内置的已签名市场索引；由 scripts/update-builtin-market.mjs 生成 */\nexport const BUILTIN_MARKET: { index: string; signature: string } | null = ${JSON.stringify({ index, signature: signature.trim() })};\n`
);
console.log(`builtin market updated from ${base}`);
