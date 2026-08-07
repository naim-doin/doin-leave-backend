const express = require('express');
const { all, run } = require('../db');
const { requireAuth, requireRole } = require('../auth');

const router = express.Router();

router.get('/', requireAuth, async (req, res, next) => {
  try {
    res.json(await all('SELECT date,label FROM holidays ORDER BY date'));
  } catch (e) { next(e); }
});

router.post('/', requireAuth, requireRole('hr'), async (req, res, next) => {
  try {
    const { date, label } = req.body || {};
    if (!date || !label) return res.status(400).json({ error: 'date and label are required.' });
    await run('INSERT OR REPLACE INTO holidays (date,label) VALUES (?,?)', [date, label.trim()]);
    res.status(201).json({ date, label: label.trim() });
  } catch (e) { next(e); }
});

router.delete('/:date', requireAuth, requireRole('hr'), async (req, res, next) => {
  try {
    await run('DELETE FROM holidays WHERE date=?', [req.params.date]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
