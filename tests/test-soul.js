/** The SOUL must make the operator's words authoritative, not decorative. */
import assert from 'node:assert/strict';
import { buildSystemPrompt, loadSoul } from '../src/ai/soul.js';
import { config } from '../src/config.js';

let passed = 0;
const check = (cond, msg) => { assert.ok(cond, msg); passed++; };

console.log('=== SOUL / system prompt ===\n');

const { soul } = loadSoul();
check(soul.includes('I listen to their words'), 'SOUL has an explicit listen-to-the-operator section');
check(soul.includes('Their explicit instruction is the instruction I execute.'),
  'a direct instruction is what gets executed');
check(soul.includes('Their words define *intent*'), 'user words define intent; tools define facts');

const prompt = buildSystemPrompt({
  settings: config.defaults,
  memories: [],
  summary: null,
  portfolio: null,
  providerStatus: [],
});
check(prompt.includes('The person talking to you is the operator.'),
  'the system prompt makes operator authority a hard rule');
check(prompt.includes('carry it out now, then report the result'),
  '"immediately" means act and confirm, not promise');
check(prompt.includes('Never refuse a high-confidence signal that passed those gates'),
  'the old malformed gate rule is fixed');
check(!prompt.includes('You may NoT refuses'),
  'the broken sentence is gone');

console.log(`\npassed ${passed}`);
process.exit(0);
