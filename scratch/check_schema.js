
import pool from '../src/db/pool.js';
import { initConfig } from '../src/config.js';

async function check() {
  await initConfig();
  const res = await pool.query(`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_name = 'kitchen_sessions';
  `);
  console.log(JSON.stringify(res.rows, null, 2));
  process.exit(0);
}

check();
