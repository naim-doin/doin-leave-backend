const express = require('express');
const { get, all, run } = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { adjustBalance } = require('./employees');

const router = express.Router();
const ANNUAL_CARRY_FORWARD_CAP = 5;

async function getLastRolloverYear() {
  const row = await get("SELECT value FROM settings WHERE key='last_rollover_year'");
  return row ? Number(row.value) : null;
}

router.get('/rollover-status', requireAuth, async (req, res, next) => {
  try {
    const currentYear = new Date().getFullYear();
    const lastRolloverYear = await getLastRolloverYear();
    res.json({ currentYear, lastRolloverYear, dueForRollover: lastRolloverYear === null || lastRolloverYear < currentYear });
  } catch (e) { next(e); }
});

router.post('/rollover', requireAuth, requireRole('hr'), async (req, res, next) => {
  try {
    const currentYear = new Date().getFullYear();
    const lastRolloverYear = await getLastRolloverYear();
    if (lastRolloverYear !== null && lastRolloverYear >= currentYear) {
      return res.status(409).json({ error: `Rollover has already run for ${currentYear}.` });
    }
    const employees = await all('SELECT id FROM employees');
    const types = await all('SELECT code,default_total FROM leave_types');
    let adjustedCount = 0, totalCarried = 0;

    for (const emp of employees) {
      for (const t of types) {
        const bal = await get('SELECT total,used FROM leave_balances WHERE employee_id=? AND type_code=?', [emp.id, t.code]);
        if (!bal) continue;
        let carry = 0;
        if (t.code === 'annual') {
          const unused = Math.max(0, bal.total - bal.used);
          carry = Math.min(unused, ANNUAL_CARRY_FORWARD_CAP);
        }
        const newTotal = t.default_total + carry;
        await adjustBalance(emp.id, t.code, { used: 0, total: newTotal }, req.user.id, `Year-end rollover to ${currentYear}${carry > 0 ? ` (carried forward ${carry} annual day${carry === 1 ? '' : 's'})` : ''}`);
        adjustedCount++; totalCarried += carry;
      }
    }
    await run(`INSERT INTO settings (key,value) VALUES ('last_rollover_year', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [String(currentYear)]);
    res.json({ ok: true, year: currentYear, employeesProcessed: employees.length, balancesAdjusted: adjustedCount, totalAnnualDaysCarried: totalCarried, carryForwardCap: ANNUAL_CARRY_FORWARD_CAP });
  } catch (e) { next(e); }
});

module.exports = router;
