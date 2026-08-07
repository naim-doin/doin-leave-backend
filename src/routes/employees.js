const express = require('express');
const bcrypt = require('bcryptjs');
const { get, all, run } = require('../db');
const { requireAuth, requireRole } = require('../auth');

const router = express.Router();

async function balancesFor(employeeId) {
  const rows = await all(`
    SELECT lb.type_code, lb.total, lb.used, lt.label, lt.gender_restricted
    FROM leave_balances lb JOIN leave_types lt ON lt.code = lb.type_code
    WHERE lb.employee_id = ?
  `, [employeeId]);
  const out = {};
  rows.forEach(r => { out[r.type_code] = { total: r.total, used: r.used, label: r.label, genderRestricted: r.gender_restricted }; });
  return out;
}

// Sets used/total for one employee+leave type to an absolute value (not a delta) and logs the change.
// Used for opening-balance entry (mid-year onboarding) and year-end rollover.
async function adjustBalance(employeeId, typeCode, { used, total }, actorId, reason) {
  const current = await get('SELECT total,used FROM leave_balances WHERE employee_id=? AND type_code=?', [employeeId, typeCode]);
  if (!current) throw new Error(`No ${typeCode} balance row for employee ${employeeId}`);
  const newUsed = used !== undefined ? used : current.used;
  const newTotal = total !== undefined ? total : current.total;
  await run('UPDATE leave_balances SET used=?, total=? WHERE employee_id=? AND type_code=?', [newUsed, newTotal, employeeId, typeCode]);
  await run(`
    INSERT INTO balance_adjustments (employee_id,type_code,previous_used,new_used,previous_total,new_total,actor_id,reason)
    VALUES (?,?,?,?,?,?,?,?)
  `, [employeeId, typeCode, current.used, newUsed, current.total, newTotal, actorId || null, reason || null]);
  return { previous: current, next: { used: newUsed, total: newTotal } };
}

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const rows = await all('SELECT id,name,email,dept,role,gender,manager_id,active,photo FROM employees ORDER BY name');
    const includeBalances = req.user.role === 'hr';
    const out = [];
    for (const e of rows) {
      const isSelfOrHr = includeBalances || e.id === req.user.id;
      out.push({
        ...e,
        active: !!e.active,
        email: isSelfOrHr ? e.email : undefined,
        balances: isSelfOrHr ? await balancesFor(e.id) : undefined
      });
    }
    res.json(out);
  } catch (e) { next(e); }
});

const PHOTO_MAX_LENGTH = 250_000; // ~180KB of actual image data once decoded — plenty for a small profile photo
const PHOTO_PATTERN = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/;

router.patch('/:id/photo', requireAuth, async (req, res, next) => {
  try {
    const employeeId = Number(req.params.id);
    if (req.user.role !== 'hr' && req.user.id !== employeeId) {
      return res.status(403).json({ error: 'You can only update your own photo.' });
    }
    const { photo } = req.body || {};
    if (!photo || typeof photo !== 'string') return res.status(400).json({ error: 'photo (a data URL) is required.' });
    if (photo.length > PHOTO_MAX_LENGTH) return res.status(400).json({ error: 'Photo is too large — please use a smaller image.' });
    if (!PHOTO_PATTERN.test(photo)) return res.status(400).json({ error: 'photo must be a base64 PNG, JPEG, WEBP, or GIF data URL.' });

    const emp = await get('SELECT id FROM employees WHERE id=?', [employeeId]);
    if (!emp) return res.status(404).json({ error: 'Employee not found.' });

    await run('UPDATE employees SET photo=? WHERE id=?', [photo, employeeId]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/:id/photo', requireAuth, async (req, res, next) => {
  try {
    const employeeId = Number(req.params.id);
    if (req.user.role !== 'hr' && req.user.id !== employeeId) {
      return res.status(403).json({ error: 'You can only remove your own photo.' });
    }
    const emp = await get('SELECT id FROM employees WHERE id=?', [employeeId]);
    if (!emp) return res.status(404).json({ error: 'Employee not found.' });
    await run('UPDATE employees SET photo=NULL WHERE id=?', [employeeId]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/me/balances', requireAuth, async (req, res, next) => {
  try {
    res.json(await balancesFor(req.user.id));
  } catch (e) { next(e); }
});

router.post('/', requireAuth, requireRole('hr'), async (req, res, next) => {
  try {
    const { name, email, dept, gender, role, managerId } = req.body || {};
    if (!name || !email || !dept || !gender || !role) {
      return res.status(400).json({ error: 'name, email, dept, gender and role are required.' });
    }
    if (!['male', 'female'].includes(gender)) return res.status(400).json({ error: 'gender must be male or female.' });
    if (!['employee', 'manager', 'hr'].includes(role)) return res.status(400).json({ error: 'Invalid role.' });

    const existing = await get('SELECT id FROM employees WHERE email=?', [email.toLowerCase().trim()]);
    if (existing) return res.status(409).json({ error: 'An employee with that email already exists.' });

    const tempPassword = Math.random().toString(36).slice(-10);
    const hash = bcrypt.hashSync(tempPassword, 10);

    const info = await run(`
      INSERT INTO employees (name,email,password_hash,dept,gender,role,manager_id,must_reset_password)
      VALUES (?,?,?,?,?,?,?,1)
    `, [name.trim(), email.toLowerCase().trim(), hash, dept, gender, role, managerId || null]);

    const types = await all('SELECT code,default_total FROM leave_types');
    for (const t of types) {
      await run('INSERT INTO leave_balances (employee_id,type_code,total,used) VALUES (?,?,?,0)', [info.lastInsertRowid, t.code, t.default_total]);
    }

    res.status(201).json({ id: info.lastInsertRowid, tempPassword });
  } catch (e) { next(e); }
});

// set a single employee's "used" for one leave type — for recording pre-system leave
// taken earlier this year (mid-year onboarding), or any manual correction.
router.patch('/:id/balances', requireAuth, requireRole('hr'), async (req, res, next) => {
  try {
    const employeeId = Number(req.params.id);
    const { typeCode, used, reason } = req.body || {};
    if (!typeCode || used === undefined || used === null) {
      return res.status(400).json({ error: 'typeCode and used are required.' });
    }
    if (typeof used !== 'number' || used < 0) return res.status(400).json({ error: 'used must be a non-negative number.' });

    const emp = await get('SELECT id FROM employees WHERE id=?', [employeeId]);
    if (!emp) return res.status(404).json({ error: 'Employee not found.' });
    const type = await get('SELECT code FROM leave_types WHERE code=?', [typeCode]);
    if (!type) return res.status(400).json({ error: 'Unknown leave type.' });

    const result = await adjustBalance(employeeId, typeCode, { used }, req.user.id, reason || 'Manual balance edit');
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

// bulk opening-balance import — for entering everyone's already-used leave when
// switching to this system mid-year. Rows are matched by email; unknown emails
// or unknown leave-type columns are reported back, not silently skipped.
router.post('/import-balances', requireAuth, requireRole('hr'), async (req, res, next) => {
  try {
    const { rows, reason } = req.body || {};
    if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'rows must be a non-empty array.' });

    const validTypes = new Set((await all('SELECT code FROM leave_types')).map(t => t.code));
    const results = [];
    for (const row of rows) {
      const email = (row.email || '').toLowerCase().trim();
      if (!email) { results.push({ email: row.email || '(blank)', ok: false, error: 'No email given.' }); continue; }
      const emp = await get('SELECT id FROM employees WHERE email=?', [email]);
      if (!emp) { results.push({ email, ok: false, error: 'No employee with this email.' }); continue; }

      const applied = [];
      for (const [key, value] of Object.entries(row)) {
        if (key === 'email' || value === '' || value === null || value === undefined) continue;
        if (!validTypes.has(key)) { results.push({ email, ok: false, error: `Unknown leave type column: ${key}` }); continue; }
        const num = Number(value);
        if (isNaN(num) || num < 0) { results.push({ email, ok: false, error: `Invalid value for ${key}: ${value}` }); continue; }
        await adjustBalance(emp.id, key, { used: num }, req.user.id, reason || 'Bulk opening-balance import');
        applied.push(key);
      }
      if (applied.length) results.push({ email, ok: true, updated: applied });
    }
    res.json({ results });
  } catch (e) { next(e); }
});

router.get('/:id/adjustments', requireAuth, requireRole('hr'), async (req, res, next) => {
  try {
    const rows = await all(`
      SELECT ba.*, a.name as actor_name FROM balance_adjustments ba
      LEFT JOIN employees a ON a.id = ba.actor_id
      WHERE ba.employee_id=? ORDER BY ba.created_at DESC
    `, [req.params.id]);
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/:id/reset-password', requireAuth, requireRole('hr'), async (req, res, next) => {
  try {
    const employeeId = Number(req.params.id);
    const emp = await get('SELECT id,name FROM employees WHERE id=?', [employeeId]);
    if (!emp) return res.status(404).json({ error: 'Employee not found.' });

    const tempPassword = Math.random().toString(36).slice(-10);
    const hash = bcrypt.hashSync(tempPassword, 10);
    await run('UPDATE employees SET password_hash=?, must_reset_password=1 WHERE id=?', [hash, employeeId]);

    res.json({ ok: true, id: employeeId, tempPassword });
  } catch (e) { next(e); }
});

router.patch('/:id/status', requireAuth, requireRole('hr'), async (req, res, next) => {
  try {
    const employeeId = Number(req.params.id);
    const { active } = req.body || {};
    if (typeof active !== 'boolean') return res.status(400).json({ error: 'active (true/false) is required.' });

    const emp = await get('SELECT id,name,role,manager_id,active FROM employees WHERE id=?', [employeeId]);
    if (!emp) return res.status(404).json({ error: 'Employee not found.' });

    if (!active) {
      // safety: never allow deactivating the last active HR account — that would lock everyone out of admin functions
      if (emp.role === 'hr') {
        const activeHrCount = (await get("SELECT COUNT(*) c FROM employees WHERE role='hr' AND active=1")).c;
        if (activeHrCount <= 1) {
          return res.status(409).json({ error: 'Cannot deactivate the only active HR account. Promote another employee to HR first.' });
        }
      }
    }

    await run('UPDATE employees SET active=? WHERE id=?', [active ? 1 : 0, employeeId]);

    let affectedReports = 0;
    if (!active && emp.role === 'manager') {
      affectedReports = (await get("SELECT COUNT(*) c FROM employees WHERE manager_id=? AND active=1", [employeeId])).c;
    }

    res.json({ ok: true, id: employeeId, active, affectedReports });
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.adjustBalance = adjustBalance;
module.exports.balancesFor = balancesFor;
