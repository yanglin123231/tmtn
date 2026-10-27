import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Market, SNIPE_FEE_CURVE } from './engine/market.js';
import { SimTrader, GAS_PRESETS } from './engine/trader.js';
import { Agent } from './engine/agent.js';
import { Blocklist } from './engine/blocklist.js';
import { Favorites } from './engine/favorites.js';
import { DATA_DIR as DATA_DIR_UI } from './engine/live/config.js';
import { MODE, LIVE_TRADE, WALLET_SLOT, WALLET_PEERS, BAW_DIR, WALLET_LABEL } from './engine/live/config.js';
import * as latency from './engine/live/latency.js';
import { redactSecrets } from './engine/live/rpc.js';
import { dataFile } from './engine/live/config.js';

// 日志脱敏：控制台 / live.log 里出现的 RPC 地址（含 NodeReal key）一律打码
for (const k of ['log', 'info', 'warn', 'error']) { const f = console[k].bind(console); console[k] = (...a) => f(...a.map((x) => (typeof x === 'string' ? redactSecrets(x) : x instanceof Error ? redactSecrets(x.stack || x.message) : x))); }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);

// MODE=live：真实行情（shrine + Flap Agent Curve Reader + fsi）+ baw 报价/预演；再加 LIVE_TRADE=1 才会把手动订单真实上链
const LIVE = MODE === 'live';
let market, trader;
if (LIVE) {
  const { LiveMarket } = await import('./engine/live/liveMarket.js');
  const { LiveTrader } = await import('./engine/live/liveTrader.js');
  market = new LiveMarket();
  trader = new LiveTrader(market);
  await trader.init();
  // 按币的「发射后转出」监控（data/transferWatch.json，与 AUTO_TRANSFER_FOUR 无关）
  const { startTransferWatch } = await import('./engine/live/transferWatch.js');
  startTransferWatch(trader, market.provider, { intervalMs: 3000, dryRun: !LIVE_TRADE });
} else {
  market = new Market();
  trader = new SimTrader(market);
}
const agent = new Agent(market, trader, { live: LIVE });
const favorites = new Favorites();
// RPC 用量：每分钟汇总一次（按节点 / 用途 / 方法），打印到控制台并追加到 data/rpc-usage.jsonl；/api/rpc-usage 看最近 60 分钟
const rpcUsageLog = [];
if (LIVE) {
  const { takeUsage, cuOf } = await import('./engine/live/rpc.js');
  const { appendFileSync, mkdirSync } = await import('node:fs');
  setInterval(() => {
    const u = takeUsage(), nr = Object.entries(u).filter(([k]) => k.startsWith('NodeReal'));
    const total = nr.filter(([k]) => !k.endsWith('|ws_bytes')).reduce((a, [, n]) => a + n, 0);
    const perKey = {}; for (const [k, n] of nr) { const [node, , m] = k.split('|'); const o = (perKey[node] ||= { req: 0, cu: 0 }); if (m !== 'ws_bytes') o.req += n; o.cu += cuOf(m, n); }
    for (const o of Object.values(perKey)) o.cu = Math.round(o.cu);
    const row = { ts: Date.now(), nodereal: total, cu: Object.values(perKey).reduce((a, o) => a + o.cu, 0), perKey, all: Object.values(u).reduce((a, n) => a + n, 0), detail: u };
    rpcUsageLog.push(row); if (rpcUsageLog.length > 60) rpcUsageLog.shift();
    const top = nr.filter(([k]) => !k.endsWith('|ws_bytes')).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${k}×${n}`).join('，');
    console.log(`[RPC] 最近 1 分钟 NodeReal ${total} 次 / ${row.cu} CU（${Object.entries(perKey).map(([k, o]) => `${k} ${o.req} 次 ${o.cu} CU`).join('，')}）${top ? '：' + top : ''}`);
    try { mkdirSync(path.join(__dirname, 'data'), { recursive: true }); appendFileSync(path.join(__dirname, 'data', 'rpc-usage.jsonl'), JSON.stringify(row) + '\n'); } catch { /* 写不了就算了 */ }
  }, 60_000);
}
// 行情列表满了会淘汰最老的币：持有中（本程序记录 + 持仓快照）和收藏的币不能被淘汰，否则持仓页会少掉它们
market.keepSet = () => new Set([
  ...[...(trader.positions?.values?.() || [])].filter((p) => p.amount > 0).map((p) => String(p.token).toLowerCase()),
  ...(() => { try { return holdSnap?.rows || []; } catch { return []; } })().filter((r) => r.amount > 0).map((r) => String(r.token).toLowerCase()),   // 启动早期 holdSnap 还没定义
  ...Object.keys(favorites.items || {}).map((a) => a.toLowerCase()),
]);
const blocklist = new Blocklist(); agent.isBlocked = (s) => blocklist.has(s);   // 屏蔽的币不自动买
// 实盘的 ⚡ 快捷买入金额存进 data/live-settings.json，重启后沿用（以前每次重启都回到默认 0.1）
if (LIVE) { const q = Number(trader.loadSaved?.().quickBuy); if (q > 0) agent.setConfig({ quickBuy: q }); }
// 持仓页：链上数量 + baw 钱包历史算成本（只在实盘模式）
const holdings = LIVE ? new (await import('./engine/live/holdings.js')).Holdings(market, trader) : null;
market.start();

const net = { wss: 302, rpc: 102, detect: 146, detectAt: Date.now() };
setInterval(() => {
  if (LIVE) Object.assign(net, market.netStatus());
  else { net.wss = Math.round(260 + Math.random() * 90); net.rpc = Math.round(80 + Math.random() * 50); }
}, LIVE ? 1000 : 3000);
agent.on('detect', (ms) => { net.detect = ms; net.detectAt = Date.now(); });
const modeInfo = () => ({ mode: LIVE ? 'live' : 'sim', baw: LIVE ? trader.status : null });

const app = express();
// ---------- 本地 API 防护 ----------
// 1) Host 只认本机名（防 DNS rebinding：别的网站把域名解析到 127.0.0.1 再来调接口）
// 2) 改动类请求（POST 等）和 WebSocket：浏览器发来的必须是本页面同源（Origin = http://localhost:端口），别的网页（含本机其他端口）一律拒绝
// 3) 没有 Origin 的请求（其他钱包后端、脚本）必须带访问令牌 x-tmtn-token：TMTN_API_TOKEN，没配就用 data/api-token（首次启动随机生成）
// 额外允许的主机名 / 来源用 ALLOWED_HOSTS / ALLOWED_ORIGINS（逗号分隔）
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', ...String(process.env.ALLOWED_HOSTS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)]);
const EXTRA_ORIGINS = new Set(String(process.env.ALLOWED_ORIGINS || '').split(',').map((x) => x.trim().replace(/\/$/, '').toLowerCase()).filter(Boolean));
const API_TOKEN = (() => {
  if (process.env.TMTN_API_TOKEN) return process.env.TMTN_API_TOKEN;
  const f = dataFile('api-token');
  try { const t = fs.readFileSync(f, 'utf8').trim(); if (t.length >= 32) return t; } catch { /* 第一次启动 */ }
  const t = crypto.randomBytes(32).toString('hex'); fs.mkdirSync(new URL('.', f), { recursive: true }); fs.writeFileSync(f, t + '\n', { mode: 0o600 }); return t;
})();
const hostOk = (h) => LOCAL_HOSTS.has(String(h || '').toLowerCase().replace(/:\d+$/, ''));
const originOk = (o) => { try { const u = new URL(o); return EXTRA_ORIGINS.has(u.origin.toLowerCase()) || (u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname.toLowerCase()) && Number(u.port || 80) === PORT); } catch { return false; } };
const tokenOk = (t) => { const a = Buffer.from(String(t || '')), b = Buffer.from(API_TOKEN); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const guard = (req, write) => {
  if (!hostOk(req.headers.host)) return 'Host 不是本机，已拒绝';
  if (!write) return null;
  const o = req.headers.origin;
  if (o) return originOk(o) ? null : `来源 ${String(o).slice(0, 80)} 不是本页面，已拒绝`;
  return tokenOk(req.headers['x-tmtn-token']) ? null : '缺少访问令牌（x-tmtn-token），已拒绝';
};
app.use((req, res, next) => {
  const e = guard(req, !['GET', 'HEAD', 'OPTIONS'].includes(req.method));
  if (e) { console.warn(`[security] ${req.method} ${req.path}：${e}`); return res.status(403).json({ error: e }); }
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" });   // 页面不许被别的网站嵌进 iframe（防点击劫持）
  next();
});
app.use(express.json());
// 强制登录：实盘模式下币安钱包未登录时，所有动用资金的接口一律拒绝（买卖、兑换、换回 BNB、领取、撤销授权、单币转出规则）
const AUTH_GATED = new Set(['/api/order', '/api/swap', '/api/quote-to-bnb', '/api/claim', '/api/approvals/revoke', '/api/token-rules']);
app.use((req, res, next) => {
  if (LIVE && req.method === 'POST' && AUTH_GATED.has(req.path) && !(req.path === '/api/order' && WALLET_PEERS.length) && trader.status?.auth?.state !== 'ok') return res.status(401).json({ error: '币安钱包未登录', auth: trader.status?.auth?.state });   // 多钱包时下单按钱包分别处理（未登录的跳过）
  next();
});
// 首页：把 app.js / style.css 的版本号换成文件修改时间（每次改动都是新地址，浏览器不会用旧缓存），首页本身不缓存
app.get(['/', '/index.html'], (req, res) => {
  try {
    const pub = path.join(__dirname, 'public'), v = (f) => Math.round(fs.statSync(path.join(pub, f)).mtimeMs);
    const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8').replace(/(app\.js|style\.css)\?v=[^"']*/g, (m, f) => `${f}?v=${v(f)}`);
    res.setHeader('Cache-Control', 'no-store'); res.type('html').send(html);
  } catch (e) { res.status(500).send(e.message); }
});
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));   // 每次都向服务器确认有没有更新（没变就 304），避免浏览器一直用旧的 app.js / style.css

const state = () => ({
  ...modeInfo(), block: market.block, bnbUsd: market.bnbUsd, net,
  wallets: trader.walletsView(), settings: trader.settings, gasPresets: GAS_PRESETS, config: agent.config, usage: agent.usageView(),
  tokens: market.list(), positions: trader.positionsView(), snipeCurve: SNIPE_FEE_CURVE, claimable: LIVE ? trader.claimable : [],
});

app.post('/api/claim', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '只有实盘模式能领取' }); res.json(await trader.claimOne(req.body.market, '手动领取')); });
app.post('/api/auth/login', async (req, res) => { try { res.json(LIVE ? loginView(await trader.startLogin()) : null); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/auth/login-cancel', (req, res) => { res.json(LIVE ? loginView(trader.cancelLogin()) : null); });
app.post('/api/auth/check', async (req, res) => res.json(LIVE ? await trader.checkAuth() : null));
setTimeout(() => { for (const o of [...trader.orders].reverse()) latency.record(o); }, 5000);   // 启动时把内存里已有订单补记一次（按 id/tx 去重）
app.get('/api/latency-stats', (req, res) => res.json(latency.stats(Math.max(0.01, Number(req.query.days) || 1))));
app.get('/api/state', (req, res) => res.json({ ...state(), holdings: holdView || holdSnap, orders: trader.orders.slice(0, 100), logs: agent.logs.slice(0, 150), records: agent.records, flow: market.named ? market.named(market.flow.slice(0, 80)) : market.flow.slice(0, 80) }));
// 持仓快照：后台每 5 秒算一次（下单 / 领取 / 转账结束后立刻再算），通过 WebSocket 推给页面、也放进 /api/state，
// 页面打开详情时直接用快照，不再每次现算（现算要读钱包历史和链上报价，慢）
let holdSnap = null, holdView = null, holdBusy = false, holdAgain = false;   // holdSnap：本钱包；holdView：多钱包时合并后的（给页面）
// ---------- 多钱包（同时下单）----------
// 每个钱包是一个独立的后端（各自的 baw 登录目录 BINANCE_BAW_DIR、数据目录 DATA_DIR、设置 / 授权 / 自动转出）。
// 主后端（钱包 1）在 WALLET_PEERS 里登记其他钱包的后端地址；页面上的一笔订单由主后端同时发给所有「参与下单」的钱包。
const peerFetch = async (peer, p, body, ms = 2500) => {
  const r = await fetch(peer.url.replace(/\/$/, '') + p, { method: body ? 'POST' : 'GET', headers: { 'x-tmtn-token': peer.token || API_TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(ms) });   // 其他钱包后端要用同一个 TMTN_API_TOKEN（或在 WALLET_PEERS 里写 token）
  const j = await r.json().catch(() => null); if (!r.ok) throw Object.assign(new Error(j?.error || `HTTP ${r.status}`), { status: r.status }); return j;
};
// 其他钱包的 baw 用自己的登录目录 + 自己的设备标识（BINANCE_INSTANCE_ID），避免和钱包 1 的登录互相影响
const signinCmd = (dir, inst) => (dir ? `BINANCE_BAW_DIR=${dir}${inst ? ` BINANCE_INSTANCE_ID=${inst}` : ''} baw auth signin` : 'baw auth signin');
// 给页面 / 主后端看的登录进度（不含 qrCodeId 等内部字段）
const loginView = (l) => (l ? { id: l.id, state: l.state, urlForWeb: l.urlForWeb, pairingCode: l.pairingCode, expireAt: l.expireAt, message: l.message, address: l.address || null } : null);
const selfInfo = () => ({ slot: WALLET_SLOT, expect: process.env.WALLET_ADDRESS || null, login: loginView(trader.status?.login), authMessage: trader.status?.auth?.message || '', label: WALLET_LABEL, agentId: trader.status?.auth?.agentId || null, address: trader.wallets?.[0]?.address || null, bnb: trader.wallets?.[0]?.bnb ?? null, auth: trader.status?.auth?.state || 'checking', bawDir: BAW_DIR || null, signin: signinCmd(BAW_DIR, process.env.BINANCE_INSTANCE_ID) });
const walletOn = (slot) => { const v = (trader.settings?.walletOn || {})[slot]; return v === undefined ? slot === WALLET_SLOT : v !== false; };   // 其他钱包默认不参与，要在钱包菜单里打开
async function walletsView() {
  const out = [{ ...selfInfo(), self: true, reachable: true, on: walletOn(WALLET_SLOT) }];
  for (const p of WALLET_PEERS) {
    let info = null, err = null; try { info = await peerFetch(p, '/api/wallet-info'); } catch (e) { err = e.message; }
    out.push({ slot: p.slot, expect: info?.expect || p.address || null, login: info?.login || null, authMessage: info?.authMessage || '', label: p.label || info?.label || `钱包 ${p.slot}`, agentId: info?.agentId || null, address: info?.address || null, bnb: info?.bnb ?? null, auth: info ? info.auth : 'offline', bawDir: p.bawDir || info?.bawDir || null, signin: p.signin || signinCmd(p.bawDir || info?.bawDir, p.instanceId),   /* WALLET_PEERS 里可以直接写登录命令（比如钱包 2 跑在 Docker 里） */ reachable: !!info, error: err, on: walletOn(p.slot) });
  }
  return out;
}
// 持仓合并：同一个币各钱包的数量 / 市值 / 成本 / 已卖出 / 盈亏相加，byWallet 里留每个钱包自己的；wallets 里留每个钱包完整的持仓（页面可按钱包筛选）
async function mergeHoldings(own) {
  if (!WALLET_PEERS.length || !own) return own;
  const parts = [{ slot: WALLET_SLOT, label: WALLET_LABEL, snap: own }];
  for (const p of WALLET_PEERS) { try { const s = await peerFetch(p, '/api/holdings?own=1'); if (s?.rows) parts.push({ slot: p.slot, label: p.label || `钱包 ${p.slot}`, snap: s }); } catch { /* 这个钱包暂时连不上就先不算 */ } }
  const by = new Map(), sumK = ['amount', 'supplyPct', 'valueBnb', 'valueUsd', 'costBnb', 'soldBnb', 'costUsd', 'soldUsd', 'pnlBnb', 'pnlUsd'];
  for (const part of parts) for (const r of part.snap.rows || []) {
    const k = String(r.token).toLowerCase(), cur = by.get(k);
    const mine = { slot: part.slot, label: part.label, amount: r.amount, valueUsd: r.valueUsd, costUsd: r.costUsd, soldUsd: r.soldUsd, pnlUsd: r.pnlUsd };
    if (!cur) { by.set(k, { ...r, byWallet: [mine] }); continue; }
    for (const f of sumK) if (r[f] != null) cur[f] = (cur[f] || 0) + r[f];
    cur.byWallet.push(mine); cur.firstAt = Math.min(cur.firstAt || Infinity, r.firstAt || Infinity);
    cur.trades = [...(cur.trades || []), ...(r.trades || [])].sort((a, b) => b.ts - a.ts);
  }
  const rows = [...by.values()].map((r) => ({ ...r, pnlPct: r.costUsd > 0 && r.pnlUsd != null ? (r.pnlUsd / r.costUsd) * 100 : r.pnlPct }));
  const totals = {}; for (const part of parts) for (const [k, v] of Object.entries(part.snap.totals || {})) if (typeof v === 'number') totals[k] = (totals[k] || 0) + v;
  return { ...own, rows, totals, bnb: parts.reduce((a, x) => a + (x.snap.bnb || 0), 0), wallets: parts.map((x) => ({ slot: x.slot, label: x.label, rows: x.snap.rows, totals: x.snap.totals, bnb: x.snap.bnb })) };
}
async function refreshHoldSnap() {
  if (!holdings) return; if (holdBusy) { holdAgain = true; return; } holdBusy = true;
  try { holdSnap = await holdings.view(); holdView = await mergeHoldings(holdSnap); broadcast({ type: 'holdings', data: holdView }); } catch { /* 下次再算 */ }
  holdBusy = false; if (holdAgain) { holdAgain = false; setTimeout(refreshHoldSnap, 200); }
}
if (holdings) { setTimeout(refreshHoldSnap, 3000); setInterval(refreshHoldSnap, 5000); }
app.get('/api/holdings', async (req, res) => {
  if (!holdings) return res.json({ rows: [], totals: {}, bnb: 0 });
  if (req.query.refresh) { trader.syncAt = 0; await trader.refreshBalance?.().catch(() => {}); await trader.syncHoldings?.().catch(() => {}); await holdings.loadHistory(true).catch(() => {}); holdSnap = await holdings.view(); holdView = await mergeHoldings(holdSnap); broadcast({ type: 'holdings', data: holdView }); return res.json(req.query.own ? holdSnap : holdView); }
  res.json(req.query.own ? holdSnap || await holdings.view() : holdView || holdSnap || await holdings.view());   // own=1：只要本钱包的（其他后端合并时用）
});
// 计价币余额与一键换回 BNB（只在点击后执行；先 preview 给确认框看报价）
app.get('/api/quote-balances', async (req, res) => { if (!LIVE) return res.json([]); try { res.json(await trader.quoteBalances()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/quote-to-bnb/preview', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '只有实盘模式可用' }); try { res.json(await trader.quoteToBnbPreview(String(req.body.token || ''), Number(req.body.slippage) || 1)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/quote-to-bnb', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '只有实盘模式可用' }); res.json(await trader.quoteToBnb({ token: String(req.body.token || ''), slippage: Number(req.body.slippage) || 1 })); });
app.get('/api/trades/:token', async (req, res) => { try { const v = LIVE ? await market.tradesPage(req.params.token, Number(req.query.before) || 0, Math.min(500, Number(req.query.limit) || 100)) : null; v ? res.json(v) : res.status(404).json({ error: '没有数据' }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/trader/:token/:addr', async (req, res) => { try { const v = LIVE ? await market.traderStats(req.params.token, req.params.addr) : null; v ? res.json(v) : res.status(404).json({ error: '没有数据' }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/rpc-usage', (req, res) => res.json(rpcUsageLog));
// 页面布局偏好（左侧钱包追踪栏开 / 关、宽度）：服务器也存一份，浏览器数据丢了或换了地址也能恢复
const UI_PREFS = path.join(DATA_DIR_UI, 'ui-prefs.json');
app.get('/api/ui-prefs', (req, res) => { try { res.json(JSON.parse(fs.readFileSync(UI_PREFS, 'utf8'))); } catch { res.json({}); } });
app.post('/api/ui-prefs', (req, res) => {
  const b = req.body || {}, cur = (() => { try { return JSON.parse(fs.readFileSync(UI_PREFS, 'utf8')); } catch { return {}; } })();
  if (typeof b.trkPanel === 'boolean') cur.trkPanel = b.trkPanel; if (Number(b.trkPanelW) > 0) cur.trkPanelW = Math.min(640, Math.max(260, Number(b.trkPanelW)));
  try { fs.mkdirSync(path.dirname(UI_PREFS), { recursive: true }); fs.writeFileSync(UI_PREFS, JSON.stringify(cur)); } catch { /* ignore */ }
  res.json(cur);
});
// ---------- 追踪 + 跟单（只在实盘、只在主后端）----------
let tracker = null;
if (LIVE && WALLET_SLOT === 1) {
  const { Tracker } = await import('./engine/live/tracker.js');
  tracker = new Tracker({ market, provider: market.provider, placeOrder, log: (m) => console.log(m) });
  market.on('trade', (t) => tracker.onTrade(t).catch(() => {}));
  tracker.on('event', (e) => broadcast({ type: 'track', data: e }));
  tracker.on('targets', (v) => broadcast({ type: 'trackTargets', data: v }));
  tracker.on('tasks', (v) => broadcast({ type: 'copyTasks', data: v }));
  tracker.on('log', (r) => broadcast({ type: 'copyLog', data: r }));
  tracker.on('reload', () => broadcast({ type: 'trackReload' }));   // 历史回补完成：页面重新拉追踪数据
  setTimeout(() => tracker.backfillPending(), 20_000);   // 启动后补一次还没回补过的追踪地址（最近 24 小时，只写历史，不跟单）
}
// ---------- Gang 新盘狙击（只在实盘主后端；默认关闭 + 模拟，本人在顶栏「狙击」模块里打开）----------
let sniper = null;
if (LIVE && WALLET_SLOT === 1) {
  const { Sniper } = await import('./engine/live/sniper.js');
  const { wbnbTopUp } = await import('./engine/live/sniper.js');
  // 预备 WBNB：本钱包直接做，其他钱包发给它们自己的后端（/api/snipe/float）
  const floatFn = (target, slots) => Promise.all(slots.map((slot) => slot === WALLET_SLOT ? wbnbTopUp(trader, target, LIVE_TRADE)
    : (() => { const p = WALLET_PEERS.find((x) => x.slot === slot); return p ? peerFetch(p, '/api/snipe/float', { target }, 60_000).catch((e) => ({ wallet: p.label || `钱包 ${slot}`, error: e.message })) : { wallet: `钱包 ${slot}`, skip: '没有这个钱包' }; })()));
  sniper = new Sniper({ market, trader, placeOrder, floatFn, isBlocked: (t) => blocklist.has(t), log: (m) => console.log(m) });
  sniper.on('state', (v) => broadcast({ type: 'snipeState', data: v }));
  sniper.on('log', (r) => { broadcast({ type: 'snipeLog', data: r }); if (r.kind !== 'skip') console.log(`[狙击] ${r.symbol} ${r.kind}：${r.reason}`); });
}
// 交易节点保持热连接（每个钱包后端都做）：冷连接第一次读链要 0.7～1.8 秒，狙击时钱包 2 的后端也要马上能读曲线、模拟
if (LIVE) setInterval(() => trader.gangV2?.provider?.getBlockNumber?.().catch(() => {}), 10_000);
// 每个钱包后端都有：把自己钱包的 WBNB 补到 target（主后端的狙击调用；只在 LIVE_TRADE=1 时真的包装）
app.post('/api/snipe/float', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '只有实盘可用' }); try { const { wbnbTopUp } = await import('./engine/live/sniper.js'); res.json(await wbnbTopUp(trader, Math.min(2, Math.max(0, Number(req.body?.target) || 0)), LIVE_TRADE)); } catch (e) { res.status(400).json({ error: e.message }); } });
const needSniper = (res) => { if (!sniper) { res.status(400).json({ error: '只有实盘主后端支持狙击' }); return false; } return true; };
app.get('/api/snipe', (req, res) => { if (!needSniper(res)) return; res.json({ ...sniper.view(), log: sniper.log.slice(0, 300) }); });
app.post('/api/snipe', (req, res) => {   // { params } 改参数；{ enabled: true/false } 开 / 关（急停 = enabled:false）
  if (!needSniper(res)) return; const b = req.body || {};
  try { if (b.params) sniper.update(b.params); if (b.forget) sniper.forget(b.forget); if (b.enabled !== undefined) sniper.setEnabled(b.enabled === true); res.json(sniper.view()); } catch (e) { res.status(400).json({ error: e.message }); }
});
const needTracker = (res) => { if (!tracker) { res.status(400).json({ error: '只有实盘主后端支持追踪 / 跟单' }); return false; } return true; };
app.get('/api/track', (req, res) => { if (!needTracker(res)) return; res.json({ ...tracker.targetsView(), feed: tracker.feed.slice(0, 300) }); });
app.get('/api/track/resolve', async (req, res) => {   // .ai / .bnb 域名 → 地址
  if (!LIVE) return res.status(400).json({ error: '只有实盘可用' });
  const name = String(req.query.name || '').trim().toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(name)) return res.json({ address: name, name: market.names?.peek?.(name) || null });
  if (!/^[a-z0-9-_.]+\.[a-z]+$/.test(name)) return res.status(400).json({ error: '请填 .ai / .bnb 域名或 0x 地址' });
  try { const { resolveDomain } = await import('./engine/live/baw.js'); const d = await resolveDomain(name); if (!d?.address) throw new Error('没有解析到地址'); res.json({ address: String(d.address).toLowerCase(), name }); }
  catch (e) { res.status(400).json({ error: `解析失败：${e.message}` }); }
});
app.get('/api/track/feed', (req, res) => { if (!needTracker(res)) return; res.json(tracker.feedPage({ before: Number(req.query.before) || undefined, limit: Math.min(300, Number(req.query.limit) || 100) })); });   // 追踪历史往回翻
app.post('/api/track/targets', (req, res) => {
  if (!needTracker(res)) return; const b = req.body || {};
  try { if (b.remove) tracker.removeTarget(b.address); else tracker.addTarget(b); res.json(tracker.targetsView()); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/copy', (req, res) => { if (!needTracker(res)) return; res.json({ ...tracker.tasksView(), log: tracker.log.slice(0, 300) }); });
app.post('/api/copy/tasks', (req, res) => {   // 新建：一律暂停 + 模拟；改参数 / 启动 / 暂停 / 关闭
  if (!needTracker(res)) return; const b = req.body || {};
  try { res.json(b.id && b.delete ? tracker.deleteTask(b.id) : b.id ? tracker.updateTask(b.id, b) : tracker.createTask(b)); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/copy/pause-all', (req, res) => { if (!needTracker(res)) return; tracker.setAllPaused(req.body?.paused !== false); res.json(tracker.tasksView()); });
app.get('/api/wallet-info', (req, res) => res.json(LIVE ? selfInfo() : null));
// 页面上按钱包点「登录」/「取消」：本钱包由自己的 baw 登录；其他钱包把请求转给它自己的后端（钱包 2 在 Docker 容器里用容器里的 baw 登录，绝不在本机为它发起）
app.post('/api/wallets/login', async (req, res) => {
  if (!LIVE) return res.status(400).json({ error: '只有实盘支持' });
  const slot = Number(req.body?.slot), cancel = !!req.body?.cancel;
  try {
    if (slot === WALLET_SLOT) return res.json(loginView(cancel ? trader.cancelLogin() : await trader.startLogin()));
    const p = WALLET_PEERS.find((x) => x.slot === slot); if (!p) return res.status(400).json({ error: '没有这个钱包' });
    res.json(await peerFetch(p, cancel ? '/api/auth/login-cancel' : '/api/auth/login', {}, 40_000));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/wallets', async (req, res) => res.json(LIVE ? await walletsView() : []));
app.post('/api/wallets', (req, res) => {   // 某个钱包是否「参与下单」（存在主后端的设置里）
  if (!LIVE) return res.status(400).json({ error: '只有实盘可用' });
  const slot = Number(req.body?.slot); if (!slot) return res.status(400).json({ error: '缺少 slot' });
  trader.settings.walletOn = { ...(trader.settings.walletOn || {}), [slot]: req.body.on !== false }; trader.saveSetting('walletOn', trader.settings.walletOn);
  walletsView().then((v) => { broadcast({ type: 'wallets', data: v }); res.json(v); });
});
if (LIVE && WALLET_PEERS.length) setInterval(() => walletsView().then((v) => broadcast({ type: 'wallets', data: v })).catch(() => {}), 10_000);
app.get('/api/lookup/:a', async (req, res) => {
  // 搜索：最多等 1.5 秒（链上查 Four 盘）；查不到 = 不是本终端跟踪的内盘（外盘 / 已毕业 / 其他平台），页面改为打开 GMGN
  const t = LIVE ? await Promise.race([market.lookup(req.params.a).catch(() => null), new Promise((r) => setTimeout(() => r(null), 1500))]) : (market.get(req.params.a) ? market.summary(market.get(req.params.a)) : null);
  t ? res.json(t) : res.status(404).json({ error: '未找到该代币', external: true });
});
app.get('/api/token/:a', async (req, res) => {
  if (LIVE) await market.refresh(req.params.a);
  const d = market.detail(req.params.a); d ? res.json(d) : res.status(404).json({ error: '代币不存在' });
});
// 地址 → 域名本地映射（前端定时拉取，ver 不变就返回空）
// 代币头像代理缓存：/api/img?u=<url> → data/img/<sha1>.<ext>，命中直接读盘，浏览器端 immutable 长缓存
const IMG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'img');
fs.mkdirSync(IMG_DIR, { recursive: true });
const imgInflight = new Map(), imgFail = new Map();
const IPFS_GW = ['https://flap.mypinata.cloud/ipfs/', 'https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/', 'https://cloudflare-ipfs.com/ipfs/'];
// 只代理这些图床（含子域名），只走 https；别的地址一律拒绝（防止被当成访问内网 / 任意网站的跳板）。IMG_HOSTS 可追加（逗号分隔）
const IMG_HOSTS = ['four.meme', 'mypinata.cloud', 'gang.fun', 'gangfun-ipfs.tos-ap-southeast-1.bytepluses.com', 'shrine.trade', 'ipfs.io', 'dweb.link', 'cloudflare-ipfs.com', ...String(process.env.IMG_HOSTS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)];
const imgHostOk = (u) => { try { const x = new URL(u); return x.protocol === 'https:' && !x.username && !x.password && (!x.port || x.port === '443') && IMG_HOSTS.some((h) => x.hostname === h || x.hostname.endsWith('.' + h)); } catch { return false; } };
// 只收位图：按文件头判断真实格式（不信对方的 Content-Type），SVG（可以带脚本）一律不收
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif' };
const sniffImg = (b) => {
  const s = (i, j) => b.subarray(i, j).toString('latin1');
  if (b[0] === 0x89 && s(1, 4) === 'PNG') return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (s(0, 4) === 'GIF8') return 'image/gif';
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WEBP') return 'image/webp';
  if (s(4, 8) === 'ftyp' && /^avi[fs]$/.test(s(8, 12))) return 'image/avif';
  return null;
};
async function imgFetchOne(u) {
  const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 8000);
  try {
    let r;
    for (let hop = 0; ; hop++) {   // 跳转自己跟，每一跳都要在白名单里
      if (!imgHostOk(u)) throw new Error('host not allowed');
      r = await fetch(u, { signal: ac.signal, redirect: 'manual', headers: { accept: 'image/*' } });
      if (r.status < 300 || r.status >= 400) break;
      if (hop >= 3 || !r.headers.get('location')) throw new Error('redirect');
      u = new URL(r.headers.get('location'), u).href;
    }
    if (!r.ok) throw new Error('http ' + r.status);
    if (Number(r.headers.get('content-length') || 0) > 2e6) throw new Error('too big');
    const buf = Buffer.from(await r.arrayBuffer()); if (buf.length > 2e6 || !buf.length) throw new Error('size');
    const ct = sniffImg(buf); if (!ct) throw new Error('not raster image');
    return { ct, buf };
  } finally { clearTimeout(tm); }
}
async function imgFetch(u) {
  const m = u.match(/\/ipfs\/(.+)$/); const urls = [u, ...(m ? IPFS_GW.map((g) => g + m[1]).filter((x) => x !== u) : [])];
  let err; for (const x of urls) { try { return await imgFetchOne(x); } catch (e) { err = e; } } throw err;
}
app.get('/api/img', async (req, res) => {
  const u = String(req.query.u || '');
  if (u.length > 2000 || !imgHostOk(u)) return res.status(403).set('Cache-Control', 'public, max-age=600').end();
  const key = crypto.createHash('sha1').update(u).digest('hex'); const meta = path.join(IMG_DIR, key + '.json');
  // nosniff + 沙箱 CSP：就算文件内容有问题，浏览器也不会把它当网页 / 脚本执行
  const send = (m) => { res.set({ 'Content-Type': m.ct, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Img-Cache': m.hit ? 'HIT' : 'MISS', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': `inline; filename="${m.file}"` }); res.sendFile(path.join(IMG_DIR, m.file)); };
  try { const m = JSON.parse(fs.readFileSync(meta, 'utf8')); if (EXT[m.ct] && /^[0-9a-f]{40}\.[a-z]+$/.test(m.file) && fs.existsSync(path.join(IMG_DIR, m.file))) return send({ ...m, hit: true }); } catch { /* 未缓存 */ }   // 旧缓存里的 SVG 等非位图不再返回
  if ((imgFail.get(key) || 0) > Date.now()) return res.status(404).set('Cache-Control', 'public, max-age=600').end();
  try {
    let p = imgInflight.get(key);
    if (!p) { p = imgFetch(u).then(({ ct, buf }) => { const file = key + '.' + (EXT[ct] || 'img'); fs.writeFileSync(path.join(IMG_DIR, file), buf); const m = { ct, file, url: u }; fs.writeFileSync(meta, JSON.stringify(m)); return m; }).finally(() => imgInflight.delete(key)); imgInflight.set(key, p); }
    send(await p);
  } catch { imgFail.set(key, Date.now() + 600_000); res.status(404).set('Cache-Control', 'public, max-age=600').end(); }
});
app.get('/api/names', (req, res) => {
  const n = market.names; if (!n) return res.json({ ver: 0, names: {} });
  if (Number(req.query.ver) === n.ver) return res.json({ ver: n.ver });
  res.json({ ver: n.ver, names: n.all() });
});

app.get('/api/preview', async (req, res) => {
  const q = req.query;
  res.json(await trader.preview({ walletId: q.wallet, token: q.token, side: q.side, amount: Number(q.amount), slippage: Number(q.slippage || 35) }));
});

// 按代币总量百分比买入：反推需要多少 BNB（多轮报价逼近）
// 买「总量的 X%」需要多少 BNB（按这个钱包自己的持仓上限 / 余额 / 单笔上限压好）。多钱包时每个钱包各自算
async function costForPct(q) {
  q = q || {}; let pct = Math.min(100, Number(q.pct) || 0);
  if (!(pct > 0)) return ({ bnb: 0 });
  // Four Agent 专属币每个钱包最多持有总量 1%，超过的部分买不到，按 1% 算，避免反推出离谱的 BNB
  const tk = market.get?.(q.token); let capped = false; const asked = pct; const notes = [];
  // Four / Gang 都是单钱包最多持有总量 1%
  if ((tk?.platform === 'four' || tk?.platform === 'gang') && pct > 1) { pct = 1; capped = true; }
  let target = 1_000_000_000 * pct / 100;
  // Four 单钱包最多 1%：扣掉当前持仓，只买剩下的部分
  if (tk?.platform === 'four') {
    try {
      const w = trader.wallet?.(q.wallet); const mine = w ? await trader.tokenBal(w, tk.address) : 0;
      const room = (1e7 - (mine || 0)) * 0.99;
      if (room <= 1e7 * 0.001) return ({ bnb: 0, capReached: true, error: '已达单钱包上限 1%' });
      if (target > room) { target = room; capped = true; pct = +(room / 1e7).toFixed(3); }
    } catch { /* 读不到持仓就按 1% */ }
  }
  // Gang 老盘：合约 walletRoom 直接给出这个钱包还能买多少
  if (tk?.source === 'gang' && (trader.useGang?.(tk) || trader.useGangV2?.(tk))) {
    try {
      const w = trader.wallet?.(q.wallet);
      const room = !w ? 1e7 : (trader.useGangV2(tk) ? Number(await trader.gangV2.room(tk.address, w.address)) / 1e18 : await trader.gangTrade.walletRoom(tk.address, w.address)) * 0.99;
      if (room <= 1e7 * 0.001) return ({ bnb: 0, capReached: true, error: '已达单钱包上限 1%' });
      if (target > room) { target = room; capped = true; pct = +(room / 1e7).toFixed(3); }
    } catch { /* 读不到额度就按 1% */ }
  }
  // Flap Agent 曲线有单钱包持仓上限 maxSharesPerWallet：目标不超过「上限 - 已持有」再留 1% 余量
  if (tk?.market && tk.source === 'agent-curve' && trader.portal?.provider) {
    try {
      const { ethers } = await import('ethers');
      const w = trader.wallet?.(q.wallet);
      const c = new ethers.Contract(tk.market, ['function maxSharesPerWallet() view returns (uint256)', 'function sharesOf(address) view returns (uint256)'], trader.portal.provider);
      const [cap, mine] = await Promise.all([c.maxSharesPerWallet().catch(() => 0n), w ? c.sharesOf(w.address).catch(() => 0n) : 0n]);
      if (cap > 0n) {
        const room = Number(ethers.formatEther(cap - (mine > cap ? cap : mine))) * 0.99;
        if (room <= 0) return ({ bnb: 0, capReached: true, error: '已达单钱包持仓上限' });
        if (target > room) { target = room; capped = true; pct = +(room / 1e7).toFixed(3); }
      }
    } catch { /* 读不到上限就按原目标 */ }
  }
  try {
    let a = 0.01, ok = false, lastErr = null;
    for (let i = 0; i < 6; i++) {
      const p = await trader.preview({ walletId: q.wallet, token: q.token, side: 'buy', amount: a, slippage: Number(q.slippage || 35) });
      if (!(p?.out > 0)) { lastErr = p?.error || null; break; }
      ok = true;
      const next = a * target / p.out;
      if (Math.abs(next - a) / a < 0.002) { a = next; break; }
      a = next;
    }
    if (!ok) return ({ bnb: 0, error: `拿不到报价${lastErr ? '：' + lastErr : ''}` });
    // 下单前一次性把金额压到能成交的范围：持仓上限 → 单笔上限 → 余额（留 0.002 BNB 付 gas），不让后端先失败再重试
    if (capped) notes.push(asked > 1 && pct >= 0.98 ? `${asked}% 超过单钱包上限 1%，已按 1% 买入` : `${asked}% 超过单钱包剩余额度，已按剩余额度（约 ${pct}%）买入`);
    const maxTrade = LIVE ? Number(trader.status?.maxTradeBnb) || 0 : 0;
    if (maxTrade > 0 && a > maxTrade) { a = maxTrade; notes.push(`超过单笔上限 ${maxTrade} BNB，已按 ${maxTrade} BNB 买入`); }
    const w = trader.wallet?.(q.wallet); const bal = Number(w?.bnb) || 0;
    if (LIVE && bal > 0 && a > bal - 0.002) { a = Math.max(0, bal - 0.002); notes.push(`BNB 余额不足，已按余额 ${a.toFixed(4)} BNB 买入`); }
    if (!(a > 0)) return ({ bnb: 0, error: 'BNB 余额不足' });
    return ({ bnb: +a.toFixed(6), tokens: target, pct, capped, note: notes.join('；') || null });
  } catch (e) { return { bnb: 0, error: e.message }; }
}
app.get('/api/cost-for-pct', async (req, res) => res.json(await costForPct(req.query)));

// 下单（页面、跟单都走这里）。slots：指定哪几个钱包下单（跟单任务用）；不填 = 所有开了「参与下单」的钱包
async function placeOrder({ wallets = ['baw'], token, side, amount, slippage, via, clientTs, pctSupply, slots = null, source = '手动' }) {
  {
    if (LIVE && token && !market.get(token)) await market.lookup(token).catch(() => null);   // 本后端还没收录这个币（多钱包时第二个后端可能会这样）
    const local = () => Promise.all(wallets.map(async (w) => {
      let amt = amount;
      if (side === 'buy' && Number(pctSupply) > 0) {   // 每个钱包自己报价：买到总量的 X% 要多少 BNB
        const c = await costForPct({ wallet: w, token, pct: Number(pctSupply), slippage });
        if (!(c.bnb > 0)) { const o = { id: `pct-${Date.now()}`, ts: Date.now(), wallet: WALLET_LABEL, token, symbol: market.get(token)?.symbol || '', side, amount: 0, status: 'failed', reason: c.capReached ? c.error : `买 ${pctSupply}% 报价失败：${c.error || '拿不到报价'}` }; broadcast({ type: 'order', data: o }); return o; }
        amt = c.bnb;
      }
      return trader.execute({ walletId: w, token, side, amount: amt, slippage, source: String(source || '手动').slice(0, 40), via: via === 'quick' ? 'quick' : null, clientTs: Number(clientTs) || null });
    }));
    if (!LIVE || !WALLET_PEERS.length) { if (slots && !slots.includes(WALLET_SLOT)) return []; return await local(); }
    // 多钱包：所有「参与下单」的钱包同时执行（买入 = 每个钱包各买 amount BNB；卖出 = 每个钱包卖自己持仓的 amount%）。未登录 / 连不上的跳过，其他照常
    const t = market.get(token), sym = t?.symbol || '';
    const skip = (slot, label, reason) => { const o = { id: `w${slot}-skip-${Date.now()}`, ts: Date.now(), wallet: label, walletSlot: slot, token, symbol: sym, side, amount, status: 'failed', reason: `${label}：${reason}，已跳过` }; broadcast({ type: 'order', data: o }); return [o]; };
    const jobs = [];
    const want = (slot) => (slots ? slots.includes(slot) : walletOn(slot));
    if (want(WALLET_SLOT)) jobs.push(trader.status?.auth?.state === 'ok' ? local().then((r) => r.map((o) => ({ ...o, walletSlot: WALLET_SLOT }))) : Promise.resolve(skip(WALLET_SLOT, WALLET_LABEL, '币安钱包未登录')));
    for (const p of WALLET_PEERS) {
      if (!want(p.slot)) continue; const label = p.label || `钱包 ${p.slot}`;
      jobs.push(peerFetch(p, '/api/order', { wallets: ['baw'], token, side, amount, slippage, via, clientTs, pctSupply, source }, 200_000)
        .then((r) => (r || []).map((o) => { const x = { ...o, id: `w${p.slot}-${o.id}`, wallet: label, walletSlot: p.slot }; broadcast({ type: 'order', data: x }); return x; }))
        .catch((e) => skip(p.slot, label, e.status === 401 ? '币安钱包未登录' : `后端连不上（${e.message}）`)));
    }
    if (!jobs.length) throw new Error(slots ? '跟单任务选的钱包都不可用' : '没有开启「参与下单」的钱包');
    return (await Promise.all(jobs)).flat();
  }
}
app.post('/api/order', async (req, res) => {
  const b = req.body || {};
  try { res.json(await placeOrder({ wallets: b.wallets?.length ? b.wallets : ['big'], token: b.token, side: b.side, amount: b.amount, slippage: b.slippage, via: b.via, clientTs: b.clientTs, pctSupply: b.pctSupply, source: b.source || '手动' })); }
  catch (e) { console.error('[order] 下单异常:', e && e.stack || e); res.status(400).json({ error: e.message }); }
});

// 单币规则（发射后领取 / 转出）。转账要本人在页面上点「确认」才会变成 armed
app.get('/api/token-rules', (req, res) => res.json(LIVE ? trader.rulesView() : {}));
// 页面只能改「是否领取」和「转出确认状态」；转出地址、自动标记、执行状态都只由服务器写（地址固定为 AUTO_TRANSFER_TO）
app.post('/api/token-rules', (req, res) => {
  if (!LIVE) return res.status(400).json({ error: '只有实盘可用' });
  try {
    if (req.body.remove) return res.json(trader.setRule(req.body.token, null));
    const p = req.body.patch || {}, patch = {};
    if (p.transfer !== undefined) { if (!['armed', 'confirm', 'off'].includes(p.transfer)) throw new Error('transfer 只能是 armed / confirm / off'); patch.transfer = p.transfer; }
    if (p.claim !== undefined) patch.claim = p.claim === true;
    if (patch.transfer === 'armed') { const r = trader.rules()[String(req.body.token || '').toLowerCase()]; if (!r?.to) throw new Error('这个币没有服务器生成的转出规则，不能确认转出'); console.log(`[tokenRule] 页面确认转出 ${r.symbol} → ${r.to}`); }
    res.json(trader.setRule(req.body.token, patch));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/favorites', (req, res) => res.json(favorites.view()));
app.post('/api/favorites', (req, res) => { try { const v = favorites.op(req.body || {}); broadcast({ type: 'favorites', data: v }); res.json(v); } catch (e) { res.status(400).json({ error: e.message }); } });
app.get('/api/approvals', async (req, res) => { if (!LIVE) return res.json([]); try { res.json(await trader.allowancesView()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/approvals/revoke', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '只有实盘可用' }); try { res.json(await trader.revokeApproval(String(req.body.token || ''), String(req.body.spender || ''))); } catch (e) { res.status(400).json({ error: e.message }); } });
app.get('/api/token-info/:a', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '只有实盘可用' }); try { res.json(await trader.tokenInfo(req.params.a)); } catch (e) { res.status(400).json({ error: e.shortMessage || e.message }); } });
app.post('/api/swap/quote', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '只有实盘可用' }); try { const { from, to, amount, slippage } = req.body; res.json(await trader.swapQuote({ from, to, amount, slippage: Number(slippage) || 1 })); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/swap', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '只有实盘可用' }); const { from, to, amount, pct, slippage, clientTs } = req.body; res.json(await trader.swapManual({ from, to, amount, pct: pct != null ? Number(pct) : null, slippage: Number(slippage) || 1, clientTs: Number(clientTs) || null })); });
app.get('/api/blocklist', (req, res) => res.json(blocklist.view()));
app.post('/api/blocklist', (req, res) => { try { const v = blocklist.set(req.body.kind, req.body.address, !!req.body.on, req.body.label); broadcast({ type: 'blocklist', data: v }); res.json(v); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/config', (req, res) => { agent.setConfig(req.body); if (LIVE && Number(req.body?.quickBuy) > 0) trader.saveSetting('quickBuy', Number(req.body.quickBuy)); res.json(agent.config); });
app.post('/api/settings', (req, res) => {
  const { maxTradeBnb, sendTo, ...rest } = req.body;   // 转出地址只能在服务器配置里改，页面不能改
  if (maxTradeBnb !== undefined) { if (!LIVE) return res.status(400).json({ error: '只有实盘模式有单笔上限' }); try { trader.setMaxTrade(maxTradeBnb); } catch (e) { return res.status(400).json({ error: e.message }); } }
  if (LIVE && !trader.settings.sendTo && [rest.autoSendAfterClaim, rest.autoSendFourMigrated, rest.autoSendGangMigrated].includes(true)) return res.status(400).json({ error: '没有设置 AUTO_TRANSFER_TO（.env），不能打开自动转出' });
  // 只接受已知的设置项，并且先校验再写入（以前先 Object.assign 再校验：格式错的预设会留在内存里直到重启，任意键也能写进 settings）
  if (rest.qbPresets !== undefined) { const q = rest.qbPresets; const ok = q && ['buy', 'sell'].every((k) => Array.isArray(q[k]) && q[k].length === 3 && q[k].every((a) => Array.isArray(a) && a.length === 8 && a.every((v) => Number(v) > 0 && Number(v) <= (k === 'sell' ? 100 : 1000))));
    if (!ok) return res.status(400).json({ error: '预设格式不对' }); }
  if (rest.gas !== undefined) { if (!GAS_PRESETS[rest.gas]) return res.status(400).json({ error: 'gas 档位不对' }); trader.settings.gas = rest.gas; }
  if (rest.execPath !== undefined) trader.settings.execPath = rest.execPath === 'ai' ? 'ai' : 'direct';
  if (rest.multiRpc !== undefined) trader.settings.multiRpc = rest.multiRpc === true;
  if (rest.autoClaim !== undefined) trader.settings.autoClaim = !!rest.autoClaim;
  if (LIVE && rest.autoSendAfterClaim !== undefined) { trader.settings.autoSendAfterClaim = rest.autoSendAfterClaim === true; trader.saveSetting('autoSendAfterClaim', trader.settings.autoSendAfterClaim); console.log(`[settings] 领取后自动转出 ${trader.settings.autoSendAfterClaim ? '打开' : '关闭'} → ${trader.settings.sendTo}`); }
  if (LIVE && rest.autoSendFourMigrated !== undefined) { trader.settings.autoSendFourMigrated = rest.autoSendFourMigrated === true; trader.saveSetting('autoSendFourMigrated', trader.settings.autoSendFourMigrated); console.log(`[settings] Four 发射后自动转出 ${trader.settings.autoSendFourMigrated ? '打开' : '关闭'} → ${trader.settings.sendTo}`); }
  if (LIVE && rest.autoSendGangMigrated !== undefined) { trader.settings.autoSendGangMigrated = rest.autoSendGangMigrated === true; trader.saveSetting('autoSendGangMigrated', trader.settings.autoSendGangMigrated); console.log(`[settings] Gang 发射后自动转出 ${trader.settings.autoSendGangMigrated ? '打开' : '关闭'} → ${trader.settings.sendTo}`); }
  if (rest.qbPresets !== undefined) { trader.settings.qbPresets = rest.qbPresets; if (LIVE) trader.saveSetting('qbPresets', rest.qbPresets); }
  if (rest.sellToBnb !== undefined) { trader.settings.sellToBnb = rest.sellToBnb !== false; if (LIVE) trader.saveSetting('sellToBnb', trader.settings.sellToBnb); }
  if (rest.preApproveCap !== undefined) { trader.settings.preApproveCap = rest.preApproveCap !== false; if (LIVE) trader.saveSetting('preApproveCap', trader.settings.preApproveCap); }
  if (LIVE && rest.autoClaim !== undefined) { trader.saveSetting('autoClaim', !!rest.autoClaim); if (rest.autoClaim) trader.scanClaims(); } broadcast({ type: 'settings', data: trader.settings }); res.json(trader.settings); });
app.post('/api/wallet/:id', (req, res) => {
  if (LIVE) return res.status(400).json({ error: '实盘行情模式不能修改钱包' });
  const w = trader.wallet(req.params.id);
  const { whitelisted, agentId, faucet } = req.body;
  if (whitelisted != null) w.whitelisted = !!whitelisted;
  if (agentId != null) w.agentId = !!agentId;
  if (faucet) w.bnb += Number(faucet);
  res.json(trader.walletsView());
});
app.post('/api/launch', (req, res) => LIVE ? res.status(400).json({ error: '实盘行情模式不能模拟发射' }) : res.json(market.summary(market.launch(req.body || {}))));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', verifyClient: ({ req }) => { const e = guard(req, true); if (e) console.warn(`[security] WebSocket：${e}`); return !e; } });   // WebSocket 同样要同源 / 令牌
// 序列化失败只跳过这一帧，不让整个服务崩溃
let badFrameLogged = false;
const broadcast = (msg) => {
  let s;
  try { s = JSON.stringify(msg); } catch (e) { if (!badFrameLogged) { badFrameLogged = true; console.error(`推送 ${msg?.type} 序列化失败，已跳过：${e.message}`); } return; }
  for (const c of wss.clients) if (c.readyState === 1) c.send(s);
};
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e?.stack || e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e?.stack || e));

wss.on('connection', (ws) => {
  ws.sub = null;
  ws.on('message', (raw) => {
    try {
      const m = JSON.parse(raw);
      if (m.type === 'sub') {
        ws.sub = m.token;
        const send = () => { const d = market.detail(m.token); if (d && ws.sub === m.token) ws.send(JSON.stringify({ type: 'detail', full: true, data: d })); };
        send();
        if (LIVE) market.refresh(m.token).then(send);
      }
    } catch { /* ignore */ }
  });
});

market.on('trade', (t) => broadcast({ type: 'trade', data: t }));
market.on('launch', (s) => broadcast({ type: 'launch', data: s }));
// 实盘行情：选中的代币每 3 秒刷新一次详情
if (LIVE) setInterval(() => new Set([...wss.clients].map((c) => c.sub).filter(Boolean)).forEach((a) => market.refresh(a)), 3000);
market.on('detail', (a) => { for (const c of wss.clients) if (c.readyState === 1 && c.sub === a) c.send(JSON.stringify({ type: 'detail', full: true, data: market.detail(a) })); });
// 订单结束（成交或失败）后马上重读链上余额，3 / 5 / 20 秒后再读一次，等区块和 baw 索引跟上
const resync = async () => { trader.syncAt = 0; if (holdings) holdings.histAt = 0; await trader.refreshBalance?.().catch(() => {}); await trader.syncHoldings?.().catch(() => {}); };
trader.on('order', (o) => { broadcast({ type: 'order', data: o }); if (LIVE && ['filled', 'failed', 'unknown'].includes(o.status)) { for (const ms of [3000, 5000, 20000]) setTimeout(() => resync(), ms); for (const ms of [1500, 6000, 15000]) setTimeout(refreshHoldSnap, ms); } });
trader.on('autoTransfer', (o) => broadcast({ type: 'autoTransfer', data: o }));
trader.on('rules', (r) => broadcast({ type: 'rules', data: r }));
trader.on('settings', (st) => broadcast({ type: 'settings', data: st }));
market.on('migrate', (s) => { if (LIVE && s?.platform === 'four') { trader.syncAt = 0; trader.refreshBalance?.(); } });
agent.on('log', (l) => broadcast({ type: 'log', data: l }));
agent.on('record', (r) => broadcast({ type: 'record', data: r }));
agent.on('config', (c) => broadcast({ type: 'config', data: c }));

setInterval(() => {
  broadcast({ type: 'tick', data: { ...modeInfo(), block: market.block, bnbUsd: market.bnbUsd, net, wallets: trader.walletsView(), usage: agent.usageView(), tokens: market.list(), positions: trader.positionsView(), claimable: LIVE ? trader.claimable : [] } });
  for (const c of wss.clients) {
    if (c.readyState !== 1 || !c.sub) continue;
    const d = market.detail(c.sub);
    if (d) c.send(JSON.stringify({ type: 'detail', full: false, data: { ...d, candles: d.candles.slice(-5) } }));
  }
}, 500);

// 默认只监听本机。HOST 只给 Docker 容器用（容器里要监听 0.0.0.0，端口再只映射到宿主机的 127.0.0.1）
server.listen(PORT, process.env.HOST || '127.0.0.1', () => {
  console.log(`\n  TMTN（${!LIVE ? '模拟盘' : LIVE_TRADE ? `实盘 · 手动订单真实下单 · 单笔上限 ${trader.status.maxTradeBnb || '不限'} BNB` : '实盘行情 · 只报价不下单'}）`);
  if (LIVE) console.log(`  baw：${trader.status.connected ? `已连接 ${trader.wallets[0].address}` : `未连接（${trader.status.error}）`}`);
  console.log(`  ➜  http://localhost:${PORT}\n`);
});
