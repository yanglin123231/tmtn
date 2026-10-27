// 追踪 + 跟单。
// 追踪：关注一些地址（.ai / .bnb 域名或直接填地址），它们在 Flap / Four / Gang V2 内盘上的成交从现有的链上订阅里筛出来，
//       标成 建仓 / 加仓 / 减仓 / 清仓（按链上余额判断），推给页面。不额外轮询链。
// 跟单：每个任务跟一个目标。安全规则：
//   - 新建的任务一律是「暂停」，默认「模拟」（只记录会买多少，不下单），都要本人在页面上打开；
//   - 有「全部暂停」总开关；
//   - 服务器端强制上限：单笔、每个币、每天合计、同时持有几个币；每个币每个任务不重复跟（除非允许加仓）；
//   - 每一次决定（下单 / 模拟 / 跳过及原因）都写进记录。
// 下单走和页面同一条路（placeOrder：多钱包、登录检查、地址锁定、单笔上限都照常）。
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { ethers } from 'ethers';
import { dataFile } from './config.js';
import { fetchTraderHistory, labelActions } from './trackBackfill.js';

const TARGETS = dataFile('track-targets.json'), TASKS = dataFile('copy-tasks.json'), FEED = dataFile('track-feed.jsonl'), LOG = dataFile('copy-log.jsonl');
const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { try { mkdirSync(new URL('.', f), { recursive: true }); writeFileSync(f, JSON.stringify(v, null, 1)); } catch { /* ignore */ } };
const append = (f, v) => { try { mkdirSync(new URL('.', f), { recursive: true }); appendFileSync(f, JSON.stringify(v) + '\n'); } catch { /* ignore */ } };
const lc = (a) => String(a || '').toLowerCase();
const FEED_DAYS = 30, FEED_MAX = 50_000;   // 追踪历史保留 30 天、最多 5 万条
const erc20 = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);
const day = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 10);

// 跟单参数默认值（新建任务时用；页面可改）
export const COPY_DEFAULTS = {
  mode: 'fixed', amountBnb: 0.01, ratioPct: 10, maxPerTrade: 0.05, maxPerToken: 0.05, dailyCap: 0.2, maxOpen: 5,
  onlyFirst: true, minTargetBnb: 0, maxTargetBnb: 0, maxMcUsd: 0, platforms: ['flap', 'four', 'gang'], maxDelaySec: 15,
  slippage: 20, wallets: [1], followSell: false, dryRun: true, maxCopies: 1,
};
const HARD_MAX_TRADE = 0.5;   // 无论参数怎么填，单笔不超过 0.5 BNB（另外还受交易设置里的单笔上限约束）

export class Tracker extends EventEmitter {
  constructor({ market, provider, placeOrder, log }) {
    super();
    Object.assign(this, { market, provider, placeOrder, logFn: log || (() => {}) });
    const t = readJson(TARGETS, { targets: [], groups: ['默认'] });
    this.targets = t.targets || []; this.groups = t.groups?.length ? t.groups : ['默认'];
    const k = readJson(TASKS, { tasks: [], paused: false });
    this.tasks = k.tasks || []; this.allPaused = !!k.paused;
    this.feed = []; this.log = []; this.pos = new Map();   // pos：目标地址|代币 → 我们看到的持仓（只用来判断建仓）
    this.compactFeed();   // 历史记录：只保留最近 30 天、最多 5 万条（超出时重写文件），启动时只把最近 500 条放进内存
    try { this.feed = readFileSync(FEED, 'utf8').trim().split('\n').slice(-500).map((l) => JSON.parse(l)).reverse(); } catch { /* 第一次 */ }
    this.appended = 0;
    try { this.log = readFileSync(LOG, 'utf8').trim().split('\n').slice(-300).map((l) => JSON.parse(l)).reverse(); } catch { /* 第一次 */ }
  }

  // ---------- 追踪目标 ----------
  saveTargets() { writeJson(TARGETS, { targets: this.targets, groups: this.groups }); this.emit('targets', this.targetsView()); }
  targetsView() { return { targets: this.targets, groups: this.groups }; }
  target(addr) { return this.targets.find((x) => x.address === lc(addr)); }
  addTarget({ address, name, remark, group, avatar, domain }) {
    const a = lc(address); if (!/^0x[0-9a-f]{40}$/.test(a)) throw new Error('地址格式不对');
    const cur = this.target(a);
    const v = { address: a, name: String((name !== undefined ? name : cur?.name) || domain || cur?.domain || '').slice(0, 40),   /* 显式传空 = 清掉旧名字 */ domain: domain || cur?.domain || null, remark: String(remark ?? cur?.remark ?? '').slice(0, 80),
      group: group || cur?.group || '默认', avatar: avatar || cur?.avatar || null, addedAt: cur?.addedAt || Date.now(), sound: cur?.sound ?? true };
    if (v.group && !this.groups.includes(v.group)) this.groups.push(v.group);
    const i = this.targets.findIndex((x) => x.address === a);   // 改备注等：保持原来的位置
    if (i >= 0) this.targets[i] = { ...v, backfilledAt: cur?.backfilledAt }; else this.targets.push(v);
    this.saveTargets();
    if (i < 0) this.backfill([a]).catch((e) => this.logFn(`[追踪] 历史回补失败：${e.message}`));   // 新加的地址：补最近 24 小时
    return v;
  }
  // ---------- 历史回补（只写历史，不响提示音、不触发跟单）----------
  // 新加的追踪地址，以及启动时还没回补过的地址，从链上补最近 24 小时的内盘买卖
  backfillPending() { const list = this.targets.filter((t) => !t.backfilledAt).map((t) => t.address); if (list.length) this.backfill(list).catch((e) => this.logFn(`[追踪] 历史回补失败：${e.message}`)); }
  async backfill(addresses, { hours = 24 } = {}) {
    if (this.backfilling) { this.backfillQueue = [...new Set([...(this.backfillQueue || []), ...addresses])]; return; }
    this.backfilling = true;
    try {
      const { trades, head } = await fetchTraderHistory(this.provider, addresses, { hours });
      // 区块 → 时间：取两个区块的时间戳线性估算（只多 2 次查询）
      const hb = await this.provider.getBlock(head), lo = trades.length ? Math.max(0, trades[0].block) : head, lb = lo < head ? await this.provider.getBlock(lo) : hb;
      const msPer = lo < head ? ((Number(hb.timestamp) - Number(lb.timestamp)) * 1000) / (head - lo) : 450;
      const tsOf = (n) => Number(hb.timestamp) * 1000 - (head - n) * msPer;
      // 卖出前窗口内没看到买入的，用当前余额判断是不是已经清仓（最多查 150 个）
      const bal = new Map(); const need = [...new Set(trades.filter((t) => t.side === 'sell').map((t) => `${t.trader}|${t.token}`))].slice(0, 150);
      for (const k of need) { const [w, tok] = k.split('|'); try { bal.set(k, Number(ethers.formatEther(erc20.decodeFunctionResult('balanceOf', await this.provider.call({ to: tok, data: erc20.encodeFunctionData('balanceOf', [w]) }))[0]))); } catch { /* 不知道就算减仓 */ } }
      const have = new Set(); try { for (const l of readFileSync(FEED, 'utf8').split('\n')) { if (!l) continue; try { have.add(JSON.parse(l).id); } catch { /* 坏行 */ } } } catch { /* 没有文件 */ }
      const sym = new Map(); const evs = [];
      for (const tr of labelActions(trades, bal)) {
        const id = `${tr.tx}:${tr.side}:${tr.trader}`; if (have.has(id)) continue; have.add(id);
        const tg = this.target(tr.trader); if (!tg) continue;
        const t = this.market.get(tr.token);
        let symbol = t?.symbol; if (!symbol) { if (!sym.has(tr.token)) { try { sym.set(tr.token, await new ethers.Contract(tr.token, ['function symbol() view returns (string)'], this.provider).symbol()); } catch { sym.set(tr.token, tr.token.slice(0, 6)); } } symbol = sym.get(tr.token); }
        const quote = t?.quote || (tr.platform === 'gang' ? '报价币' : 'BNB'), rate = t ? (this.market.quoteUsd?.(t) || 0) / (this.market.bnbUsd || 1) : (quote === 'BNB' ? 1 : 0);
        evs.push({ id, ts: Math.round(tsOf(tr.block)), seenAt: Date.now(), target: tr.trader, targetName: tg.name || tg.domain || null, group: tg.group, action: tr.action, side: tr.side,
          token: tr.token, symbol, image: t?.image || null, platform: t?.platform || tr.platform, quote, quoteAmt: tr.bnb, bnb: tr.bnb * (rate || (quote === 'BNB' ? 1 : 0)), usd: null, tokens: tr.tokens, pct: tr.pct,
          mcapUsd: t?.mcapUsd || null, createdAt: t?.createdAt || null, tx: tr.tx, backfill: true });
      }
      if (evs.length) {
        // 合并进历史文件，按时间排序重写；内存里的最近 500 条也重建
        let rows = []; try { rows = readFileSync(FEED, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { /* 第一次 */ }
        rows = rows.concat(evs).sort((a, b) => a.ts - b.ts);
        mkdirSync(new URL('.', FEED), { recursive: true }); writeFileSync(FEED, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
        this.feed = rows.slice(-500).reverse(); this.older = null;
      }
      const now = Date.now(); for (const a of addresses) { const t = this.target(a); if (t) t.backfilledAt = now; } this.saveTargets();
      this.logFn(`[追踪] 历史回补 ${addresses.length} 个地址：链上 ${trades.length} 笔，新增 ${evs.length} 条`);
      this.emit('reload');   // 页面重新拉一次追踪数据（不逐条推送，所以不响提示音；也不进 decide，不会跟单）
      return { trades: trades.length, added: evs.length };
    } finally {
      this.backfilling = false;
      const q = this.backfillQueue; this.backfillQueue = null; if (q?.length) this.backfill(q).catch(() => {});
    }
  }
  removeTarget(address) { this.targets = this.targets.filter((x) => x.address !== lc(address)); this.saveTargets(); }

  // ---------- 成交 → 追踪动态 ----------
  async onTrade(tr) {
    const who = lc(tr.trader), tg = this.target(who); if (!tg || !tr.address) return;
    const t = this.market.get(tr.address); if (!t) return;
    const key = `${who}|${lc(tr.address)}`, tokens = Number(tr.tokens) || 0;
    // 用链上余额判断：买之前是 0 = 建仓；卖完剩 0 = 清仓。读不到余额时按本程序看到的累计数量判断
    let after = null; try { after = Number(ethers.formatEther(erc20.decodeFunctionResult('balanceOf', await this.provider.call({ to: tr.address, data: erc20.encodeFunctionData('balanceOf', [who]) }))[0])); } catch { /* 用累计 */ }
    const seen = this.pos.get(key) || 0;
    let action, pct = null;
    if (tr.side === 'buy') { const before = after != null ? Math.max(0, after - tokens) : seen; action = before <= tokens * 0.001 ? '建仓' : '加仓'; this.pos.set(key, (after ?? seen + tokens)); }
    else { const before = after != null ? after + tokens : seen; pct = before > 0 ? Math.min(100, (tokens / before) * 100) : null; action = after != null ? (after <= before * 0.005 ? '清仓' : '减仓') : '减仓'; this.pos.set(key, Math.max(0, after ?? seen - tokens)); }
    const rate = (this.market.quoteUsd?.(t) || 0) / (this.market.bnbUsd || 1);   // 报价币 → BNB
    const ev = { id: `${tr.tx}:${tr.side}:${who}`, ts: tr.ts || Date.now(), seenAt: Date.now(), target: who, targetName: tg.name || tg.domain || null, group: tg.group,
      action, side: tr.side, token: lc(tr.address), symbol: t.symbol, image: t.image || null, platform: t.platform, quote: t.quote || 'BNB', quoteAmt: tr.bnb, bnb: tr.bnb * (rate || (t.quote === 'BNB' ? 1 : 0)),
      usd: tr.usd ?? null, tokens, pct, mcapUsd: t.mcapUsd || null, createdAt: t.createdAt || null, tx: tr.tx };
    if (this.feed.some((x) => x.id === ev.id)) return;
    this.feed.unshift(ev); if (this.feed.length > 500) this.feed.length = 500; append(FEED, ev); this.older = null;
    if (++this.appended % 2000 === 0) this.compactFeed();
    this.emit('event', ev);
    for (const task of this.tasks) if (task.target === who) this.decide(task, ev).catch((e) => this.record(task, ev, 'error', `出错：${e.message}`));
  }

  // 历史记录轮转：超过 30 天或多于 5 万条的旧记录删掉（文件重写一次）
  compactFeed() {
    try {
      const lines = readFileSync(FEED, 'utf8').trim().split('\n').filter(Boolean); const cut = Date.now() - FEED_DAYS * 86400_000;
      const keep = lines.slice(-FEED_MAX).filter((l) => { try { return JSON.parse(l).ts >= cut; } catch { return false; } });
      if (keep.length < lines.length) writeFileSync(FEED, keep.join('\n') + (keep.length ? '\n' : ''));
    } catch { /* 文件还不存在 */ }
  }
  // 往回翻：before 之前的 limit 条（新→旧）。第一次翻页时把文件读进内存缓存，有新记录时缓存作废
  feedPage({ before = Date.now() + 1, limit = 100 } = {}) {
    if (!this.older) { try { this.older = readFileSync(FEED, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse(); } catch { this.older = []; } }
    const items = []; let i = this.older.findIndex((x) => x.ts < before); if (i < 0) i = this.older.length;
    for (; i < this.older.length && items.length < limit; i++) items.push(this.older[i]);
    return { items, more: i < this.older.length, total: this.older.length };
  }

  // ---------- 跟单任务 ----------
  saveTasks() { writeJson(TASKS, { tasks: this.tasks, paused: this.allPaused }); this.emit('tasks', this.tasksView()); }
  tasksView() { return { tasks: this.tasks, paused: this.allPaused }; }
  createTask({ target, name, params }) {
    const a = lc(target); if (!/^0x[0-9a-f]{40}$/.test(a)) throw new Error('目标地址格式不对');
    const task = { id: 'c' + Date.now().toString(36), target: a, name: String(name || this.target(a)?.name || a.slice(0, 8)).slice(0, 40), createdAt: Date.now(),
      status: 'paused', params: this.cleanParams({ ...COPY_DEFAULTS, ...(params || {}) }), stats: { buyBnb: 0, sellBnb: 0, buys: 0, sells: 0, sims: 0, realized: 0, lastAt: null, copies: 0, simCopies: 0 }, tokens: {}, days: {} };
    this.tasks.push(task); this.saveTasks(); return task;   // 新建一律暂停
  }
  cleanParams(p) {
    const n = (v, d, lo = 0, hi = 1e9) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
    return { mode: p.mode === 'ratio' ? 'ratio' : 'fixed', amountBnb: n(p.amountBnb, 0.01, 0, HARD_MAX_TRADE), ratioPct: n(p.ratioPct, 10, 0, 1000), maxPerTrade: n(p.maxPerTrade, 0.05, 0, HARD_MAX_TRADE),
      maxPerToken: n(p.maxPerToken, 0.05, 0, 10), dailyCap: n(p.dailyCap, 0.2, 0, 50), maxOpen: Math.round(n(p.maxOpen, 5, 0, 100)), onlyFirst: p.onlyFirst !== false,
      minTargetBnb: n(p.minTargetBnb, 0), maxTargetBnb: n(p.maxTargetBnb, 0), maxMcUsd: n(p.maxMcUsd, 0), platforms: (Array.isArray(p.platforms) ? p.platforms : ['flap', 'four', 'gang']).filter((x) => ['flap', 'four', 'gang'].includes(x)),
      maxDelaySec: n(p.maxDelaySec, 15, 1, 600), slippage: n(p.slippage, 20, 1, 50), wallets: (Array.isArray(p.wallets) ? p.wallets : [1]).map(Number).filter((x) => x > 0), followSell: p.followSell === true, dryRun: p.dryRun !== false,
      maxCopies: Math.round(n(p.maxCopies, 1, 0, 1000)) };   // 最多跟单几次（跟买成功的次数），0 = 不限；模拟和真实分开计数
  }
  updateTask(id, patch) {
    const t = this.tasks.find((x) => x.id === id); if (!t) throw new Error('任务不存在');
    if (patch.params) t.params = this.cleanParams({ ...t.params, ...patch.params });
    if (patch.name) t.name = String(patch.name).slice(0, 40);
    if (patch.status && ['running', 'paused', 'closed'].includes(patch.status)) t.status = patch.status;
    this.saveTasks(); return t;
  }
  // 删除：只能删已关闭的任务（运行中 / 暂停的要先关闭）
  deleteTask(id) { const t = this.tasks.find((x) => x.id === id); if (!t) throw new Error('任务不存在'); if (t.status !== 'closed') throw new Error('先关闭任务再删除'); this.tasks = this.tasks.filter((x) => x.id !== id); this.saveTasks(); return this.tasksView(); }
  setAllPaused(v) { this.allPaused = !!v; this.saveTasks(); }

  record(task, ev, kind, reason, extra = {}) {
    const row = { ts: Date.now(), task: task.id, taskName: task.name, target: task.target, kind, reason, token: ev?.token, symbol: ev?.symbol, action: ev?.action, ...extra };
    this.log.unshift(row); if (this.log.length > 500) this.log.length = 500; append(LOG, row); this.emit('log', row);
    return row;
  }

  async decide(task, ev) {
    const p = task.params, tk = (task.tokens[ev.token] ||= { bought: 0, sold: 0, open: false, n: 0 });
    if (task.status !== 'running') return;                                   // 暂停 / 关闭的任务不记录（太多）
    if (this.allPaused) return this.record(task, ev, 'skip', '全部暂停中');
    { const max = p.maxCopies || 0, n = p.dryRun ? task.stats.simCopies || 0 : task.stats.copies || 0; if (max > 0 && n >= max && ev.side === 'buy') return this.record(task, ev, 'skip', `已跟满 ${max} 次`); }
    const delay = (Date.now() - (ev.ts || ev.seenAt)) / 1000;
    if (ev.side === 'sell') {
      if (!p.followSell) return;
      if (!tk.open) return this.record(task, ev, 'skip', '我们没有跟买这个币，不跟卖');
      const pct = ev.action === '清仓' ? 100 : Math.max(1, Math.round(ev.pct || 0));
      if (p.dryRun) { task.stats.sims++; this.saveTasks(); return this.record(task, ev, 'sim', `模拟跟卖 ${pct}%`); }
      const res = await this.placeOrder({ token: ev.token, side: 'sell', amount: pct, slippage: p.slippage, slots: p.wallets, source: `跟单 ${task.name}` });
      return this.afterOrder(task, ev, res, 'sell', pct);
    }
    // 买入：逐条检查，任何一条不满足就跳过并写明原因
    if (!p.platforms.includes(ev.platform)) return this.record(task, ev, 'skip', `平台 ${ev.platform} 不在跟单范围`);
    if (p.onlyFirst && ev.action !== '建仓') return this.record(task, ev, 'skip', '只跟建仓，这次是加仓');
    if (tk.n > 0 && p.onlyFirst) return this.record(task, ev, 'skip', '这个币已经跟过');
    if (delay > p.maxDelaySec) return this.record(task, ev, 'skip', `发现太晚（${delay.toFixed(1)} 秒 > ${p.maxDelaySec} 秒）`);
    if (p.minTargetBnb > 0 && !(ev.bnb >= p.minTargetBnb)) return this.record(task, ev, 'skip', `对方买入 ${ev.bnb?.toFixed(4)} BNB 小于下限 ${p.minTargetBnb}`);
    if (p.maxTargetBnb > 0 && ev.bnb > p.maxTargetBnb) return this.record(task, ev, 'skip', `对方买入 ${ev.bnb.toFixed(4)} BNB 大于上限 ${p.maxTargetBnb}`);
    if (p.maxMcUsd > 0 && ev.mcapUsd > p.maxMcUsd) return this.record(task, ev, 'skip', `市值 $${Math.round(ev.mcapUsd)} 超过上限 $${p.maxMcUsd}`);
    let amt = p.mode === 'ratio' ? (ev.bnb || 0) * p.ratioPct / 100 : p.amountBnb;
    amt = Math.min(amt, p.maxPerTrade, HARD_MAX_TRADE);
    if (p.maxPerToken > 0) amt = Math.min(amt, p.maxPerToken - tk.bought);
    const today = task.days[day()] || 0; if (p.dailyCap > 0) amt = Math.min(amt, p.dailyCap - today);
    const open = Object.values(task.tokens).filter((x) => x.open).length;
    if (!tk.open && p.maxOpen > 0 && open >= p.maxOpen) return this.record(task, ev, 'skip', `已同时持有 ${open} 个币（上限 ${p.maxOpen}）`);
    const nW = p.wallets.length || 1; amt = +(amt / 1).toFixed(6);
    if (!(amt >= 0.001)) return this.record(task, ev, 'skip', '额度已用完（单币 / 每日上限）或金额太小');
    // 每个钱包各买 amt；每日 / 单币额度按合计扣
    if (p.dailyCap > 0 && today + amt * nW > p.dailyCap + 1e-9) amt = +((p.dailyCap - today) / nW).toFixed(6);
    if (!(amt >= 0.001)) return this.record(task, ev, 'skip', '每日额度不够');
    tk.n++;   // 先占位，避免同一个币连续两笔重复跟
    if (p.dryRun) {
      task.stats.sims++; task.stats.simCopies = (task.stats.simCopies || 0) + 1; tk.simBnb = (tk.simBnb || 0) + amt * nW;
      const row = this.record(task, ev, 'sim', `模拟买入：每个钱包 ${amt} BNB × ${nW} 个钱包（对方 ${ev.action} ${ev.bnb?.toFixed(4)} BNB）· 模拟第 ${task.stats.simCopies} 次`);
      this.checkLimit(task, ev, true); this.saveTasks(); return row;
    }
    const res = await this.placeOrder({ token: ev.token, side: 'buy', amount: amt, slippage: p.slippage, slots: p.wallets, source: `跟单 ${task.name}` });
    return this.afterOrder(task, ev, res, 'buy', amt);
  }

  afterOrder(task, ev, res, side, amt) {
    // 成交的，和「已提交、结果未知」的（pending：已广播在等回执 / 在等币安 App 确认）都按已花钱计入额度和次数：宁可少跟一次，也不能超过上限
    const list = [].concat(res || []), ok = list.filter((o) => o?.status === 'filled' || o?.status === 'pending'), tk = task.tokens[ev.token];
    for (const o of ok) {
      if (side === 'buy') { const b = Number(o.amountIn ?? o.amount) || amt; task.stats.buyBnb += b; task.stats.buys++; tk.bought += b; tk.open = true; task.days[day()] = (task.days[day()] || 0) + b; }
      else { const b = Number(o.out) || 0; task.stats.sellBnb += b; task.stats.sells++; tk.sold += b; if (amt >= 100) { tk.open = false; task.stats.realized += tk.sold - tk.bought; } }
    }
    if (ok.length) task.stats.lastAt = Date.now();
    if (side === 'buy' && ok.length) task.stats.copies = (task.stats.copies || 0) + 1;   // 一次跟买（不管几个钱包成交）算一次
    const row = this.record(task, ev, ok.length ? 'order' : 'fail', `${side === 'buy' ? `跟买 ${amt} BNB` : `跟卖 ${amt}%`}：${list.map((o) => `${o.wallet || ''} ${o.status === 'filled' ? '成交' : o.status === 'pending' ? '已提交待确认（已计入额度）' : '失败 ' + (o.reason || '')}`).join('；')}`, { results: list.map((o) => ({ wallet: o.wallet, status: o.status, tx: o.tx, reason: o.reason })) });
    if (side === 'buy' && ok.length) this.checkLimit(task, ev, false);
    this.saveTasks(); return row;
  }

  // 跟满 N 次：任务自动关闭、进「历史」，记下原因。模拟只看模拟次数，真实只看真实次数
  checkLimit(task, ev, sim) {
    const max = task.params.maxCopies || 0, n = sim ? task.stats.simCopies : task.stats.copies;
    if (!(max > 0) || n < max) return;
    task.status = 'closed'; task.closedAt = Date.now(); task.closeReason = `${sim ? '模拟' : '真实'}跟单已满 ${max} 次，自动停止`;
    this.record(task, ev, 'stop', task.closeReason);
  }
}
