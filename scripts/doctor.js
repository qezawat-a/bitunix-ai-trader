/**
 * Pre-flight check: verifies env, Neon, Bitunix REST auth, AI providers and
 * Telegram before you let the agent touch a live account.
 *
 *   npm run doctor
 */
import 'dotenv/config';
import { config } from '../src/config.js';
import { pool, migrate, seedSettings, loadSettings } from '../src/db/index.js';
import bitunix from '../src/exchange/bitunix.js';
import ai from '../src/ai/providers.js';
import { runAll } from '../src/strategies/index.js';
import * as I from '../src/strategies/indicators.js';

const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m) => console.log(`  ❌ ${m}`);
const warn = (m) => console.log(`  ⚠️  ${m}`);
let failures = 0;

async function step(title, fn) {
  console.log(`\n${title}`);
  try { await fn(); } catch (e) { bad(e.message); failures++; }
}

console.log('🩺 Bitunix AI Trader — doctor\n══════════════════════════════');

await step('1. Environment', async () => {
  const req = {
    BITUNIX_API_KEY: config.bitunix.key,
    BITUNIX_API_SECRET: config.bitunix.secret,
    DATABASE_URL: config.db.url,
    TELEGRAM_BOT_TOKEN: config.telegram.token,
  };
  for (const [k, v] of Object.entries(req)) v ? ok(k) : (bad(`${k} missing`), failures++);
  const keys = ['openai', 'gemini', 'anthropic'].filter((p) => config.ai[p].key);
  keys.length ? ok(`AI keys: ${keys.join(', ')}`) : (bad('no AI key'), failures++);
  config.telegram.allowed.length
    ? ok(`allowed chats: ${config.telegram.allowed.join(', ')}`)
    : warn('TELEGRAM_ALLOWED_CHAT_IDS empty — anyone can command the agent');
});

await step('2. Neon database', async () => {
  await migrate(); ok('schema applied');
  const s = await seedSettings(); ok(`${Object.keys(s).length} settings`);
  await loadSettings(); ok('settings loaded');
});

await step('3. Bitunix public API', async () => {
  const pairs = await bitunix.getTradingPairs();
  ok(`${pairs.length} trading pairs`);
  const t = await bitunix.getTickers('BTCUSDT');
  const tk = Array.isArray(t) ? t[0] : t;
  if (!tk?.markPrice) throw new Error('ticker payload missing markPrice');
  ok(`BTCUSDT mark ${tk.markPrice}`);
  const k = await bitunix.getKline({ symbol: 'BTCUSDT', interval: '15m', limit: 200 });
  ok(`${k.length} candles`);
  const d = await bitunix.getDepth('BTCUSDT', 5);
  ok(`depth ${d.bids.length} bids / ${d.asks.length} asks`);
  const f = await bitunix.getFundingRate('BTCUSDT');
  ok(`funding ${(Number(f.fundingRate) * 100).toFixed(4)}% every ${f.fundingInterval}h`);
});

await step('4. Bitunix signed API', async () => {
  const acc = await bitunix.getAccount();
  const a = Array.isArray(acc) ? acc[0] : acc;
  ok(`available ${a.available} ${a.marginCoin}, mode ${a.positionMode}`);
  const pos = await bitunix.getPendingPositions();
  ok(`${(pos || []).length} open positions`);
  const orders = await bitunix.getPendingOrders({ limit: 5 });
  ok(`${orders?.orderList?.length ?? 0} pending orders`);
});

await step('5. Strategy engine', async () => {
  const raw = await bitunix.getKline({ symbol: 'BTCUSDT', interval: '15m', limit: 200 });
  const candles = raw.map((c) => ({
    time: Number(c.time), open: +c.open, high: +c.high, low: +c.low, close: +c.close,
    volume: +(c.baseVol || 0),
  })).sort((a, b) => a.time - b.time);
  const depth = await bitunix.getDepth('BTCUSDT', 15);
  const fr = await bitunix.getFundingRate('BTCUSDT');
  const reg = I.regime(candles);
  ok(`regime ${reg.regime} (ADX ${reg.adx.toFixed(1)}, ATR ${reg.atrPct.toFixed(2)}%)`);
  for (const r of runAll(candles, { depth, funding: fr })) {
    console.log(`     ${r.side ? (r.side === 'LONG' ? '↑' : '↓') : '·'} ${r.name.padEnd(20)} ${r.side ? `${Math.round(r.confidence)}%` : '  —'}  ${r.notes[0] || ''}`);
  }
});

await step('6. AI providers', async () => {
  const st = await ai.refreshModels();
  for (const p of st) {
    ok(`${p.provider}: ${p.model}${p.pinned ? ' (pinned)' : ''}`);
    if (p.rejected?.length) warn(`   your key cannot call: ${p.rejected.join(', ')}`);
  }
  const r = await ai.chat({
    messages: [{ role: 'user', content: 'Reply with exactly: READY' }],
    thinking: 'off', maxTokens: 32,
  });
  r.content.includes('READY') ? ok(`${r.provider}/${r.model} responded`) : warn(`unexpected: ${r.content}`);

  // tool calling is mandatory — the agent is useless without it
  const t = await ai.chat({
    messages: [{ role: 'user', content: 'Call the ping tool with ok=true.' }],
    tools: [{ name: 'ping', description: 'readiness check',
      parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } }],
    thinking: 'off', maxTokens: 128,
  });
  t.toolCalls?.length
    ? ok(`${t.model} supports tool calling`)
    : warn(`${t.model} did not emit a tool call — pin a stronger model with /models set`);
});

await step('7. Telegram', async () => {
  const res = await fetch(`https://api.telegram.org/bot${config.telegram.token}/getMe`);
  const j = await res.json();
  if (!j.ok) throw new Error(j.description);
  ok(`@${j.result.username}`);
});

console.log(`\n══════════════════════════════`);
console.log(failures ? `❌ ${failures} problem(s) — fix before going live` : '✅ All checks passed — safe to start');
await pool.end();
process.exit(failures ? 1 : 0);
