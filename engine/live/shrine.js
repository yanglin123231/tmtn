// shrine.trade：新盘推送 / 全市场成交流 / 代币实时费率（currentBuyFeeBps、antiSniper）
import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { SHRINE_API, SHRINE_WS, SHRINE_STREAM } from './config.js';

export async function tokenInfo(address, wallet) {
  const res = await fetch(`${SHRINE_API}/api/token/${address}${wallet ? `?wallet=${wallet}` : ''}`, { headers: { accept: 'application/json' } });
  let body; try { body = await res.json(); } catch { body = { error: 'bad_response', message: `HTTP ${res.status}` }; }
  return body;
}

export class ShrineFeeds extends EventEmitter {
  // status 会被 JSON 序列化发给页面，定时器单独放在 pingers 里（放进 status 会导致 JSON.stringify 循环引用而崩溃）
  constructor() { super(); this.pingers = {}; this.status = { launch: { connected: false, lastEventAt: 0, reconnects: 0 }, stream: { connected: false, lastEventAt: 0, reconnects: 0 } }; }

  start() { this.connect('launch', SHRINE_WS, 3000); setTimeout(() => this.connect('stream', SHRINE_STREAM, 8000), 1500); }

  connect(kind, url, retryMs) {
    const st = this.status[kind];
    const ws = new WebSocket(url);
    ws.on('open', () => {
      st.connected = true; st.openedAt = Date.now(); st.fails = 0; st.downSince = 0; st.retryAt = 0; st.lastError = null;
      // 用 ping/pong 测 WS 往返延迟，顶栏显示
      clearInterval(this.pingers[kind]);
      this.pingers[kind] = setInterval(() => { st.pingAt = Date.now(); try { ws.ping(); } catch { /* */ } }, 5000);
    });
    ws.on('pong', () => { st.rttMs = Date.now() - st.pingAt; });
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      st.lastEventAt = Date.now();
      if (kind === 'launch' && m.type === 'new_launch') this.emit('launch', m);
      else if (kind === 'launch' && m.type === 'graduated') this.emit('graduated', m);
      else if (kind === 'stream' && (m.type === 'buy' || m.type === 'sell')) this.emit('trade', m);
      else if (kind === 'stream' && m.type === 'create' && m.token) this.emit('launch', { ...m, type: 'new_launch' }); // 修复参考版：create 也触发自动买
    });
    // 断线重连：连续失败时间隔加倍（最长 5 分钟）。被 shrine 限流（429）时至少等 60 秒，以前每 3 秒重连一次，越连越被限流
    ws.on('close', () => {
      clearInterval(this.pingers[kind]); st.connected = false; st.reconnects++; st.fails = (st.fails || 0) + 1; st.downSince ||= Date.now();
      // 429：shrine 每个 IP 只允许一个订阅（同一台电脑上别的程序占着时就会这样），5 分钟后再试
      st.busy = /429/.test(st.lastError || '');
      const wait = st.busy ? 300_000 : Math.min(300_000, retryMs * 2 ** Math.min(st.fails - 1, 7));
      st.retryAt = Date.now() + wait; setTimeout(() => this.connect(kind, url, retryMs), wait);
    });
    ws.on('error', (e) => { st.lastError = e.message; });
  }
}
