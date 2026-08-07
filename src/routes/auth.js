const express = require('express');
const bcrypt = require('bcryptjs');
const { get, run } = require('../db');
const { signToken, requireAuth } = require('../auth');

const router = express.Router();

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

    const emp = await get('SELECT * FROM employees WHERE email = ?', [String(email).toLowerCase().trim()]);
    if (!emp) return res.status(401).json({ error: 'Invalid email or password.' });

    const ok = bcrypt.compareSync(password, emp.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password.' });

    if (!emp.active) return res.status(403).json({ error: 'This account has been deactivated. Contact HR.' });

    const token = signToken(emp);
    res.json({
      token,
      mustResetPassword: !!emp.must_reset_password,
      user: { id: emp.id, name: emp.name, email: emp.email, role: emp.role, dept: emp.dept, photo: emp.photo }
    });
  } catch (e) { next(e); }
});

router.post('/change-password', requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    }
    const emp = await get('SELECT * FROM employees WHERE id = ?', [req.user.id]);
    if (!emp) return res.status(404).json({ error: 'Account not found.' });

    if (!emp.must_reset_password) {
      if (!currentPassword || !bcrypt.compareSync(currentPassword, emp.password_hash)) {
        return res.status(401).json({ error: 'Current password is incorrect.' });
      }
    }
    const hash = bcrypt.hashSync(newPassword, 10);
    await run('UPDATE employees SET password_hash=?, must_reset_password=0 WHERE id=?', [hash, emp.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const emp = await get('SELECT id,name,email,role,dept,gender,manager_id,photo FROM employees WHERE id=?', [req.user.id]);
    if (!emp) return res.status(404).json({ error: 'Account not found.' });
    res.json(emp);
  } catch (e) { next(e); }
});

module.exports = router;
