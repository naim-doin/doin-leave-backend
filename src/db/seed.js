const bcrypt = require('bcryptjs');
const { initSchema, get, all, run } = require('./index');
const { seedReferenceData, LEAVE_TYPES } = require('./reference-data');

const FIRST = ["Aarav","Nadia","Tomas","Yui","Kwame","Elena","Farhan","Priya","Lucas","Amara","Hiro","Sofia","Deepak","Maya","Omar","Ingrid","Ravi","Chloe","Sam","Layla","Noah","Zara","Ben","Ines","Kofi","Anya","Rohan","Freya","Tariq","Mei","Diego","Nora","Yusuf","Ana","Kenji","Leila","Marco","Ivy","Rafael","Fatima","Owen","Sana","Theo","Rina","Jamal","Clara","Vikram","Lena","Cyrus","Dana","Emeka","Petra","Salim","Nia","Adam","Wei","Tessa","Ola","Milo","Rhea"];
const LAST = ["Shah","Kowalski","Reyes","Tanaka","Mensah","Petrova","Rahman","Iyer","Novak","Diallo","Sato","Almeida","Verma","Silva","Haddad","Larsen","Kapoor","Dubois","Kim","Farouk","Bennett","Osei","Marsh","Coelho","Adeyemi","Volkov","Chatterjee","Lindqvist","Malik","Chen"];
const DEPTS = ["Engineering","Sales","Support","Marketing","Finance","People Ops","Design"];

function seedRand(seed) { let s = seed; return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; }; }
const rnd = seedRand(42);
function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }

const DEFAULT_PASSWORD = 'Doin@2026';

async function run_() {
  await initSchema();
  await seedReferenceData();

  const existing = await get('SELECT COUNT(*) c FROM employees');
  if (existing.c > 0) {
    console.log('Employees already exist — skipping employee seed. Delete the database to reseed from scratch.');
    return;
  }

  const hash = bcrypt.hashSync(DEFAULT_PASSWORD, 10);

  const rows = [];
  for (let i = 0; i < 60; i++) {
    const first = FIRST[i], last = pick(LAST);
    const dept = DEPTS[i % DEPTS.length];
    const gender = i % 2 === 0 ? 'male' : 'female';
    const email = `${first.toLowerCase()}.${last.toLowerCase()}${i}@doin.tech`;
    rows.push({ first, last, dept, gender, email });
  }

  const idByIndex = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const info = await run(
      `INSERT INTO employees (name,email,password_hash,dept,gender,role,manager_id,must_reset_password) VALUES (?,?,?,?,?,?,?,1)`,
      [`${r.first} ${r.last}`, r.email, hash, r.dept, r.gender, 'employee', null]
    );
    idByIndex[i] = info.lastInsertRowid;
  }

  await run('UPDATE employees SET role=? WHERE id=?', ['hr', idByIndex[0]]);

  const deptManagerId = {};
  for (const d of DEPTS) {
    const idx = rows.findIndex((r, i) => r.dept === d && idByIndex[i] !== idByIndex[0] && !Object.values(deptManagerId).includes(idByIndex[i]));
    if (idx >= 0) {
      const id = idByIndex[idx];
      await run('UPDATE employees SET role=? WHERE id=?', ['manager', id]);
      deptManagerId[d] = id;
    }
  }

  for (let i = 0; i < rows.length; i++) {
    const id = idByIndex[i];
    const emp = await get('SELECT role FROM employees WHERE id=?', [id]);
    if (emp.role === 'employee') {
      await run('UPDATE employees SET manager_id=? WHERE id=?', [deptManagerId[rows[i].dept] || null, id]);
    }
  }

  const allEmps = await all('SELECT id,gender FROM employees');
  for (const e of allEmps) {
    for (const t of LEAVE_TYPES) {
      const eligible = !t.gender || t.gender === e.gender;
      const used = eligible ? Math.min(t.total, Math.floor(rnd() * (t.total > 20 ? 6 : t.total * 0.6))) : 0;
      await run('INSERT INTO leave_balances (employee_id,type_code,total,used) VALUES (?,?,?,?)', [e.id, t.code, t.total, used]);
    }
  }

  console.log(`Seeded ${allEmps.length} DEMO employees (for local testing/demo only).`);
  console.log(`Default password for every seeded account: ${DEFAULT_PASSWORD} (forced reset on first login)`);
  const hr = await get("SELECT email FROM employees WHERE role='hr'");
  console.log(`Demo HR admin login: ${hr.email}`);
  console.log(`\nFor a REAL launch, don't use this demo data — run "npm run create-admin" instead to create your actual HR account.`);
}

run_().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
