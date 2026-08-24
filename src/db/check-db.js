require('dotenv').config();
const { createClient } = require('@libsql/client');

async function main() {
  const url = process.env.DB_URL || '(not set — using local file)';
  console.log('Connecting to:', url);
  const db = createClient({ url: process.env.DB_URL || 'file:./data.sqlite', authToken: process.env.DB_AUTH_TOKEN || undefined });
  try {
    const res = await db.execute('SELECT id, name, email, role, active FROM employees ORDER BY id');
    if (res.rows.length === 0) console.log('No employees found in this database.');
    else res.rows.forEach(r => console.log(`  #${r.id} — ${r.name} <${r.email}> — role: ${r.role} — active: ${r.active}`));
  } catch (e) { console.error('Could not query this database:', e.message); }
}
main();
