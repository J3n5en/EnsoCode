# PWA 完整模式冷启动头像裂图

## 症状

手机 PWA 每次打开，侧栏秘书头像是裂图（或一块空色块），要等和桌面同步完才正常。
桌面端、以及连上之后的界面都正常，所以容易去查 `SecretaryFace` 的回退或宿主的缓存头。

## 根因

冷启动时盖在 renderer 上的是启动快照：上次界面的静态副本，用沙箱 `srcdoc` 挂载，不跑脚本。
快照里的 `<img src="/desk/li/...">` 只能经 SW → desk 壳 → 隧道向桌面取，桌面没连上前一直挂着；
SW 被回收、找不到壳、超时（504）时请求失败，快照里没有 `onError` 回退，就是裂图；
不经 SW 的请求落到中继，中继对未知路径回 `index.html`，同样裂图。
另外 `/desk/li/` 的回包只带 `Content-Type`（宿主的 `Cache-Control` 在隧道里丢了），
SW 构造的响应也不进 HTTP 缓存，所以取到过的头像下次启动仍要重新经隧道取。
秘书清单只从宿主取，快照之外没有可提前显示的数据。

## 修法

desk 壳把按版本寻址的图（秘书/成员头像、插件图片，地址里带 `v`/`h`）取到后存进 Cache Storage
`enso-remote-images`，按「哪张图」去重、限条数，同一张图换版本时删旧的；之后同地址直接命中。
挂快照前把快照里的 `/desk/li/` 地址换成本地副本的 blob 地址（找不到精确版本时用同一张图的缓存版本），
没有副本的去掉 `src`，只留底色占位。带磁盘路径或外链的图不落盘。
renderer 里 `SecretaryFace` 失败后在远程模式下后台重试，连上后换回图片；秘书清单到达时清掉已删秘书的头像副本。
缓存名不能用 `enso-desk-` 前缀，壳启动时会删掉该前缀下不认识的缓存。

## 回归防线

`src/shared/remoteImageCache.test.ts`、`src/renderer/lib/remoteImage.test.ts`

## 相关代码

`src/shared/remoteImageCache.ts`、`packages/phone/src/desk/main.ts`、`src/renderer/lib/remoteImage.ts`、
`src/renderer/components/secretary/SecretaryFace.tsx`、`packages/phone/public/sw.js`
