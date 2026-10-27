# 添加第 2、3、4… 个币安 Agentic 钱包

TMTN 可以让多个币安 Agentic 钱包一起下单：页面上点一次买入，每个「参与下单」的钱包各买一份。本文教你添加钱包 2、3、4……，可以加任意多个。

> **可以整篇交给你的 AI 助手（Claude Code 等）照做。** 文中标 🧑 的步骤必须由你本人完成（扫码、选账号、核对配对码、决定是否实盘），AI 做到这里要停下来等你。

## 为什么要用 Docker

币安 Agentic Wallet CLI（`baw`）用**电脑网卡的 MAC 地址**识别设备。同一台电脑上登录两个币安账号，后登录的会把先登录的挤掉，只设置不同的 `BINANCE_BAW_DIR` / `BINANCE_INSTANCE_ID` 并不能解决。

解决办法：钱包 1 照常跑在电脑上（`npm run live`）；钱包 2、3、4… 各跑一个 Docker 容器。每个容器有自己的虚拟网卡，MAC 固定不变，币安就把它当成一台独立的设备。

```
浏览器 ──> 钱包 1（主后端，本机 8788 / 8787）
             │  订单按 WALLET_PEERS 转发，带 x-tmtn-token
             ├──> tmtn-wallet2 容器  127.0.0.1:8789   登录目录 wallets/wallet2/baw
             ├──> tmtn-wallet3 容器  127.0.0.1:8790   登录目录 wallets/wallet3/baw
             └──> tmtn-walletN 容器  127.0.0.1:(8787+N)
```

| 钱包 | 容器名 | 端口（只开在 127.0.0.1） | 配置和登录信息 |
| --- | --- | --- | --- |
| 2 | `tmtn-wallet2` | 8789 | `wallets/wallet2/` |
| 3 | `tmtn-wallet3` | 8790 | `wallets/wallet3/` |
| N | `tmtn-walletN` | 8787+N | `wallets/walletN/` |

`wallets/` 在 `.gitignore` 里，里面有登录信息和访问令牌，**不要提交、不要发给别人**。

## 给 AI 助手的规则

如果你是替用户执行本教程的 AI，请遵守：

1. **不要伪造或修改电脑的网卡 MAC**，也不要改 `wallets/walletN/mac`。容器的 MAC 由脚本生成并固定。
2. **不要替用户下单、转账、领取或打开自动转出**。本教程只负责把钱包接进来。
3. **不要重启或停止正在运行的钱包 1 后端**，除非用户明确同意（重启会中断正在进行的操作）。需要重启时告诉用户，等用户确认。
4. **不要在聊天里打印 `TMTN_API_TOKEN`** 等密钥的值；需要检查时只说「已设置 / 没设置」。
5. 遇到 🧑 步骤停下来，把需要的信息（链接、配对码、要用哪个账号）清楚地告诉用户，等用户回复后再继续。
6. 每一步都运行「校验」里的命令，结果不对就停下来报告，不要跳过。

## 第 0 步：前置检查

在项目根目录运行：

```bash
cd /path/to/TMTN          # 换成你的项目目录
docker info >/dev/null && echo "Docker OK"
docker compose version
node -v
test -f .env && echo ".env OK"
grep -q '^TMTN_API_TOKEN=.\{32,\}' .env && echo "TMTN_API_TOKEN 已设置" || echo "TMTN_API_TOKEN 没设置"
curl -s -o /dev/null -w '钱包 1 后端：HTTP %{http_code}\n' http://127.0.0.1:8788/api/wallet-info   # 你的主后端端口
```

- **没有 Docker**：macOS 推荐装 [OrbStack](https://orbstack.dev)（轻、省电），也可以用 Docker Desktop。装好后打开它。
- **没有 `.env`**：`cp .env.example .env`。
- **`TMTN_API_TOKEN` 没设置**：主后端和每个钱包容器之间靠这个令牌互相认证，必须设成同一个值。生成一个并写进 `.env`：

  ```bash
  TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  grep -q '^TMTN_API_TOKEN=' .env && sed -i.bak "s/^TMTN_API_TOKEN=.*/TMTN_API_TOKEN=$TOKEN/" .env || echo "TMTN_API_TOKEN=$TOKEN" >> .env
  unset TOKEN
  ```

  改完 `.env` 后**钱包 1 要重启才会用新令牌**（🧑 由用户决定什么时候重启）。

- 钱包 1 自己要先登录好（`baw auth signin`），这是前提。

## 第 1 步：创建钱包 N 的容器

把 `N` 换成要添加的编号（第一次加就是 2）。如果你已经知道这个钱包的 BSC 地址（币安 App 里 Agentic 钱包的地址），**强烈建议**用 `--address` 填上：之后万一用错账号扫码，这个钱包会拒绝工作，不会拿错账号下单。

```bash
scripts/add-wallet.sh N --address 0x你的钱包N地址
# 还不知道地址就先不填：scripts/add-wallet.sh N
```

脚本会：检查 Docker 和令牌 → 生成并固定一个虚拟 MAC → 写 `wallets/walletN/docker-compose.yml` → 构建镜像（第一次要几分钟）并启动容器 → 打印状态。默认是**只报价**（`LIVE_TRADE=0`），不会真实下单。

**校验：**

```bash
scripts/add-wallet.sh N --status
```

应看到「容器：Up …」和「登录：未登录」。如果是「后端：连不上」，看日志：`docker logs --tail 50 tmtn-walletN`。

## 第 2 步：🧑 用钱包 N 对应的币安账号登录

> ⚠️ **这一步最容易出错。** 曾经有人用钱包 1 的账号去扫钱包 2 的码，结果两个后端用的是同一个账号。扫码前请确认：手机上币安 App 当前登录的，就是你想作为「钱包 N」的那个账号。

**方式 A（推荐，用户自己在终端里做）：**

```bash
docker exec -it tmtn-walletN baw auth signin
```

容器里没有浏览器，所以终端会直接打印一个**登录链接**和一个**配对码**。

1. 🧑 把链接复制到电脑浏览器打开，页面上会出现二维码。
2. 🧑 用**钱包 N 对应的币安账号**打开币安 App 扫码。
3. 🧑 **核对 App 里显示的配对码和终端打印的完全一致**，一致才点确认。不一致就取消，重新运行上面的命令。

**方式 B（AI 代为发起，用户只负责扫码）：**

AI 运行：

```bash
docker exec tmtn-walletN baw --json auth signin
```

输出里有 `urlForWeb`（登录链接）、`pairingCode`（配对码）、`qrCodeId`。AI 把链接和配对码发给用户，然后在后台等待用户确认（最多 5 分钟）：

```bash
docker exec tmtn-walletN baw --json auth verify --qrCodeId <上一步的 qrCodeId>
```

用户照方式 A 的 1～3 步操作。返回 `"status":"SUCCESS"` 表示登录成功；超时就重新发起。

**校验：**

```bash
scripts/add-wallet.sh N --status
```

- 「登录：已登录」，并且地址就是你预期的钱包 N 地址 → 成功。
- 第 1 步没填 `--address` 的：🧑 请用户核对打印出来的地址是钱包 N 的，并且**和钱包 1、其他钱包都不一样**。确认后锁定：`scripts/add-wallet.sh N --address 0x这个地址`。
- 「登录的不是预期账号（已拒绝使用）」→ 扫错账号了，见下面「扫错账号怎么办」。

顺便确认钱包 1 没被挤掉：打开 TMTN 页面看钱包 1 仍是已登录，或在终端运行 `baw wallet status`。

## 第 3 步：让钱包 1 知道钱包 N

```bash
scripts/add-wallet.sh --peers --write-env
```

它会把所有已添加的钱包写进 `.env` 的 `WALLET_PEERS`（先把 `.env` 备份成 `.env.bak-时间`），例如：

```bash
WALLET_PEERS=[{"slot":2,"label":"钱包 2","url":"http://127.0.0.1:8789","signin":"docker exec -it tmtn-wallet2 baw auth signin"}]
```

然后 🧑 **重启钱包 1 的后端**（用户自己决定时机）。

**校验：** 打开 TMTN 页面，右上角钱包菜单里应该能看到钱包 N，状态是已登录。

## 第 4 步：🧑 决定是否实盘

新钱包默认只报价。用户确认一切正常、愿意让钱包 N 真实下单后，再运行：

```bash
scripts/add-wallet.sh N --live
```

（改回只报价：`scripts/add-wallet.sh N --quote-only`）

然后在页面钱包菜单里打开钱包 N 的「参与下单」（其他钱包默认不参与）。建议先用极小金额试一笔。

额外钱包**不会自动转出**（容器里 `AUTO_TRANSFER_TO` 是空的）。

## 再加一个

钱包 3、4、5… 重复第 1～4 步，只是把 `N` 换掉。每次第 3 步都会把全部钱包重新写进 `WALLET_PEERS`。

## 日常维护

| 要做的事 | 命令 |
| --- | --- |
| 看状态 | `scripts/add-wallet.sh N --status` |
| 看日志 | `docker logs -f --tail 100 tmtn-walletN` |
| 停止 / 启动 | `docker stop tmtn-walletN` / `docker start tmtn-walletN` |
| 更新代码后重建 | `git pull` 后运行 `scripts/add-wallet.sh N`（登录信息、MAC、数据都保留） |
| 换了 `TMTN_API_TOKEN` | 每个钱包运行一次 `scripts/add-wallet.sh N`，再重启钱包 1 |

容器设置了 `restart: unless-stopped`，Docker / OrbStack 启动后会自动拉起。

## 扫错账号怎么办

现象：`--status` 显示「登录的不是预期账号」，或者两个钱包显示同一个地址。

1. 先在页面钱包菜单里关掉这个钱包的「参与下单」。
2. 让容器退出这个账号。先看 baw 支持的命令：`docker exec -it tmtn-walletN baw auth --help`，用其中的登出命令；如果没有，就停容器、把登录目录挪走（**不要删**，留着备查）：

   ```bash
   docker stop tmtn-walletN
   mv wallets/walletN/baw wallets/walletN/baw.wrong-$(date +%Y%m%d-%H%M%S)
   scripts/add-wallet.sh N          # 会重新建一个空的登录目录并启动
   ```

3. 回到第 2 步，这次用正确的账号扫码，并核对配对码。
4. 如果扫错的是钱包 1 的账号，回去确认钱包 1 仍然正常登录。

## 常见问题

- **钱包 1 被挤掉了 / 登录老是掉**：检查是不是有两个后端用了同一个 MAC（比如复制了 `wallets/wallet2` 当 `wallet3`）。每个钱包的 `wallets/walletN/mac` 必须不同；复制出来的话删掉新目录，重新运行 `scripts/add-wallet.sh N`。
- **`容器 MAC 是 ……，预期 ……`**：Docker 版本太旧，不支持固定 `mac_address`。升级 OrbStack / Docker Desktop。
- **端口被占用**：`lsof -nP -iTCP:端口 -sTCP:LISTEN` 看是哪个程序。
- **页面里钱包 N 显示「连不上」**：容器没在运行，或 `TMTN_API_TOKEN` 和钱包 1 的不一致（改过令牌后要按上面「换了 TMTN_API_TOKEN」处理）。
- **容器里行情只用公共节点**：为了省 NodeReal 额度，容器默认 `FEEDS_PUBLIC=1`，不读你的 `.env`，也拿不到你的 RPC key。
