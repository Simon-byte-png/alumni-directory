# CloudBase 间接依赖核查（2026-09-30）

核查依据：本项目 `package-lock.json`、已安装 SDK 的实际源代码、npm 官方仓库包元数据和维护者安全公告。这里的 SDK 指腾讯提供的服务端开发工具包，它把数据库、签名、存储等功能封装成可以调用的函数。

| 包和当前版本 | 做什么 | 本网站的实际调用路径 | 判断 |
| --- | --- | --- | --- |
| `axios@0.27.2` | 发送 HTTP 请求 | CloudBase 读取固定腾讯云元数据地址；SDK 另提供请求便利方法，本网站没有调用这些便利方法 | 老版本有公告；未发现用户可控制该请求地址的路径，不能据此宣称完全无风险 |
| `lodash.set@4.3.2` | 根据字段路径设置嵌套对象内容 | 数据库实时监听的 `updatedFields`；项目只使用读写和事务，没有启用实时监听 | 公告中的恶意字段路径没有发现可达的产品入口；此独立包的最新版本仍是 4.3.2，无简单的原包版本升级修复 |
| `lodash.unset@4.5.2` | 根据字段路径移除嵌套对象内容 | 数据库实时监听的 `removedFields`；项目没有启用实时监听 | 同上；官方包已有 4.18.0，但 CloudBase 的数据库组件仍固定 4.5.2，替换需要兼容性验证 |
| `qs@6.15.3` | 解析地址中的查询参数，例如 `a=1&b=2` | 依赖树经 `@cloudbase/signature-nodejs → url → qs` 带入；实际服务端签名代码是 `require('url')`，Node 优先解析为内置模块，未调用 npm 的 `url` 包 | 纠正之前仅按依赖树推断的“签名时使用 qs”：在当前 Node 服务端实际路径中未发现调用，不能把安装存在等同于可被网页触发 |

源代码位置：

- `@cloudbase/node-sdk/dist/utils/metadata.js`：固定云元数据地址、短超时；`dist/cloudbase.js` 的 `requestClient` 提供 axios 便利方法。
- `@cloudbase/database/dist/commonjs/realtime/virtual-websocket-client.js`：`updatedFields` / `removedFields` 分别调用 set / unset。
- `@cloudbase/signature-nodejs/lib/signer.js`：`require('url')`；本机 Node 22 的 `require.resolve('url')` 返回 `url`，而不是 npm 文件路径。

官方 npm 元数据确认 `@cloudbase/node-sdk` 最新标签仍为 **3.18.3**，其中仍固定 `axios 0.27.2`、`@cloudbase/database 1.4.3`；后者固定上述两个 lodash 包。不能通过“再更新一次 CloudBase SDK”直接去掉这些问题。

当前结论：四个包确实存在有公告的旧版本，未验证出可由本网站输入触发的攻击路径；保留为依赖风险。不要直接删除它们，否则 SDK 导入或未来调用可能失败。上线前这次不盲目替换底层库；后续可在隔离环境验证 axios、qs、unset 的覆盖升级，对没有更新版本的 set 使用经过验证的安全替代，或者等上游替换。新增实时监听、代理任意 URL 等功能时必须重新审查。

参考原文：

- [axios 维护者公告](https://github.com/axios/axios/security/advisories/GHSA-jr5f-v2jv-69x6)
- [lodash.set 公告](https://github.com/advisories/GHSA-p6mc-m468-83gw)
- [lodash 维护者修复记录](https://github.com/lodash/lodash/wiki/Changelog)
- [qs 维护者公告](https://github.com/ljharb/qs/security/advisories/GHSA-4mjr-xmp4-gh2g)
- [CloudBase 服务端 SDK 官方 npm 元数据](https://registry.npmjs.org/@cloudbase/node-sdk/latest)

本项目未使用前端 `@cloudbase/js-sdk`；移除它可减少不需要的依赖，但不能消除服务端 SDK 固定引入的四个包。此次没有混入依赖大版本替换。
