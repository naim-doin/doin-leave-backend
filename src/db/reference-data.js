const { run } = require('./index');

const LEAVE_TYPES = [
  { code: 'annual', label: 'Annual', total: 14, gender: null },
  { code: 'sick', label: 'Sick', total: 14, gender: null },
  { code: 'casual', label: 'Casual', total: 7, gender: null },
  { code: 'maternity', label: 'Maternity', total: 120, gender: 'female' },
  { code: 'paternity', label: 'Paternity', total: 2, gender: 'male' },
  { code: 'special', label: 'Special', total: 3, gender: null },
  { code: 'unpaid', label: 'Unpaid', total: 9999, gender: null },
];

const HOLIDAYS_2026 = [
  ['2026-02-21', "Language Martyrs' Day"],
  ['2026-03-26', 'Independence Day'],
  ['2026-05-01', 'May Day'],
  ['2026-08-15', 'National Mourning Day'],
  ['2026-12-16', 'Victory Day'],
  ['2026-12-25', 'Christmas Day'],
];

async function seedReferenceData() {
  for (const t of LEAVE_TYPES) {
    await run('INSERT OR REPLACE INTO leave_types (code,label,default_total,gender_restricted) VALUES (?,?,?,?)',
      [t.code, t.label, t.total, t.gender]);
  }
  for (const [date, label] of HOLIDAYS_2026) {
    await run('INSERT OR IGNORE INTO holidays (date,label) VALUES (?,?)', [date, label]);
  }
}

module.exports = { seedReferenceData, LEAVE_TYPES, HOLIDAYS_2026 };
