import { connect, migrate, seedSettings, close } from './index.js';
import { createLogger } from '../logger.js';

const log = createLogger('migrate');

try {
  await connect();
  await migrate();
  const s = await seedSettings();
  log.info('settings seeded:', Object.keys(s).length, 'keys');
  log.info('done ✅');
} catch (e) {
  log.error(e.message);
  for (const hint of e.hints || []) log.error(`   → ${hint}`);
  process.exitCode = 1;
} finally {
  await close();
}
