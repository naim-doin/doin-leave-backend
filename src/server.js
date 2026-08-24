require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { initSchema } = require('./db');

const authRoutes = require('./routes/auth');
const employeeRoutes = require('./routes/employees');
const requestRoutes = require('./routes/requests');
const holidayRoutes = require('./routes/holidays');
const miscRoutes = require('./routes/misc');
const adminRoutes = require('./routes/admin');
const documentRoutes = require('./routes/documents');

const app = express();
app.use(express.json({ limit: '400kb' }));

const allowedOrigins = (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : true, credentials: true }));

const loginAttempts = new Map();
app.use('/api/auth/login', (req, res, next) => {
  const key = req.ip;
  const now = Date.now();
  const entry = loginAttempts.get(key) || { count: 0, resetAt: now + 60_000 };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 60_000; }
  entry.count++;
  loginAttempts.set(key, entry);
  if (entry.count > 10) return res.status(429).json({ error: 'Too many login attempts. Try again in a minute.' });
  next();
});

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/auth', authRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/requests', requestRoutes);
app.use('/api/holidays', holidayRoutes);
app.use('/api', miscRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/documents', documentRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

const PORT = process.env.PORT || 4000;
initSchema()
  .then(() => { app.listen(PORT, () => console.log(`Doin Leave API listening on port ${PORT}`)); })
  .catch(err => { console.error('Failed to initialize database schema:', err); process.exit(1); });
