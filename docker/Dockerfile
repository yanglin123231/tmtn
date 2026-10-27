# TMTN 额外钱包的后端（钱包 2、3、4…）：每个钱包一个容器。
# 币安 Agentic Wallet（baw）用网卡 MAC 识别设备，同一台机器上登录两个账号会互相挤掉；
# 容器有自己的虚拟网卡（docker-compose 里固定 mac_address），币安就把它当成另一台设备。
# 构建上下文是项目根目录：docker build -f docker/Dockerfile .（scripts/add-wallet.sh 会自动做）
FROM node:22-slim
RUN npm i -g @binance/agentic-wallet@1.12.0 && npm cache clean --force
# 容器里没有浏览器：去掉 baw 自带的「打开浏览器」脚本，baw auth signin 会直接把登录链接打印出来，复制到电脑的浏览器里打开
RUN rm -f /usr/local/lib/node_modules/@binance/agentic-wallet/node_modules/open/xdg-open
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . ./
# 默认只报价（LIVE_TRADE=0）、不自动转出；钱包编号、端口、实盘开关由 wallets/walletN/docker-compose.yml 覆盖
ENV MODE=live LIVE_TRADE=0 HOST=0.0.0.0 WALLET_PEERS=[] FEEDS_PUBLIC=1 AUTO_TRANSFER_FOUR=0 DATA_DIR=/data
CMD ["node", "server.js"]
