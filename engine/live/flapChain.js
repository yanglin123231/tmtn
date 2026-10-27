// Flap Agent 曲线：直接订阅链上成交 / 新市场事件，不再依赖第三方 shrine 推送。
// 事件按真实交易核对过（2026-10）：每个 Flap 市场合约都会发一个通用事件，topic0 = 0x0483a030…，
// data = (bytes32 名称, uint256 订单号, address 交易者, address 代币, uint256 数量 A, uint256 数量 B)
//   - virtualBuyFill：A = 付出的报价币，B = 买到的代币
//   - virtualSellFill：A = 拿到的报价币，B = 卖出的代币
//   - virtualMarketCreated：新市场（这里只用来马上刷新一次 Flap 列表）
// 量很小（全网约每小时几十条），按 topic 订阅不加地址过滤。订阅用 NodeReal（多 key）→ publicnode wss；每 60 秒用 getLogs 补查。
import { EventEmitter } from 'node:events';
import { ethers } from 'ethers';
import { NODEREAL_WSS } from './config.js';
import { WsLogs, PUBLIC_WSS } from './rpc.js';

const T_EVENT = '0x0483a030f7f57a91177910ed00ae51f19170eb9db2129394c858e7e3bc188aed';
const coder = ethers.AbiCoder.defaultAbiCoder();
const name32 = (hex) => Buffer.from(hex.slice(2, 66), 'hex').toString().replace(/\0+$/, '');

export class FlapChain extends EventEmitter {
  constructor(provider) {
    super();
    this.provider = provider;   // 补查用：公共节点优先
    this.seen = new Set();
    this.status = { connected: false, wss: null, lastBlock: 0, lastLogAt: 0, trades: 0, lastError: null, pollError: null };
  }

  async start() {
    try { this.status.lastBlock = await this.provider.getBlockNumber(); } catch (e) { this.status.pollError = e.shortMessage || e.message; }
    this.sub = new WsLogs({ label: 'flap', urls: [...NODEREAL_WSS, PUBLIC_WSS], filters: [{ topics: [T_EVENT] }], onLog: (l) => this.handle(l, true), status: this.status }).start();
    this.pollLoop();
  }

  async pollLoop() {
    for (;;) {
      await new Promise((r) => setTimeout(r, this.sub?.live ? 60_000 : 3_000));
      try {
        const head = await this.provider.getBlockNumber();
        let from = Math.max(this.status.lastBlock + 1, head - 20_000);
        while (from <= head) {
          const to = Math.min(head, from + 1999);
          for (const l of await this.provider.getLogs({ topics: [T_EVENT], fromBlock: from, toBlock: to })) this.handle(l, false);
          this.status.lastBlock = to; from = to + 1;
        }
        this.status.pollError = null;
      } catch (e) { this.status.pollError = e.shortMessage || e.message; }
    }
  }

  handle(log, live) {
    const id = `${log.transactionHash}:${log.index}`; if (this.seen.has(id)) return; this.seen.add(id);
    if (this.seen.size > 20_000) this.seen = new Set([...this.seen].slice(-10_000));
    this.status.lastBlock = Math.max(this.status.lastBlock, log.blockNumber || 0);
    const kind = name32(log.data);
    if (kind === 'virtualMarketCreated') return this.emit('created', { block: log.blockNumber, tx: log.transactionHash });
    if (kind !== 'virtualBuyFill' && kind !== 'virtualSellFill') return;
    let d; try { d = coder.decode(['bytes32', 'uint256', 'address', 'address', 'uint256', 'uint256'], log.data); } catch { return; }
    const quote = Number(ethers.formatEther(d[4])), tokens = Number(ethers.formatEther(d[5]));
    if (!(tokens > 0)) return;
    this.status.trades++;
    this.emit('trade', { token: d[3].toLowerCase(), trader: d[2].toLowerCase(), side: kind === 'virtualBuyFill' ? 'buy' : 'sell', bnb: quote, tokens, price: quote / tokens, tx: log.transactionHash, block: log.blockNumber, ts: live ? Date.now() : null }, { live });
  }
}
