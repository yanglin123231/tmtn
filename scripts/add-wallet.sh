#!/usr/bin/env bash
# 添加 / 更新第 N 个币安 Agentic 钱包（N ≥ 2）：每个钱包一个 Docker 容器，固定虚拟网卡 MAC，币安把它当成独立设备。
#
#   scripts/add-wallet.sh N [--address 0x…] [--live] [--quote-only] [--write-env]
#   scripts/add-wallet.sh N --status
#   scripts/add-wallet.sh --peers [--write-env]
#
#   N             钱包编号（2、3、4…）。容器名 tmtn-walletN，端口 127.0.0.1:(8787+N)，配置在 wallets/walletN/
#   --address     这个钱包预期的 BSC 地址。填了之后 baw 登录成别的账号会被拒绝（防止扫错账号）
#   --live        这个钱包真实下单（LIVE_TRADE=1）。不加 = 只报价，第一次建议先不加
#   --quote-only  改回只报价（LIVE_TRADE=0）
#   --write-env   把所有已添加钱包的 WALLET_PEERS 写进项目根目录 .env（先备份成 .env.bak-时间）。主后端要重启才生效
#   --status      只查看这个钱包容器的状态（登录状态、地址）
#   --peers       只打印（或写入）WALLET_PEERS
#
# 可以重复运行：MAC、登录信息、数据都保留，只更新地址 / 实盘开关并重建容器。不会碰主后端进程。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

die() { echo "✗ $*" >&2; exit 1; }
ok() { echo "✓ $*"; }
port_of() { echo $((8787 + $1)); }

N="" ADDRESS="" LIVE="" WRITE_ENV=0 STATUS=0 PEERS_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --address) ADDRESS="${2:-}"; shift 2 ;;
    --address=*) ADDRESS="${1#*=}"; shift ;;
    --live) LIVE=1; shift ;;
    --quote-only) LIVE=0; shift ;;
    --write-env) WRITE_ENV=1; shift ;;
    --status) STATUS=1; shift ;;
    --peers) PEERS_ONLY=1; shift ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) [ -z "$N" ] || die "多余的参数：$1"; N="$1"; shift ;;
  esac
done

# 所有 wallets/walletN/ 拼成主后端用的 WALLET_PEERS
peers_json() {
  local out="" d n p
  for d in wallets/wallet*/; do
    [ -f "$d/docker-compose.yml" ] || continue
    n="${d#wallets/wallet}"; n="${n%/}"
    case "$n" in ''|*[!0-9]*) continue ;; esac
    p=$(port_of "$n")
    out="$out${out:+,}{\"slot\":$n,\"label\":\"钱包 $n\",\"url\":\"http://127.0.0.1:$p\",\"signin\":\"docker exec -it tmtn-wallet$n baw auth signin\"}"
  done
  echo "[$out]"
}

write_env() {
  local peers line bak
  peers="$(peers_json)"; line="WALLET_PEERS=$peers"
  [ -f .env ] || die "项目根目录没有 .env"
  bak=".env.bak-$(date +%Y%m%d-%H%M%S)"; cp -p .env "$bak"
  if grep -q '^WALLET_PEERS=' .env; then
    PEERS_LINE="$line" node -e 'const fs=require("fs");const s=fs.readFileSync(".env","utf8").split("\n").map((l)=>l.startsWith("WALLET_PEERS=")?process.env.PEERS_LINE:l).join("\n");fs.writeFileSync(".env",s)'
  else
    printf '\n%s\n' "$line" >> .env
  fi
  grep -q '^WALLET_LABEL=' .env || printf 'WALLET_LABEL=钱包 1\n' >> .env
  ok ".env 已更新（备份：$bak）：$line"
  echo "  → 重启主后端（钱包 1）后生效"
}

status() {
  local n="$1" p want info
  p=$(port_of "$n"); want=""
  [ -f "wallets/wallet$n/address" ] && want="$(cat "wallets/wallet$n/address")"
  echo "钱包 $n · 容器 tmtn-wallet$n · http://127.0.0.1:$p"
  docker ps --filter "name=^tmtn-wallet$n\$" --format '容器：{{.Status}}' | sed 's/^/  /' | grep . || echo "  容器：没在运行"
  if ! info="$(curl -fsS -m 3 "http://127.0.0.1:$p/api/wallet-info" 2>/dev/null)"; then echo "  后端：连不上"; return 1; fi
  WANT="$want" INFO="$info" node -e '
    const i = JSON.parse(process.env.INFO || "null") || {}, want = (process.env.WANT || "").toLowerCase();
    const names = { ok: "已登录", wrong_account: "登录的不是预期账号（已拒绝使用）", checking: "检查中", logged_out: "未登录" };
    console.log("  登录：" + (names[i.auth] || i.auth || "未知"));
    console.log("  地址：" + (i.address || "（还没有）") + (want ? "   预期：" + want : "   预期：未设置（建议用 --address 锁定）"));
    if (want && i.address && i.address.toLowerCase() !== want) console.log("  ✗ 地址和预期不一致：登错账号了，见教程「扫错账号怎么办」");
    else if (want && i.address) console.log("  ✓ 地址和预期一致");
    console.log("  BNB：" + (i.bnb ?? "-"));'
}

if [ "$PEERS_ONLY" = 1 ]; then
  echo "WALLET_PEERS=$(peers_json)"
  [ "$WRITE_ENV" = 1 ] && write_env
  exit 0
fi

case "$N" in ''|*[!0-9]*) die "用法：scripts/add-wallet.sh N [--address 0x…] [--live] [--write-env]（N 是 2、3、4…）" ;; esac
[ "$N" -ge 2 ] || die "钱包 1 是主后端（npm run live），这里只添加 2 号及以后的钱包"
[ "$N" -le 99 ] || die "N 太大了"

if [ "$STATUS" = 1 ]; then status "$N"; exit $?; fi

# ---------- 前置检查 ----------
command -v docker >/dev/null || die "没有 docker 命令。macOS 推荐装 OrbStack（https://orbstack.dev），或 Docker Desktop"
docker info >/dev/null 2>&1 || die "Docker 没在运行：先打开 OrbStack / Docker Desktop"
docker compose version >/dev/null 2>&1 || die "没有 docker compose（Docker Compose v2）"
command -v node >/dev/null || die "没有 node"
command -v curl >/dev/null || die "没有 curl"
[ -f .env ] || die "项目根目录没有 .env：先 cp .env.example .env"
TOKEN="$(grep -E '^TMTN_API_TOKEN=' .env | tail -1 | cut -d= -f2- | sed -E "s/^['\"]|['\"]\$//g")"
[ "${#TOKEN}" -ge 32 ] || die ".env 里的 TMTN_API_TOKEN 没填（至少 32 位）。生成一个：node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"，写进 .env 的 TMTN_API_TOKEN=，然后重启主后端"

DIR="wallets/wallet$N"; NAME="tmtn-wallet$N"; PORT=$(port_of "$N")
mkdir -p "$DIR/baw" "$DIR/data"; chmod 700 "$DIR" "$DIR/baw"

# 端口：自己的容器占着没关系，别的程序占着就停下
if ! docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then die "端口 $PORT 已被别的程序占用：lsof -nP -iTCP:$PORT -sTCP:LISTEN 看看是谁"; fi
fi

# MAC：第一次随机生成（02: 开头 = 本地管理地址，不会和真实网卡冲突），之后一直用同一个。改了币安会当成新设备，要重新登录
if [ -f "$DIR/mac" ]; then MAC="$(cat "$DIR/mac")"
else
  while :; do
    MAC="02:$(od -An -N5 -tx1 /dev/urandom | tr -s ' ' | sed 's/^ //; s/ $//; s/ /:/g')"
    grep -qsx "$MAC" wallets/wallet*/mac || break
  done
  echo "$MAC" > "$DIR/mac"
fi
echo "$MAC" | grep -Eq '^([0-9a-f]{2}:){5}[0-9a-f]{2}$' || die "$DIR/mac 格式不对：$MAC"

# 预期地址
if [ -n "$ADDRESS" ]; then
  echo "$ADDRESS" | grep -Eq '^0x[0-9a-fA-F]{40}$' || die "--address 不是有效的 BSC 地址：$ADDRESS"
  echo "$ADDRESS" > "$DIR/address"
fi
ADDRESS=""; [ -f "$DIR/address" ] && ADDRESS="$(cat "$DIR/address")"

# 实盘开关：没指定就沿用上次（第一次 = 只报价）
if [ -n "$LIVE" ]; then echo "$LIVE" > "$DIR/live"; fi
LIVE=0; [ -f "$DIR/live" ] && LIVE="$(cat "$DIR/live")"

# 访问令牌单独放在 wallets/walletN/.env（不写进 compose 文件）
umask 077
printf 'TMTN_API_TOKEN=%s\n' "$TOKEN" > "$DIR/.env"
umask 022

cat > "$DIR/docker-compose.yml" <<YML
# 由 scripts/add-wallet.sh 生成，可以重新运行脚本覆盖。登录信息在 ./baw，数据在 ./data（重建容器也不丢）
services:
  $NAME:
    build:
      context: ../..
      dockerfile: docker/Dockerfile
    image: tmtn-wallet:latest
    container_name: $NAME
    hostname: $NAME
    mac_address: "$MAC"   # 固定的虚拟网卡地址：不要改，改了币安会当成新设备，要重新登录
    restart: unless-stopped
    env_file: .env        # TMTN_API_TOKEN（和主后端 .env 里的一致，主后端才能把订单转过来）
    environment:
      WALLET_SLOT: "$N"
      WALLET_LABEL: "钱包 $N"
      PORT: "$PORT"
      LIVE_TRADE: "$LIVE"           # 1 = 真实下单；0 = 只报价
      WALLET_ADDRESS: "$ADDRESS"    # 只允许这个地址（空 = 不检查，建议填）
      AUTO_TRANSFER_TO: ""          # 额外钱包不自动转出
    ports:
      - "127.0.0.1:$PORT:$PORT"     # 只开在本机
    volumes:
      - ./baw:/root/.baw
      - ./data:/data
YML

echo "→ 构建镜像并启动 $NAME（第一次要几分钟）"
docker compose -p "$NAME" -f "$DIR/docker-compose.yml" up -d --build

# 容器的 MAC 是否就是我们写的
GOT="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.MacAddress}}{{end}}' "$NAME" 2>/dev/null || true)"
[ "$GOT" = "$MAC" ] && ok "容器 MAC = $MAC" || echo "! 容器 MAC 是「$GOT」，预期 $MAC（Docker 版本太老可能不支持 mac_address）"

printf '→ 等后端起来'
for _ in $(seq 1 60); do curl -fsS -m 2 "http://127.0.0.1:$PORT/api/wallet-info" >/dev/null 2>&1 && break; printf '.'; sleep 1; done; echo
status "$N" || die "后端没起来：docker logs --tail 50 $NAME"

echo
echo "实盘：$([ "$LIVE" = 1 ] && echo '真实下单（LIVE_TRADE=1）' || echo '只报价（LIVE_TRADE=0），确认无误后加 --live 重新运行')"
echo "登录（需要本人操作，用钱包 $N 对应的币安账号）：docker exec -it $NAME baw auth signin"
echo "查看状态：scripts/add-wallet.sh $N --status"
echo "WALLET_PEERS=$(peers_json)"
[ "$WRITE_ENV" = 1 ] && write_env || echo "（加 --write-env 可以把上面这行写进 .env）"
