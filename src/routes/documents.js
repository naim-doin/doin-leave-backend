const express = require('express');
const { get, all, run } = require('../db');
const { requireAuth, requireRole } = require('../auth');

const router = express.Router();

const DOC_TYPES = {
  salary_certificate: 'Salary Certificate',
  noc: 'NOC',
  employment_certificate: 'Employment Certificate',
  other: 'Other'
};

function serialize(row, employeeName) {
  return {
    id: row.id, employeeId: row.employee_id, employeeName,
    docType: row.doc_type, docTypeLabel: DOC_TYPES[row.doc_type] || row.doc_type,
    note: row.note, status: row.status,
    expectedDate: row.expected_date, rejectReason: row.reject_reason,
    requestedAt: row.requested_at, decidedAt: row.decided_at
  };
}

// employee sees their own; HR sees everyone's
router.get('/', requireAuth, async (req, res, next) => {
  try {
    let rows;
    if (req.user.role === 'hr') {
      rows = await all(`
        SELECT d.*, e.name as employee_name FROM document_requests d
        JOIN employees e ON e.id = d.employee_id
        ORDER BY d.requested_at DESC
      `);
    } else {
      rows = await all(`
        SELECT d.*, e.name as employee_name FROM document_requests d
        JOIN employees e ON e.id = d.employee_id
        WHERE d.employee_id=? ORDER BY d.requested_at DESC
      `, [req.user.id]);
    }
    res.json(rows.map(r => serialize(r, r.employee_name)));
  } catch (e) { next(e); }
});

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { docType, note } = req.body || {};
    if (!docType || !DOC_TYPES[docType]) {
      return res.status(400).json({ error: 'docType must be one of: salary_certificate, noc, employment_certificate, other.' });
    }
    if (docType === 'other' && !(note && note.trim())) {
      return res.status(400).json({ error: 'Please describe what document you need.' });
    }
    const info = await run(
      'INSERT INTO document_requests (employee_id, doc_type, note) VALUES (?,?,?)',
      [req.user.id, docType, note ? note.trim().slice(0, 500) : null]
    );
    const row = await get('SELECT * FROM document_requests WHERE id=?', [info.lastInsertRowid]);
    res.status(201).json(serialize(row, req.user.name));
  } catch (e) { next(e); }
});

router.post('/:id/approve', requireAuth, requireRole('hr'), async (req, res, next) => {
  try {
    const row = await get('SELECT * FROM document_requests WHERE id=?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Request not found.' });
    if (row.status !== 'pending') return res.status(409).json({ error: 'This request has already been decided.' });

    const { expectedDate } = req.body || {};
    if (!expectedDate) return res.status(400).json({ error: 'An expected delivery date is required to approve.' });

    await run(
      "UPDATE document_requests SET status='approved', expected_date=?, decided_at=datetime('now'), decided_by=? WHERE id=?",
      [expectedDate, req.user.id, row.id]
    );
    const emp = await get('SELECT name FROM employees WHERE id=?', [row.employee_id]);
    res.json(serialize(await get('SELECT * FROM document_requests WHERE id=?', [row.id]), emp.name));
  } catch (e) { next(e); }
});

router.post('/:id/reject', requireAuth, requireRole('hr'), async (req, res, next) => {
  try {
    const row = await get('SELECT * FROM document_requests WHERE id=?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Request not found.' });
    if (row.status !== 'pending') return res.status(409).json({ error: 'This request has already been decided.' });

    const reason = (req.body && req.body.reason) ? String(req.body.reason).trim().slice(0, 500) : '';
    if (!reason) return res.status(400).json({ error: 'A reason is required to reject a request.' });

    await run(
      "UPDATE document_requests SET status='rejected', reject_reason=?, decided_at=datetime('now'), decided_by=? WHERE id=?",
      [reason, req.user.id, row.id]
    );
    const emp = await get('SELECT name FROM employees WHERE id=?', [row.employee_id]);
    res.json(serialize(await get('SELECT * FROM document_requests WHERE id=?', [row.id]), emp.name));
  } catch (e) { next(e); }
});

module.exports = router;
