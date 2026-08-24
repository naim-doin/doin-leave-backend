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

const PROFILE_FIELDS = ['id','name','email','dept','role','gender','manager_id','active','photo','designation','employee_code','joining_date'];

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const rows = await all(`SELECT ${PROFILE_FIELDS.join(',')} FROM employees ORDER BY name`);
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

router.get('/me/balances', requireAuth, async (req, res, next) => {
  try { res.json(await balancesFor(req.user.id)); }
  catch (e) { next(e); }
});

router.post('/', requireAuth, requireRole('hr'), async (req, res, next) => {
  try {
    const { name, email, dept, gender, role, managerId, designation, employeeCode, joiningDate } = req.body || {};
    if (!name || !email || !dept || !gender || !role) {
      return res.status(400).json({ error: 'name, email, dept, gender and role are required.' });
    }
    if (!['male', 'female'].includes(gender)) return res.status(400).json({ error: 'gender must be male or female.' });
    if (!['employee', 'manager', 'hr'].includes(role)) return res.status(400).json({ error: 'Invalid role.' });

    const existing = await get('SELECT id FROM employees WHERE email=?', [email.toLowerCase().trim()]);
    if (existing) return res.status(409).json({ error: 'An employee with that email already exists.' });

    if (employeeCode) {
      const dupCode = await get('SELECT id FROM employees WHERE employee_code=?', [employeeCode.trim()]);
      if (dupCode) return res.status(409).json({ error: 'That Employee ID is already in use.' });
    }

    const tempPassword = Math.random().toString(36).slice(-10);
    const hash = bcrypt.hashSync(tempPassword, 10);

    const info = await run(`
      INSERT INTO employees (name,email,password_hash,dept,gender,role,manager_id,must_reset_password,designation,employee_code,joining_date)
      VALUES (?,?,?,?,?,?,?,1,?,?,?)
    `, [name.trim(), email.toLowerCase().trim(), hash, dept.trim(), gender, role, managerId || null,
        designation ? designation.trim() : null, employeeCode ? employeeCode.trim() : null, joiningDate || null]);

    const types = await all('SELECT code,default_total FROM leave_types');
    const insertBal = 'INSERT INTO leave_balances (employee_id,type_code,total,used) VALUES (?,?,?,0)';
    for (const t of types) await run(insertBal, [info.lastInsertRowid, t.code, t.default_total]);

    res.status(201).json({ id: info.lastInsertRowid, tempPassword });
  } catch (e) { next(e); }
});

// full profile edit — HR only, HR has authority to correct anything after creation
router.patch('/:id', requireAuth, requireRole('hr'), async (req, res, next) => {
  try {
    const employeeId = Number(req.params.id);
    const emp = await get('SELECT * FROM employees WHERE id=?', [employeeId]);
    if (!emp) return res.status(404).json({ error: 'Employee not found.' });

    const { name, dept, gender, role, managerId, designation, employeeCode, joiningDate } = req.body || {};

    if (gender && !['male', 'female'].includes(gender)) return res.status(400).json({ error: 'gender must be male or female.' });
    if (role && !['employee', 'manager', 'hr'].includes(role)) return res.status(400).json({ error: 'Invalid role.' });

    // safety: don't allow moving the last active HR out of the HR role
    if (role && role !== 'hr' && emp.role === 'hr') {
      const activeHrCount = (await get("SELECT COUNT(*) c FROM employees WHERE role='hr' AND active=1")).c;
      if (activeHrCount <= 1) {
        return res.status(409).json({ error: 'Cannot change the role of the only active HR account. Promote another employee to HR first.' });
      }
    }

    if (employeeCode) {
      const dupCode = await get('SELECT id FROM employees WHERE employee_code=? AND id!=?', [employeeCode.trim(), employeeId]);
      if (dupCode) return res.status(409).json({ error: 'That Employee ID is already in use.' });
    }

    const next = {
      name: name !== undefined ? name.trim() : emp.name,
      dept: dept !== undefined ? dept.trim() : emp.dept,
      gender: gender !== undefined ? gender : emp.gender,
      role: role !== undefined ? role : emp.role,
      manager_id: managerId !== undefined ? (managerId || null) : emp.manager_id,
      designation: designation !== undefined ? (designation.trim() || null) : emp.designation,
      employee_code: employeeCode !== undefined ? (employeeCode.trim() || null) : emp.employee_code,
      joining_date: joiningDate !== undefined ? (joiningDate || null) : emp.joining_date
    };

    await run(`
      UPDATE employees SET name=?, dept=?, gender=?, role=?, manager_id=?, designation=?, employee_code=?, joining_date=?
      WHERE id=?
    `, [next.name, next.dept, next.gender, next.role, next.manager_id, next.designation, next.employee_code, next.joining_date, employeeId]);

    res.json({ ok: true });
  } catch (e) { next(e); }
});

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

    if (!active && emp.role === 'hr') {
      const activeHrCount = (await get("SELECT COUNT(*) c FROM employees WHERE role='hr' AND active=1")).c;
      if (activeHrCount <= 1) {
        return res.status(409).json({ error: 'Cannot deactivate the only active HR account. Promote another employee to HR first.' });
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

const PHOTO_MAX_LENGTH = 250_000;
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

module.exports = router;
module.exports.adjustBalance = adjustBalance;
module.exports.balancesFor = balancesFor;
