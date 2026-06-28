require("dotenv").config();
const express = require("express");
const { Bot, InlineKeyboard } = require("grammy");
const { parseHeliusWebhook } = require("./parser");
const { formatBuyAlert, formatMilestoneAlert, formatWelcome } = require("./formatter");
const { getSolPrice, getTokenInfo, getMarketCap } = require("./data");
const { addMintToHelius, removeMintFromHelius } = require("./helius");
const store = require("./store");
const raid = require("./raid");
const xauth = require("./xauth");

const app = express();
app.use(express.json());

const bot = new Bot(process.env.BOT_TOKEN);
const SUPER_ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map((id) => id.trim());
const WEBHOOK_SECRET = process.env.HELIUS_WEBHOOK_SECRET || "";
const MILESTONE_COUNTS = [10, 25, 50, 100, 250, 500, 1000];
const BANNER_URL = process.env.BANNER_URL || "";

function isSuperAdmin(ctx) {
  return SUPER_ADMIN_IDS.includes(String(ctx.from?.id));
}

async function isGroupAdmin(ctx) {
  try {
    const member = await ctx.getChatMember(ctx.from.id);
    return ["administrator", "creator"].includes(member.status);
  } catch { return false; }
}

function isGroup(ctx) {
  return ["group", "supergroup"].includes(ctx.chat?.type);
}

function buildSettingsKeyboard(group) {
  const s = group.settings || {};
  const minBuy = s.minBuySol ?? 0.05;
  const whale = s.whaleSol ?? 10;
  const showPrice = s.showPrice !== false;
  const active = group.active;

  return new InlineKeyboard()
    .text("Min Buy: " + minBuy + " SOL", "set_minbuy")
    .text("Whale: " + whale + " SOL", "set_whale")
    .row()
    .text("Set Emoji", "set_emoji")
    .text("Set Banner", "set_banner")
    .row()
    .text((showPrice ? "ON" : "OFF") + " Show Price", "toggle_price")
    .text("Stats", "show_stats")
    .row()
    .text(active ? "Pause Alerts" : "Resume Alerts", "toggle_active")
    .text("Remove Token", "confirm_unregister");
}

function buildSettingsText(group) {
  const s = group.settings || {};
  return (
    "<b>NO BRAIN Buy Bot Settings</b>\n\n" +
    "Token: <b>" + group.tokenName + " [" + group.tokenSymbol + "]</b>\n" +
    "CA: <code>" + group.mint + "</code>\n\n" +
    "Min Buy: <b>" + (s.minBuySol ?? 0.05) + " SOL</b>\n" +
    "Whale Alert: <b>" + (s.whaleSol ?? 10) + " SOL</b>\n" +
    "Show Price: <b>" + (s.showPrice !== false ? "ON" : "OFF") + "</b>\n" +
    "Alerts: <b>" + (group.active ? "Active" : "Paused") + "</b>\n\n" +
    "<i>Tap a button to change settings</i>"
  );
}

// ── Bot joined a group ────────────────────────────────────────
bot.on("my_chat_member", async (ctx) => {
  const newStatus = ctx.myChatMember && ctx.myChatMember.new_chat_member ? ctx.myChatMember.new_chat_member.status : null;
  const chatId = String(ctx.chat.id);
  const chatTitle = ctx.chat.title || "your group";
  if (newStatus === "administrator" || newStatus === "member") {
    if (!["group", "supergroup"].includes(ctx.chat.type)) return;
    store.addGroup(chatId, { title: chatTitle, addedAt: Date.now(), mint: null, active: false });
    await bot.api.sendMessage(chatId, formatWelcome(chatTitle), { parse_mode: "HTML" });
  }
  if (newStatus === "kicked" || newStatus === "left") store.removeGroup(chatId);
});

// ── /start ────────────────────────────────────────────────────
bot.command("start", async (ctx) => {
  if (isGroup(ctx)) {
    const chatId = String(ctx.chat.id);
    const group = store.getGroup(chatId);
    if (group && group.mint) {
      return ctx.reply(
        "<b>NO BRAIN Buy Bot</b> is active!\n\nTracking: <b>" + group.tokenName + " [" + group.tokenSymbol + "]</b>\n\nUse /settings to customize.",
        { parse_mode: "HTML" }
      );
    }
    return ctx.reply("<b>NO BRAIN Buy Bot</b>\n\nSet your token:\n\n<code>/add YOUR_TOKEN_MINT</code>", { parse_mode: "HTML" });
  }
  ctx.reply(
    "<b>NO BRAIN Buy Bot</b>\n\nAdd me to your group as admin then use:\n\n<code>/add YOUR_TOKEN_MINT</code>",
    { parse_mode: "HTML" }
  );
});

// ── /add ─────────────────────────────────────────────────────
bot.command("add", async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply("Use this inside your group.");
  if (!(await isGroupAdmin(ctx))) return ctx.reply("Admins only.");
  const mint = ctx.message.text.split(" ")[1] ? ctx.message.text.split(" ")[1].trim() : null;
  if (!mint || mint.length < 32) return ctx.reply("Usage: <code>/add YOUR_MINT</code>", { parse_mode: "HTML" });
  const chatId = String(ctx.chat.id);
  const existing = store.getGroup(chatId);
  if (existing && existing.mint === mint) return ctx.reply("Already tracking this token.");
  await ctx.reply("Validating token info...");
  const info = await getTokenInfo(mint).catch(() => null);
  const tokenName = (info && info.name) ? info.name : mint.slice(0, 6);
  const tokenSymbol = (info && info.symbol) ? info.symbol : "???";
  const heliusOk = await addMintToHelius(mint);
  if (!heliusOk) return ctx.reply("Failed to register with Helius.");
  store.updateGroup(chatId, {
    mint, tokenName, tokenSymbol, active: true,
    registeredAt: Date.now(), totalBuys: 0, totalVolumeSol: 0,
    biggestBuy: 0, uniqueBuyers: [], milestones: 0,
    settings: { minBuySol: 0.05, whaleSol: 10, buyEmoji: "green", showPrice: true, bannerUrl: BANNER_URL },
  });
  store.addMintGroup(mint, chatId);
  console.log("[ADD] Registered mint", mint, "for chat", chatId);
  ctx.reply(
    "CA set successfully!\n\nToken: <b>" + tokenName + " [" + tokenSymbol + "]</b>\nCA: <code>" + mint + "</code>\n\nBuy alerts are LIVE!\n\nUse /settings to customize.",
    { parse_mode: "HTML" }
  );
});

// ── /remove ───────────────────────────────────────────────────
bot.command("remove", async (ctx) => {
  if (!isGroup(ctx) || !(await isGroupAdmin(ctx))) return ctx.reply("Admins only.");
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group || !group.mint) return ctx.reply("No token registered.");
  const mint = group.mint;
  store.removeMintGroup(mint, chatId);
  if (store.getGroupsForMint(mint).length === 0) await removeMintFromHelius(mint);
  store.updateGroup(chatId, { mint: null, active: false });
  ctx.reply("Stopped tracking <b>" + group.tokenName + "</b>.", { parse_mode: "HTML" });
});

// ── /settings ─────────────────────────────────────────────────
bot.command("settings", async (ctx) => {
  if (!isGroup(ctx) || !(await isGroupAdmin(ctx))) return ctx.reply("Admins only.");
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group || !group.mint) return ctx.reply("No token. Use /add first.");
  ctx.reply(buildSettingsText(group), { parse_mode: "HTML", reply_markup: buildSettingsKeyboard(group) });
});

// ── Settings callbacks ────────────────────────────────────────
bot.callbackQuery("toggle_active", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  if (!(await isGroupAdmin(ctx))) return;
  const group = store.getGroup(chatId);
  if (!group) return;
  store.updateGroup(chatId, { active: !group.active });
  const updated = store.getGroup(chatId);
  ctx.editMessageText(buildSettingsText(updated), { parse_mode: "HTML", reply_markup: buildSettingsKeyboard(updated) });
});

bot.callbackQuery("toggle_price", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  if (!(await isGroupAdmin(ctx))) return;
  const group = store.getGroup(chatId);
  if (!group) return;
  store.updateGroupSetting(chatId, "showPrice", group.settings && group.settings.showPrice === false ? true : false);
  const updated = store.getGroup(chatId);
  ctx.editMessageText(buildSettingsText(updated), { parse_mode: "HTML", reply_markup: buildSettingsKeyboard(updated) });
});

bot.callbackQuery("set_minbuy", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  if (!(await isGroupAdmin(ctx))) return;
  store.updateGroupSetting(chatId, "awaitingInput", "minBuySol");
  ctx.reply("Reply with min buy in SOL (e.g. <code>0.1</code>)", { parse_mode: "HTML" });
});

bot.callbackQuery("set_whale", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  if (!(await isGroupAdmin(ctx))) return;
  store.updateGroupSetting(chatId, "awaitingInput", "whaleSol");
  ctx.reply("Reply with whale threshold in SOL (e.g. <code>10</code>)", { parse_mode: "HTML" });
});

bot.callbackQuery("set_emoji", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  if (!(await isGroupAdmin(ctx))) return;
  store.updateGroupSetting(chatId, "awaitingInput", "buyEmoji");
  ctx.reply("Reply with your buy emoji");
});

bot.callbackQuery("set_banner", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  if (!(await isGroupAdmin(ctx))) return;
  store.updateGroupSetting(chatId, "awaitingInput", "bannerUrl");
  ctx.reply("Reply with your banner image URL (https://...)");
});

bot.callbackQuery("show_stats", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group) return;
  const solPrice = await getSolPrice();
  const usdVol = ((group.totalVolumeSol || 0) * solPrice).toFixed(0);
  ctx.reply(
    "<b>" + group.tokenName + " Stats</b>\n\nBuys: <b>" + (group.totalBuys || 0) + "</b>\nHolders: <b>" + (group.uniqueBuyers || []).length + "</b>\nVolume: <b>" + (group.totalVolumeSol || 0).toFixed(2) + " SOL ($" + usdVol + ")</b>",
    { parse_mode: "HTML" }
  );
});

bot.callbackQuery("confirm_unregister", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await isGroupAdmin(ctx))) return;
  const kb = new InlineKeyboard().text("Yes remove", "do_unregister").text("Cancel", "cancel_unregister");
  ctx.reply("Sure you want to remove your token?", { reply_markup: kb });
});

bot.callbackQuery("do_unregister", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  if (!(await isGroupAdmin(ctx))) return;
  const group = store.getGroup(chatId);
  if (!group || !group.mint) return;
  const mint = group.mint;
  store.removeMintGroup(mint, chatId);
  if (store.getGroupsForMint(mint).length === 0) await removeMintFromHelius(mint);
  store.updateGroup(chatId, { mint: null, active: false });
  ctx.editMessageText("Stopped tracking <b>" + group.tokenName + "</b>.", { parse_mode: "HTML" });
});

bot.callbackQuery("cancel_unregister", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.deleteMessage();
});

// ── X OAUTH COMMANDS ──────────────────────────────────────────
bot.command("connectx", async (ctx) => {
  const userId = String(ctx.from.id);
  const authUrl = xauth.buildAuthUrl(userId);
  const kb = new InlineKeyboard().url("Connect your X account", authUrl);
  ctx.reply(
    "Tap below to connect your X (Twitter) account. Once connected you can like, retweet, comment and follow directly from Telegram raids!",
    { reply_markup: kb }
  );
});

bot.command("xstatus", async (ctx) => {
  const userId = String(ctx.from.id);
  const user = xauth.getUser(userId);
  if (user) {
    ctx.reply("Connected as <b>@" + user.xUsername + "</b>\n\nUse /disconnectx to unlink.", { parse_mode: "HTML" });
  } else {
    ctx.reply("Not connected. Use /connectx to link your X account.");
  }
});

bot.command("disconnectx", async (ctx) => {
  const userId = String(ctx.from.id);
  if (!xauth.isConnected(userId)) return ctx.reply("No X account connected.");
  xauth.disconnectUser(userId);
  ctx.reply("X account disconnected.");
});

// ── RAID COMMANDS ─────────────────────────────────────────────
bot.command("raid", async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply("Use this in your group.");
  if (!(await isGroupAdmin(ctx))) return ctx.reply("Admins only.");
  const parts = ctx.message.text.split(" ");
  const link = parts[1] ? parts[1].trim() : null;
  const duration = parts[2] ? parseInt(parts[2]) : 30;
  if (!link || !link.startsWith("http")) {
    return ctx.reply("Usage: <code>/raid https://x.com/post/123 30</code>", { parse_mode: "HTML" });
  }
  const chatId = String(ctx.chat.id);
  const existing = raid.getRaid(chatId);
  if (existing) raid.endRaid(chatId);
  const startedBy = ctx.from.first_name || ctx.from.username || "Admin";
  const newRaid = raid.startRaid(chatId, link, duration, startedBy);
  const msg = raid.formatRaidMessage(newRaid);
  const kb = raid.buildRaidKeyboard(newRaid.type, link, chatId);
  const sent = await ctx.reply(msg, { parse_mode: "HTML", reply_markup: kb });
  newRaid.messageId = sent.message_id;
  setTimeout(async function() {
    const currentRaid = raid.getRaid(chatId);
    if (currentRaid && currentRaid.startedAt === newRaid.startedAt) {
      const ended = raid.endRaid(chatId);
      if (ended) await bot.api.sendMessage(chatId, raid.formatRaidStats(ended), { parse_mode: "HTML" });
    }
  }, duration * 60 * 1000);
});

bot.command("endraid", async (ctx) => {
  if (!isGroup(ctx) || !(await isGroupAdmin(ctx))) return ctx.reply("Admins only.");
  const chatId = String(ctx.chat.id);
  const currentRaid = raid.getRaid(chatId);
  if (!currentRaid) return ctx.reply("No active raid.");
  const ended = raid.endRaid(chatId);
  ctx.reply(raid.formatRaidStats(ended), { parse_mode: "HTML" });
});

bot.command("raidstats", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const currentRaid = raid.getRaid(chatId);
  if (!currentRaid) return ctx.reply("No active raid. Start one with /raid link");
  ctx.reply(raid.formatRaidStats(currentRaid), { parse_mode: "HTML" });
});

bot.command("raidlb", async (ctx) => {
  const chatId = String(ctx.chat.id);
  ctx.reply(raid.formatLeaderboard(chatId), { parse_mode: "HTML" });
});

bot.command("raiddone", async (ctx) => {
  if (!isGroup(ctx)) return;
  const chatId = String(ctx.chat.id);
  const userId = String(ctx.from.id);
  const userName = ctx.from.first_name || ctx.from.username || "Unknown";
  const currentRaid = raid.getRaid(chatId);
  if (!currentRaid) return ctx.reply("No active raid.");
  const result = raid.markDone(chatId, userId, userName, []);
  if (result === "already") return ctx.reply("You already marked yourself as done!");
  ctx.reply(userName + " completed the raid! Total raiders: " + currentRaid.doneMemberIds.length);
});

// ── X Action Callbacks ────────────────────────────────────────
bot.callbackQuery(/^xlike:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = ctx.callbackQuery.data.split(":")[1];
  const userId = String(ctx.from.id);
  const userName = ctx.from.first_name || "Unknown";
  if (!xauth.isConnected(userId)) {
    const authUrl = xauth.buildAuthUrl(userId);
    const kb = new InlineKeyboard().url("Connect X Account", authUrl);
    return ctx.reply("Connect your X account first!", { reply_markup: kb });
  }
  const currentRaid = raid.getRaid(chatId);
  if (!currentRaid) return ctx.reply("Raid has ended.");
  try {
    await xauth.likeTweet(userId, currentRaid.link);
    raid.recordTask(chatId, userId, "likes");
    raid.markDone(chatId, userId, userName, ["Like"]);
    ctx.reply(userName + " liked the tweet!");
  } catch (err) {
    ctx.reply("Failed to like: " + err.message);
  }
});

bot.callbackQuery(/^xrt:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = ctx.callbackQuery.data.split(":")[1];
  const userId = String(ctx.from.id);
  const userName = ctx.from.first_name || "Unknown";
  if (!xauth.isConnected(userId)) {
    const authUrl = xauth.buildAuthUrl(userId);
    const kb = new InlineKeyboard().url("Connect X Account", authUrl);
    return ctx.reply("Connect your X account first!", { reply_markup: kb });
  }
  const currentRaid = raid.getRaid(chatId);
  if (!currentRaid) return ctx.reply("Raid has ended.");
  try {
    await xauth.retweet(userId, currentRaid.link);
    raid.recordTask(chatId, userId, "retweets");
    raid.markDone(chatId, userId, userName, ["Retweet"]);
    ctx.reply(userName + " retweeted!");
  } catch (err) {
    ctx.reply("Failed to retweet: " + err.message);
  }
});

bot.callbackQuery(/^xcomment:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = ctx.callbackQuery.data.split(":")[1];
  const userId = String(ctx.from.id);
  if (!xauth.isConnected(userId)) {
    const authUrl = xauth.buildAuthUrl(userId);
    const kb = new InlineKeyboard().url("Connect X Account", authUrl);
    return ctx.reply("Connect your X account first!", { reply_markup: kb });
  }
  const currentRaid = raid.getRaid(chatId);
  if (!currentRaid) return ctx.reply("Raid has ended.");
  if (!currentRaid.awaitingComment) currentRaid.awaitingComment = {};
  currentRaid.awaitingComment[userId] = true;
  ctx.reply("Reply with your comment text and I will post it on X for you.");
});

bot.callbackQuery(/^xfollow:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = ctx.callbackQuery.data.split(":")[1];
  const userId = String(ctx.from.id);
  const userName = ctx.from.first_name || "Unknown";
  if (!xauth.isConnected(userId)) {
    const authUrl = xauth.buildAuthUrl(userId);
    const kb = new InlineKeyboard().url("Connect X Account", authUrl);
    return ctx.reply("Connect your X account first!", { reply_markup: kb });
  }
  const currentRaid = raid.getRaid(chatId);
  if (!currentRaid) return ctx.reply("Raid has ended.");
  try {
    await xauth.followUser(userId, currentRaid.link);
    raid.recordTask(chatId, userId, "follows");
    raid.markDone(chatId, userId, userName, ["Follow"]);
    ctx.reply(userName + " followed the account!");
  } catch (err) {
    ctx.reply("Failed to follow: " + err.message);
  }
});

bot.callbackQuery(/^raid_done:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = ctx.callbackQuery.data.split(":")[1];
  const userId = String(ctx.from.id);
  const userName = ctx.from.first_name || "Unknown";
  const currentRaid = raid.getRaid(chatId);
  if (!currentRaid) return ctx.reply("This raid has ended.");
  const result = raid.markDone(chatId, userId, userName, ["Done"]);
  if (result === "already") return ctx.answerCallbackQuery({ text: "Already done!", show_alert: true });
  ctx.reply(userName + " completed the raid! Total raiders: " + currentRaid.doneMemberIds.length);
});

// ── Handle text (settings + raid comments) ───────────────────
bot.on("message:text", async (ctx) => {
  if (!isGroup(ctx)) return;
  const chatId = String(ctx.chat.id);
  const userId = String(ctx.from.id);
  const userName = ctx.from.first_name || "Unknown";

  const currentRaid = raid.getRaid(chatId);
  if (currentRaid && currentRaid.awaitingComment && currentRaid.awaitingComment[userId]) {
    delete currentRaid.awaitingComment[userId];
    const commentText = ctx.message.text.trim();
    try {
      await xauth.commentTweet(userId, currentRaid.link, commentText);
      raid.recordTask(chatId, userId, "comments");
      raid.markDone(chatId, userId, userName, ["Comment"]);
      ctx.reply(userName + " commented on the tweet!");
    } catch (err) {
      ctx.reply("Failed to post comment: " + err.message);
    }
    return;
  }

  const group = store.getGroup(chatId);
  if (!group || !group.settings || !group.settings.awaitingInput) return;
  if (!(await isGroupAdmin(ctx))) return;

  const field = group.settings.awaitingInput;
  const text = ctx.message.text.trim();
  let value;
  if (field === "buyEmoji" || field === "bannerUrl") {
    value = text;
  } else {
    value = parseFloat(text);
    if (isNaN(value) || value < 0) return ctx.reply("Invalid value. Enter a number.");
  }
  store.updateGroupSetting(chatId, field, value);
  store.updateGroupSetting(chatId, "awaitingInput", null);
  ctx.reply("Updated! Use /settings to view.");
});

// ── Public commands ───────────────────────────────────────────
bot.command("stats", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group || !group.mint) return ctx.reply("No token. Use /add first.");
  const solPrice = await getSolPrice();
  const usdVol = ((group.totalVolumeSol || 0) * solPrice).toFixed(0);
  ctx.reply(
    "<b>" + group.tokenName + " [" + group.tokenSymbol + "] Stats</b>\n\nBuys: <b>" + (group.totalBuys || 0) + "</b>\nHolders: <b>" + (group.uniqueBuyers || []).length + "</b>\nVolume: <b>" + (group.totalVolumeSol || 0).toFixed(2) + " SOL ($" + usdVol + ")</b>\nBiggest Buy: <b>" + (group.biggestBuy || 0).toFixed(2) + " SOL</b>",
    { parse_mode: "HTML" }
  );
});

bot.command("help", (ctx) => {
  ctx.reply(
    "<b>NO BRAIN Buy Bot Commands</b>\n\n" +
    "<b>Buy Alerts</b>\n" +
    "/add CA - Track token buys\n" +
    "/remove - Remove token\n" +
    "/settings - Bot settings\n" +
    "/stats - Buy stats\n" +
    "/pause - Pause alerts\n" +
    "/resume - Resume alerts\n\n" +
    "<b>X Account</b>\n" +
    "/connectx - Link your X account\n" +
    "/xstatus - Check connection\n" +
    "/disconnectx - Unlink X account\n\n" +
    "<b>Raids</b>\n" +
    "/raid link [mins] - Start a raid\n" +
    "/endraid - End current raid\n" +
    "/raidstats - Raid progress\n" +
    "/raidlb - Raid leaderboard\n" +
    "/raiddone - Mark yourself done",
    { parse_mode: "HTML" }
  );
});

bot.command("pause", async (ctx) => {
  if (!isGroup(ctx) || !(await isGroupAdmin(ctx))) return ctx.reply("Admins only.");
  store.updateGroup(String(ctx.chat.id), { active: false });
  ctx.reply("Buy alerts paused.");
});

bot.command("resume", async (ctx) => {
  if (!isGroup(ctx) || !(await isGroupAdmin(ctx))) return ctx.reply("Admins only.");
  store.updateGroup(String(ctx.chat.id), { active: true });
  ctx.reply("Buy alerts resumed.");
});

bot.command("groups", (ctx) => {
  if (!isSuperAdmin(ctx)) return;
  const groups = store.getAllGroups();
  const keys = Object.keys(groups);
  if (!keys.length) return ctx.reply("No groups.");
  const lines = keys.map(function(id, i) {
    const g = groups[id];
    return (i + 1) + ". <b>" + g.title + "</b> - " + (g.tokenName || "No token") + " - Buys: " + (g.totalBuys || 0);
  });
  ctx.reply("<b>Groups (" + keys.length + ")</b>\n\n" + lines.join("\n"), { parse_mode: "HTML" });
});

// ── OAuth Callback ────────────────────────────────────────────
app.get("/auth/callback", async (req, res) => {
  const code = req.query.code;
  const state = req.query.state;
  const error = req.query.error;
  if (error) return res.send("<h2>Authorization denied.</h2><p>Close this window.</p>");
  if (!code || !state) return res.send("<h2>Invalid request.</h2>");
  try {
    const result = await xauth.exchangeCode(code, state);
    res.send("<h2>X account connected!</h2><p>Welcome @" + result.xUsername + "!</p><p>Close this window and go back to Telegram.</p>");
  } catch (err) {
    console.error("OAuth callback error:", err.message);
    res.send("<h2>Connection failed.</h2><p>" + err.message + "</p><p>Try /connectx again.</p>");
  }
});

// ── Helius Webhook ────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  if (WEBHOOK_SECRET) {
    const secret = req.headers["authorization"] || req.headers["x-helius-secret"];
    if (secret !== WEBHOOK_SECRET) return res.sendStatus(401);
  }
  res.sendStatus(200);

  const events = req.body;
  console.log("[WEBHOOK] Received", Array.isArray(events) ? events.length : 0, "events");

  if (!Array.isArray(events) || !events.length) return;

  const solPrice = await getSolPrice();

  for (const event of events) {
    try {
      console.log("[WEBHOOK] Event type:", event.type, "signature:", event.signature ? event.signature.slice(0, 20) : "none");

      const buy = parseHeliusWebhook(event);
      console.log("[WEBHOOK] Buy parsed:", buy ? "mint=" + buy.tokenMint + " sol=" + buy.solSpent : "null - not a buy");

      if (!buy) continue;

      const chatIds = store.getGroupsForMint(buy.tokenMint);
      console.log("[WEBHOOK] ChatIds for mint", buy.tokenMint, ":", chatIds);

      if (!chatIds.length) {
        console.log("[WEBHOOK] No groups tracking this mint");
        continue;
      }

      for (const chatId of chatIds) {
        const group = store.getGroup(chatId);
        console.log("[WEBHOOK] Group for chatId", chatId, ":", group ? "found active=" + group.active : "not found");

        if (!group || !group.active) continue;

        const s = group.settings || {};
        const minBuy = s.minBuySol ?? 0.05;
        const whaleSol = s.whaleSol ?? 10;

        console.log("[WEBHOOK] solSpent:", buy.solSpent, "minBuy:", minBuy);
        if (buy.solSpent !== null && buy.solSpent < minBuy) {
          console.log("[WEBHOOK] Buy below minimum, skipping");
          continue;
        }

        const isWhale = buy.solSpent !== null && buy.solSpent >= whaleSol;
        const isNewHolder = !(group.uniqueBuyers || []).includes(buy.buyer);

        store.recordGroupBuy(chatId, buy.solSpent || 0, buy.buyer);
        const updatedGroup = store.getGroup(chatId);

        const marketCap = await getMarketCap(buy.tokenMint).catch(() => null);

        const buyUrl = "https://jup.ag/swap/SOL-" + buy.tokenMint;
        const kb = new InlineKeyboard()
          .url("Buy", buyUrl)
          .url("Buy", buyUrl)
          .url("Buy", buyUrl);

        const msg = formatBuyAlert(buy, updatedGroup, solPrice, s, isWhale, isNewHolder, marketCap);

        const bannerUrl = s.bannerUrl || BANNER_URL;
        console.log("[WEBHOOK] Sending alert to chatId", chatId, "bannerUrl:", bannerUrl ? "set" : "none");

        if (bannerUrl) {
          try {
            await bot.api.sendPhoto(chatId, bannerUrl, { caption: msg, parse_mode: "HTML", reply_markup: kb });
            console.log("[WEBHOOK] Photo alert sent successfully");
          } catch (photoErr) {
            console.log("[WEBHOOK] Photo failed, sending text:", photoErr.message);
            await bot.api.sendMessage(chatId, msg, { parse_mode: "HTML", disable_web_page_preview: true, reply_markup: kb });
          }
        } else {
          await bot.api.sendMessage(chatId, msg, { parse_mode: "HTML", disable_web_page_preview: true, reply_markup: kb });
          console.log("[WEBHOOK] Text alert sent successfully");
        }

        const nextMilestoneIdx = updatedGroup.milestones || 0;
        if (nextMilestoneIdx < MILESTONE_COUNTS.length && updatedGroup.totalBuys >= MILESTONE_COUNTS[nextMilestoneIdx]) {
          const milestoneMsg = formatMilestoneAlert(updatedGroup, MILESTONE_COUNTS[nextMilestoneIdx], solPrice);
          await bot.api.sendMessage(chatId, milestoneMsg, { parse_mode: "HTML" });
          store.recordMilestone(chatId);
        }
      }
    } catch (err) {
      console.error("[WEBHOOK] Error:", err.message);
    }
  }
});

app.get("/", function(req, res) { res.send("NO BRAIN Buy Bot running"); });

// ── Buy Poller (fallback if webhooks not firing) ──────────────
const lastSigPerMint = {};

async function pollMintsForBuys() {
  const allGroups = store.getAllGroups();
  const mints = [...new Set(Object.values(allGroups).map(g => g.mint).filter(Boolean))];
  if (!mints.length) return;

  const solPrice = await getSolPrice().catch(() => 0);

  for (const mint of mints) {
    try {
      const url = "https://api.helius.xyz/v0/addresses/" + mint + "/transactions?api-key=" + process.env.HELIUS_API_KEY + "&limit=10&type=SWAP";
      const res = await fetch(url);
      const txs = await res.json();
      if (!Array.isArray(txs) || !txs.length) continue;

      const lastSig = lastSigPerMint[mint];
      let newTxs;
      if (!lastSig) {
        newTxs = [txs[0]];
      } else {
        const idx = txs.findIndex(t => t.signature === lastSig);
        newTxs = idx === -1 ? txs : txs.slice(0, idx);
      }
      lastSigPerMint[mint] = txs[0].signature;
      if (!newTxs.length) continue;

      console.log("[POLL] " + newTxs.length + " new tx(s) for mint", mint);

      for (const tx of newTxs.reverse()) {
        try {
          const buy = parseHeliusWebhook(tx);
          if (!buy) continue;

          const chatIds = store.getGroupsForMint(buy.tokenMint);
          if (!chatIds.length) continue;

          for (const chatId of chatIds) {
            const group = store.getGroup(chatId);
            if (!group || !group.active) continue;

            const s = group.settings || {};
            const minBuy = s.minBuySol ?? 0.05;
            const whaleSol = s.whaleSol ?? 10;

            if (buy.solSpent !== null && buy.solSpent < minBuy) continue;

            const isWhale = buy.solSpent !== null && buy.solSpent >= whaleSol;
            const isNewHolder = !(group.uniqueBuyers || []).includes(buy.buyer);

            store.recordGroupBuy(chatId, buy.solSpent || 0, buy.buyer);
            const updatedGroup = store.getGroup(chatId);

            const marketCap = await getMarketCap(buy.tokenMint).catch(() => null);
            const buyUrl = "https://jup.ag/swap/SOL-" + buy.tokenMint;
            const kb = new InlineKeyboard()
              .url("Buy", buyUrl)
              .url("Buy", buyUrl)
              .url("Buy", buyUrl);

            const msg = formatBuyAlert(buy, updatedGroup, solPrice, s, isWhale, isNewHolder, marketCap);
            const bannerUrl = s.bannerUrl || BANNER_URL;

            if (bannerUrl) {
              try {
                await bot.api.sendPhoto(chatId, bannerUrl, { caption: msg, parse_mode: "HTML", reply_markup: kb });
              } catch {
                await bot.api.sendMessage(chatId, msg, { parse_mode: "HTML", disable_web_page_preview: true, reply_markup: kb });
              }
            } else {
              await bot.api.sendMessage(chatId, msg, { parse_mode: "HTML", disable_web_page_preview: true, reply_markup: kb });
            }

            const nextMilestoneIdx = updatedGroup.milestones || 0;
            if (nextMilestoneIdx < MILESTONE_COUNTS.length && updatedGroup.totalBuys >= MILESTONE_COUNTS[nextMilestoneIdx]) {
              const milestoneMsg = formatMilestoneAlert(updatedGroup, MILESTONE_COUNTS[nextMilestoneIdx], solPrice);
              await bot.api.sendMessage(chatId, milestoneMsg, { parse_mode: "HTML" });
              store.recordMilestone(chatId);
            }
          }
        } catch (err) {
          console.error("[POLL] tx error:", err.message);
        }
      }
    } catch (err) {
      console.error("[POLL] mint error:", err.message);
    }
  }
}

// Start polling after 10s, then every 30s
setTimeout(function() {
  pollMintsForBuys();
  setInterval(pollMintsForBuys, 30000);
}, 10000);

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log("NO BRAIN Buy Bot on port " + PORT); });

// Delay bot polling start to allow previous Railway instance to terminate
console.log("[BOT] Waiting 5s for previous instance to exit...");
setTimeout(async () => {
  try {
    await bot.start({
      drop_pending_updates: true,
      onStart: (info) => console.log("[BOT] Started as @" + info.username),
    });
  } catch (err) {
    console.error("[BOT] Start error:", err.message);
    process.exit(1);
  }
}, 5000);
