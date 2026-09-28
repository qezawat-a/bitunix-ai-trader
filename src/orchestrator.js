import { createLogger } from './logger.js';
import { config } from './config.js';
import * as db from './db/index.js';
import agent from './ai/agent.js';
import ai from './ai/providers.js';
import { scan } from './scanner/scanner.js';
import { openFromSignal, reverse, availableBalance } from './trading/executor.js';
import { manageOpenPositions, checkReversal, portfolioSnapshot } from './trading/manager.js';
import { formatSignal, formatFill, formatReport, agentText, mdt, italic } from './telegram/format.js';
import { STRATEGY_COUNT } from './strategies/index.js';
import { dream as dreamCycle, formatDream } from './ai/dream.js';

const log = createLogger('orchestrator');

/**
 * The runtime. Five independent loops, each on its own configurable interval:
 *
 *   scan      (scan_interval_sec)        find signals, let the agent judge, execute
 *   manage    (manage_interval_sec)      mid-position management
 *   guard     (guard_interval_sec)       protection: TP/SL, breakeven, trailing
 *   report    (report_interval_sec)      push signals + PnL to Telegram
 *   autonomous(agent_autonomous_sec)     free-running agent initiative
 *   dream     (dream_interval_hours)      off-hours reflection on own results
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
    // Runtime toggles. Both are deliberately NOT settings: they are the
    // "stop the machine for a minute" switches, where a user wants a switch
    // that takes effect immediately and does not need a schema entry, a
    // validator and a database round trip. /scan and /report drive these.
    this.scanningEnabled = true;
    this.reportsEnabled = true;
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
    this._schedule('report', 'report_interval_sec', () => this.reportLoop());
    this._schedule('autonomous', 'agent_autonomous_sec', () => this.autonomousLoop());
    this._schedule('dream', 'dream_interval_hours', () => this.dreamLoop(), 3600);
    log.info('all loops started');
  }

  /**
   * A loop must never die. Exchange outages, auth failures and AI hiccups are
   * caught, counted and (after a few repeats) reported to Telegram once —
   * then the loop keeps running with exponential backoff until it recovers.
   */
  _schedule(name, settingKey, fn, initialSec = null) {
    this.failures = this.failures || {};
    this.failures[name] = { count: 0, notified: false, lastError: null };

    const tick = async () => {
      if (!this.running) return;
      if (this.inFlight.has(name)) { this._arm(name, settingKey, tick, initialSec); return; }
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
        this._arm(name, settingKey, tick, initialSec);
      }
    };
    this._arm(name, settingKey, tick);
  }

  _arm(name, settingKey, tick, initialSec = null) {
    if (!this.running) return;
    // the merged manage+guard pass runs at the faster of the two intervals
    const s = db.settings();
    const base = Math.max(3, settingKey === 'manage_interval_sec'
      ? Math.min(Number(s.manage_interval_sec || 15), Number(s.guard_interval_sec || 15))
      : Number(s[settingKey] || 15));
    const fails = this.failures?.[name]?.count || 0;
    // back off up to 8x the configured interval while the loop is broken
    const sec = fails ? Math.min(base * Math.min(2 ** fails, 8), 300) : base;
    clearTimeout(this.timers[name]);
    // The first arm uses initialSec when given: the dream loop must not fire an
    // hour after boot by way of a 1-second delay that happens to read "1".
    this.timers[name] = setTimeout(tick, (initialSec ?? sec) * 1000);
  }

  rescheduleLoops() { log.info('intervals reloaded'); }

  // ----------------------------------------------------------------- loops

  async scanLoop() {
    if (!this.scanningEnabled) return;
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
          mdt`${position.side} → ${signal.side} at ${signal.confidence}% (${signal.agreement}/${STRATEGY_COUNT}), threshold ${s.reversal_confidence}%`,
        ].join('\n'));
        const verdict = await agent.judgeSignal(signal);
        if (!verdict.take) {
          await this.notify(verdict.error
            ? mdt`⚠️ ${signal.symbol} reversal: no verdict from the model — left the position alone.`
            : mdt`↩️ reversal skipped — ${verdict.reasoning}`);
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
            mdt`${position.side} → ${signal.side} at ${signal.confidence}% (${signal.agreement}/${STRATEGY_COUNT})`,
            italic('auto trade is OFF — the position was NOT flipped'),
          ].join('\n'));
        }
      }
      for (const sig of qualified.slice(0, 3)) {
        await this.notify(formatSignal(sig) + '\n' + italic('auto trade is OFF — not executing'));
      }
      return;
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
        if (verdict.error) {
          // Not a judgement: the gate could not produce one. Say that, and
          // escalate if it keeps happening — a silently failing gate means the
          // bot stops trading entirely while looking merely cautious.
          await this.notify([
            mdt`⚠️ ${sig.symbol}: no verdict from the model — signal dropped, NOT rejected.`,
            italic(verdict.failures > 1 ? `${verdict.failures} in a row — the AI gate is effectively down.` : 'Retried once already.'),
          ].join('\n'));
          if (verdict.failures === 3) {
            await this.notify([
              mdt`🚨 The AI gate has failed ${verdict.failures} times in a row.`,
              mdt`No signal can be taken while this persists. Check /models and /diag.`,
            ].join('\n'));
          }
        } else {
          await this.notify(mdt`🤔 skipping ${sig.symbol} — ${verdict.reasoning}`);
        }
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

  /**
   * ONE pass does all of it: book closures, attach missing protection, move to
   * breakeven, trail winners, evaluate account-level TP/SL.
   *
   * manage and guard used to be two separate loops calling the SAME function on
   * the SAME schedule (both default 15s), so every pass ran twice: the position
   * scan, the kline fetch for ATR and the pending-TP/SL read were all doubled,
   * and manage notified Telegram while guard stayed silent — the same stop
   * move logged twice and pushed once, which made the guard pass look like
   * extra safety when it was in fact a duplicate of the pass above it.
   *
   * They are now one loop, and the two settings it obeys are still separate
   * (manage_interval_sec, guard_interval_sec): the faster of the two is the
   * cadence, so a user who shortens the protection interval really does get
   * tighter protection.
   */
  async manageLoop() {
    const s = db.settings();
    const { positions, actions } = await manageOpenPositions({
      notify: (t) => this.notify(t),
    });
    for (const a of actions) {
      if (a.type === 'stop_moved') {
        log.info(`guard: ${a.symbol} stop -> ${a.stop} (${a.reason})`);
      }
    }
    return positions;
  }

  async reportLoop() {
    // /report off silences the PERIODIC push only. The degraded-account
    // warning below is deliberately exempt: a bot that has silently lost
    // sight of the account is exactly the failure this project exists to
    // prevent, and the user asked for quiet, not for blindness.
    const quiet = !this.reportsEnabled;

    // A failed read must never be rendered as a zero: "0 positions" and
    // "I could not reach the exchange" mean opposite things to a trader.
    const [snapshot, balance, stats] = await Promise.all([
      portfolioSnapshot().catch((e) => ({ unreadable: e.message, count: 0, totalPnl: 0, totalMargin: 0, roi: 0, positions: [] })),
      availableBalance().catch((e) => ({ unreadable: e.message, available: 0, margin: 0, frozen: 0, bonus: 0, unrealized: 0 })),
      db.tradeStats(7).catch(() => null),
    ]);
    const unreadable = snapshot.unreadable || balance.unreadable;
    if (unreadable) {
      // Do NOT go permanently silent. The first version of this returned
      // early after a single message, so a persistently unreadable account
      // meant the bot never spoke again — which is indistinguishable from
      // being dead, the exact failure this whole path exists to prevent.
      // Announce on change, then keep a slow pulse so it stays visibly alive.
      const every = Math.max(5, Number(db.settings().heartbeat_minutes ?? 15)) * 60_000;
      const changed = this._unreadable !== unreadable;
      if (changed || Date.now() - (this._unreadableAt || 0) > every) {
        this._unreadable = unreadable;
        this._unreadableAt = Date.now();
        await this.notify([
          mdt`⚠️ Cannot read the account — showing no numbers rather than false zeros.`,
          mdt`${unreadable}`,
          italic(changed ? 'Retrying every cycle.' : 'Still failing.'),
        ].join('\n'));
      }
      return;
    }
    if (this._unreadable) {
      this._unreadable = null;
      this._unreadableAt = 0;
      await this.notify(mdt`✅ Account readable again — reporting resumed.`);
    }
    // Stay quiet when there is genuinely nothing to say — but not SILENT.
    // With no positions and no qualified signals this returned nothing at all,
    // so an idle bot and a dead bot looked exactly the same from Telegram.
    // Send a compact heartbeat instead, throttled so it cannot become noise.
    if (quiet) return;
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

  /**
   * Dream. Reflects on its own closed trades and writes consolidated lessons
   * back to long-term memory. It is the only loop that must not run while the
   * machine is busy: dream trades nothing, but it spends a long thinking call,
   * and a reflection that competes with position management for the model is
   * a reflection that gets a worse answer.
   */
  async dreamLoop() {
    const s = db.settings();
    if (!s.dream_enabled || !ai.available) return;
    let busy = null;
    try { busy = Number((await portfolioSnapshot())?.count || 0); } catch { busy = null; }
    if (busy === null) {
      log.warn('dream skipped — could not read the book');
      return;
    }
    if (busy > 0) {
      log.info(`dream skipped — ${busy} position(s) open`);
      return;
    }
    const r = await dreamCycle();
    if (!r.ok) { log.warn(`dream: ${r.reason}`); return; }
    if (r.empty || !r.written) return;    // nothing new is not news
    await this.notify(formatDream(r).slice(0, 3800));
  }

  stop() {
    this.running = false;
    for (const t of Object.values(this.timers)) clearTimeout(t);
    log.info('loops stopped');
  }
}

export default Orchestrator;
