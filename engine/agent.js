// 自动狙击 Agent：监听新建内盘 → 过滤 → 防狙击税保护（实时读费率，低于上限才买）→ 多钱包同时提交。
// 不经过任何「AI 思考」环节，命中即直接提交请求。另含自动止盈止损。
import { EventEmitter } from 'node:events';
import { TOTAL_SUPPLY } from './market.js';

const platformDefaults = (platform) => ({
  enabled: platform === 'four',
  wallets: ['big'],
  antiSnipe: { enabled: platform === 'four', maxFeePct: 10, maxWaitSec: 60, pollMs: 500 },
  delaySec: 0,                       // 不开防狙击时可设延时狙击 1-3 秒
  mode: 'fill',                      // fixed 固定金额 | pct 按总量占比 | fill 买满上限(1%)
  maxPerTrade: 0.2, pctOfSupply: 0.5, slippage: 99, dailyBudget: 1, hourlyMax: 5, minReserve: 0,
  quote: 'all',                      // bnb 只买 BNB 报价 | all 全部（非 BNB 由 Core 同笔兑换）
  include: '', exclude: 'test, scam',
});

export const DEFAULT_CONFIG = {
  flap: platformDefaults('flap'),
  four: platformDefaults('four'),
  exit: { enabled: false, takeProfitPct: 100, takeProfitSellPct: 50, stopLossPct: 40, trailingPct: 30, maxHoldMin: 0 },
  quickBuy: 0.1, paused: false, sound: true, notify: true,
};

export class Agent extends EventEmitter {
  constructor(market, trader, { live = false } = {}) {
    super();
    this.market = market; this.trader = trader; this.live = live;
    this.config = structuredClone(DEFAULT_CONFIG); this.config.four.enabled = false; this.config.flap.enabled = false;   // 自动买入已移除
    if (live) {   // 实盘：默认全部关闭，钱包换成 baw
      for (const p of ['flap', 'four']) Object.assign(this.config[p], { enabled: false, wallets: ['baw'], dailyBudget: 0.5, maxPerTrade: 0.05, slippage: 20 });
    }
    this.logs = []; this.records = []; this.spend = new Map(); this.tpDone = new Set(); this.busy = new Set();
    market.on('launch', (s) => this.onLaunch(s));
    market.on('migrate', (s) => this.onMigrate(s));
    market.on('rug', (s) => this.log('error', `💀 ${s.symbol} 流动性被撤（Rug）`));
    this.timer = setInterval(() => this.manageExits().catch((e) => this.log('error', e.message)), 1000);
  }

  log(level, msg, extra = {}) {
    const e = { ts: Date.now(), level, msg, ...extra };
    this.logs.unshift(e); if (this.logs.length > 300) this.logs.length = 300;
    this.emit('log', e);
  }

  setConfig(patch) {
    const merge = (dst, src) => { for (const k of Object.keys(src)) { if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k]) && dst[k]) merge(dst[k], src[k]); else dst[k] = src[k]; } };
    merge(this.config, patch);
    this.config.four.enabled = false; this.config.flap.enabled = false;   // 自动买入已移除：任何请求都不能再打开
    this.emit('config', this.config);
  }

  // 每个钱包的今日花费、近 1 小时笔数（按平台独立计算）
  usage(platform, wid) {
    const k = `${platform}:${wid}`;
    if (!this.spend.has(k)) this.spend.set(k, { day: new Date().toDateString(), bnb: 0, times: [] });
    const u = this.spend.get(k);
    if (u.day !== new Date().toDateString()) Object.assign(u, { day: new Date().toDateString(), bnb: 0 });
    u.times = u.times.filter((t) => Date.now() - t < 3600_000);
    return u;
  }

  usageView() {
    const out = {};
    for (const p of ['flap', 'four']) {
      const c = this.config[p];
      const us = c.wallets.map((w) => this.usage(p, w));
      out[p] = { spent: us.reduce((a, u) => a + u.bnb, 0), budget: c.dailyBudget * c.wallets.length, lastHour: us.reduce((a, u) => a + u.times.length, 0), hourlyMax: c.hourlyMax * c.wallets.length };
    }
    return out;
  }

  filter(c, s) {
    if (c.quote === 'bnb' && s.quote !== 'BNB') return `报价币 ${s.quote}，只买 BNB 报价`;
    const name = `${s.symbol} ${s.name}`.toLowerCase();
    const inc = c.include.split(/[,，]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    const exc = c.exclude.split(/[,，]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (inc.length && !inc.some((k) => name.includes(k))) return '名称不含关键词';
    const hit = exc.find((k) => name.includes(k)); if (hit) return `命中排除词「${hit}」`;
    return null;
  }

  async onLaunch(s) {
    const detectMs = s.detectMs ?? 40 + Math.round(Math.random() * 160);
    this.log('info', `🆕 链上检测到新内盘 ${s.symbol}（${s.platform === 'four' ? 'Four·Agent 专属' : s.platform === 'gang' ? (s.gangTrack === 'v2' ? 'Gang V2' : 'Gang') : 'Flap·Agent 曲线'}，${s.quote} 报价）· ${detectMs}ms`, { token: s.address, kind: 'launch', detectMs });
    this.emit('detect', detectMs);
    // 自动买入已移除：发现新币只记日志，不再狙击 / 下单
    return;
    const c = this.config[s.platform];
    if (this.config.paused || !c.enabled) return;
    if (this.isBlocked?.(s)) return this.record(s, 'skip', '已屏蔽');
    const why = this.filter(c, s);
    if (why) return this.record(s, 'skip', why);

    // 实盘读链上/shrine 的实时费率；读不到（null）也按「未达标」继续等，直到超时
    const readFee = async () => (this.market.fetchBuyFeePct ? this.market.fetchBuyFeePct(s.address) : this.market.buyFeePct(this.market.get(s.address)));
    if (c.antiSnipe.enabled && (s.platform === 'four' || this.live)) {
      const start = Date.now();
      let fee = await readFee();
      while (fee == null || fee > c.antiSnipe.maxFeePct) {
        if (Date.now() - start > c.antiSnipe.maxWaitSec * 1000) return this.record(s, 'skip', `等待 ${c.antiSnipe.maxWaitSec}s 费率仍 ${fee == null ? '未知' : fee.toFixed(1) + '%'}，放弃`);
        this.log('dim', `⏳ ${s.symbol} 实时总费率 ${fee == null ? '读取中' : fee.toFixed(1) + '%'} > 上限 ${c.antiSnipe.maxFeePct}%，${c.antiSnipe.pollMs}ms 后复查`);
        await new Promise((r) => setTimeout(r, c.antiSnipe.pollMs));
        fee = await readFee();
      }
      this.log('ok', `✅ ${s.symbol} 费率降到 ${fee.toFixed(2)}%（开盘后 ${((Date.now() - s.createdAt) / 1000).toFixed(1)}s），立即买入`);
    } else if (c.delaySec > 0) {
      await new Promise((r) => setTimeout(r, c.delaySec * 1000));
    }
    await Promise.all(c.wallets.map((wid) => this.snipe(s, c, wid)));
  }

  async snipe(s, c, wid) {
    const w = this.trader.wallet(wid);
    const t = this.market.get(s.address);
    const el = this.trader.eligibility(w, t);
    if (!el.ok) return this.record(s, 'skip', `${w.label}：${el.reason}，合约会拒绝买入，已跳过`, wid);
    const u = this.usage(s.platform, wid);
    if (c.hourlyMax && u.times.length >= c.hourlyMax) return this.record(s, 'skip', `${w.label} 近 1 小时已达 ${c.hourlyMax} 笔`, wid);
    let bnb = c.mode === 'fixed' ? c.maxPerTrade
      : c.mode === 'pct' ? this.market.costFor(t, TOTAL_SUPPLY * c.pctOfSupply / 100)
      : Math.min(c.maxPerTrade, this.market.costFor(t, this.trader.capLeft(w, t)));
    const dry = this.trader.status?.dryRun;   // DRY RUN 只报价，不受钱包余额限制
    bnb = Math.min(bnb, c.maxPerTrade, c.dailyBudget - u.bnb, dry ? Infinity : w.bnb - c.minReserve - 0.002);
    if (!(bnb > 0.0005)) return this.record(s, 'skip', `${w.label} 预算/余额不足`, wid);
    u.bnb += bnb; u.times.push(Date.now());
    const o = await this.trader.execute({ walletId: wid, token: s.address, side: 'buy', amount: +bnb.toFixed(6), slippage: c.slippage, source: '自动狙击' });
    if (o.status !== 'filled') u.bnb -= bnb;
    const msg = o.status === 'filled' ? `${w.label} 买入 ${o.amountIn.toFixed(4)} BNB${o.feePct != null ? `，费率 ${o.feePct.toFixed(2)}%` : ''}，${o.latencyMs}ms`
      : o.status === 'dry_run' ? `${w.label} DRY RUN 已报价 ${bnb.toFixed(4)} BNB（未上链），${o.latencyMs}ms` : `${w.label} ${o.reason}`;
    this.record(s, o.status === 'filled' ? 'buy' : o.status === 'dry_run' ? 'dry' : 'fail', msg, wid);
  }

  record(s, status, msg, wid) {
    const r = { ts: Date.now(), platform: s.platform, symbol: s.symbol, token: s.address, status, msg, wid };
    this.records.unshift(r); if (this.records.length > 100) this.records.length = 100;
    this.emit('record', r);
    this.log(status === 'buy' ? 'ok' : status === 'fail' ? 'error' : 'dim', `🎯 ${s.symbol}：${msg}`, { token: s.address });
  }

  onMigrate(s) {
    this.log('info', `🚀 ${s.symbol} 内盘募满，已迁移到 PancakeSwap`, { token: s.address });
    if (!this.trader.settings.autoClaim) return;
    const held = this.trader.positionsView().filter((p) => p.token === s.address && p.amount > 0);
    for (const p of held) this.log('ok', `🎁 ${p.wallet} 发射后自动领取 ${s.symbol}（已到账，可外盘交易）`, { token: s.address });
  }

  async manageExits() {
    const x = this.config.exit;
    if (!x.enabled || this.config.paused) return;
    for (const p of this.trader.positionsView()) {
      if (p.amount <= 0 || p.stage === 'rugged') continue;
      const key = `${p.walletId}:${p.token}`;
      if (this.busy.has(key)) continue;
      let pct = 0, why = '';
      if (!this.tpDone.has(key) && p.pnlPct >= x.takeProfitPct) { pct = x.takeProfitSellPct; why = `止盈 +${p.pnlPct.toFixed(1)}%`; this.tpDone.add(key); }
      else if (p.pnlPct <= -x.stopLossPct) { pct = 100; why = `止损 ${p.pnlPct.toFixed(1)}%`; }
      else if (this.tpDone.has(key) && p.drawdownPct <= -x.trailingPct) { pct = 100; why = `移动止损 回撤 ${p.drawdownPct.toFixed(1)}%`; }
      else if (x.maxHoldMin && Date.now() - p.openedAt > x.maxHoldMin * 60000) { pct = 100; why = `持仓超 ${x.maxHoldMin} 分钟`; }
      if (!pct) continue;
      this.busy.add(key);
      this.log('info', `📤 ${p.symbol}（${p.wallet}）${why} → 卖出 ${pct}%`, { token: p.token });
      this.trader.execute({ walletId: p.walletId, token: p.token, side: 'sell', amount: pct, slippage: 35, source: '自动卖出' }).finally(() => this.busy.delete(key));
    }
  }
}
