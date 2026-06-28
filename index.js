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
const BRAIN_CHANNEL = "-1004454130853";

// ── DM Setup Wizard state (in-memory) ────────────────────────
// wizardState[userId] = { chatId, groupName, tokenName, tokenSymbol, mint, step, settings }
const wizardState = {};

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

function isDM(ctx) {
  return ctx.chat?.type === "private";
}

// ── Settings keyboard ─────────────────────────────────────────
function buildSettingsKeyboard(group) {
  const s = group.settings || {};
  const minBuy = s.minBuySol ?? 0.05;
  const whale = s.whaleSol ?? 10;
  const showPrice = s.showPrice !== false;
  const active = group.active;
  const whaleAlert = s.whaleAlert !== false;
  const trendingAlert = s.trendingAlert || false;
  const ignoreMev = s.ignoreMev || false;

  return new InlineKeyboard()
    .text("Min Buy: " + minBuy + " SOL", "set_minbuy")
    .text("Whale: " + whale + " SOL", "set_whale")
    .row()
    .text("Set Emoji", "set_emoji")
    .text("🖼 Buy Image", "set_banner")
    .row()
    .text((showPrice ? "✅" : "⬜") + " Show Price", "toggle_price")
    .text((whaleAlert ? "✅" : "⬜") + " Whale Alert", "toggle_whale_alert")
    .row()
    .text((trendingAlert ? "✅" : "⬜") + " Trending", "toggle_trending")
    .text((ignoreMev ? "✅" : "⬜") + " Ignore MEV", "toggle_mev")
    .row()
    .text("🔗 Set Links", "set_links")
    .text("📊 Stats", "show_stats")
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
    "Trending Alerts: <b>" + (s.trendingAlert ? "ON" : "OFF") + "</b>\n" +
    "Ignore MEV: <b>" + (s.ignoreMev ? "ON" : "OFF") + "</b>\n" +
    "Alerts: <b>" + (group.active ? "🟢 Active" : "🔴 Paused") + "</b>\n\n" +
    "<i>Tap a button to change settings</i>"
  );
}

// ── DM Wizard helpers ─────────────────────────────────────────
function buildWizardKeyboard(step, settings) {
  if (step === "confirm") {
    return new InlineKeyboard()
      .text("✅ Confirm & Post to Channel", "wizard_confirm")
      .row()
      .text("✏️ Edit Settings", "wizard_edit");
  }
  if (step === "layout") {
    return new InlineKeyboard()
      .text("Layout 1 — Classic", "wizard_layout_1")
      .row()
      .text("Layout 2 — Minimal", "wizard_layout_2")
      .row()
      .text("Layout 3 — Hype", "wizard_layout_3");
  }
  return null;
}

function buildWizardSummary(state) {
  const s = state.settings || {};
  return (
    "<b>📋 Setup Summary</b>\n\n" +
    "Token: <b>" + state.tokenName + " [" + state.tokenSymbol + "]</b>\n" +
    "Group: <b>" + state.groupName + "</b>\n\n" +
    "Min Buy: <b>" + (s.minBuySol || 0.05) + " SOL</b>\n" +
    "Buy Emoji: <b>" + (s.buyEmoji || "🟢") + "</b>\n" +
    "Show Price: <b>" + (s.showPrice !== false ? "ON" : "OFF") + "</b>\n" +
    "Whale Alerts: <b>" + (s.whaleAlert !== false ? "ON" : "OFF") + "</b>\n" +
    "Ignore MEV: <b>" + (s.ignoreMev ? "ON" : "OFF") + "</b>\n" +
    "Layout: <b>" + (s.layout || 1) + "</b>\n" +
    (s.tgLink ? "TG: " + s.tgLink + "\n" : "") +
    (s.xLink ? "X: " + s.xLink + "\n" : "") +
    (s.website ? "Web: " + s.website + "\n" : "") +
    "\n<i>Tap Confirm to go live and post to Brain Bot Channel!</i>"
  );
}

async function startWizard(userId, chatId, groupName, tokenName, tokenSymbol, mint) {
  wizardState[userId] = {
    chatId,
    groupName,
    tokenName,
    tokenSymbol,
    mint,
    step: "image",
    settings: { minBuySol: 0.05, buyEmoji: "🟢", showPrice: true, whaleAlert: true, ignoreMev: false, trendingAlert: false, layout: 1 },
    bannerFileId: null,
  };
  try {
    await bot.api.sendMessage(userId,
      "<b>🧠 NO BRAIN Buy Bot Setup</b>\n\n" +
      "Token added: <b>" + tokenName + " [" + tokenSymbol + "]</b>\n\n" +
      "<b>Step 1/7 — Buy Image</b>\n\nSend your buy alert image (GIF or photo). This will show on every buy alert.\n\n<i>Or send /skip to use no image.</i>",
      { parse_mode: "HTML" }
    );
  } catch (e) {
    console.error("[WIZARD] Could not DM user:", e.message);
  }
}

async function wizardNextStep(userId, step) {
  const state = wizardState[userId];
  if (!state) return;
  state.step = step;

  const steps = {
    minbuy: "<b>Step 2/7 — Min Buy Amount</b>\n\nWhat is the minimum buy in SOL to show an alert?\n\nReply with a number (e.g. <code>0.05</code>)",
    emoji: "<b>Step 3/7 — Buy Emoji</b>\n\nSend your buy emoji (e.g. 🟢 🚀 💎 🔥)\n\nThis fills the bar on each buy alert.",
    tglink: "<b>Step 4/7 — Telegram Link</b>\n\nSend your group invite link (e.g. https://t.me/yourgroup)\n\n<i>Or /skip</i>",
    xlink: "<b>Step 5/7 — X (Twitter) Link</b>\n\nSend your X profile link (e.g. https://x.com/yourtoken)\n\n<i>Or /skip</i>",
    website: "<b>Step 6/7 — Website</b>\n\nSend your website URL\n\n<i>Or /skip</i>",
    layout: "<b>Step 7/7 — Buy Alert Layout</b>\n\nChoose your buy alert style:",
  };

  if (steps[step]) {
    const kb = step === "layout" ? buildWizardKeyboard("layout") : null;
    await bot.api.sendMessage(userId, steps[step], { parse_mode: "HTML", reply_markup: kb || undefined });
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
  const welcomeMsg =
    "👋 Welcome <b>" + name + "</b> to <b>" + (ctx.chat.title || "the group") + "</b>!\n\n" +
    (group.mint ? "We are tracking <b>" + group.tokenName + " [" + group.tokenSymbol + "]</b> 🚀\n\n" : "") +
    (s.tgLink ? "📢 <a href='" + s.tgLink + "'>Join our TG</a>\n" : "") +
    (s.xLink ? "🐦 <a href='" + s.xLink + "'>Follow on X</a>\n" : "") +
    (s.website ? "🌐 <a href='" + s.website + "'>Website</a>\n" : "") +
    "\n<i>Buy alerts are LIVE! 🔔</i>";

  if (group.bannerFileId) {
    try {
      await bot.api.sendPhoto(chatId, group.bannerFileId, { caption: welcomeMsg, parse_mode: "HTML" });
      return;
    } catch (e) {}
  }
  await bot.api.sendMessage(chatId, welcomeMsg, { parse_mode: "HTML", disable_web_page_preview: true });
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
  await ctx.reply("🔍 Validating token...");
  const info = await getTokenInfo(mint).catch(() => null);
  const tokenName = (info && info.name) ? info.name : mint.slice(0, 6);
  const tokenSymbol = (info && info.symbol) ? info.symbol : "???";
  const heliusOk = await addMintToHelius(mint);
  if (!heliusOk) console.warn("[ADD] Helius webhook skipped, polling will handle it.");
  store.updateGroup(chatId, {
    mint, tokenName, tokenSymbol, active: true,
    registeredAt: Date.now(), totalBuys: 0, totalVolumeSol: 0,
    biggestBuy: 0, uniqueBuyers: [], milestones: 0,
    settings: { minBuySol: 0.05, whaleSol: 10, buyEmoji: "🟢", showPrice: true, whaleAlert: true, ignoreMev: false, trendingAlert: false, layout: 1 },
  });
  store.addMintGroup(mint, chatId);
  console.log("[ADD] Registered mint", mint, "for chat", chatId);

  await ctx.reply(
    "✅ <b>CA set successfully!</b>\n\nToken: <b>" + tokenName + " [" + tokenSymbol + "]</b>\nCA: <code>" + mint + "</code>\n\nBuy alerts are LIVE! 🚀\n\n<b>Check your DM to complete setup →</b>",
    { parse_mode: "HTML" }
  );

  // Start DM wizard
  const userId = String(ctx.from.id);
  const groupName = ctx.chat.title || "your group";
  await startWizard(userId, chatId, groupName, tokenName, tokenSymbol, mint);
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

bot.callbackQuery("toggle_trending", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  if (!(await isGroupAdmin(ctx))) return;
  const group = store.getGroup(chatId);
  if (!group) return;
  store.updateGroupSetting(chatId, "trendingAlert", !(group.settings && group.settings.trendingAlert));
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
  ctx.reply("Reply with your buy emoji");
});

bot.callbackQuery("set_banner", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  if (!(await isGroupAdmin(ctx))) return;
  store.updateGroupSetting(chatId, "awaitingInput", "bannerPhoto");
  ctx.reply("Send your buy alert image or GIF now.");
});

bot.callbackQuery("set_links", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  if (!(await isGroupAdmin(ctx))) return;
  store.updateGroupSetting(chatId, "awaitingInput", "tgLink");
  ctx.reply("Send your Telegram group link (e.g. https://t.me/yourgroup)\n\nOr /skip", { parse_mode: "HTML" });
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

// ── Wizard callbacks ──────────────────────────────────────────
bot.callbackQuery(/^wizard_layout_/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = String(ctx.from.id);
  const state = wizardState[userId];
  if (!state) return;
  const layout = parseInt(ctx.callbackQuery.data.replace("wizard_layout_", ""));
  state.settings.layout = layout;
  state.step = "confirm";
  await ctx.reply(buildWizardSummary(state), {
    parse_mode: "HTML",
    reply_markup: buildWizardKeyboard("confirm"),
  });
});

bot.callbackQuery("wizard_confirm", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = String(ctx.from.id);
  const state = wizardState[userId];
  if (!state) return ctx.reply("Setup expired. Run /add again in your group.");

  // Save all wizard settings to group
  const s = state.settings;
  store.updateGroup(state.chatId, {
    bannerFileId: state.bannerFileId || null,
  });
  store.updateGroupSetting(state.chatId, "minBuySol", s.minBuySol);
  store.updateGroupSetting(state.chatId, "buyEmoji", s.buyEmoji);
  store.updateGroupSetting(state.chatId, "showPrice", s.showPrice);
  store.updateGroupSetting(state.chatId, "whaleAlert", s.whaleAlert);
  store.updateGroupSetting(state.chatId, "ignoreMev", s.ignoreMev);
  store.updateGroupSetting(state.chatId, "trendingAlert", s.trendingAlert);
  store.updateGroupSetting(state.chatId, "layout", s.layout);
  store.updateGroupSetting(state.chatId, "tgLink", s.tgLink || "");
  store.updateGroupSetting(state.chatId, "xLink", s.xLink || "");
  store.updateGroupSetting(state.chatId, "website", s.website || "");

  // Build channel post
  const group = store.getGroup(state.chatId);
  const channelMsg =
    "🆕 <b>New Token Listed!</b>\n\n" +
    "Token: <b>" + state.tokenName + " [" + state.tokenSymbol + "]</b>\n" +
    "CA: <code>" + state.mint + "</code>\n\n" +
    (s.tgLink ? "📢 <a href='" + s.tgLink + "'>Telegram</a>  " : "") +
    (s.xLink ? "🐦 <a href='" + s.xLink + "'>X / Twitter</a>  " : "") +
    (s.website ? "🌐 <a href='" + s.website + "'>Website</a>" : "") +
    "\n\n" +
    "📊 <a href='https://dexscreener.com/solana/" + state.mint + "'>DexScreener</a>  " +
    "🐦 <a href='https://birdeye.so/token/" + state.mint + "'>Birdeye</a>  " +
    "🟡 <a href='https://jup.ag/swap/SOL-" + state.mint + "'>Buy on Jupiter</a>\n\n" +
    "#solana #newlisting #nobrain";

  try {
    if (state.bannerFileId) {
      await bot.api.sendPhoto(BRAIN_CHANNEL, state.bannerFileId, {
        caption: channelMsg,
        parse_mode: "HTML",
      });
    } else {
      await bot.api.sendMessage(BRAIN_CHANNEL, channelMsg, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
    }
    await ctx.reply("✅ <b>Settings saved!</b>\n\nYour token is now listed in the Brain Bot Channel 🚀\n\nBuy alerts are LIVE in your group!", { parse_mode: "HTML" });
  } catch (e) {
    console.error("[WIZARD] Channel post error:", e.message);
    await ctx.reply("✅ Settings saved! Could not post to channel: " + e.message);
  }

  delete wizardState[userId];
});

bot.callbackQuery("wizard_edit", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = String(ctx.from.id);
  const state = wizardState[userId];
  if (!state) return;
  state.step = "image";
  await ctx.reply("Let's redo setup. Send your buy image (or /skip):");
});

// ── X OAUTH COMMANDS ──────────────────────────────────────────
bot.command("connectx", async (ctx) => {
  const userId = String(ctx.from.id);
  const authUrl = xauth.buildAuthUrl(userId);
  const kb = new InlineKeyboard().url("Connect your X account", authUrl);
  ctx.reply(
    "Tap below to connect your X (Twitter) account.",
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

// ── Handle DM wizard messages ─────────────────────────────────
bot.on("message", async (ctx, next) => {
  if (!isDM(ctx)) return next();
  const userId = String(ctx.from.id);
  const state = wizardState[userId];
  if (!state) return next();

  const msg = ctx.message;
  const text = msg.text ? msg.text.trim() : null;
  const isSkip = text === "/skip";

  if (state.step === "image") {
    if (isSkip) {
      state.bannerFileId = null;
    } else if (msg.photo) {
      state.bannerFileId = msg.photo[msg.photo.length - 1].file_id;
      await ctx.reply("✅ Image saved!");
    } else if (msg.animation) {
      state.bannerFileId = msg.animation.file_id;
      await ctx.reply("✅ GIF saved!");
    } else {
      return ctx.reply("Please send a photo or GIF, or type /skip");
    }
    await wizardNextStep(userId, "minbuy");
    return;
  }

  if (state.step === "minbuy") {
    if (!isSkip) {
      const val = parseFloat(text);
      if (isNaN(val) || val < 0) return ctx.reply("Enter a valid number (e.g. 0.05)");
      state.settings.minBuySol = val;
    }
    await wizardNextStep(userId, "emoji");
    return;
  }

  if (state.step === "emoji") {
    if (!isSkip && text) state.settings.buyEmoji = text;
    await wizardNextStep(userId, "tglink");
    return;
  }

  if (state.step === "tglink") {
    if (!isSkip && text) state.settings.tgLink = text;
    await wizardNextStep(userId, "xlink");
    return;
  }

  if (state.step === "xlink") {
    if (!isSkip && text) state.settings.xLink = text;
    await wizardNextStep(userId, "website");
    return;
  }

  if (state.step === "website") {
    if (!isSkip && text) state.settings.website = text;
    await wizardNextStep(userId, "layout");
    return;
  }

  return next();
});

// ── Handle group text (settings + raid comments) ──────────────
bot.on("message:text", async (ctx) => {
  if (isDM(ctx)) return;
  const chatId = String(ctx.chat.id);
  const userId = String(ctx.from.id);
  const userName = ctx.from.first_name || "Unknown";

  // Raid comment handling
  if (isGroup(ctx)) {
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
  }

  // Group settings input
  const group = store.getGroup(chatId);
  if (!group || !group.settings || !group.settings.awaitingInput) return;
  if (!(await isGroupAdmin(ctx))) return;

  const field = group.settings.awaitingInput;
  const text = ctx.message.text.trim();

  if (text === "/skip") {
    store.updateGroupSetting(chatId, "awaitingInput", null);
    ctx.reply("Skipped.");
    return;
  }

  // Chain link inputs
  if (field === "tgLink") {
    store.updateGroupSetting(chatId, "tgLink", text);
    store.updateGroupSetting(chatId, "awaitingInput", "xLink");
    ctx.reply("Got it! Now send your X link (or /skip):");
    return;
  }
  if (field === "xLink") {
    store.updateGroupSetting(chatId, "xLink", text);
    store.updateGroupSetting(chatId, "awaitingInput", "website");
    ctx.reply("Got it! Now send your website URL (or /skip):");
    return;
  }
  if (field === "website") {
    store.updateGroupSetting(chatId, "website", text);
    store.updateGroupSetting(chatId, "awaitingInput", null);
    ctx.reply("✅ Links saved!");
    return;
  }

  let value;
  if (field === "buyEmoji") {
    value = text;
  } else {
    value = parseFloat(text);
    if (isNaN(value) || value < 0) return ctx.reply("Invalid value. Enter a number.");
  }
  store.updateGroupSetting(chatId, field, value);
  store.updateGroupSetting(chatId, "awaitingInput", null);
  ctx.reply("✅ Updated! Use /settings to view.");
});

// ── Handle photo in group (for banner update via settings) ────
bot.on("message:photo", async (ctx) => {
  if (isDM(ctx)) return;
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group || !group.settings || group.settings.awaitingInput !== "bannerPhoto") return;
  if (!(await isGroupAdmin(ctx))) return;
  const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
  store.updateGroup(chatId, { bannerFileId: fileId });
  store.updateGroupSetting(chatId, "awaitingInput", null);
  ctx.reply("✅ Buy image updated!");
});

bot.on("message:animation", async (ctx) => {
  if (isDM(ctx)) return;
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group || !group.settings || group.settings.awaitingInput !== "bannerPhoto") return;
  if (!(await isGroupAdmin(ctx))) return;
  const fileId = ctx.message.animation.file_id;
  store.updateGroup(chatId, { bannerFileId: fileId });
  store.updateGroupSetting(chatId, "awaitingInput", null);
  ctx.reply("✅ Buy GIF updated!");
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
  if (!Array.isArray(events) || !events.length) return;
  const solPrice = await getSolPrice();
  for (const event of events) {
    try {
      const buy = parseHeliusWebhook(event);
      if (!buy) continue;
      const chatIds = store.getGroupsForMint(buy.tokenMint);
      if (!chatIds.length) continue;
      for (const chatId of chatIds) {
        await sendBuyAlert(buy, chatId, solPrice);
      }
    } catch (err) {
      console.error("[WEBHOOK] Error:", err.message);
    }
  }
});

app.get("/", function(req, res) { res.send("NO BRAIN Buy Bot running"); });

// ── Buy Poller (Helius RPC — reliable on free plan) ───────────
const lastSigPerMint = {};
const HELIUS_RPC_URL = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";

async function rpcCall(method, params) {
  const res = await fetch(HELIUS_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "poll", method, params }),
    signal: AbortSignal.timeout(10000),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error("Non-JSON RPC: " + text.slice(0, 80)); }
  if (data.error) throw new Error("RPC error: " + data.error.message);
  return data.result;
}

async function sendBuyAlert(buy, chatId, solPrice) {
  const group = store.getGroup(chatId);
  if (!group || !group.active) return;
  const s = group.settings || {};
  const minBuy = s.minBuySol ?? 0.05;
  const whaleSol = s.whaleSol ?? 10;

  // Ignore MEV bots (very small buys from program accounts)
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

  // Use stored file_id banner if available, else URL banner
  const bannerFileId = group.bannerFileId || null;
  const bannerUrl = s.bannerUrl || BANNER_URL;

  if (bannerFileId) {
    try {
      await bot.api.sendPhoto(chatId, bannerFileId, { caption: msg, parse_mode: "HTML", reply_markup: kb });
    } catch {
      await bot.api.sendMessage(chatId, msg, { parse_mode: "HTML", disable_web_page_preview: true, reply_markup: kb });
    }
  } else if (bannerUrl) {
    try {
      await bot.api.sendPhoto(chatId, bannerUrl, { caption: msg, parse_mode: "HTML", reply_markup: kb });
    } catch {
      await bot.api.sendMessage(chatId, msg, { parse_mode: "HTML", disable_web_page_preview: true, reply_markup: kb });
    }
  } else {
    await bot.api.sendMessage(chatId, msg, { parse_mode: "HTML", disable_web_page_preview: true, reply_markup: kb });
  }

  // Whale alert
  if (isWhale && s.whaleAlert !== false) {
    await bot.api.sendMessage(chatId,
      "🐳 <b>WHALE ALERT!</b>\n\n" + buy.buyer.slice(0, 6) + "..." + buy.buyer.slice(-4) + " just bought <b>" + (buy.solSpent || 0).toFixed(2) + " SOL</b> of " + group.tokenName + "!",
      { parse_mode: "HTML" }
    );
  }

  const nextMilestoneIdx = updatedGroup.milestones || 0;
  if (nextMilestoneIdx < MILESTONE_COUNTS.length && updatedGroup.totalBuys >= MILESTONE_COUNTS[nextMilestoneIdx]) {
    const milestoneMsg = formatMilestoneAlert(updatedGroup, MILESTONE_COUNTS[nextMilestoneIdx], solPrice);
    await bot.api.sendMessage(chatId, milestoneMsg, { parse_mode: "HTML" });
    store.recordMilestone(chatId);
  }
}

async function pollMintsForBuys() {
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
      if (!lastSig) {
        newSigs = [sigInfos[0]];
      } else {
        const idx = sigInfos.findIndex(function(s) { return s.signature === lastSig; });
        newSigs = idx === -1 ? sigInfos : sigInfos.slice(0, idx);
      }
      lastSigPerMint[mint] = sigInfos[0].signature;
      if (!newSigs.length) continue;

      console.log("[POLL] " + newSigs.length + " new tx(s) for", mint.slice(0, 8) + "...");

      for (const sigInfo of newSigs.reverse()) {
        try {
          const tx = await rpcCall("getTransaction", [
            sigInfo.signature,
            { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }
          ]);
          if (!tx || !tx.meta) continue;

          const accountKeys = (tx.transaction && tx.transaction.message && tx.transaction.message.accountKeys) || [];
          const buyer = accountKeys[0] ? (accountKeys[0].pubkey || String(accountKeys[0])) : "Unknown";
          const preBalances = tx.meta.preBalances || [];
          const postBalances = tx.meta.postBalances || [];

          const nativeTransfers = [];
          accountKeys.forEach(function(acc, i) {
            const diff = (postBalances[i] || 0) - (preBalances[i] || 0);
            const addr = acc.pubkey || String(acc);
            if (diff < 0) nativeTransfers.push({ fromUserAccount: addr, toUserAccount: "", amount: Math.abs(diff) });
            if (diff > 0) nativeTransfers.push({ fromUserAccount: "", toUserAccount: addr, amount: diff });
          });

          const preToken = tx.meta.preTokenBalances || [];
          const postToken = tx.meta.postTokenBalances || [];
          const tokenTransfers = [];
          postToken.forEach(function(post) {
            const pre = preToken.find(function(p) { return p.accountIndex === post.accountIndex && p.mint === post.mint; });
            const preAmt = pre ? Number(pre.uiTokenAmount.amount) : 0;
            const postAmt = Number(post.uiTokenAmount.amount);
            const diff = postAmt - preAmt;
            if (diff > 0) {
              const ownerAcc = accountKeys[post.accountIndex];
              const owner = ownerAcc ? (ownerAcc.pubkey || String(ownerAcc)) : "Unknown";
              tokenTransfers.push({
                mint: post.mint,
                toUserAccount: owner,
                tokenAmount: diff / Math.pow(10, post.uiTokenAmount.decimals),
              });
            }
          });

          const event = {
            signature: sigInfo.signature,
            feePayer: buyer,
            timestamp: tx.blockTime || Math.floor(Date.now() / 1000),
            nativeTransfers,
            tokenTransfers,
          };

          const buy = parseHeliusWebhook(event);
          if (!buy || buy.tokenMint !== mint) continue;

          const chatIds = store.getGroupsForMint(mint);
          for (const chatId of chatIds) {
            await sendBuyAlert(buy, chatId, solPrice);
          }
        } catch (err) {
          console.error("[POLL] tx error:", sigInfo.signature.slice(0, 10), err.message);
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
