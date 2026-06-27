/**
 * raid.js
 * Handles Twitter/X and Telegram raids with OAuth actions.
 */

const { InlineKeyboard } = require("grammy");
const xauth = require("./xauth");

const activeRaids = {};
const raidHistory = {};

function detectRaidType(link) {
  if (link.includes("twitter.com") || link.includes("x.com")) return "twitter";
  if (link.includes("t.me") || link.includes("telegram.me")) return "telegram";
  return "general";
}

function getRaidTypeLabel(type) {
  if (type === "twitter") return "Twitter/X Raid";
  if (type === "telegram") return "Telegram Raid";
  return "Raid";
}

function buildRaidKeyboard(type, link, chatId) {
  const kb = new InlineKeyboard();

  if (type === "twitter") {
    kb.text("Like", "xlike:" + chatId)
      .text("Retweet", "xrt:" + chatId)
      .row()
      .text("Comment", "xcomment:" + chatId)
      .text("Follow", "xfollow:" + chatId)
      .row();
  } else if (type === "telegram") {
    kb.url("Open Post", link).row();
  } else {
    kb.url("Open Link", link).row();
  }

  kb.text("Done!", "raid_done:" + chatId);
  return kb;
}

function formatRaidMessage(raid) {
  const type = getRaidTypeLabel(raid.type);
  const elapsed = Math.floor((Date.now() - raid.startedAt) / 60000);
  const remaining = Math.max(0, raid.durationMinutes - elapsed);
  const doneCount = raid.doneMemberIds.length;

  let lines = [];
  lines.push("RAID STARTED!");
  lines.push("");
  lines.push("Type: <b>" + type + "</b>");
  lines.push("Link: " + raid.link);
  lines.push("");

  if (raid.type === "twitter") {
    lines.push("<b>Tasks:</b>");
    lines.push("1. Like the post");
    lines.push("2. Retweet");
    lines.push("3. Leave a comment");
    lines.push("4. Follow the account");
    lines.push("");
    lines.push("<b>Connect your X account first:</b>");
    lines.push("/connectx - Link your X account");
    lines.push("");
    lines.push("Then tap the buttons below to complete tasks directly from Telegram!");
  } else {
    lines.push("<b>Tasks:</b>");
    lines.push("1. Open the post");
    lines.push("2. React to it");
    lines.push("3. Leave a comment");
  }

  lines.push("");
  lines.push("Raiders done: <b>" + doneCount + "</b>");
  lines.push("Time remaining: <b>" + remaining + " min</b>");

  return lines.join("\n");
}

function formatRaidStats(raid) {
  const doneCount = raid.doneMemberIds.length;
  const elapsed = Math.floor(((raid.endedAt || Date.now()) - raid.startedAt) / 60000);
  const type = getRaidTypeLabel(raid.type);

  let lines = [];
  lines.push("RAID RESULTS");
  lines.push("");
  lines.push("Type: <b>" + type + "</b>");
  lines.push("Duration: <b>" + elapsed + " min</b>");
  lines.push("Total Raiders: <b>" + doneCount + "</b>");
  lines.push("");

  if (raid.taskStats) {
    lines.push("<b>Task Breakdown:</b>");
    lines.push("Likes: <b>" + (raid.taskStats.likes || 0) + "</b>");
    lines.push("Retweets: <b>" + (raid.taskStats.retweets || 0) + "</b>");
    lines.push("Comments: <b>" + (raid.taskStats.comments || 0) + "</b>");
    lines.push("Follows: <b>" + (raid.taskStats.follows || 0) + "</b>");
    lines.push("");
  }

  if (raid.doneMembers && raid.doneMembers.length > 0) {
    lines.push("<b>Top Raiders:</b>");
    raid.doneMembers.slice(0, 10).forEach(function(m, i) {
      const tasks = m.tasks ? m.tasks.join(", ") : "done";
      lines.push((i + 1) + ". " + (m.name || "Unknown") + " - " + tasks);
    });
  }

  return lines.join("\n");
}

function formatLeaderboard(chatId) {
  const history = raidHistory[chatId] || [];
  if (!history.length) return "No raid history yet. Start one with /raid link";

  const counts = {};
  history.forEach(function(r) {
    (r.doneMembers || []).forEach(function(m) {
      if (!counts[m.userId]) counts[m.userId] = { name: m.name, raids: 0, likes: 0, retweets: 0, comments: 0, follows: 0 };
      counts[m.userId].raids++;
      if (m.tasks) {
        m.tasks.forEach(function(t) {
          if (t === "Like") counts[m.userId].likes++;
          if (t === "Retweet") counts[m.userId].retweets++;
          if (t === "Comment") counts[m.userId].comments++;
          if (t === "Follow") counts[m.userId].follows++;
        });
      }
    });
  });

  const sorted = Object.values(counts).sort(function(a, b) { return b.raids - a.raids; });

  let lines = [];
  lines.push("RAID LEADERBOARD");
  lines.push("Total Raids: <b>" + history.length + "</b>");
  lines.push("");

  sorted.slice(0, 10).forEach(function(entry, i) {
    lines.push((i + 1) + ". <b>" + entry.name + "</b> - " + entry.raids + " raids");
  });

  return lines.join("\n");
}

function startRaid(chatId, link, durationMinutes, startedBy) {
  const type = detectRaidType(link);
  const r = {
    chatId, link, type,
    durationMinutes: durationMinutes || 30,
    startedAt: Date.now(),
    startedBy,
    doneMemberIds: [],
    doneMembers: [],
    taskStats: { likes: 0, retweets: 0, comments: 0, follows: 0 },
    active: true,
    messageId: null,
  };
  activeRaids[chatId] = r;
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

function getRaid(chatId) {
  return activeRaids[chatId] || null;
}

function markDone(chatId, userId, userName, tasks) {
  const r = activeRaids[chatId];
  if (!r) return false;
  if (r.doneMemberIds.includes(userId)) return "already";

  r.doneMemberIds.push(userId);
  r.doneMembers.push({ userId, name: userName, tasks: tasks || [] });
  return true;
}

function recordTask(chatId, userId, task) {
  const r = activeRaids[chatId];
  if (!r) return;
  if (r.taskStats) r.taskStats[task] = (r.taskStats[task] || 0) + 1;

  // Update member task list
  const member = r.doneMembers.find(function(m) { return m.userId === userId; });
  if (member) {
    if (!member.tasks) member.tasks = [];
    if (!member.tasks.includes(task)) member.tasks.push(task);
  }
}

module.exports = {
  startRaid, endRaid, getRaid, markDone, recordTask,
  buildRaidKeyboard, formatRaidMessage, formatRaidStats, formatLeaderboard,
};
