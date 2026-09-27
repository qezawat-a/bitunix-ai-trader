import { createLogger } from './logger.js';
import { config } from './config.js';
import * as db from './db/index.js';
import agent from './ai/agent.js';
import ai from './ai/providers.js';
import { scan } from './scanner/scanner.js';
import { openFromSignal, reverse, availableBalance } from './trading/executor.js';
import { manageOpenPositions, checkReversal, portfolioSnapshot } from './trading/manager.js';
import { formatSignal, formatFill, formatReport, agentText, mdt, italic } from './telegram/format.js';

const log = createLogger('orchestrator');

/**
 * The runtime. Five independent loops, each on its own configurable interval:
 *
 *   scan      (scan_interval_sec)        find signals, let the agent judge, execute
 *   manage    (manage_interval_sec)      mid-position management
 *   guard     (guard_interval_sec)       protection: TP/SL, breakeven, trailing
 *   report    (report_interval_sec)      push signals + PnL to Telegram
 *   autonomous(agent_autonomous_sec)     free-running agent initiative
 *
 * Every loop is self-rescheduling, so changing an interval with /set takes
 * effect on the next tick without a restart.
 */
export class Orchestrator {
  constructor({ bot, chatIds }) {
    this.bot = bot;
    this.chatIds = chatIds;
    this.timers = {};
    this.running = false;
    this.lastSignals = [];
    this.inFlight = new Set();
    this.stats = { scans: 0, signals: 0, trades: 0, reversals: 0, errors: 0, startedAt: Date.now() };
  }

  async notify(text) {
    for (const id of this.chatIds) {
      try { await this.bot.sendMessage(id, text); } catch (e) { log.warn(`notify: ${e.message}`); }
    }
  }

  start() {
    this.running = true;
    this._schedule('scan', 'scan_interval_sec', () => this.scanLoop());
    this._schedule('manage', 'manage_interval_sec', () => this.manageLoop());
    this._schedule('guard', 'guard_interval_sec', () => this.guardLoop());
    this._schedule('report', 'report_interval_sec', () => this.reportLoop());
    this._schedule('autonomous', 'agent_autonomous_sec', () => this.autonomousLoop());
    log.info('all loops started');
  }

  /**
   * A loop must never die. Exchange outages, auth failures and AI hiccups are
   * caught, counted and (after a few repeats) reported to Telegram once —
   * then the loop keeps running with exponential backoff until it recovers.
   */
  _schedule(name, settingKey, fn) {
    this.failures = this.failures || {};
    this.failures[name] = { count: 0, notified: false, lastError: null };

    const tick = async () => {
      if (!this.running) return;
      if (this.inFlight.has(name)) { this._arm(name, settingKey, tick); return; }
      this.inFlight.add(name);
      const f = this.failures[name];
      try {
        await fn();
        if (f.count) {
          log.info(`${name} loop recovered after ${f.count} failure(s)`);
          if (f.notified) await this.notify(mdt`✅ ${name} loop recovered.`).catch(() => {});
        }
        f.count = 0; f.notified = false; f.lastError = null;
      } catch (e) {
        this.stats.errors++;
        f.count++; f.lastError = e.message;
        log.error(`${name} loop (fail #${f.count}): ${e.stack || e.message}`);
        // tell the user once, after it is clearly not a one-off blip
        if (f.count === 3 && !f.notified) {
          f.notified = true;
          await this.notify([
            mdt`⚠️ ${name} loop is failing (${f.count}x in a row)`,
            mdt`${e.message}`,
            italic('I will keep retrying with backoff.'),
          ].join('\n')).catch(() => {});
        }
        try { await db.logEvent('loop_error', { loop: name, error: e.message, count: f.count }); } catch {}
      } finally {
        this.inFlight.delete(name);
        this._arm(name, settingKey, tick);
      }
    };
    this._arm(name, settingKey, tick);
  }

  _arm(name, settingKey, tick) {
    if (!this.running) return;
    const base = Math.max(3, Number(db.settings()[settingKey] || 15));
    const fails = this.failures?.[name]?.count || 0;
    // back off up to 8x the configured interval while the loop is broken
    const sec = fails ? Math.min(base * Math.min(2 ** fails, 8), 300) : base;
    clearTimeout(this.timers[name]);
    this.timers[name] = setTimeout(tick, sec * 1000);
  }

  rescheduleLoops() { log.info('intervals reloaded'); }

  // ----------------------------------------------------------------- loops

  async scanLoop() {
    const s = db.settings();
    const signals = await scan();
    this.lastSignals = signals;
    this.stats.scans++;

    const qualified = signals.filter((x) => x.qualified);
    if (!qualified.length) return;
    this.stats.signals += qualified.length;

    // --- reversals first: an opposite high-conviction signal on an open position
    //
    // A reversal CLOSES a position and OPENS the opposite one, so it is an
    // entry, not a protective exit. It must obey auto_trade like any other
    // entry. This used to run before the auto_trade gate below, which meant
    // the bot flipped live positions while telling the user it was only
    // analysing — the contradiction was real, and it was this.
    if (s.reversal_enabled && s.auto_trade) {
      let reversals = [];
      try { reversals = await checkReversal(qualified); }
      catch (e) { log.warn(`reversal check unavailable: ${e.message}`); }
      for (const { position, signal } of reversals) {
        await this.notify([
          mdt`🔄 REVERSAL — ${signal.symbol}`,
          mdt`${position.side} → ${signal.side} at ${signal.confidence}% (${signal.agreement}/6), threshold ${s.reversal_confidence}%`,
        ].join('\n'));
        const verdict = await agent.judgeSignal(signal);
        if (!verdict.take) {
          await this.notify(mdt`↩️ reversal skipped — ${verdict.reasoning}`);
          continue;
        }
        const r = await reverse(position, signal, verdict);
        this.stats.reversals++;
        await this.notify(r.ok ? formatFill(r) : mdt`❌ reversal failed: ${r.reason}`);
      }
    }

    if (!s.auto_trade) {
      if (s.reversal_enabled) {
        let pending = [];
        try { pending = await checkReversal(qualified); }
        catch { /* reporting only; never let this break the scan */ }
        for (const { position, signal } of pending) {
          await this.notify([
            mdt`🔄 REVERSAL SIGNAL — ${signal.symbol}`,
            mdt`${position.side} → ${signal.side} at ${signal.confidence}% (${signal.agreement}/6)`,
            italic('auto trade is OFF — the position was NOT flipped'),
          ].join('\n'));
        }
      }
      for (const sig of qualified.slice(0, 3)) {
        await this.notify(formatSignal(sig) + '\n' + italic('auto trade is OFF — not executing'));
      }
      return;
    }

    // Below the floor there is not enough margin to open anything, so every
    // signal would cost a full agent cycle and an order that the exchange
    // rejects. Stop at the gate instead, and say it once — the balance is a
    // standing condition, not news that needs repeating every scan.
    const floor = Number(s.min_account_balance_usdt ?? 5);
    if (floor > 0) {
      let avail = null;
      try { avail = (await availableBalance())?.available; } catch { /* keep going */ }
      if (avail != null && Number(avail) < floor) {
        if (this._balanceFloorNotified !== true) {
          this._balanceFloorNotified = true;
          await this.notify(
            mdt`⏸ Entries paused — available balance ${Number(avail).toFixed(2)} USDT is below min_account_balance_usdt (${floor}).`
            + '\n' + italic('Scanning and position management continue. This will not be repeated.'),
          );
        }
        return;
      }
      if (avail != null && this._balanceFloorNotified) {
        this._balanceFloorNotified = false;
        await this.notify(mdt`▶️ Entries resumed — balance ${Number(avail).toFixed(2)} USDT is above the ${floor} USDT floor.`);
      }
    }

    // --- the agent is the final gate on every qualified signal
    let snap;
    try { snap = await portfolioSnapshot(); }
    catch (e) { log.warn(`cannot read positions, skipping entries this cycle: ${e.message}`); return; }
    let slots = Number(s.max_open_positions) - snap.count;
    if (slots <= 0) return;

    for (const sig of qualified) {
      if (slots <= 0) break;
      if (snap.positions.some((p) => p.symbol === sig.symbol)) continue;

      await this.notify(formatSignal(sig));
      const verdict = await agent.judgeSignal(sig);
      await db.logEvent('ai_verdict', {
        symbol: sig.symbol, side: sig.side, take: verdict.take, reasoning: verdict.reasoning,
      }, sig.symbol);

      if (!verdict.take) {
        await this.notify(mdt`🤔 skipping ${sig.symbol} — ${verdict.reasoning}`);
        continue;
      }

      const r = await openFromSignal(sig, { aiVerdict: verdict, marginOverride: verdict.marginUsdt });
      if (r.ok) {
        this.stats.trades++; slots--;
        await this.notify(formatFill(r) + '\n' + italic(verdict.reasoning || ''));
      } else {
        await this.notify(mdt`❌ ${sig.symbol}: ${r.reason}`);
      }
    }
  }

  async manageLoop() {
    // mid-position management: book closures, keep protection in sync
    await manageOpenPositions({ notify: (t) => this.notify(t) });
  }

  async guardLoop() {
    // dedicated protection pass (breakeven / trailing), cheap and frequent
    const { positions, actions } = await manageOpenPositions();
    for (const a of actions) {
      if (a.type === 'stop_moved') {
        log.info(`guard: ${a.symbol} stop -> ${a.stop} (${a.reason})`);
      }
    }
    return positions;
  }

  async reportLoop() {
    // A failed read must never be rendered as a zero: "0 positions" and
    // "I could not reach the exchange" mean opposite things to a trader.
    const [snapshot, balance, stats] = await Promise.all([
      portfolioSnapshot().catch((e) => ({ unreadable: e.message, count: 0, totalPnl: 0, totalMargin: 0, roi: 0, positions: [] })),
      availableBalance().catch((e) => ({ unreadable: e.message, available: 0, margin: 0, frozen: 0, bonus: 0, unrealized: 0 })),
      db.tradeStats(7).catch(() => null),
    ]);
    const unreadable = snapshot.unreadable || balance.unreadable;
    if (unreadable) {
      // Announce once, not every report interval: an unreachable account is a
      // standing condition too, and repeating it turns a real alarm into
      // wallpaper. Re-announced only if the error itself changes.
      if (this._unreadable !== unreadable) {
        this._unreadable = unreadable;
        await this.notify([
          mdt`⚠️ Cannot read the account — reporting paused rather than showing zeros.`,
          mdt`${unreadable}`,
          italic('This will not be repeated until it changes or recovers.'),
        ].join('\n'));
      }
      return;
    }
    if (this._unreadable) {
      this._unreadable = null;
      await this.notify(mdt`✅ Account readable again — reporting resumed.`);
    }
    // Stay quiet when there is genuinely nothing to say — but not SILENT.
    // With no positions and no qualified signals this returned nothing at all,
    // so an idle bot and a dead bot looked exactly the same from Telegram.
    // Send a compact heartbeat instead, throttled so it cannot become noise.
    const qualified = this.lastSignals.filter((x) => x.qualified);
    if (!snapshot.count && !qualified.length) {
      const every = Math.max(5, Number(db.settings().heartbeat_minutes ?? 15)) * 60_000;
      if (Date.now() - (this._lastHeartbeat || 0) < every) return;
      this._lastHeartbeat = Date.now();
      await this.notify(
        mdt`💤 alive · ${this.stats.scans} scans · balance ${Number(balance.available).toFixed(2)} USDT · no positions, no signals`,
      );
      return;
    }
    this._lastHeartbeat = Date.now();
    await this.notify(formatReport({ snapshot, signals: this.lastSignals.slice(0, 6), balance, stats }));
  }

  async autonomousLoop() {
    if (!ai.available) return;
    await agent.autonomousTick({ notify: (t) => this.notify(agentText(t).slice(0, 3500)) });
  }

  stop() {
    this.running = false;
    for (const t of Object.values(this.timers)) clearTimeout(t);
    log.info('loops stopped');
  }
}

export default Orchestrator;
