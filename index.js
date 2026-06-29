require("dotenv").config();
const express = require("express");
const { Bot, InlineKeyboard } = require("grammy");
const { parseHeliusWebhook } = require("./parser");
const { formatBuyAlert, formatMilestoneAlert, formatWelcome, formatSpotlight, formatChannelListing } = require("./formatter");
const { getSolPrice, getTokenInfo, getMarketCap, getMarketData } = require("./data");
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
const MILESTONE_GIF = process.env.MILESTONE_GIF || "";
const SPOTLIGHT_GIF = process.env.SPOTLIGHT_GIF || "";
const BRAIN_CHANNEL = process.env.BRAIN_CHANNEL || "";
const HELIUS_RPC_URL = "https://mainnet.helius-rpc.com/?api-key=" + (process.env.HELIUS_API_KEY || "");

const wizardState = {};
const spotlightIntervals = {};

function isSuperAdmin(ctx) { return SUPER_ADMIN_IDS.includes(String(ctx.from?.id)); }

async function isGroupAdmin(ctx) {
  try { const m = await ctx.getChatMember(ctx.from.id); return ["administrator", "creator"].includes(m.status); }
  catch { return false; }
}

function isGroup(ctx) { return ["group", "supergroup"].includes(ctx.chat?.type); }
function isDM(ctx) { return ctx.chat?.type === "private"; }

// ── Require X connect helper ──────────────────────────────────
async function requireXConnect(ctx, userId, callback) {
  if (!xauth.isConnected(userId)) {
    const authUrl = xauth.buildAuthUrl(userId);
    const kb = new InlineKeyboard().url("🔗 Connect X Account", authUrl);
    await ctx.reply(
      "❌ You need to connect your X account first!\n\n" +
      "Tap the button below to connect, then try again.",
      { reply_markup: kb }
    );
    return false;
  }
  return true;
}

// ── Settings keyboard ─────────────────────────────────────────
function buildSettingsKeyboard(group) {
  const s = group.settings || {};
  const minBuy = s.minBuySol ?? 0.05;
  const whale = s.whaleSol ?? 10;
  const showPrice = s.showPrice !== false;
  const active = group.active;
  const whaleAlert = s.whaleAlert !== false;
  const ignoreMev = s.ignoreMev || false;

  return new InlineKeyboard()
    .text("Min Buy: " + minBuy + " SOL", "set_minbuy")
    .text("Whale: " + whale + " SOL", "set_whale")
    .row()
    .text("Set Emoji", "set_emoji")
    .text("Buy Image", "set_banner")
    .row()
    .text((showPrice ? "✅" : "⬜") + " Show Price", "toggle_price")
    .text((whaleAlert ? "✅" : "⬜") + " Whale Alert", "toggle_whale_alert")
    .row()
    .text((ignoreMev ? "✅" : "⬜") + " Ignore MEV", "toggle_mev")
    .text("📊 Stats", "show_stats")
    .row()
    .text("🔗 Set Links", "set_links")
    .text("🖼 Set Milestone GIF", "set_milestone_gif")
    .row()
    .text(active ? "⏸ Pause" : "▶️ Resume", "toggle_active")
    .text("❌ Remove Token", "confirm_unregister");
}

function buildSettingsText(group) {
  const s = group.settings || {};
  return (
    "<b>⚙️ NO BRAIN Buy Bot Settings</b>\n\n" +
    "Token: <b>" + group.tokenName + " [" + group.tokenSymbol + "]</b>\n" +
    "CA: <code>" + group.mint + "</code>\n\n" +
    "Min Buy: <b>" + (s.minBuySol ?? 0.05) + " SOL</b>\n" +
    "Whale Alert: <b>" + (s.whaleSol ?? 10) + " SOL</b>\n" +
    "Show Price: <b>" + (s.showPrice !== false ? "ON" : "OFF") + "</b>\n" +
    "Whale Alerts: <b>" + (s.whaleAlert !== false ? "ON" : "OFF") + "</b>\n" +
    "Ignore MEV: <b>" + (s.ignoreMev ? "ON" : "OFF") + "</b>\n" +
    "Alerts: <b>" + (group.active ? "🟢 Active" : "🔴 Paused") + "</b>\n\n" +
    "<i>Tap a button to change settings</i>"
  );
}

// ── Wizard ────────────────────────────────────────────────────
async function startWizard(userId, chatId, groupName, tokenName, tokenSymbol, mint) {
  wizardState[userId] = {
    chatId, groupName, tokenName, tokenSymbol, mint, step: "image",
    settings: { minBuySol: 0.05, buyEmoji: "🟢", showPrice: true, whaleAlert: true, ignoreMev: false, layout: 1 },
    bannerFileId: null,
  };
  try {
    await bot.api.sendMessage(userId,
      "<b>🧠 NO BRAIN Buy Bot Setup</b>\n\n" +
      "Token: <b>" + tokenName + " [" + tokenSymbol + "]</b>\n\n" +
      "<b>Step 1/7 — Buy Image</b>\n\nSend your buy alert image or GIF.\n\n<i>Or /skip</i>",
      { parse_mode: "HTML" }
    );
  } catch (e) { console.error("[WIZARD] DM failed:", e.message); }
}

async function wizardNext(userId, step) {
  const state = wizardState[userId];
  if (!state) return;
  state.step = step;
  const msgs = {
    minbuy: "<b>Step 2/7 — Min Buy</b>\n\nMinimum buy in SOL (e.g. <code>0.05</code>)\n\n<i>Or /skip</i>",
    emoji: "<b>Step 3/7 — Buy Emoji</b>\n\nSend your buy emoji (e.g. 🟢 🚀 💎 🔥)\n\n<i>Or /skip</i>",
    tglink: "<b>Step 4/7 — Telegram Link</b>\n\nYour group invite link\n\n<i>Or /skip</i>",
    xlink: "<b>Step 5/7 — X Link</b>\n\nYour X profile link\n\n<i>Or /skip</i>",
    website: "<b>Step 6/7 — Website</b>\n\nYour website URL\n\n<i>Or /skip</i>",
    layout: "<b>Step 7/7 — Layout</b>\n\nChoose buy alert style:",
  };
  if (msgs[step]) {
    const kb = step === "layout" ? new InlineKeyboard().text("Layout 1 - Classic", "wizard_layout_1").row().text("Layout 2 - Minimal", "wizard_layout_2").row().text("Layout 3 - Hype", "wizard_layout_3") : null;
    await bot.api.sendMessage(userId, msgs[step], { parse_mode: "HTML", reply_markup: kb || undefined });
  }
}

function buildWizardSummary(state) {
  const s = state.settings || {};
  return (
    "<b>📋 Setup Summary</b>\n\n" +
    "Token: <b>" + state.tokenName + " [" + state.tokenSymbol + "]</b>\n" +
    "Group: <b>" + state.groupName + "</b>\n\n" +
    "Min Buy: <b>" + (s.minBuySol || 0.05) + " SOL</b>\n" +
    "Emoji: <b>" + (s.buyEmoji || "🟢") + "</b>\n" +
    "Layout: <b>" + (s.layout || 1) + "</b>\n" +
    (s.tgLink ? "TG: " + s.tgLink + "\n" : "") +
    (s.xLink ? "X: " + s.xLink + "\n" : "") +
    (s.website ? "Web: " + s.website + "\n" : "") +
    "\n<i>Tap Confirm to go live!</i>"
  );
}

// ── Spotlight system ──────────────────────────────────────────
async function postSpotlight(chatId) {
  const group = store.getGroup(chatId);
  if (!group || !group.mint || !group.active) return;
  const [solPrice, marketData] = await Promise.all([getSolPrice(), getMarketData(group.mint)]);
  const msg = formatSpotlight(group, marketData, solPrice);
  const s = group.settings || {};
  const gifUrl = s.spotlightGif || SPOTLIGHT_GIF;
  try {
    let sent;
    if (gifUrl) {
      sent = await bot.api.sendAnimation(chatId, gifUrl, { caption: msg, parse_mode: "HTML" });
    } else {
      sent = await bot.api.sendMessage(chatId, msg, { parse_mode: "HTML" });
    }
    // Pin it
    try { await bot.api.pinChatMessage(chatId, sent.message_id, { disable_notification: true }); } catch {}
  } catch (e) { console.error("[SPOTLIGHT] Error:", e.message); }
}

function startSpotlight(chatId) {
  if (spotlightIntervals[chatId]) clearInterval(spotlightIntervals[chatId]);
  spotlightIntervals[chatId] = setInterval(function() { postSpotlight(chatId); }, 60 * 60 * 1000);
  // Post immediately too
  postSpotlight(chatId);
}

// ── Buy alert sender ──────────────────────────────────────────
async function sendBuyAlert(buy, chatId, solPrice) {
  const group = store.getGroup(chatId);
  if (!group || !group.active) return;
  const s = group.settings || {};
  const minBuy = s.minBuySol ?? 0.05;
  const whaleSol = s.whaleSol ?? 10;
  if (s.ignoreMev && buy.solSpent !== null && buy.solSpent < 0.001) return;
  if (buy.solSpent !== null && buy.solSpent < minBuy) return;

  const isWhale = buy.solSpent !== null && buy.solSpent >= whaleSol;
  const isNewHolder = !(group.uniqueBuyers || []).includes(buy.buyer);
  store.recordGroupBuy(chatId, buy.solSpent || 0, buy.buyer);
  const updatedGroup = store.getGroup(chatId);
  const marketCap = await getMarketCap(buy.tokenMint).catch(function() { return null; });

  const buyUrl = "https://jup.ag/swap/SOL-" + buy.tokenMint;
  const kb = new InlineKeyboard()
    .url("🟢 Buy", buyUrl)
    .url("📊 Chart", "https://dexscreener.com/solana/" + buy.tokenMint)
    .url("🐦 Bird", "https://birdeye.so/token/" + buy.tokenMint);

  const msg = formatBuyAlert(buy, updatedGroup, solPrice, s, isWhale, isNewHolder, marketCap);
  const bannerFileId = group.bannerFileId || null;
  const bannerUrl = s.bannerUrl || BANNER_URL;

  if (bannerFileId) {
    try { await bot.api.sendPhoto(chatId, bannerFileId, { caption: msg, parse_mode: "HTML", reply_markup: kb }); }
    catch { await bot.api.sendMessage(chatId, msg, { parse_mode: "HTML", disable_web_page_preview: true, reply_markup: kb }); }
  } else if (bannerUrl) {
    try { await bot.api.sendPhoto(chatId, bannerUrl, { caption: msg, parse_mode: "HTML", reply_markup: kb }); }
    catch { await bot.api.sendMessage(chatId, msg, { parse_mode: "HTML", disable_web_page_preview: true, reply_markup: kb }); }
  } else {
    await bot.api.sendMessage(chatId, msg, { parse_mode: "HTML", disable_web_page_preview: true, reply_markup: kb });
  }

  if (isWhale && s.whaleAlert !== false) {
    await bot.api.sendMessage(chatId,
      "🐳 <b>WHALE ALERT!</b>\n\n" + buy.buyer.slice(0, 6) + "..." + buy.buyer.slice(-4) + " just bought <b>" + (buy.solSpent || 0).toFixed(2) + " SOL</b> of " + group.tokenName + "!",
      { parse_mode: "HTML" }
    );
  }

  const nextMilestoneIdx = updatedGroup.milestones || 0;
  if (nextMilestoneIdx < MILESTONE_COUNTS.length && updatedGroup.totalBuys >= MILESTONE_COUNTS[nextMilestoneIdx]) {
    const milestoneMsg = formatMilestoneAlert(updatedGroup, MILESTONE_COUNTS[nextMilestoneIdx], solPrice);
    const milestoneGif = s.milestoneGif || MILESTONE_GIF;
    if (milestoneGif) {
      try { await bot.api.sendAnimation(chatId, milestoneGif, { caption: milestoneMsg, parse_mode: "HTML" }); }
      catch { await bot.api.sendMessage(chatId, milestoneMsg, { parse_mode: "HTML" }); }
    } else if (bannerFileId) {
      try { await bot.api.sendPhoto(chatId, bannerFileId, { caption: milestoneMsg, parse_mode: "HTML" }); }
      catch { await bot.api.sendMessage(chatId, milestoneMsg, { parse_mode: "HTML" }); }
    } else {
      await bot.api.sendMessage(chatId, milestoneMsg, { parse_mode: "HTML" });
    }
    store.recordMilestone(chatId);
  }
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

// ── Welcome new members ───────────────────────────────────────
bot.on("chat_member", async (ctx) => {
  const newMember = ctx.chatMember && ctx.chatMember.new_chat_member ? ctx.chatMember.new_chat_member : null;
  if (!newMember || newMember.status !== "member") return;
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group) return;
  const user = newMember.user;
  const name = user.first_name + (user.last_name ? " " + user.last_name : "");
  const s = group.settings || {};
  const msg =
    "👋 Welcome <b>" + name + "</b> to <b>" + (ctx.chat.title || "the group") + "</b>!\n\n" +
    (group.mint ? "🧠 Tracking <b>" + group.tokenName + " [" + group.tokenSymbol + "]</b>\n\n" : "") +
    (s.tgLink ? "📢 <a href='" + s.tgLink + "'>Join TG</a>  " : "") +
    (s.xLink ? "🐦 <a href='" + s.xLink + "'>Follow X</a>  " : "") +
    (s.website ? "🌐 <a href='" + s.website + "'>Website</a>" : "") +
    "\n\n<i>Buy alerts are LIVE! 🔔</i>";
  if (group.bannerFileId) {
    try { await bot.api.sendPhoto(chatId, group.bannerFileId, { caption: msg, parse_mode: "HTML" }); return; } catch {}
  }
  await bot.api.sendMessage(chatId, msg, { parse_mode: "HTML", disable_web_page_preview: true });
});

// ── /start ────────────────────────────────────────────────────
bot.command("start", async (ctx) => {
  if (isGroup(ctx)) {
    const chatId = String(ctx.chat.id);
    const group = store.getGroup(chatId);
    if (group && group.mint) {
      return ctx.reply("<b>🧠 NO BRAIN Buy Bot</b> is active!\n\nTracking: <b>" + group.tokenName + " [" + group.tokenSymbol + "]</b>\n\nUse /settings to customize.", { parse_mode: "HTML" });
    }
    return ctx.reply("<b>🧠 NO BRAIN Buy Bot</b>\n\nSet your token:\n\n<code>/add YOUR_TOKEN_MINT</code>", { parse_mode: "HTML" });
  }
  ctx.reply("<b>🧠 NO BRAIN Buy Bot</b>\n\nAdd me to your group as admin then:\n\n<code>/add YOUR_TOKEN_MINT</code>\n\nType /help for all commands.", { parse_mode: "HTML" });
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
  await ctx.reply("🔍 Validating token...");
  const info = await getTokenInfo(mint).catch(() => null);
  const tokenName = (info && info.name) ? info.name : mint.slice(0, 6);
  const tokenSymbol = (info && info.symbol) ? info.symbol : "???";
  await addMintToHelius(mint);
  store.updateGroup(chatId, {
    mint, tokenName, tokenSymbol, active: true,
    registeredAt: Date.now(), totalBuys: 0, totalVolumeSol: 0,
    biggestBuy: 0, uniqueBuyers: [], milestones: 0,
    settings: { minBuySol: 0.05, whaleSol: 10, buyEmoji: "🟢", showPrice: true, whaleAlert: true, ignoreMev: false, layout: 1 },
  });
  store.addMintGroup(mint, chatId);
  console.log("[ADD] mint=" + mint + " chat=" + chatId);

  await ctx.reply(
    "✅ <b>CA set successfully!</b>\n\nToken: <b>" + tokenName + " [" + tokenSymbol + "]</b>\nCA: <code>" + mint + "</code>\n\nBuy alerts are LIVE! 🚀\n\n<b>Check your DM to complete setup</b>",
    { parse_mode: "HTML" }
  );

  // Start hourly spotlight
  startSpotlight(chatId);

  // DM wizard
  await startWizard(String(ctx.from.id), chatId, ctx.chat.title || "your group", tokenName, tokenSymbol, mint);
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
  if (spotlightIntervals[chatId]) { clearInterval(spotlightIntervals[chatId]); delete spotlightIntervals[chatId]; }
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

bot.callbackQuery("toggle_whale_alert", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  if (!(await isGroupAdmin(ctx))) return;
  const group = store.getGroup(chatId);
  if (!group) return;
  store.updateGroupSetting(chatId, "whaleAlert", group.settings && group.settings.whaleAlert === false ? true : false);
  const updated = store.getGroup(chatId);
  ctx.editMessageText(buildSettingsText(updated), { parse_mode: "HTML", reply_markup: buildSettingsKeyboard(updated) });
});

bot.callbackQuery("toggle_mev", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  if (!(await isGroupAdmin(ctx))) return;
  const group = store.getGroup(chatId);
  if (!group) return;
  store.updateGroupSetting(chatId, "ignoreMev", !(group.settings && group.settings.ignoreMev));
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
  ctx.reply("Reply with your buy emoji (e.g. 🟢 🚀 💎)");
});

bot.callbackQuery("set_banner", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  if (!(await isGroupAdmin(ctx))) return;
  store.updateGroupSetting(chatId, "awaitingInput", "bannerPhoto");
  ctx.reply("Send your buy alert image or GIF now.");
});

bot.callbackQuery("set_milestone_gif", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  if (!(await isGroupAdmin(ctx))) return;
  store.updateGroupSetting(chatId, "awaitingInput", "milestoneGif");
  ctx.reply("Send your milestone GIF or image now, or reply with a URL.");
});

bot.callbackQuery("set_links", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  if (!(await isGroupAdmin(ctx))) return;
  store.updateGroupSetting(chatId, "awaitingInput", "tgLink");
  ctx.reply("Send your Telegram group link (or /skip):");
});

bot.callbackQuery("show_stats", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group) return;
  const solPrice = await getSolPrice();
  const usdVol = ((group.totalVolumeSol || 0) * solPrice).toFixed(0);
  ctx.reply(
    "<b>📊 " + group.tokenName + " Stats</b>\n\nBuys: <b>" + (group.totalBuys || 0) + "</b>\nHolders: <b>" + (group.uniqueBuyers || []).length + "</b>\nVolume: <b>" + (group.totalVolumeSol || 0).toFixed(2) + " SOL ($" + usdVol + ")</b>\nBiggest: <b>" + (group.biggestBuy || 0).toFixed(2) + " SOL</b>",
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

// ── Wizard callbacks ──────────────────────────────────────────
bot.callbackQuery(/^wizard_layout_/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = String(ctx.from.id);
  const state = wizardState[userId];
  if (!state) return;
  state.settings.layout = parseInt(ctx.callbackQuery.data.replace("wizard_layout_", ""));
  state.step = "confirm";
  await ctx.reply(buildWizardSummary(state), {
    parse_mode: "HTML",
    reply_markup: new InlineKeyboard().text("✅ Confirm & Go Live", "wizard_confirm").row().text("✏️ Edit", "wizard_edit"),
  });
});

bot.callbackQuery("wizard_confirm", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = String(ctx.from.id);
  const state = wizardState[userId];
  if (!state) return ctx.reply("Setup expired. Run /add again.");
  const s = state.settings;
  store.updateGroup(state.chatId, { bannerFileId: state.bannerFileId || null });
  ["minBuySol", "buyEmoji", "showPrice", "whaleAlert", "ignoreMev", "layout", "tgLink", "xLink", "website"].forEach(function(k) {
    if (s[k] !== undefined) store.updateGroupSetting(state.chatId, k, s[k]);
  });

  const marketCap = await getMarketCap(state.mint).catch(() => null);
  const solPrice = await getSolPrice();
  const channelMsg = formatChannelListing(state.tokenName, state.tokenSymbol, state.mint, marketCap, solPrice, s);

  if (BRAIN_CHANNEL) {
    try {
      if (state.bannerFileId) {
        await bot.api.sendPhoto(BRAIN_CHANNEL, state.bannerFileId, { caption: channelMsg, parse_mode: "HTML" });
      } else {
        await bot.api.sendMessage(BRAIN_CHANNEL, channelMsg, { parse_mode: "HTML", disable_web_page_preview: true });
      }
    } catch (e) { console.error("[WIZARD] Channel post error:", e.message); }
  }

  await ctx.reply("✅ <b>Settings saved! Buy alerts are LIVE in your group!</b>", { parse_mode: "HTML" });
  delete wizardState[userId];
});

bot.callbackQuery("wizard_edit", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = String(ctx.from.id);
  const state = wizardState[userId];
  if (!state) return;
  state.step = "image";
  await ctx.reply("Send your buy image (or /skip):");
});

// ── X OAuth ───────────────────────────────────────────────────
bot.command("connectx", async (ctx) => {
  const userId = String(ctx.from.id);
  const authUrl = xauth.buildAuthUrl(userId);
  const kb = new InlineKeyboard().url("🔗 Connect X Account", authUrl);
  ctx.reply("Tap below to connect your X account. Once connected you can like, retweet, comment and bookmark directly from Telegram!", { reply_markup: kb });
});

bot.command("login", async (ctx) => {
  const userId = String(ctx.from.id);
  const authUrl = xauth.buildAuthUrl(userId);
  const kb = new InlineKeyboard().url("🔗 Login with X", authUrl);
  ctx.reply("Tap below to link your Twitter/X account:", { reply_markup: kb });
});

bot.command("logout", async (ctx) => {
  const userId = String(ctx.from.id);
  if (!xauth.isConnected(userId)) return ctx.reply("No X account connected.");
  xauth.disconnectUser(userId);
  ctx.reply("X account disconnected.");
});

bot.command("xstatus", async (ctx) => {
  const userId = String(ctx.from.id);
  const user = xauth.getUser(userId);
  if (user) { ctx.reply("✅ Connected as <b>@" + user.xUsername + "</b>\n\nUse /logout to unlink.", { parse_mode: "HTML" }); }
  else { ctx.reply("❌ Not connected. Use /connectx or /login to link your X account."); }
});

// ── RAID COMMANDS ─────────────────────────────────────────────

bot.command("raid", async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply("Use this in your group.");
  if (!(await isGroupAdmin(ctx))) return ctx.reply("Admins only.");

  const parts = ctx.message.text.split(" ");
  const link = parts[1] ? parts[1].trim() : null;
  const chatId = String(ctx.chat.id);

  if (!link || !link.startsWith("http")) {
    return ctx.reply("Usage: <code>/raid https://x.com/post/123</code>", { parse_mode: "HTML" });
  }

  // Init pending raid
  raid.initPendingRaid(chatId, link);

  // Fetch tweet stats
  const tweetStats = await xauth.getTweetStats(link).catch(() => null);

  const msg = raid.formatRaidOptions(link, tweetStats);
  const kb = raid.raidOptionsKeyboard(chatId);

  await ctx.reply(msg, { parse_mode: "HTML", reply_markup: kb });
});

// Raid options callbacks
bot.callbackQuery(/^raid_start:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = ctx.callbackQuery.data.split(":")[1];
  if (!(await isGroupAdmin(ctx))) return;

  const pending = raid.getPendingRaid(chatId);
  if (!pending) return ctx.reply("No raid configured. Use /raid first.");

  const startedBy = ctx.from.first_name || "Admin";
  const activeRaid = raid.startRaid(chatId, pending.link, pending.targets, startedBy);

  const msg = raid.formatActiveRaid(activeRaid);
  const kb = raid.activeRaidKeyboard(chatId);
  const sent = await ctx.reply(msg, { parse_mode: "HTML", reply_markup: kb });
  activeRaid.messageId = sent.message_id;
});

bot.callbackQuery(/^raid_targets:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = ctx.callbackQuery.data.split(":")[1];
  if (!(await isGroupAdmin(ctx))) return;

  const pending = raid.getPendingRaid(chatId);
  if (!pending) { raid.initPendingRaid(chatId, ""); }

  const msg = raid.formatTargetsMessage(chatId);
  const kb = raid.targetsKeyboard(chatId);
  ctx.reply(msg, { parse_mode: "HTML", reply_markup: kb });
});

bot.callbackQuery(/^raid_lock:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = ctx.callbackQuery.data.split(":")[1];
  if (!(await isGroupAdmin(ctx))) return;
  try {
    await bot.api.restrictChatMember(chatId, ctx.from.id, { permissions: {} });
    ctx.reply("🔒 Chat locked. Only admins can send messages.");
  } catch (e) {
    ctx.reply("Could not lock chat: " + e.message);
  }
});

bot.callbackQuery(/^raid_close:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = ctx.callbackQuery.data.split(":")[1];
  if (!(await isGroupAdmin(ctx))) return;
  delete raid.pendingTargets[chatId];
  ctx.deleteMessage();
});

bot.callbackQuery(/^raid_back:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = ctx.callbackQuery.data.split(":")[1];
  const pending = raid.getPendingRaid(chatId);
  if (!pending) return;
  const tweetStats = await xauth.getTweetStats(pending.link).catch(() => null);
  const msg = raid.formatRaidOptions(pending.link, tweetStats);
  const kb = raid.raidOptionsKeyboard(chatId);
  ctx.editMessageText(msg, { parse_mode: "HTML", reply_markup: kb });
});

// Target callbacks
bot.callbackQuery(/^target_likes:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = ctx.callbackQuery.data.split(":")[1];
  if (!(await isGroupAdmin(ctx))) return;
  const pt = raid.pendingTargets[chatId];
  if (pt) pt.awaitingField = "likes";
  ctx.reply("Enter target number for Likes:");
});

bot.callbackQuery(/^target_retweets:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = ctx.callbackQuery.data.split(":")[1];
  if (!(await isGroupAdmin(ctx))) return;
  const pt = raid.pendingTargets[chatId];
  if (pt) pt.awaitingField = "retweets";
  ctx.reply("Enter target number for Retweets:");
});

bot.callbackQuery(/^target_replies:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = ctx.callbackQuery.data.split(":")[1];
  if (!(await isGroupAdmin(ctx))) return;
  const pt = raid.pendingTargets[chatId];
  if (pt) pt.awaitingField = "replies";
  ctx.reply("Enter target number for Replies:");
});

bot.callbackQuery(/^target_save:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = ctx.callbackQuery.data.split(":")[1];
  if (!(await isGroupAdmin(ctx))) return;
  const pending = raid.getPendingRaid(chatId);
  if (!pending) return;
  ctx.reply(
    "✅ Targets saved!\n\n" +
    "❤️ Likes: " + (pending.targets.likes || 0) + "\n" +
    "🔄 Retweets: " + (pending.targets.retweets || 0) + "\n" +
    "💬 Replies: " + (pending.targets.replies || 0) + "\n\n" +
    "Now tap <b>Start Raid</b> to begin!",
    {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text("⚡️ Start Raid ⚡️", "raid_start:" + chatId),
    }
  );
});

// Active raid action callbacks
bot.callbackQuery(/^xlike:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = ctx.callbackQuery.data.split(":")[1];
  const userId = String(ctx.from.id);
  const userName = ctx.from.first_name || "Unknown";
  if (!(await requireXConnect(ctx, userId, null))) return;
  const currentRaid = raid.getRaid(chatId);
  if (!currentRaid) return ctx.reply("No active raid.");
  try {
    await xauth.likeTweet(userId, currentRaid.link);
    raid.recordProgress(chatId, "likes");
    raid.markDone(chatId, userId, userName, ["Like"]);
    store.addXP(chatId, userId, userName, 10);
    ctx.reply("❤️ " + userName + " liked the tweet! +10 XP");
  } catch (err) { ctx.reply("Failed: " + err.message); }
});

bot.callbackQuery(/^xrt:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = ctx.callbackQuery.data.split(":")[1];
  const userId = String(ctx.from.id);
  const userName = ctx.from.first_name || "Unknown";
  if (!(await requireXConnect(ctx, userId, null))) return;
  const currentRaid = raid.getRaid(chatId);
  if (!currentRaid) return ctx.reply("No active raid.");
  try {
    await xauth.retweet(userId, currentRaid.link);
    raid.recordProgress(chatId, "retweets");
    raid.markDone(chatId, userId, userName, ["Retweet"]);
    store.addXP(chatId, userId, userName, 15);
    ctx.reply("🔄 " + userName + " retweeted! +15 XP");
  } catch (err) { ctx.reply("Failed: " + err.message); }
});

bot.callbackQuery(/^xcomment:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = ctx.callbackQuery.data.split(":")[1];
  const userId = String(ctx.from.id);
  if (!(await requireXConnect(ctx, userId, null))) return;
  const currentRaid = raid.getRaid(chatId);
  if (!currentRaid) return ctx.reply("No active raid.");
  if (!currentRaid.awaitingComment) currentRaid.awaitingComment = {};
  currentRaid.awaitingComment[userId] = true;
  ctx.reply("💬 Reply with your comment text and I will post it on X for you.");
});

bot.callbackQuery(/^xbookmark:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = ctx.callbackQuery.data.split(":")[1];
  const userId = String(ctx.from.id);
  const userName = ctx.from.first_name || "Unknown";
  if (!(await requireXConnect(ctx, userId, null))) return;
  const currentRaid = raid.getRaid(chatId);
  if (!currentRaid) return ctx.reply("No active raid.");
  try {
    await xauth.bookmarkTweet(userId, currentRaid.link);
    raid.recordProgress(chatId, "bookmarks");
    raid.markDone(chatId, userId, userName, ["Bookmark"]);
    store.addXP(chatId, userId, userName, 5);
    ctx.reply("🗒️ " + userName + " bookmarked! +5 XP");
  } catch (err) { ctx.reply("Failed: " + err.message); }
});

bot.callbackQuery(/^xall:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = ctx.callbackQuery.data.split(":")[1];
  const userId = String(ctx.from.id);
  const userName = ctx.from.first_name || "Unknown";
  if (!(await requireXConnect(ctx, userId, null))) return;
  const currentRaid = raid.getRaid(chatId);
  if (!currentRaid) return ctx.reply("No active raid.");

  let done = [];
  let failed = [];
  try { await xauth.likeTweet(userId, currentRaid.link); done.push("❤️ Like"); } catch { failed.push("Like"); }
  try { await xauth.retweet(userId, currentRaid.link); done.push("🔄 Retweet"); } catch { failed.push("Retweet"); }
  try { await xauth.bookmarkTweet(userId, currentRaid.link); done.push("🗒️ Bookmark"); } catch { failed.push("Bookmark"); }

  raid.recordProgress(chatId, "likes");
  raid.recordProgress(chatId, "retweets");
  raid.recordProgress(chatId, "bookmarks");
  raid.markDone(chatId, userId, userName, done);
  store.addXP(chatId, userId, userName, 30);

  ctx.reply("👊 " + userName + " did all actions! +30 XP\n" + done.join(", ") + (failed.length ? "\nFailed: " + failed.join(", ") : ""));

  // Prompt for comment
  if (!currentRaid.awaitingComment) currentRaid.awaitingComment = {};
  currentRaid.awaitingComment[userId] = true;
  ctx.reply("💬 Now reply with your comment for X (or /skip):");
});

bot.command("stop", async (ctx) => {
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
  if (!currentRaid) return ctx.reply("No active raid.");
  ctx.reply(raid.formatRaidStats(currentRaid), { parse_mode: "HTML" });
});

bot.command("lb", async (ctx) => {
  const chatId = String(ctx.chat.id);
  ctx.reply(raid.formatLeaderboard(chatId, store), { parse_mode: "HTML" });
});

bot.command("leaderboard", async (ctx) => {
  const chatId = String(ctx.chat.id);
  ctx.reply(raid.formatLeaderboard(chatId, store), { parse_mode: "HTML" });
});

bot.command("lbreset", async (ctx) => {
  if (!isGroup(ctx) || !(await isGroupAdmin(ctx))) return ctx.reply("Admins only.");
  store.resetLeaderboard(String(ctx.chat.id));
  ctx.reply("Leaderboard reset!");
});

bot.command("xp", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const userId = String(ctx.from.id);
  const xp = store.getXP(chatId, userId);
  ctx.reply("Your XP: <b>" + xp + "</b>", { parse_mode: "HTML" });
});

// Queue commands
bot.command("next", async (ctx) => {
  if (!isGroup(ctx) || !(await isGroupAdmin(ctx))) return ctx.reply("Admins only.");
  const parts = ctx.message.text.split(" ");
  const link = parts[1];
  if (!link) return ctx.reply("Usage: /next <link>");
  const chatId = String(ctx.chat.id);
  raid.addToQueue(chatId, link, {});
  const q = raid.getQueue(chatId);
  ctx.reply("Added to queue. Queue size: " + q.length);
});

bot.command("clearnext", async (ctx) => {
  if (!isGroup(ctx) || !(await isGroupAdmin(ctx))) return ctx.reply("Admins only.");
  raid.clearQueue(String(ctx.chat.id));
  ctx.reply("Queue cleared.");
});

// ── Spotlight command ─────────────────────────────────────────
bot.command("spotlight", async (ctx) => {
  if (!isGroup(ctx) || !(await isGroupAdmin(ctx))) return ctx.reply("Admins only.");
  const chatId = String(ctx.chat.id);
  await postSpotlight(chatId);
});

// ── Stats and public ──────────────────────────────────────────
bot.command("stats", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group || !group.mint) return ctx.reply("No token. Use /add first.");
  const solPrice = await getSolPrice();
  const usdVol = ((group.totalVolumeSol || 0) * solPrice).toFixed(0);
  ctx.reply(
    "<b>📊 " + group.tokenName + " [" + group.tokenSymbol + "] Stats</b>\n\nBuys: <b>" + (group.totalBuys || 0) + "</b>\nHolders: <b>" + (group.uniqueBuyers || []).length + "</b>\nVolume: <b>" + (group.totalVolumeSol || 0).toFixed(2) + " SOL ($" + usdVol + ")</b>\nBiggest: <b>" + (group.biggestBuy || 0).toFixed(2) + " SOL</b>",
    { parse_mode: "HTML" }
  );
});

bot.command("help", (ctx) => {
  if (isDM(ctx)) {
    ctx.reply(
      "<b>🧠 NO BRAIN Buy Bot Help</b>\n\n" +
      "<b>🛠 General</b>\n" +
      "/add CA - Track a token\n" +
      "/remove - Remove token\n" +
      "/settings - Bot settings\n" +
      "/stats - Buy stats\n" +
      "/pause - Pause alerts\n" +
      "/resume - Resume alerts\n" +
      "/spotlight - Post data spotlight\n\n" +
      "<b>🔗 X Account</b>\n" +
      "/login - Link your X account\n" +
      "/logout - Unlink X account\n" +
      "/xstatus - Check connection\n\n" +
      "<b>⚡ Raids</b>\n" +
      "/raid link - Start a raid\n" +
      "/stop - Stop ongoing raid\n" +
      "/raidstats - Raid progress\n\n" +
      "<b>🏆 Leaderboard</b>\n" +
      "/lb - Show leaderboard\n" +
      "/xp - Show your XP\n" +
      "/lbreset - Reset leaderboard (admin)\n\n" +
      "<b>⏳ Queue</b>\n" +
      "/next link - Add to raid queue\n" +
      "/clearnext - Clear queue",
      { parse_mode: "HTML" }
    );
  } else {
    ctx.reply(
      "<b>🧠 NO BRAIN Buy Bot Commands</b>\n\n" +
      "/add CA — Track token\n" +
      "/remove — Remove token\n" +
      "/settings — Settings\n" +
      "/stats — Buy stats\n" +
      "/spotlight — Post data spotlight\n" +
      "/raid link — Start a raid\n" +
      "/stop — Stop raid\n" +
      "/lb — Leaderboard\n" +
      "/xp — Your XP\n" +
      "/login — Connect X account\n" +
      "/help — Full help (DM the bot)",
      { parse_mode: "HTML" }
    );
  }
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
    return (i + 1) + ". <b>" + g.title + "</b> — " + (g.tokenName || "No token") + " — Buys: " + (g.totalBuys || 0);
  });
  ctx.reply("<b>Groups (" + keys.length + ")</b>\n\n" + lines.join("\n"), { parse_mode: "HTML" });
});

// ── DM wizard handler ─────────────────────────────────────────
bot.on("message", async (ctx, next) => {
  if (!isDM(ctx)) return next();
  const userId = String(ctx.from.id);
  const state = wizardState[userId];
  if (!state) return next();
  const msg = ctx.message;
  const text = msg.text ? msg.text.trim() : null;
  const isSkip = text === "/skip";

  if (state.step === "image") {
    if (isSkip) { state.bannerFileId = null; }
    else if (msg.photo) { state.bannerFileId = msg.photo[msg.photo.length - 1].file_id; await ctx.reply("✅ Image saved!"); }
    else if (msg.animation) { state.bannerFileId = msg.animation.file_id; await ctx.reply("✅ GIF saved!"); }
    else { return ctx.reply("Send a photo or GIF, or /skip"); }
    await wizardNext(userId, "minbuy"); return;
  }
  if (state.step === "minbuy") {
    if (!isSkip) { const v = parseFloat(text); if (!isNaN(v) && v >= 0) state.settings.minBuySol = v; }
    await wizardNext(userId, "emoji"); return;
  }
  if (state.step === "emoji") {
    if (!isSkip && text) state.settings.buyEmoji = text;
    await wizardNext(userId, "tglink"); return;
  }
  if (state.step === "tglink") {
    if (!isSkip && text) state.settings.tgLink = text;
    await wizardNext(userId, "xlink"); return;
  }
  if (state.step === "xlink") {
    if (!isSkip && text) state.settings.xLink = text;
    await wizardNext(userId, "website"); return;
  }
  if (state.step === "website") {
    if (!isSkip && text) state.settings.website = text;
    await wizardNext(userId, "layout"); return;
  }
  return next();
});

// ── Group text handler ────────────────────────────────────────
bot.on("message:text", async (ctx) => {
  if (isDM(ctx)) return;
  const chatId = String(ctx.chat.id);
  const userId = String(ctx.from.id);
  const userName = ctx.from.first_name || "Unknown";
  const text = ctx.message.text.trim();

  // Raid comment
  const currentRaid = raid.getRaid(chatId);
  if (currentRaid && currentRaid.awaitingComment && currentRaid.awaitingComment[userId]) {
    delete currentRaid.awaitingComment[userId];
    if (text === "/skip") { ctx.reply("Skipped comment."); return; }
    try {
      await xauth.commentTweet(userId, currentRaid.link, text);
      raid.recordProgress(chatId, "replies");
      raid.markDone(chatId, userId, userName, ["Comment"]);
      store.addXP(chatId, userId, userName, 20);
      ctx.reply("💬 " + userName + " commented! +20 XP");
    } catch (err) { ctx.reply("Failed to comment: " + err.message); }
    return;
  }

  // Target number input
  const pendingT = raid.pendingTargets[chatId];
  if (pendingT && pendingT.awaitingField && (await isGroupAdmin(ctx))) {
    const val = parseInt(text);
    if (!isNaN(val) && val >= 0) {
      pendingT.targets[pendingT.awaitingField] = val;
      pendingT.awaitingField = null;
      ctx.reply("✅ Set " + val + ". Tap Save Targets when done.", { reply_markup: raid.targetsKeyboard(chatId) });
    }
    return;
  }

  // Settings input
  const group = store.getGroup(chatId);
  if (!group || !group.settings || !group.settings.awaitingInput) return;
  if (!(await isGroupAdmin(ctx))) return;
  const field = group.settings.awaitingInput;
  if (text === "/skip") { store.updateGroupSetting(chatId, "awaitingInput", null); ctx.reply("Skipped."); return; }

  if (field === "tgLink") { store.updateGroupSetting(chatId, "tgLink", text); store.updateGroupSetting(chatId, "awaitingInput", "xLink"); ctx.reply("Got it! Now your X link (or /skip):"); return; }
  if (field === "xLink") { store.updateGroupSetting(chatId, "xLink", text); store.updateGroupSetting(chatId, "awaitingInput", "website"); ctx.reply("Got it! Now your website (or /skip):"); return; }
  if (field === "website") { store.updateGroupSetting(chatId, "website", text); store.updateGroupSetting(chatId, "awaitingInput", null); ctx.reply("✅ Links saved!"); return; }
  if (field === "milestoneGif") { store.updateGroupSetting(chatId, "milestoneGif", text); store.updateGroupSetting(chatId, "awaitingInput", null); ctx.reply("✅ Milestone GIF/image saved!"); return; }

  let value;
  if (field === "buyEmoji") { value = text; }
  else { value = parseFloat(text); if (isNaN(value) || value < 0) return ctx.reply("Invalid number."); }
  store.updateGroupSetting(chatId, field, value);
  store.updateGroupSetting(chatId, "awaitingInput", null);
  ctx.reply("✅ Updated!");
});

// ── Photo/GIF in group ────────────────────────────────────────
bot.on("message:photo", async (ctx) => {
  if (isDM(ctx)) return;
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group || !group.settings || group.settings.awaitingInput !== "bannerPhoto") return;
  if (!(await isGroupAdmin(ctx))) return;
  store.updateGroup(chatId, { bannerFileId: ctx.message.photo[ctx.message.photo.length - 1].file_id });
  store.updateGroupSetting(chatId, "awaitingInput", null);
  ctx.reply("✅ Buy image updated!");
});

bot.on("message:animation", async (ctx) => {
  if (isDM(ctx)) return;
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group || !group.settings || group.settings.awaitingInput !== "bannerPhoto") return;
  if (!(await isGroupAdmin(ctx))) return;
  store.updateGroup(chatId, { bannerFileId: ctx.message.animation.file_id });
  store.updateGroupSetting(chatId, "awaitingInput", null);
  ctx.reply("✅ Buy GIF updated!");
});

// ── OAuth Callback ────────────────────────────────────────────
app.get("/auth/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.send("<h2>Authorization denied.</h2><p>Close this window.</p>");
  if (!code || !state) return res.send("<h2>Invalid request.</h2>");
  try {
    const result = await xauth.exchangeCode(code, state);
    res.send("<h2>✅ X account connected!</h2><p>Welcome @" + result.xUsername + "!</p><p>Close this window and go back to Telegram to start raiding!</p>");
  } catch (err) {
    res.send("<h2>Connection failed.</h2><p>" + err.message + "</p><p>Try /login again.</p>");
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
  console.log("[WEBHOOK] Events:", Array.isArray(events) ? events.length : 0);
  if (!Array.isArray(events) || !events.length) return;
  const solPrice = await getSolPrice();
  for (const event of events) {
    try {
      const buy = parseHeliusWebhook(event);
      if (!buy) continue;
      const chatIds = store.getGroupsForMint(buy.tokenMint);
      console.log("[WEBHOOK] mint=" + buy.tokenMint + " chatIds=" + chatIds.length);
      for (const chatId of chatIds) { await sendBuyAlert(buy, chatId, solPrice); }
    } catch (err) { console.error("[WEBHOOK] Error:", err.message); }
  }
});

app.get("/", function(req, res) { res.send("🧠 NO BRAIN Buy Bot running"); });

// ── RPC Poller ────────────────────────────────────────────────
const lastSigPerMint = {};

async function rpcCall(method, params) {
  const res = await fetch(HELIUS_RPC_URL, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "poll", method, params }),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json();
  if (data.error) throw new Error("RPC: " + data.error.message);
  return data.result;
}

async function pollMints() {
  const allGroups = store.getAllGroups();
  const mints = [...new Set(Object.values(allGroups).map(function(g) { return g.mint; }).filter(Boolean))];
  if (!mints.length) return;
  const solPrice = await getSolPrice().catch(function() { return 0; });

  for (const mint of mints) {
    try {
      const sigInfos = await rpcCall("getSignaturesForAddress", [mint, { limit: 10, commitment: "confirmed" }]);
      if (!Array.isArray(sigInfos) || !sigInfos.length) continue;
      const lastSig = lastSigPerMint[mint];
      let newSigs;
      if (!lastSig) { newSigs = [sigInfos[0]]; }
      else { const idx = sigInfos.findIndex(function(s) { return s.signature === lastSig; }); newSigs = idx === -1 ? sigInfos : sigInfos.slice(0, idx); }
      lastSigPerMint[mint] = sigInfos[0].signature;
      if (!newSigs.length) continue;
      console.log("[POLL] " + newSigs.length + " new tx for " + mint.slice(0, 8) + "...");

      for (const sigInfo of newSigs.reverse()) {
        try {
          const tx = await rpcCall("getTransaction", [sigInfo.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
          if (!tx || !tx.meta) continue;
          const accountKeys = (tx.transaction && tx.transaction.message && tx.transaction.message.accountKeys) || [];
          const buyer = accountKeys[0] ? (accountKeys[0].pubkey || String(accountKeys[0])) : "Unknown";
          const preBalances = tx.meta.preBalances || [];
          const postBalances = tx.meta.postBalances || [];
          const preToken = tx.meta.preTokenBalances || [];
          const postToken = tx.meta.postTokenBalances || [];
          const tokenTransfers = [];
          postToken.forEach(function(post) {
            const pre = preToken.find(function(p) { return p.accountIndex === post.accountIndex && p.mint === post.mint; });
            const diff = Number(post.uiTokenAmount.amount) - (pre ? Number(pre.uiTokenAmount.amount) : 0);
            if (diff > 0) {
              const owner = accountKeys[post.accountIndex] ? (accountKeys[post.accountIndex].pubkey || String(accountKeys[post.accountIndex])) : "Unknown";
              tokenTransfers.push({ mint: post.mint, toUserAccount: owner, tokenAmount: diff / Math.pow(10, post.uiTokenAmount.decimals) });
            }
          });
          const solDiff = (preBalances[0] || 0) - (postBalances[0] || 0);
          const solSpent = solDiff > 0 ? solDiff / 1e9 : null;
          const tokenOut = tokenTransfers.find(function(t) { return t.mint === mint; });
          if (!tokenOut) continue;
          const buy = { buyer, tokenMint: mint, tokenAmount: tokenOut.tokenAmount, solSpent, signature: sigInfo.signature, timestamp: new Date((tx.blockTime || Math.floor(Date.now() / 1000)) * 1000), tokenSymbol: "???", tokenName: mint.slice(0, 6) + "..." };
          for (const chatId of store.getGroupsForMint(mint)) { await sendBuyAlert(buy, chatId, solPrice); }
        } catch (err) { console.error("[POLL] tx error:", err.message); }
      }
    } catch (err) { console.error("[POLL] mint error:", err.message); }
  }
}

setTimeout(function() { pollMints(); setInterval(pollMints, 30000); }, 10000);

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log("🧠 NO BRAIN Buy Bot on port " + PORT); });

setTimeout(async function() {
  try {
    await bot.start({
      drop_pending_updates: true,
      onStart: function(info) { console.log("[BOT] Started as @" + info.username); },
    });
  } catch (err) { console.error("[BOT] Start error:", err.message); process.exit(1); }
}, 5000);
