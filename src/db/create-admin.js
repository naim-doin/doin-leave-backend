const bcrypt = require('bcryptjs');
const readline = require('readline');
const { initSchema, get, run } = require('./index');
const { seedReferenceData, LEAVE_TYPES } = require('./reference-data');

function parseArgs() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { args[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return args;
}
function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer); }));
}

async function main() {
  const args = parseArgs();
  await initSchema();
  await seedReferenceData();

  let { name, email, password, gender } = args;
  if (!name) name = await ask('Full name: ');
  if (!email) email = await ask('Work email: ');
  if (!password) password = await ask('Password (min 8 characters): ');
  if (!gender) gender = await ask('Gender (male/female): ');

  name = (name || '').trim();
  email = (email || '').trim().toLowerCase();
  gender = (gender || '').trim().toLowerCase();

  if (!name) { console.error('Name is required.'); process.exit(1); }
  if (!email || !email.includes('@')) { console.error('A valid email is required.'); process.exit(1); }
  if (!password || password.length < 8) { console.error('Password must be at least 8 characters.'); process.exit(1); }
  if (!['male', 'female'].includes(gender)) { console.error('Gender must be "male" or "female".'); process.exit(1); }

  const existing = await get('SELECT id FROM employees WHERE email=?', [email]);
  if (existing) { console.error(`An account with ${email} already exists.`); process.exit(1); }

  const hash = bcrypt.hashSync(password, 10);
  const info = await run(`
    INSERT INTO employees (name,email,password_hash,dept,gender,role,manager_id,must_reset_password,active,designation)
    VALUES (?,?,?,?,?,?,?,0,1,?)
  `, [name, email, hash, 'People Ops', gender, 'hr', null, 'HR Manager']);

  for (const t of LEAVE_TYPES) {
    await run('INSERT INTO leave_balances (employee_id,type_code,total,used) VALUES (?,?,?,0)', [info.lastInsertRowid, t.code, t.total]);
  }

  console.log(`\nHR account created: ${name} <${email}>`);
  console.log('You can log in immediately with the password you just set.');
}
main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
