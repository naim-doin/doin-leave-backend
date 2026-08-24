const bcrypt = require('bcryptjs');
const readline = require('readline');
const { initSchema, get, run } = require('./index');

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

  let { email, password } = args;
  if (!email) email = await ask('Account email to reset: ');
  if (!password) password = await ask('New password (min 8 characters): ');

  email = (email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) { console.error('A valid email is required.'); process.exit(1); }
  if (!password || password.length < 8) { console.error('Password must be at least 8 characters.'); process.exit(1); }

  const emp = await get('SELECT id, name, role FROM employees WHERE email=?', [email]);
  if (!emp) { console.error(`No account found with email ${email}.`); process.exit(1); }

  const hash = bcrypt.hashSync(password, 10);
  await run('UPDATE employees SET password_hash=?, must_reset_password=0 WHERE id=?', [hash, emp.id]);

  console.log(`\nPassword reset for ${emp.name} <${email}> (role: ${emp.role}).`);
}
main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
