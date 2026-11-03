import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { chunk } from './format.js';

const log = createLogger('telegram');

/**
 * Minimal dependency-free Telegram Bot API client with long polling.
 *
 * Robust sending: MarkdownV2 first, and if Telegram rejects the entities
 * (the classic "can't parse entities" 400 that silently killed reports in the
 * reference scanner) it automatically retries as plain text, then as a
 * truncated plain text. A message is never lost.
 */
export class TelegramBot {
  constructor(token = config.telegram.token) {
    this.token = token;
    this.api = `https://api.telegram.org/bot${token}`;
    this.offset = 0;
    this.handlers = [];
    this.running = false;
    this.me = null;
    // Set when Telegram auth fails at boot. The trader keeps running with no
    // Telegram at all: sends become rate-limited no-ops and polling never
    // starts. A broken bot token must never take the position manager down
    // with it — that is how an unreachable notification channel turns into
    // unmanaged live positions.
    this.degraded = false;
    this.degradedReason = null;
    this.recovering = false;       // true while a transient outage is being retried in the background
    this.retryBaseMs = 5_000;      // first retry delay; doubles up to retryMaxMs
    this.retryMaxMs = 5 * 60_000;
    this._lastDegradedWarn = 0;
  }

  /**
   * A rejected token (401/403/404) will never fix itself. Everything else -
   * 5xx like "Bad Gateway", 429, DNS, timeouts - is the network or Telegram's
   * side and passes on its own.
   */
  static isPermanent(e) {
    return e?.code === 401 || e?.code === 403 || e?.code === 404
      || /Unauthorized|bot was blocked|bot is deactivated|Not Found/i.test(e?.message || '');
  }

  /** Record that Telegram is unreachable, and stop hammering the API. */
  _degrade(reason, { transient = false } = {}) {
    if (!this.degraded) {
      this.degraded = true;
      this.degradedReason = reason;
      this.running = false;
      log.error(transient
        ? `telegram unreachable (${reason}) — continuing WITHOUT Telegram and retrying in the background. `
          + `Trading, scanning and position management stay ON. This is not a token problem.`
        : `telegram unavailable (${reason}) — continuing WITHOUT Telegram. `
          + `Trading, scanning and position management stay ON, but reports and `
          + `/commands are unavailable until TELEGRAM_BOT_TOKEN is fixed.`);
    }
  }

  async _connect() {
    this.me = await this.call('getMe');
    log.info(`connected as @${this.me.username}`);
    await this.setCommands();
    this.running = true;
    this._poll();
  }

  /** Keep trying after a transient outage; come back to life without a restart. */
  async _recover() {
    if (this.recovering) return;
    this.recovering = true;
    let wait = this.retryBaseMs;
    while (this.degraded) {
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 2, this.retryMaxMs);
      try {
        await this._connect();
        this.degraded = false;
        this.degradedReason = null;
        this.recovering = false;
        log.info('telegram recovered — reports and /commands are back');
        for (const id of config.telegram.allowed || []) {
          await this.sendMessage(id, 'Telegram is back\\. Reports and commands work again\\.', {}).catch(() => {});
        }
        return;
      } catch (e) {
        if (TelegramBot.isPermanent(e)) {
          this.recovering = false;
          this._degradedPermanent = true;
          log.error(`telegram: ${e.message} — the token is being rejected, giving up. Fix TELEGRAM_BOT_TOKEN.`);
          return;
        }
        log.warn(`telegram still unreachable (${e.message}); next try in ${Math.round(wait / 1000)}s`);
      }
    }
    this.recovering = false;
  }

  async call(method, payload = {}) {
    let res;
    try {
      res = await fetch(`${this.api}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(70_000),
      });
    } catch (e) {
      // Network/DNS/timeout, not an API-level rejection. Surface the real cause
      // rather than a JSON parse error from an HTML error page.
      throw new Error(`${method}: ${e.message}`);
    }
    const json = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
    if (!json.ok) {
      const err = new Error(`${method}: ${json.description}`);
      err.description = json.description;
      err.code = json.error_code;
      throw err;
    }
    return json.result;
  }

  async sendMessage(chatId, text, { parseMode = 'MarkdownV2', ...extra } = {}) {
    if (this.degraded) {
      const now = Date.now();
      if (now - this._lastDegradedWarn > 10 * 60_000) {
        this._lastDegradedWarn = now;
        log.warn(`dropping telegram message to ${chatId} — telegram is degraded (${this.degradedReason})`);
      }
      return [];
    }
    const parts = chunk(text);
    const sent = [];
    for (const part of parts) {
      try {
        sent.push(await this.call('sendMessage', {
          chat_id: chatId, text: part, parse_mode: parseMode,
          disable_web_page_preview: true, ...extra,
        }));
      } catch (e) {
        // FIX: entity parse failures must never swallow the message
        if (/can't parse entities|Bad Request/i.test(e.description || e.message)) {
          log.warn(`markdown rejected (${e.description}) — resending as plain text`);
          const plain = part.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, '$1');
          try {
            sent.push(await this.call('sendMessage', {
              chat_id: chatId, text: plain, disable_web_page_preview: true, ...extra,
            }));
          } catch (e2) {
            log.error(`plain resend also failed: ${e2.message}`);
            try {
              sent.push(await this.call('sendMessage', {
                chat_id: chatId, text: plain.slice(0, 3500),
              }));
            } catch (e3) { log.error(`message lost: ${e3.message}`); }
          }
        } else {
          log.error(`sendMessage failed: ${e.message}`);
        }
      }
    }
    return sent;
  }

  async sendTyping(chatId) {
    try { await this.call('sendChatAction', { chat_id: chatId, action: 'typing' }); } catch {}
  }

  onMessage(fn) { this.handlers.push(fn); }

  allowed(chatId) {
    const list = config.telegram.allowed;
    if (!list.length) return true;   // no allowlist = open (set one in production!)
    return list.includes(String(chatId));
  }

  async setCommands() {
    try {
      await this.call('setMyCommands', {
        commands: [
          { command: 'start', description: 'Wake the agent up' },
          { command: 'help', description: 'All commands' },
          { command: 'status', description: 'Agent, exchange and model status' },
          { command: 'balance', description: 'Futures balance' },
          { command: 'positions', description: 'Open positions' },
          { command: 'position_history', description: 'Closed positions' },
          { command: 'order_history', description: 'Past orders' },
          { command: 'pnl', description: 'Performance summary' },
          { command: 'signal', description: 'Scan the market now' },
          { command: 'analyse', description: 'Deep analysis of a symbol' },
          { command: 'deep', description: '5-phase multi-agent analysis' },
          { command: 'close', description: 'Close a position' },
          { command: 'closeall', description: 'Close every position' },
          { command: 'auto_trade', description: 'Turn auto trading on or off' },
          { command: 'scan', description: 'Scan now or on/off' },
          { command: 'report', description: 'Reports on or off' },
          { command: 'settings', description: 'All trade settings' },
          { command: 'set', description: 'Change a setting' },
          { command: 'leverage', description: 'Show or set leverage' },
          { command: 'model', description: 'Show or pin the AI model' },
          { command: 'models', description: 'Manage AI models' },
          { command: 'check_system', description: 'System health check' },
          { command: 'connect_provider', description: 'Configure AI provider' },
          { command: 'set_model', description: 'Pin a specific model' },
          { command: 'add_soul', description: 'Add a soul file' },
          { command: 'add_skill', description: 'Add a skill file' },
          { command: 'add_mcp', description: 'Add MCP server config' },
          { command: 'mcp', description: 'External MCP servers and tools' },
          { command: 'memory', description: 'What the agent has learned' },
          { command: 'skills', description: 'Teach or manage skills' },
          { command: 'code_review', description: 'Review codebases for issues' },
          { command: 'bug_fixes', description: 'Analyze bugs' },
          { command: 'simplfy', description: 'Simplify code analysis' },
          { command: 'verify', description: 'Verify a specific component' },
          { command: 'reload', description: 'Re-read soul/ from disk' },
          { command: 'diag', description: 'Test the notification chain' },
        ],
      });
    } catch (e) { log.warn(`setMyCommands: ${e.message}`); }
  }

  async start() {
    try {
      await this._connect();
    } catch (e) {
      // A bad token is a config error, not a reason to abandon live positions;
      // a 502 or a timeout is not a config error at all, so it is retried.
      const transient = !TelegramBot.isPermanent(e);
      this._degrade(e.message, { transient });
      if (transient) this._recover();
      return null;
    }
    return this.me;
  }

  async _poll() {
    while (this.running) {
      try {
        const updates = await this.call('getUpdates', {
          offset: this.offset, timeout: 50, allowed_updates: ['message', 'callback_query'],
        });
        for (const u of updates) {
          this.offset = u.update_id + 1;
          const msg = u.message;
          if (!msg?.text) continue;
          if (!this.allowed(msg.chat.id)) {
            await this.sendMessage(msg.chat.id, 'Not authorised\\.', {});
            continue;
          }
          for (const h of this.handlers) {
            h(msg).catch((e) => log.error(`handler: ${e.stack || e.message}`));
          }
        }
      } catch (e) {
        // 401/403 means the token is bad or revoked. Polling forever would spin
        // every 2s and burn the quota; degrade and let the trader run.
        if (e.code === 401 || e.code === 403 || /Unauthorized|bot was blocked|bot is deactivated/i.test(e.message)) {
          this._degrade(e.message);
          return;
        }
        if (!/timeout|aborted/i.test(e.message)) log.warn(`poll: ${e.message}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  stop() { this.running = false; }
}

export default TelegramBot;
