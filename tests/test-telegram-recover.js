/**
 * A transient Telegram failure at boot (502 Bad Gateway, timeout) must not leave
 * the bot headless for the life of the process; a rejected token must not retry.
 */
import { TelegramBot } from '../src/telegram/bot.js';

let passed = 0, failed = 0;
const ok = (c, m) => { c ? (passed++, console.log(`  ok  ${m}`)) : (failed++, console.log(`  FAIL ${m}`)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const err = (code, description) => Object.assign(new Error(`getMe: ${description}`), { code, description });

ok(TelegramBot.isPermanent(err(401, 'Unauthorized')), '401 is permanent');
ok(TelegramBot.isPermanent(err(404, 'Not Found')), '404 (malformed token) is permanent');
ok(!TelegramBot.isPermanent(err(502, 'Bad Gateway')), '502 Bad Gateway is transient');
ok(!TelegramBot.isPermanent(new Error('getMe: fetch failed')), 'a network error is transient');
ok(!TelegramBot.isPermanent(err(429, 'Too Many Requests')), '429 is transient');

// transient at boot, fine on the 3rd try
{
  const bot = new TelegramBot('123:abc');
  bot.retryBaseMs = 5; bot.retryMaxMs = 10;
  let tries = 0;
  bot.call = async (method) => {
    if (method === 'getMe') { tries += 1; if (tries < 3) throw err(502, 'Bad Gateway'); return { username: 'testbot' }; }
    if (method === 'getUpdates') { await sleep(20); return []; }
    return {};
  };
  const me = await bot.start();
  ok(me === null && bot.degraded === true && bot.recovering === true, 'a 502 at boot degrades but keeps retrying');
  await sleep(120);
  ok(bot.degraded === false && bot.me?.username === 'testbot' && tries === 3, 'it reconnects by itself after the outage');
  bot.running = false;
}

// rejected token: no retry loop
{
  const bot = new TelegramBot('bad');
  bot.retryBaseMs = 5;
  let tries = 0;
  bot.call = async () => { tries += 1; throw err(401, 'Unauthorized'); };
  await bot.start();
  await sleep(40);
  ok(bot.degraded === true && bot.recovering === false && tries === 1, 'a rejected token degrades once and does not retry');
}

console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
