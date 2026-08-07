function fmt(d) { return d.toISOString().slice(0, 10); }
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }

// Weekend is Saturday (6) and Sunday (0)
function businessDays(startStr, endStr, holidayDates) {
  let d = new Date(startStr);
  const end = new Date(endStr);
  let count = 0;
  while (d <= end) {
    const day = d.getDay();
    const ds = fmt(d);
    if (day !== 0 && day !== 6 && !holidayDates.has(ds)) count++;
    d = addDays(d, 1);
  }
  return count;
}

module.exports = { businessDays, fmt, addDays };
