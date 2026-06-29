/**
 * raid.js - Full Raidar-style raid system
 */
const { InlineKeyboard } = require("grammy");

const activeRaids = {};   // chatId -> raidData
const raidHistory = {};   // chatId -> [raidData]
const raidQueue = {};     // chatId -> [{ link, targets }]
const pendingTargets = {}; // chatId -> { link, targets: {} } being set up

function detectType(link) {
  if (link.includes("twitter.com") || link.includes("x.com")) return "twitter";
  if (link.includes("t.me") || link.includes("telegram.me")) return "telegram";
  return "general";
}

// ── Keyboards ─────────────────────────────────────────────────

function raidOptionsKeyboard(chatId) {
  return new InlineKeyboard()
    .text("⚡️ Start Raid ⚡️", "raid_start:" + chatId)
    .row()
    .text("🎯 Targets", "raid_targets:" + chatId)
    .row()
    .text("🔒 Lock Chat 🔴", "raid_lock:" + chatId)
    .row()
    .text("📓 Close", "raid_close:" + chatId);
}

function targetsKeyboard(chatId) {
  const pt = pendingTargets[chatId] || {};
  const t = pt.targets || {};
  return new InlineKeyboard()
    .text("❤️ Likes: " + (t.likes || 0), "target_likes:" + chatId)
    .row()
    .text("🔄 Retweets: " + (t.retweets || 0), "target_retweets:" + chatId)
    .row()
    .text("💬 Replies: " + (t.replies || 0), "target_replies:" + chatId)
    .row()
    .text("✅ Save Targets", "target_save:" + chatId)
    .row()
    .text("⬅️ Back", "raid_back:" + chatId);
}

function activeRaidKeyboard(chatId) {
  return new InlineKeyboard()
    .text("💬", "xcomment:" + chatId)
    .text("🔄", "xrt:" + chatId)
    .text("❤️", "xlike:" + chatId)
    .text("🗒️", "xbookmark:" + chatId)
    .text("👊", "xall:" + chatId);
}

// ── Format Messages ───────────────────────────────────────────

function formatRaidOptions(link, tweetStats) {
  const stats = tweetStats || {};
  return (
    "⚙️ <b>Raid Options</b>\n\n" +
    "🔗 Link: " + link + "\n" +
    "❤️ Likes: " + (stats.likes || 0) + "\n" +
    "🔄 Retweets: " + (stats.retweets || 0) + "\n" +
    "💬 Replies: " + (stats.replies || 0) + "\n" +
    "👀 Views: " + (stats.views || 0) + "\n" +
    "🔖 Bookmarks: " + (stats.bookmarks || 0)
  );
}

function formatTargetsMessage(chatId) {
  const pt = pendingTargets[chatId] || {};
  const t = pt.targets || {};
  return (
    "🎯 <b>Set Raid Targets</b>\n\n" +
    "Tap each to set your target numbers:\n\n" +
    "❤️ Likes target: <b>" + (t.likes || 0) + "</b>\n" +
    "🔄 Retweets target: <b>" + (t.retweets || 0) + "</b>\n" +
    "💬 Replies target: <b>" + (t.replies || 0) + "</b>"
  );
}

function progressBar(current, target) {
  if (!target) return "⬜⬜⬜⬜⬜";
  const pct = Math.min(Math.floor((current / target) * 10), 10);
  const filled = pct >= 10 ? "🟩" : pct >= 5 ? "🟨" : "🟥";
  const empty = "⬜";
  return filled.repeat(pct) + empty.repeat(10 - pct);
}

function formatActiveRaid(r) {
  const t = r.targets || {};
  const p = r.progress || {};
  const likesPct = t.likes ? Math.floor(((p.likes || 0) / t.likes) * 100) : 0;
  const rtPct = t.retweets ? Math.floor(((p.retweets || 0) / t.retweets) * 100) : 0;
  const repPct = t.replies ? Math.floor(((p.replies || 0) / t.replies) * 100) : 0;

  return (
    "⚡️ <b>Raid Started!</b>\n\n" +
    (t.likes ? "🟥 Likes " + (p.likes || 0) + " | " + t.likes + " [" + likesPct + "%]\n" : "") +
    (t.retweets ? "🟥 Retweets " + (p.retweets || 0) + " | " + t.retweets + " [" + rtPct + "%]\n" : "") +
    (t.replies ? "🟥 Replies " + (p.replies || 0) + " | " + t.replies + " [" + repPct + "%]\n" : "") +
    "\n" + r.link + "\n\n" +
    "🔥 <b>Trending</b>\n\n" +
    "💬   🔄   ❤️   🗒️   👊\ncom  retw  like  addfld  all"
  );
}

function formatRaidStats(r) {
  const p = r.progress || {};
  const elapsed = Math.floor(((r.endedAt || Date.now()) - r.startedAt) / 60000);
  return (
    "📊 <b>Raid Results</b>\n\n" +
    "Duration: <b>" + elapsed + " min</b>\n" +
    "Raiders: <b>" + r.doneMemberIds.length + "</b>\n\n" +
    "❤️ Likes: <b>" + (p.likes || 0) + "</b>\n" +
    "🔄 Retweets: <b>" + (p.retweets || 0) + "</b>\n" +
    "💬 Replies: <b>" + (p.replies || 0) + "</b>\n" +
    "🔖 Bookmarks: <b>" + (p.bookmarks || 0) + "</b>"
  );
}

function formatLeaderboard(chatId, store) {
  const lb = store.getLeaderboard(chatId);
  if (!lb.length) return "No XP data yet. Start raiding!";
  const lines = lb.slice(0, 10).map(function(entry, i) {
    const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : (i + 1) + ".";
    return medal + " <b>" + entry.name + "</b> — " + entry.xp + " XP";
  });
  return "<b>🏆 Raid Leaderboard</b>\n\n" + lines.join("\n");
}

// ── Raid lifecycle ────────────────────────────────────────────

function initPendingRaid(chatId, link) {
  pendingTargets[chatId] = { link, targets: { likes: 0, retweets: 0, replies: 0 }, awaitingField: null };
}

function getPendingRaid(chatId) { return pendingTargets[chatId] || null; }

function startRaid(chatId, link, targets, startedBy) {
  const r = {
    chatId, link, type: detectType(link),
    targets: targets || {},
    progress: { likes: 0, retweets: 0, replies: 0, bookmarks: 0 },
    startedAt: Date.now(),
    startedBy,
    doneMemberIds: [],
    doneMembers: [],
    active: true,
    awaitingComment: {},
    messageId: null,
  };
  activeRaids[chatId] = r;
  delete pendingTargets[chatId];
  return r;
}

function endRaid(chatId) {
  const r = activeRaids[chatId];
  if (!r) return null;
  r.active = false;
  r.endedAt = Date.now();
  if (!raidHistory[chatId]) raidHistory[chatId] = [];
  raidHistory[chatId].push(r);
  delete activeRaids[chatId];
  return r;
}

function getRaid(chatId) { return activeRaids[chatId] || null; }

function markDone(chatId, userId, userName, tasks) {
  const r = activeRaids[chatId];
  if (!r) return false;
  if (r.doneMemberIds.includes(userId)) return "already";
  r.doneMemberIds.push(userId);
  r.doneMembers.push({ userId, name: userName, tasks: tasks || [] });
  return true;
}

function recordProgress(chatId, field, amount) {
  const r = activeRaids[chatId];
  if (!r) return;
  if (!r.progress) r.progress = {};
  r.progress[field] = (r.progress[field] || 0) + (amount || 1);
}

// Queue
function addToQueue(chatId, link, targets) {
  if (!raidQueue[chatId]) raidQueue[chatId] = [];
  raidQueue[chatId].push({ link, targets });
}

function getQueue(chatId) { return raidQueue[chatId] || []; }

function clearQueue(chatId) { raidQueue[chatId] = []; }

function removeFromQueue(chatId, idx) {
  if (!raidQueue[chatId]) return;
  raidQueue[chatId].splice(idx, 1);
}

module.exports = {
  initPendingRaid, getPendingRaid, pendingTargets,
  startRaid, endRaid, getRaid, markDone, recordProgress,
  raidOptionsKeyboard, targetsKeyboard, activeRaidKeyboard,
  formatRaidOptions, formatTargetsMessage, formatActiveRaid, formatRaidStats, formatLeaderboard,
  addToQueue, getQueue, clearQueue, removeFromQueue,
};
