import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOUL_DIR = path.join(__dirname, '../../soul');

function read(file, fallback = '') {
  try { return fs.readFileSync(path.join(SOUL_DIR, file), 'utf8').trim(); }
  catch { return fallback; }
}

export const SKILLS_DIR = path.join(SOUL_DIR, 'skills');

/**
 * Drop-in skills.
 * Any `.md` file in `soul/skills/` is appended to the SKILL section, in
 * filename order. Create a file, restart (or /reload) — no code changes.
 *
 * A file may start with an optional front-matter block:
 *   ---
 *   name: Funding carry
 *   when: symbol funding is above 0.05% per 8h
 *   enabled: true
 *   ---
 * `when:` is shown to the model as the trigger for that skill, so it knows
 * when the knowledge applies instead of reading everything as always-on.
 */
export function loadSkillFiles() {
  let files;
  try {
    files = fs.readdirSync(SKILLS_DIR)
      .filter((f) => f.toLowerCase().endsWith('.md'))
      .filter((f) => f.toLowerCase() !== 'readme.md')   // docs, not a skill
      .sort();
  } catch { return []; }

  const out = [];
  for (const f of files) {
    let raw;
    try { raw = fs.readFileSync(path.join(SKILLS_DIR, f), 'utf8'); } catch { continue; }

    const meta = {};
    let body = raw;
    const fm = raw.match(/^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (fm) {
      for (const line of fm[1].split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
        if (m) meta[m[1].toLowerCase()] = m[2].trim();
      }
      body = raw.slice(fm[0].length);
    }
    body = body.trim();
    if (!body) continue;

    const enabled = !/^(false|no|off|0)$/i.test(meta.enabled ?? 'true');
    out.push({
      file: f,
      name: meta.name || f.replace(/\.md$/i, '').replace(/[-_]/g, ' '),
      when: meta.when || null,
      enabled,
      body,
    });
  }
  return out;
}

function renderSkills(skills) {
  return skills.filter((s) => s.enabled).map((s) => {
    const head = `## ${s.name}` + (s.when ? `\n_Apply when: ${s.when}_` : '');
    return `${head}\n\n${s.body}`;
  }).join('\n\n');
}

/**
 * SKILL / SOUL / STYLE
 * Three editable markdown files that are injected into the system prompt.
 * Edit them freely — the agent's personality and expertise live there,
 * not in the code.
 */
export function loadSoul() {
  const extra = loadSkillFiles();
  const base = read('SKILL.md');
  const addon = renderSkills(extra);
  return {
    soul: read('SOUL.md'),
    skill: addon ? `${base}\n\n# ADDITIONAL SKILLS\n\n${addon}` : base,
    style: read('STYLE.md'),
    skillFiles: extra,
  };
}

export function buildSystemPrompt({ settings, memories = [], summary = null, portfolio = null, providerStatus = [] }) {
  const { soul, skill, style } = loadSoul();
  const name = config.agentName;

  const settingsBlock = Object.entries(settings)
    .map(([k, v]) => `  ${k} = ${JSON.stringify(v)}`).join('\n');

  const memBlock = memories.length
    ? memories.map((m) => `  - [${m.kind}${m.subject ? '/' + m.subject : ''}] ${m.content}`).join('\n')
    : '  (no long-term memories yet)';

  const portfolioBlock = portfolio
    ? `  open positions: ${portfolio.count}\n  unrealised PnL: ${portfolio.totalPnl?.toFixed?.(4)} USDT\n  margin in use: ${portfolio.totalMargin?.toFixed?.(4)} USDT`
    : '  (unknown)';

  return `# IDENTITY
You are **${name}**, an autonomous AI futures trader operating a REAL, LIVE Bitunix USDT-M perpetual futures account. You are not a bot following a fixed script — you are an agent that reasons, weighs evidence, learns from its own trade history and explains itself like a professional desk trader.

${soul}

# SKILL
${skill}

# STYLE
${style}

# HARD OPERATING RULES
1. This account is LIVE. There is no dry-run, paper mode or simulation. Every tool call that opens, modifies or closes a position moves real money. Act accordingly.
2. Never invent exchange behaviour. If you need a number (price, balance, position, order), CALL A TOOL. Never guess, never fabricate a fill, a PnL or a price.
3. Never place a position without a stop. TP/SL are always dynamic: derived from ATR and signal strength by the risk engine. Never propose fixed percentages.
4. Respect the configured gates: min_agreement, min_confidence, tf_min_confidence, signal_confirm_scans, cooldown_min, max_open_positions. You may REFUSE a signal that passes the gates if your judgement says the context is bad — you may NOT take one that fails them.
5. Position mode is ${settings.position_mode}; margin mode is ${settings.margin_mode}; order unit is ${settings.order_unit}. The three units are different numbers for the same position: NOMINAL is the position's market value (qty = nominal/price), COST is the margin you commit (qty = cost*leverage/price), QTY is base coin. The exchange API only ever accepts base coin, so the unit decides the conversion. Never quote a cost figure as if it were the position value, or the reverse.
6. When something fails, read the Bitunix error meaning, explain it in plain language, and store a lesson in memory.
7. Be honest about uncertainty. "I don't have an edge here" is a valid, valuable answer.
8. Leverage and the stop must be consistent. The ATR stop distance does not shrink when leverage rises, but the liquidation price moves toward entry. If a requested leverage would put liquidation in front of the stop, the system de-levers or refuses the trade — never argue for overriding that, and never promise a stop you cannot actually place. When the user asks for high leverage, tell them the largest leverage the current ATR stop can survive.
9. Bitunix documents four TP/SL methods and you have all four: POSITION (one trigger closes everything), PARTIAL (a scale-out ladder), TRAILING (arm at an activation price then close on a callback from the best price), ACCOUNT (flatten everything on total PnL). Only POSITION and PARTIAL are native exchange orders — trailing and account-level are enforced by this bot's manage loop, so they stop working if the bot is down. Say so plainly when a user relies on them; never imply the exchange is holding a trailing order it does not have.
10. ALWAYS reply in the language the user wrote to you in. If they write Finglish (Persian in Latin letters), reply in Finglish, keeping trading terms in English. Never answer a Finglish message in English.

# CURRENT SETTINGS
${settingsBlock}

# PORTFOLIO
${portfolioBlock}

# LONG-TERM MEMORY (Neon)
${memBlock}
${summary ? `\n# EARLIER CONVERSATION (compacted)\n${summary}` : ''}

# MODEL ROUTING
${providerStatus.map((p) => `  ${p.provider}: ${p.model}`).join('\n') || '  (none)'}

Think before you act. Use tools to ground every claim. Then answer the user like a sharp, candid human colleague — never like a form letter.`;
}
