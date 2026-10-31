/** Real scan/report loops and Telegram commands, with only external I/O stubbed. */
import assert from 'node:assert/strict';
import bitunix from '../src/exchange/bitunix.js';
import { pool, loadSettings } from '../src/db/index.js';
import { resetKlineCache } from '../src/scanner/scanner.js';
import Orchestrator from '../src/orchestrator.js';
import { createCommandHandler } from '../src/telegram/commands.js';

// Never connect to an operator's exchange, database, or AI provider.
globalThis.fetch = async () => { throw new Error('unexpected network request in test'); };
const values = {
  symbols: 'WUSDT', timeframes: '1m,3m,5m,15m', auto_trade: false,
  reversal_enabled: false, min_agreement: 3, min_confidence: 80,
  tf_min_confidence: 60, signal_confirm_scans: 1, report_interval_sec: 60,
};
pool.query = async (sql) => {
  if (sql.includes('SELECT key, value FROM agent_settings')) {
    return { rows: Object.entries(values).map(([key, value]) => ({ key, value })) };
  }
  if (sql.includes('AS trades')) return { rows: [{ trades: 0, wins: 0, losses: 0, pnl: 0 }] };
  if (sql.includes('RETURNING id')) return { rows: [{ id: 1 }] };
  return { rows: [] };
};
await loadSettings();

bitunix.getAccount = async () => [{ available: '100', margin: '0' }];
bitunix.getPendingPositions = async () => [];
bitunix.getTradingPairs = async () => [{ symbol: 'WUSDT', symbolStatus: 'OPEN', quote: 'USDT' }];
bitunix.getDepth = async () => ({ bids: [], asks: [] });
bitunix.getFundingRate = async () => ({ fundingRate: 0.01 });
bitunix.getKline = async ({ interval, limit, endTime = Infinity }) => {
  const step = Number(interval.replace('m', '')) * 60_000;
  return Array.from({ length: 400 }, (_, i) => ({
    time: 1_700_000_000_000 + i * step,
    open: 1, high: 1.01, low: 0.99, close: 1, baseVol: 100,
  })).filter((c) => c.time <= endTime).slice(-limit);
};

const sent = [];
const bot = {
  sendMessage: async (chatId, text) => { sent.push(text); return [{ message_id: sent.length }]; },
  sendTyping: async () => {},
};
const runtime = new Orchestrator({ bot, chatIds: ['123'] });
runtime.running = true; // Drive passes explicitly, with no timers or trading.
const handle = createCommandHandler({ bot, orchestrator: runtime });
const plain = (text) => text.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, '$1');
const command = async (text) => {
  sent.length = 0;
  await handle({ chat: { id: 123 }, text });
  return plain(sent.at(-1) || '');
};

await runtime.scanLoop();
assert.equal(runtime.stats.scans, 1);
assert.ok(runtime.lastScanAt);
assert.equal(runtime.lastScanError, null);
assert.deepEqual(runtime.lastSignals, [], 'flat candles produce no candidate, but the scan completes');
console.log('ok: WUSDT scan completes even when no strategy votes');

sent.length = 0;
await runtime.reportLoop();
await runtime.reportLoop();
assert.equal(sent.length, 2, 'quiet passes must not be throttled to a 15-minute heartbeat');
assert.match(plain(sent[1]), /no signals this cycle/);
assert.match(plain(sent[1]), /Completed scans: 1/);
assert.match(plain(sent[1]), /scope: WUSDT/);
console.log('ok: every enabled report pass sends the quiet scan status');

runtime.lastSignals = [{
  symbol: 'WUSDT', side: 'LONG', confidence: 72, agreement: 3,
  qualified: false, rejectReason: 'confidence 72 < 80',
}];
sent.length = 0;
await runtime.reportLoop();
assert.match(plain(sent[0]), /Watchlist/);
assert.match(plain(sent[0]), /WUSDT LONG 72% — confidence 72 < 80/);
console.log('ok: rejected candidates reach Telegram without an open position');

await command('/report off');
assert.match(await command('/report'), /Reports: OFF/);
sent.length = 0;
await runtime.reportLoop();
assert.equal(sent.length, 0);
await command('/report on');
sent.length = 0;
await runtime.reportLoop();
assert.equal(sent.length, 1);
console.log('ok: report switch displays its real state and controls periodic delivery');

await command('/scan off');
await runtime.scanLoop();
assert.equal(runtime.stats.scans, 1);
assert.match(await command('/status'), /Scanner: OFF · reports: ON · scope: WUSDT/);
assert.match(await command('/scan'), /Completed scans: 1/);
await command('/scan on');
console.log('ok: scan switch and progress are visible independently of auto_trade');

bitunix.getTradingPairs = async () => [];
await assert.rejects(runtime.scanLoop(), /No tradable symbols matched WUSDT/);
assert.equal(runtime.stats.scans, 1, 'empty universe is not counted as a completed scan');
assert.match(await command('/status'), /No tradable symbols matched WUSDT/);
console.log('ok: a filtered-out symbol reports an error instead of silently scanning nothing');

bitunix.getTradingPairs = async () => [{ symbol: 'WUSDT', symbolStatus: 'OPEN', quote: 'USDT' }];
const candles = bitunix.getKline;
bitunix.getKline = async () => { throw new Error('candles unavailable'); };
resetKlineCache();
await assert.rejects(runtime.scanLoop(), /Scan failed for all 1 symbols: WUSDT: 1m: candles unavailable/);
assert.equal(runtime.stats.scans, 1);
sent.length = 0;
await runtime.reportLoop();
assert.match(plain(sent[0]), /Last scan-cycle error: Scan failed/);
assert.match(plain(sent[0]), /last completed scan/, 'old candidates must be labelled as last completed results');
console.log('ok: total candle failures remain visible in periodic reports');

bitunix.getKline = candles;
await runtime.scanLoop();
assert.equal(runtime.stats.scans, 2);
assert.equal(runtime.lastScanError, null);
runtime.running = false;
assert.match(await command('/report'), /Reports: stopped/);
assert.match(await command('/scan'), /Scanner: stopped/);
console.log('ok: recovery clears the scan error; stopped loops are not displayed as running');

await pool.end();
console.log('scan/report regression checks passed');
