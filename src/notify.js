const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';

async function notifyDiscord(content) {
  if (!WEBHOOK_URL) return;
  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
  } catch (e) {
    console.error('Discord notification failed:', e.message);
  }
}

const fmtDays = (d) => d === 0.5 ? 'half a day' : `${d} day${d === 1 ? '' : 's'}`;

function notifyApplied({ employeeName, typeLabel, start, end, days, firstStage }) {
  const stage = firstStage === 'pending_manager' ? 'awaiting manager approval' : 'awaiting HR approval';
  notifyDiscord(`🟡 **${employeeName}** applied for **${typeLabel}** leave (${start} → ${end}, ${fmtDays(days)}) — ${stage}.`);
}
function notifyManagerApproved({ employeeName, typeLabel, start, end, managerName }) {
  notifyDiscord(`🟢 **${managerName}** approved **${employeeName}**'s ${typeLabel} leave (${start} → ${end}) — now awaiting HR sign-off.`);
}
function notifyHrApproved({ employeeName, typeLabel, start, end }) {
  notifyDiscord(`✅ **${employeeName}**'s ${typeLabel} leave (${start} → ${end}) is fully approved.`);
}
function notifyRejected({ employeeName, typeLabel, start, end, actorName, reason }) {
  notifyDiscord(`❌ **${actorName}** rejected **${employeeName}**'s ${typeLabel} leave (${start} → ${end}). Reason: ${reason}`);
}
function notifyCancelled({ employeeName, typeLabel, start, end }) {
  notifyDiscord(`⚪ **${employeeName}** cancelled their ${typeLabel} leave request (${start} → ${end}).`);
}

module.exports = { notifyDiscord, notifyApplied, notifyManagerApproved, notifyHrApproved, notifyRejected, notifyCancelled };
