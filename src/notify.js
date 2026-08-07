// Sends leave-workflow events to a Discord channel via an Incoming Webhook.
// Fully optional: if DISCORD_WEBHOOK_URL isn't set, every call here is a silent no-op —
// nothing breaks, nothing logs noisily, the rest of the app works exactly as before.
// To turn it on later: create a webhook in Discord (Channel Settings → Integrations →
// Webhooks) and set DISCORD_WEBHOOK_URL to that URL in your environment.

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';

async function notifyDiscord(content) {
  if (!WEBHOOK_URL) return; // not configured — do nothing
  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
  } catch (e) {
    // Never let a Discord hiccup break the actual leave workflow.
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
