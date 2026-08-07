const express = require('express');
const { get, all, run } = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { businessDays } = require('../businessDays');
const notify = require('../notify');

const router = express.Router();

async function logAction(requestId, actorId, action, note) {
  await run('INSERT INTO request_log (request_id,actor_id,action,note) VALUES (?,?,?,?)', [requestId, actorId, action, note || null]);
}

async function getHolidaySet() {
  const rows = await all('SELECT date FROM holidays');
  return new Set(rows.map(h => h.date));
}

// used by approve/reject/cancel — all three need the employee's name and the
// leave type's label just for the Discord notification text.
async function notifyContext(r) {
  const emp = await get('SELECT name FROM employees WHERE id=?', [r.employee_id]);
  const type = await get('SELECT label FROM leave_types WHERE code=?', [r.type_code]);
  return { employeeName: emp.name, typeLabel: type.label };
}

async function serializeRequest(r) {
  const log = await all('SELECT actor_id,action,note,created_at FROM request_log WHERE request_id=? ORDER BY created_at', [r.id]);
  const emp = await get('SELECT name,dept FROM employees WHERE id=?', [r.employee_id]);
  return {
    id: r.id, employeeId: r.employee_id, employeeName: emp?.name, dept: emp?.dept,
    type: r.type_code, start: r.start_date, end: r.end_date, days: r.days,
    status: r.status, reason: r.reason, note: r.note, applied: r.applied_at, log
  };
}

router.get('/', requireAuth, async (req, res, next) => {
  try {
    let rows;
    if (req.user.role === 'hr') {
      rows = await all('SELECT * FROM requests ORDER BY applied_at DESC');
    } else if (req.user.role === 'manager') {
      rows = await all(`
        SELECT r.* FROM requests r JOIN employees e ON e.id = r.employee_id
        WHERE e.manager_id = ? OR r.employee_id = ?
        ORDER BY r.applied_at DESC
      `, [req.user.id, req.user.id]);
    } else {
      rows = await all('SELECT * FROM requests WHERE employee_id=? ORDER BY applied_at DESC', [req.user.id]);
    }
    const out = [];
    for (const r of rows) out.push(await serializeRequest(r));
    res.json(out);
  } catch (e) { next(e); }
});

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { type, start, end, reason, halfDay } = req.body || {};
    if (!type || !start || !end) return res.status(400).json({ error: 'type, start and end are required.' });
    if (end < start) return res.status(400).json({ error: 'End date is before start date.' });
    if (halfDay && start !== end) return res.status(400).json({ error: 'Half-day leave must be a single date (start and end the same).' });

    const leaveType = await get('SELECT * FROM leave_types WHERE code=?', [type]);
    if (!leaveType) return res.status(400).json({ error: 'Unknown leave type.' });

    const me = await get('SELECT * FROM employees WHERE id=?', [req.user.id]);
    if (leaveType.gender_restricted && leaveType.gender_restricted !== me.gender) {
      return res.status(403).json({ error: 'This leave type is not available for your profile.' });
    }

    const holidaySet = await getHolidaySet();
    const fullDayCount = businessDays(start, end, holidaySet);
    if (fullDayCount === 0) return res.status(400).json({ error: 'Selected range has no working days (weekend/holiday only).' });
    const days = halfDay ? 0.5 : fullDayCount;

    const bal = await get('SELECT * FROM leave_balances WHERE employee_id=? AND type_code=?', [me.id, type]);
    if (days > bal.total - bal.used) {
      return res.status(400).json({ error: `Not enough ${leaveType.label.toLowerCase()} leave left.` });
    }

    const firstStage = me.manager_id ? 'pending_manager' : 'pending_hr';
    const info = await run(`
      INSERT INTO requests (employee_id,type_code,start_date,end_date,days,status,reason)
      VALUES (?,?,?,?,?,?,?)
    `, [me.id, type, start, end, days, firstStage, reason || null]);

    await logAction(info.lastInsertRowid, me.id, 'applied', halfDay ? 'Half-day' : null);
    notify.notifyApplied({ employeeName: me.name, typeLabel: leaveType.label, start, end, days, firstStage });
    const created = await get('SELECT * FROM requests WHERE id=?', [info.lastInsertRowid]);
    res.status(201).json(await serializeRequest(created));
  } catch (e) { next(e); }
});

router.post('/:id/approve', requireAuth, requireRole('manager', 'hr'), async (req, res, next) => {
  try {
    const r = await get('SELECT * FROM requests WHERE id=?', [req.params.id]);
    if (!r) return res.status(404).json({ error: 'Request not found.' });
    const { employeeName, typeLabel } = await notifyContext(r);

    if (req.user.role === 'manager') {
      if (r.status !== 'pending_manager') return res.status(409).json({ error: 'This request is not awaiting manager approval.' });
      const applicant = await get('SELECT manager_id FROM employees WHERE id=?', [r.employee_id]);
      if (applicant.manager_id !== req.user.id) return res.status(403).json({ error: "You are not this employee's manager." });
      await run("UPDATE requests SET status='pending_hr', updated_at=datetime('now') WHERE id=?", [r.id]);
      await logAction(r.id, req.user.id, 'approved_by_manager', null);
      notify.notifyManagerApproved({ employeeName, typeLabel, start: r.start_date, end: r.end_date, managerName: req.user.name });
      return res.json(await serializeRequest(await get('SELECT * FROM requests WHERE id=?', [r.id])));
    }

    if (r.status !== 'pending_hr') return res.status(409).json({ error: 'This request is not awaiting HR approval.' });
    await run("UPDATE requests SET status='approved', updated_at=datetime('now') WHERE id=?", [r.id]);
    await run('UPDATE leave_balances SET used = used + ? WHERE employee_id=? AND type_code=?', [r.days, r.employee_id, r.type_code]);
    await logAction(r.id, req.user.id, 'approved_by_hr', null);
    notify.notifyHrApproved({ employeeName, typeLabel, start: r.start_date, end: r.end_date });
    res.json(await serializeRequest(await get('SELECT * FROM requests WHERE id=?', [r.id])));
  } catch (e) { next(e); }
});

router.post('/:id/reject', requireAuth, requireRole('manager', 'hr'), async (req, res, next) => {
  try {
    const r = await get('SELECT * FROM requests WHERE id=?', [req.params.id]);
    if (!r) return res.status(404).json({ error: 'Request not found.' });
    if (!['pending_manager', 'pending_hr'].includes(r.status)) return res.status(409).json({ error: 'This request is no longer pending.' });

    if (req.user.role === 'manager') {
      if (r.status !== 'pending_manager') return res.status(403).json({ error: 'Only HR can reject a request already forwarded past manager stage.' });
      const applicant = await get('SELECT manager_id FROM employees WHERE id=?', [r.employee_id]);
      if (applicant.manager_id !== req.user.id) return res.status(403).json({ error: "You are not this employee's manager." });
    }

    const reason = (req.body && req.body.reason) ? String(req.body.reason).trim().slice(0, 500) : '';
    if (!reason) return res.status(400).json({ error: 'A reason is required to reject a request.' });

    const note = `Rejected: ${reason}`;
    await run("UPDATE requests SET status='rejected', note=?, updated_at=datetime('now') WHERE id=?", [note, r.id]);
    await logAction(r.id, req.user.id, 'rejected', reason);
    const { employeeName, typeLabel } = await notifyContext(r);
    notify.notifyRejected({ employeeName, typeLabel, start: r.start_date, end: r.end_date, actorName: req.user.name, reason });
    res.json(await serializeRequest(await get('SELECT * FROM requests WHERE id=?', [r.id])));
  } catch (e) { next(e); }
});

router.post('/:id/cancel', requireAuth, async (req, res, next) => {
  try {
    const r = await get('SELECT * FROM requests WHERE id=?', [req.params.id]);
    if (!r) return res.status(404).json({ error: 'Request not found.' });
    if (r.employee_id !== req.user.id) return res.status(403).json({ error: 'You can only cancel your own requests.' });
    if (!['pending_manager', 'pending_hr'].includes(r.status)) return res.status(409).json({ error: 'This request can no longer be cancelled.' });

    await run("UPDATE requests SET status='rejected', note='Cancelled by employee', updated_at=datetime('now') WHERE id=?", [r.id]);
    await logAction(r.id, req.user.id, 'cancelled', null);
    const { employeeName, typeLabel } = await notifyContext(r);
    notify.notifyCancelled({ employeeName, typeLabel, start: r.start_date, end: r.end_date });
    res.json(await serializeRequest(await get('SELECT * FROM requests WHERE id=?', [r.id])));
  } catch (e) { next(e); }
});

router.post('/preview-days', requireAuth, async (req, res, next) => {
  try {
    const { start, end, halfDay } = req.body || {};
    if (!start || !end || end < start) return res.status(400).json({ error: 'Valid start and end dates are required.' });
    if (halfDay && start !== end) return res.status(400).json({ error: 'Half-day leave must be a single date.' });
    const holidaySet = await getHolidaySet();
    const fullDays = businessDays(start, end, holidaySet);
    const days = halfDay ? (fullDays > 0 ? 0.5 : 0) : fullDays;
    const hitHolidays = await all('SELECT date,label FROM holidays WHERE date BETWEEN ? AND ?', [start, end]);
    res.json({ days, holidays: hitHolidays });
  } catch (e) { next(e); }
});

// company-wide leave calendar feed — names/dates only, no reasons or other request details,
// so any signed-in employee can see who's out without seeing why
router.get('/calendar', requireAuth, async (req, res, next) => {
  try {
    const { start, end } = req.query;
    let rows;
    if (start && end) {
      rows = await all(`
        SELECT r.employee_id, e.name, e.dept, r.start_date, r.end_date
        FROM requests r JOIN employees e ON e.id = r.employee_id
        WHERE r.status='approved' AND r.start_date <= ? AND r.end_date >= ?
        ORDER BY r.start_date
      `, [end, start]);
    } else {
      rows = await all(`
        SELECT r.employee_id, e.name, e.dept, r.start_date, r.end_date
        FROM requests r JOIN employees e ON e.id = r.employee_id
        WHERE r.status='approved'
        ORDER BY r.start_date
      `);
    }
    res.json(rows.map(r => ({ employeeId: r.employee_id, name: r.name, dept: r.dept, start: r.start_date, end: r.end_date })));
  } catch (e) { next(e); }
});

module.exports = router;
