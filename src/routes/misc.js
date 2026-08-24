const express = require('express');
const { all } = require('../db');
const { requireAuth, requireRole } = require('../auth');

const router = express.Router();

router.get('/leave-types', requireAuth, async (req, res, next) => {
  try { res.json(await all('SELECT code,label,default_total,gender_restricted FROM leave_types')); }
  catch (e) { next(e); }
});

function csvEscape(v) { return `"${String(v).replace(/"/g, '""')}"`; }

router.get('/export/requests.csv', requireAuth, requireRole('hr'), async (req, res, next) => {
  try {
    const rows = await all(`
      SELECT e.name, e.dept, lt.label as type_label, r.start_date, r.end_date, r.days, r.status, r.reason, r.applied_at
      FROM requests r JOIN employees e ON e.id = r.employee_id JOIN leave_types lt ON lt.code = r.type_code
      ORDER BY r.applied_at DESC
    `);
    const header = ['Employee', 'Department', 'Leave type', 'Start', 'End', 'Days', 'Status', 'Reason', 'Applied'];
    const lines = [header.join(',')].concat(rows.map(r => [r.name, r.dept, r.type_label, r.start_date, r.end_date, r.days, r.status, r.reason || '', r.applied_at].map(csvEscape).join(',')));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="leave-requests.csv"');
    res.send(lines.join('\n'));
  } catch (e) { next(e); }
});

router.get('/export/employees.csv', requireAuth, requireRole('hr'), async (req, res, next) => {
  try {
    const emps = await all('SELECT id,name,dept,designation,employee_code,role,gender FROM employees ORDER BY name');
    const types = await all('SELECT code,label FROM leave_types');
    const header = ['Name', 'Department', 'Designation', 'Employee ID', 'Role', 'Gender', ...types.map(t => t.label + ' left')];
    const lines = [header.join(',')];
    for (const e of emps) {
      const bals = await all('SELECT type_code,total,used FROM leave_balances WHERE employee_id=?', [e.id]);
      const byCode = Object.fromEntries(bals.map(b => [b.type_code, b.total - b.used]));
      lines.push([e.name, e.dept, e.designation || '', e.employee_code || '', e.role, e.gender, ...types.map(t => byCode[t.code] ?? '')].map(csvEscape).join(','));
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="employees.csv"');
    res.send(lines.join('\n'));
  } catch (e) { next(e); }
});

module.exports = router;
