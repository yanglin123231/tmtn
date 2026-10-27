// RPC：有 NODEREAL_RPC 就用它当主节点，出错或被限流时自动换公共节点（bsc-dataseed / publicnode），30 秒后再试主节点。
// 地址里含 key，显示到页面 / 日志时一律用 maskRpc() 隐藏
import { ethers } from 'ethers';

export const maskRpc = (u) => String(u || '').replace(/(nodereal\.io\/(?:ws\/)?v1\/)[A-Za-z0-9]+/ig, '$1***').replace(/([?&](api[-_]?key|key|token)=)[^&\s"']+/ig, '$1***');
// 任意文本（日志、错误信息、记录文件）里的 RPC key 一律打码：NodeReal 地址 + .env 里 NODEREAL_KEYS 的 key 原文（用到时再读，.env 在 config.js 里才加载）
export const redactSecrets = (s) => { let t = maskRpc(s); for (const k of (process.env.NODEREAL_KEYS || '').split(',').map((x) => x.trim()).filter((x) => x.length >= 16)) t = t.split(k).join('***'); return t; };

// 页面上显示的节点名（不含 key）
// 多个 NodeReal key：页面上只显示「NodeReal #1 / #2」，不显示 key
const NR_SLOTS = [];
export const setNodeRealSlots = (urls) => { NR_SLOTS.length = 0; for (const u of urls) NR_SLOTS.push(String(u).replace(/^wss:/, 'https:').replace('/ws/v1/', '/v1/')); };
const nrName = (h) => { const i = NR_SLOTS.indexOf(String(h).replace(/^wss:/, 'https:').replace('/ws/v1/', '/v1/')); return NR_SLOTS.length > 1 && i >= 0 ? `NodeReal #${i + 1}` : 'NodeReal'; };
export const nodeName = (u) => { const h = String(u || ''); return /nodereal/i.test(h) ? nrName(h) : /publicnode/i.test(h) ? 'PublicNode' : /dataseed|bnbchain/i.test(h) ? 'BNB Chain' : /48\.club/i.test(h) ? '48 Club' : h ? (h.match(/\/\/([^/:]+)/)?.[1] || '自定义') : '—'; };

// 用量统计：每个节点、每个用途（label）、每个方法各请求了多少次（NodeReal 有额度，要盯着）
export const RPC_USAGE = new Map();
export const bumpUsage = (label, url, payload) => { const node = nodeName(url); for (const x of Array.isArray(payload) ? payload : [payload]) { const k = `${node}|${label}|${x?.method || '?'}`; RPC_USAGE.set(k, (RPC_USAGE.get(k) || 0) + 1); } };
// NodeReal（BSC）每个方法的 CU（docs.nodereal.io/docs/compute-units-cus）；WebSocket 推送按字节 0.04 CU；没列出的按 20 估
export const CU = { eth_blockNumber: 5, eth_chainId: 5, eth_call: 20, eth_getLogs: 50, eth_getBalance: 15, eth_getTransactionReceipt: 15, eth_getBlockByNumber: 15, eth_subscribe: 10, eth_estimateGas: 75, eth_gasPrice: 15, eth_getCode: 15, eth_getTransactionCount: 25, eth_sendRawTransaction: 150, logs: 0 };
export const cuOf = (method, n) => (method === 'ws_bytes' ? n * 0.04 : n * (CU[method] ?? 20));
export function takeUsage() { const out = {}; for (const [k, n] of RPC_USAGE) out[k] = n; RPC_USAGE.clear(); return out; }
export const PUBLIC_RPC = 'https://bsc-rpc.publicnode.com', PUBLIC_WSS = 'wss://bsc-rpc.publicnode.com';

// 订阅链上事件（WebSocket）：按顺序用 urls（一般是 NodeReal → publicnode）。断线 / 被拒（如 429）5 秒后换下一个；
// 用的不是第一个时，10 分钟后再试回第一个。status.connected 表示订阅正常
export class WsLogs {
  constructor({ label, urls, filters, onLog, status }) { Object.assign(this, { label, urls: urls.filter(Boolean), filters, onLog, status }); this.ws = null; }
  start() { this.connect(0); return this; }
  get live() { return !!this.ws && !!this.status.connected; }
  connect(i) {
    const url = this.urls[i]; if (!url) return;
    let ws; try { ws = new ethers.WebSocketProvider(url, 56); } catch (e) { return this.retry(i, e); }
    this.ws = ws; this.idx = i; this.status.wss = nodeName(url); this.status.connected = false;
    const sock = ws.websocket;
    sock?.addEventListener?.('open', () => { if (this.ws === ws) { this.status.connected = true; this.status.connectedAt = Date.now(); this.status.lastError = null; } });
    sock?.addEventListener?.('close', () => this.retry(i, new Error('连接断开'), ws));
    sock?.addEventListener?.('error', (e) => this.retry(i, e?.error || new Error('连接出错'), ws));
    for (const f of this.filters) ws.on(f, (log) => { this.status.connected = true; this.status.lastLogAt = Date.now(); bumpUsage(this.label + '-ws推送', url, { method: 'logs' }); const k = `${nodeName(url)}|${this.label}-ws推送|ws_bytes`; RPC_USAGE.set(k, (RPC_USAGE.get(k) || 0) + JSON.stringify(log).length + 200);   /* WS 按字节计费，估算每条推送的大小 */ try { this.onLog(log); } catch { /* 单条解析失败不影响订阅 */ } });
    bumpUsage(this.label, url, this.filters.map(() => ({ method: 'eth_subscribe' })));
    clearTimeout(this.backT);
    if (i > 0) this.backT = setTimeout(() => { if (this.ws === ws) { this.drop(ws); this.connect(0); } }, 10 * 60_000);
  }
  retry(i, e, ws) {
    if (ws && this.ws !== ws) return;
    this.drop(ws || this.ws); this.status.connected = false; this.status.lastError = String(e?.shortMessage || e?.message || e).slice(0, 160);
    if (this.pending) return; this.pending = setTimeout(() => { this.pending = null; this.connect((i + 1) % this.urls.length); }, 5_000);
  }
  drop(ws) { if (!ws) return; if (this.ws === ws) this.ws = null; try { ws.destroy(); } catch { /* ignore */ } }
}

export class FailoverProvider extends ethers.JsonRpcProvider {
  // urls 按优先顺序；其中多个 NodeReal key 轮流用（round-robin）。某个节点被限流 / 额度用完（429 等）就冷却 5 分钟，
  // 其他错误冷却 30 秒，期间用下一个；全都在冷却时仍按顺序硬试一遍。不让 ethers 自己退避重试（会卡很久）
  constructor(urls, label = 'rpc') {
    const list = urls.filter((u, i, a) => u && a.indexOf(u) === i);
    super(FailoverProvider.req(list[0]), 56, { staticNetwork: true, batchMaxCount: 1 });
    this.urls = list; this.label = label; this.rr = 0;
    this.nodes = list.map((u) => ({ url: u, name: nodeName(u), nr: /nodereal/i.test(u), cool: 0, err: null, p: new ethers.JsonRpcProvider(FailoverProvider.req(u), 56, { staticNetwork: true, batchMaxCount: 1 }) }));
    this.lastUsed = maskRpc(list[0]); this.primaryErr = null; this.coolUntil = 0;
  }
  static req(u) { const r = new ethers.FetchRequest(u); r.setThrottleParams({ maxAttempts: 1 }); r.timeout = 8_000; return r; }
  get info() {
    const now = Date.now(), first = this.nodes[0];
    const act = nodeName(this.lastUrl || this.urls[0]);
    return { active: act, primary: first?.name, fallback: act !== first?.name && !(first?.nr && /^NodeReal/.test(act)),
      coolUntil: this.coolUntil, primaryErr: this.primaryErr, keys: this.nodes.filter((n) => n.nr).map((n) => ({ name: n.name, cooling: n.cool > now, err: n.cool > now ? n.err : null })) };
  }
  order() {
    const now = Date.now(), ok = this.nodes.filter((n) => n.cool <= now);
    const nr = ok.filter((n) => n.nr);
    if (nr.length > 1) { this.rr = (this.rr + 1) % nr.length; const rot = nr.slice(this.rr).concat(nr.slice(0, this.rr)); let k = 0; for (let i = 0; i < ok.length; i++) if (ok[i].nr) ok[i] = rot[k++]; }
    return ok.length ? ok : this.nodes;
  }
  async _send(payload) {
    let last; const list = this.order();
    for (let i = 0; i < list.length; i++) {
      const n = list[i]; bumpUsage(this.label, n.url, payload);
      try {
        const r = await n.p._send(payload);
        const errs = (Array.isArray(r) ? r : [r]).filter((x) => x?.error).map((x) => String(x.error.message || ''));
        // 限流 / 额度：冷却这个节点换下一个；节点不支持（如 bsc-dataseed 的 getLogs「limit exceeded」）：换下一个；合约 revert 之类的正常错误直接返回
        const rl = errs.find((m) => /429|rate|too many|quota|exceed|limit/i.test(m));
        if (rl && i < list.length - 1) { n.cool = Date.now() + (n.nr ? 300_000 : 30_000); n.err = rl.slice(0, 120); if (n.nr) { this.primaryErr = n.err; this.coolUntil = n.cool; } last = new Error(rl); continue; }
        this.lastUsed = maskRpc(n.url); this.lastUrl = n.url; return r;
      } catch (e) {
        const m = String(e.shortMessage || e.message || e).slice(0, 160); last = e;
        n.cool = Date.now() + (/429|limit|quota|exceed|retry/i.test(m) ? 300_000 : 30_000); n.err = m;
        if (n.nr) { this.primaryErr = m; this.coolUntil = n.cool; }
      }
    }
    throw last;
  }
}
