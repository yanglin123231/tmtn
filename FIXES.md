# 本地修复记录（基于上游 v2.4.0 / 92384e7）

本仓库包含三处针对真实运行环境的修复：

## 1. `baw wallet balance --hideLowValue` 参数不兼容
- 文件：`engine/live/baw.js`
- 现象：下单失败，提示 `error: unknown option '--hideLowValue'`
- 原因：`baw` CLI v1.10.0 的 `wallet balance` 没有 `--hideLowValue` 选项
- 修复：移除该参数

## 2. 买入报 `q is not defined`
- 文件：`engine/live/gangV2Pads.js`
- 原因：`buy()` 里 `const q = this.quoteToken(c); const hashes = [];` 被写在了行尾 `//` 注释之后，等于没有声明
- 修复：把声明拆到独立一行

## 3. 持仓页看不到「在别处买入」的币
- 文件：`engine/live/holdings.js`
- 现象：只有通过本程序下过单的币才会出现在持仓里，用脚本 / 网页 / 其他终端买的币看不到
- 修复：新增 `chainExtra()`，用 Multicall3 一次读取钱包里全部 gang/four/flap 代币的链上 `balanceOf`（60 秒缓存），
  持仓数量改为「链上余额优先」，程序记录只用于补成本与历史
