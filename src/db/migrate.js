import { migrate, seedSettings, pool } from './index.js';
import { createLogger } from '../logger.js';

const log = createLogger('migrate');

try {
  await migrate();
  const s = await seedSettings();
  log.info('settings seeded:', Object.keys(s).length, 'keys');
  log.info('done ✅');
} catch (e) {
  log.error(e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
