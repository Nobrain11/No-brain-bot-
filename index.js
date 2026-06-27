
import os

output_dir = "/mnt/agents/output/no-brain-bot"

# ========== index.js (FIXED for Railway + webhook mode) ==========
index_js = r'''require("dotenv").config();
const express = require("express");
const { Bot, InlineKeyboard, webhookCallback } = require("grammy");
const { parseHeliusWebhook } = require("./parser");
const { formatBuyAlert, formatMilestoneAlert, formatWelcome } = require("./formatter");
const { getSolPrice, getTokenInfo, getMarketCap } = require("./data");
const {
  getWebhook,
  getAllWebhooks,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  setWebhookURL,
  setWebhookTypes,
  addMintToHelius,
  removeMintFromHelius,
} = require("./helius");
const store = require("./store");

const app = express();
app.use(express.json());

const bot = new Bot(process.env.BOT_TOKEN);
const SUPER_ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map((id) => id.trim());
const WEBHOOK_SECRET = process.env.HELIUS_WEBHOOK_SECRET || "";
const MILESTONE_COUNTS = [10, 25, 50, 100, 250, 500, 1000];
const BANNER_URL = process.env.BANNER_URL || "";

// ── Auto-detect environment ───────────────────────────────────
const USE_WEBHOOK = process.env.USE_WEBHOOK === "true" || !!process.env.RAILWAY_STATIC_URL || !!process.env.RAILWAY_PUBLIC_DOMAIN;
const BOT_WEBHOOK_URL = process.env.BOT_WEBHOOK_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? "https://" + process.env.RAILWAY_PUBLIC_DOMAIN + "/bot-webhook" : null);
const PORT = process.env.PORT || 3000;

function isSuperAdmin(ctx) {
  return SUPER_ADMIN_IDS.includes(String(ctx.from?.id));
}

async function isGroupAdmin(ctx) {
  try {
    const member = await ctx.getChatMember(ctx.from.id);
    return ["administrator", "creator"].includes(member.status);
  } catch {
    return false;
  }
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
    .text("Set Banner Image", "set_banner")
    .row()
    .text((showPrice ? "ON" : "OFF") + " Show Price", "toggle_price")
    .text("Stats", "show_stats")
    .row()
    .text(active ? "⏸ Pause Alerts" : "▶ Resume Alerts", "toggle_active")
    .text("❌ Remove Token", "confirm_unregister");
}

function buildSettingsText(group) {
  const s = group.settings || {};
  return (
    "🧠 <b>NO BRAIN BOT Settings</b>\n\n" +
    "Token: <b>" + group.tokenName + " [" + group.tokenSymbol + "]</b>\n" +
    "CA: <code>" + group.mint + "</code>\n\n" +
    "Min Buy: <b>" + (s.minBuySol ?? 0.05) + " SOL</b>\n" +
    "Whale Alert: <b>" + (s.whaleSol ?? 10) + " SOL</b>\n" +
    "Emoji: <b>" + (s.buyEmoji ?? "green") + "</b>\n" +
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

  if (newStatus === "kicked" || newStatus === "left") {
    store.removeGroup(chatId);
  }
});

// ── /start ────────────────────────────────────────────────────
bot.command("start", async (ctx) => {
  if (isGroup(ctx)) {
    const chatId = String(ctx.chat.id);
    const group = store.getGroup(chatId);

    if (group && group.mint) {
      return ctx.reply(
        "🧠 <b>NO BRAIN BOT</b> is active!\n\n" +
        "Tracking: <b>" + group.tokenName + " [" + group.tokenSymbol + "]</b>\n\n" +
        "Use /settings to customize.",
        { parse_mode: "HTML" }
      );
    }

    return ctx.reply(
      "🧠 <b>NO BRAIN BOT</b>\n\n" +
      "Set your token Contract Address:\n\n" +
      "<code>/add YOUR_TOKEN_MINT_ADDRESS</code>",
      { parse_mode: "HTML" }
    );
  }

  ctx.reply(
    "🧠 <b>NO BRAIN BOT</b>\n\n" +
    "Add me to your Telegram group as admin, then use:\n\n" +
    "<code>/add YOUR_TOKEN_MINT</code>\n\n" +
    "to start getting buy alerts instantly.\n\n" +
    "<b>Super Admin Commands:</b>\n" +
    "<code>/webhook</code> — Manage Helius webhook\n" +
    "<code>/groups</code> — View all groups",
    { parse_mode: "HTML" }
  );
});

// ── /add ─────────────────────────────────────────────────────
bot.command("add", async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply("Use this command inside your Telegram group.");
  if (!(await isGroupAdmin(ctx))) return ctx.reply("Only group admins can add a token.");

  const mint = ctx.message.text.split(" ")[1] ? ctx.message.text.split(" ")[1].trim() : null;
  if (!mint || mint.length < 32) {
    return ctx.reply(
      "Set your token Contract Address:\n\n<code>/add YOUR_MINT_ADDRESS</code>",
      { parse_mode: "HTML" }
    );
  }

  const chatId = String(ctx.chat.id);
  const existing = store.getGroup(chatId);
  if (existing && existing.mint === mint) return ctx.reply("Already tracking this token.");

  await ctx.reply("Validating token info...");

  const info = await getTokenInfo(mint).catch(() => null);
  const tokenName = (info && info.name) ? info.name : mint.slice(0, 6);
  const tokenSymbol = (info && info.symbol) ? info.symbol : "???";

  const heliusOk = await addMintToHelius(mint);
  if (!heliusOk) {
    return ctx.reply("Failed to register with Helius. Check HELIUS_API_KEY and HELIUS_WEBHOOK_ID.");
  }

  store.updateGroup(chatId, {
    mint,
    tokenName,
    tokenSymbol,
    active: true,
    registeredAt: Date.now(),
    totalBuys: 0,
    totalVolumeSol: 0,
    biggestBuy: 0,
    uniqueBuyers: [],
    milestones: 0,
    settings: {
      minBuySol: 0.05,
      whaleSol: 10,
      buyEmoji: "green",
      showPrice: true,
      bannerUrl: BANNER_URL,
    },
  });

  store.addMintGroup(mint, chatId);

  ctx.reply(
    "✅ CA set successfully\n\n" +
    "Token: <b>" + tokenName + " [" + tokenSymbol + "]</b>\n" +
    "CA: <code>" + mint + "</code>\n\n" +
    "Buy alerts are now LIVE!\n\n" +
    "Use /settings to customize.",
    { parse_mode: "HTML" }
  );
});

// ── /remove ───────────────────────────────────────────────────
bot.command("remove", async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply("Use this in your group.");
  if (!(await isGroupAdmin(ctx))) return ctx.reply("Admins only.");
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group || !group.mint) return ctx.reply("No token registered in this group.");
  const mint = group.mint;
  store.removeMintGroup(mint, chatId);
  const otherGroups = store.getGroupsForMint(mint);
  if (otherGroups.length === 0) await removeMintFromHelius(mint);
  store.updateGroup(chatId, { mint: null, active: false });
  ctx.reply("❌ Stopped tracking <b>" + group.tokenName + "</b>.", { parse_mode: "HTML" });
});

// ── /settings ─────────────────────────────────────────────────
bot.command("settings", async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply("Use this in your group.");
  if (!(await isGroupAdmin(ctx))) return ctx.reply("Admins only.");
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group || !group.mint) return ctx.reply("No token added. Use /add first.");
  ctx.reply(buildSettingsText(group), {
    parse_mode: "HTML",
    reply_markup: buildSettingsKeyboard(group),
  });
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
  ctx.reply("Reply with minimum buy in SOL (e.g. <code>0.1</code>)", { parse_mode: "HTML" });
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
  ctx.reply("Reply with your buy emoji (e.g. 🧠 or 🚀)", { parse_mode: "HTML" });
});

bot.callbackQuery("set_banner", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  if (!(await isGroupAdmin(ctx))) return;
  store.updateGroupSetting(chatId, "awaitingInput", "bannerUrl");
  ctx.reply("Reply with your banner image URL (must start with https://)", { parse_mode: "HTML" });
});

bot.callbackQuery("show_stats", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group) return;
  const solPrice = await getSolPrice();
  const usdVol = ((group.totalVolumeSol || 0) * solPrice).toFixed(0);
  ctx.reply(
    "🧠 <b>" + group.tokenName + " [" + group.tokenSymbol + "] Stats</b>\n\n" +
    "Total Buys: <b>" + (group.totalBuys || 0) + "</b>\n" +
    "Unique Buyers: <b>" + (group.uniqueBuyers || []).length + "</b>\n" +
    "Volume: <b>" + (group.totalVolumeSol || 0).toFixed(2) + " SOL ($" + usdVol + ")</b>\n" +
    "Biggest Buy: <b>" + (group.biggestBuy || 0).toFixed(2) + " SOL</b>\n" +
    "Milestones: <b>" + (group.milestones || 0) + "</b>",
    { parse_mode: "HTML" }
  );
});

bot.callbackQuery("confirm_unregister", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await isGroupAdmin(ctx))) return;
  const kb = new InlineKeyboard().text("✅ Yes, remove", "do_unregister").text("❌ Cancel", "cancel_unregister");
  ctx.reply("Are you sure you want to remove your token? Buy alerts will stop.", { reply_markup: kb });
});

bot.callbackQuery("do_unregister", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  if (!(await isGroupAdmin(ctx))) return;
  const group = store.getGroup(chatId);
  if (!group || !group.mint) return;
  const mint = group.mint;
  store.removeMintGroup(mint, chatId);
  const otherGroups = store.getGroupsForMint(mint);
  if (otherGroups.length === 0) await removeMintFromHelius(mint);
  store.updateGroup(chatId, { mint: null, active: false });
  ctx.editMessageText("❌ Stopped tracking <b>" + group.tokenName + "</b>.", { parse_mode: "HTML" });
});

bot.callbackQuery("cancel_unregister", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.deleteMessage();
});

// ── Handle text replies for settings ─────────────────────────
bot.on("message:text", async (ctx) => {
  if (!isGroup(ctx)) return;
  const chatId = String(ctx.chat.id);
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
  ctx.reply("✅ Updated! Use /settings to view.");
});

// ── Public commands ───────────────────────────────────────────
bot.command("stats", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group || !group.mint) return ctx.reply("No token added. Use /add first.");
  const solPrice = await getSolPrice();
  const usdVol = ((group.totalVolumeSol || 0) * solPrice).toFixed(0);
  ctx.reply(
    "🧠 <b>" + group.tokenName + " [" + group.tokenSymbol + "] Stats</b>\n\n" +
    "Total Buys: <b>" + (group.totalBuys || 0) + "</b>\n" +
    "Unique Buyers: <b>" + (group.uniqueBuyers || []).length + "</b>\n" +
    "Volume: <b>" + (group.totalVolumeSol || 0).toFixed(2) + " SOL ($" + usdVol + ")</b>\n" +
    "Biggest Buy: <b>" + (group.biggestBuy || 0).toFixed(2) + " SOL</b>\n" +
    "Milestones: <b>" + (group.milestones || 0) + "</b>",
    { parse_mode: "HTML" }
  );
});

bot.command("help", (ctx) => {
  ctx.reply(
    "🧠 <b>NO BRAIN BOT Commands</b>\n\n" +
    "/add CA - Track buys of a token live\n" +
    "/remove - Remove tracked token\n" +
    "/settings - Settings for buy bot\n" +
    "/stats - View buy stats\n" +
    "/pause - Pause buy alerts\n" +
    "/resume - Resume buy alerts",
    { parse_mode: "HTML" }
  );
});

bot.command("pause", async (ctx) => {
  if (!isGroup(ctx) || !(await isGroupAdmin(ctx))) return ctx.reply("Admins only.");
  store.updateGroup(String(ctx.chat.id), { active: false });
  ctx.reply("⏸ Buy alerts paused.");
});

bot.command("resume", async (ctx) => {
  if (!isGroup(ctx) || !(await isGroupAdmin(ctx))) return ctx.reply("Admins only.");
  store.updateGroup(String(ctx.chat.id), { active: true });
  ctx.reply("▶ Buy alerts resumed.");
});

bot.command("groups", async (ctx) => {
  if (!isSuperAdmin(ctx)) return;
  const groups = store.getAllGroups();
  const keys = Object.keys(groups);
  if (!keys.length) return ctx.reply("No groups.");
  const lines = keys.map(function(id, i) {
    const g = groups[id];
    return (i + 1) + ". <b>" + g.title + "</b> - " + (g.tokenName || "No token") + " - Buys: " + (g.totalBuys || 0);
  });
  ctx.reply("🧠 <b>Groups (" + keys.length + ")</b>\n\n" + lines.join("\n"), { parse_mode: "HTML" });
});

// ════════════════════════════════════════════════════════════════
// ═══ SUPER ADMIN: HELIUS WEBHOOK MANAGEMENT ═════════════════════
// ════════════════════════════════════════════════════════════════

bot.command("webhook", async (ctx) => {
  if (!isSuperAdmin(ctx)) {
    return ctx.reply("🚫 Super admin only.");
  }

  const args = ctx.message.text.split(" ").slice(1);
  const sub = args[0] || "status";

  // ── /webhook status ────────────────────────────────────────
  if (sub === "status") {
    try {
      const wh = await getWebhook();
      const addrs = wh.accountAddresses || [];
      const types = wh.transactionTypes || [];
      const kb = new InlineKeyboard()
        .text("🔄 Set URL", "wh_seturl")
        .text("📋 List All", "wh_listall")
        .row()
        .text("➕ Add SWAP type", "wh_addswap")
        .text("🗑 Delete Webhook", "wh_delete")
        .row()
        .text("🔁 Test", "wh_test");

      ctx.reply(
        "🧠 <b>Helius Webhook Status</b>\n\n" +
        "ID: <code>" + (wh.webhookID || wh.webhookURL || "N/A") + "</code>\n" +
        "URL: <code>" + (wh.webhookURL || "Not set") + "</code>\n" +
        "Type: <b>" + (wh.webhookType || "enhanced") + "</b>\n" +
        "Auth: <b>" + (wh.authHeader ? "Set" : "None") + "</b>\n" +
        "Addresses: <b>" + addrs.length + "</b>\n" +
        "Tx Types: <b>" + types.join(", ") + "</b>\n\n" +
        "<i>Use /webhook seturl &lt;url&gt; to update URL</i>",
        { parse_mode: "HTML", reply_markup: kb }
      );
    } catch (err) {
      ctx.reply("❌ Failed to fetch webhook: " + err.message);
    }
    return;
  }

  // ── /webhook seturl <url> ────────────────────────────────
  if (sub === "seturl") {
    const url = args[1];
    if (!url) return ctx.reply("Usage: <code>/webhook seturl https://your-bot.com/webhook</code>", { parse_mode: "HTML" });
    try {
      await setWebhookURL(url);
      ctx.reply("✅ Webhook URL updated to:\n<code>" + url + "</code>", { parse_mode: "HTML" });
    } catch (err) {
      ctx.reply("❌ Failed: " + err.message);
    }
    return;
  }

  // ── /webhook create <url> ────────────────────────────────
  if (sub === "create") {
    const url = args[1];
    if (!url) return ctx.reply("Usage: <code>/webhook create https://your-bot.com/webhook</code>", { parse_mode: "HTML" });
    try {
      const wh = await createWebhook({
        webhookURL: url,
        transactionTypes: ["SWAP"],
        accountAddresses: [],
        webhookType: "enhanced",
        authHeader: WEBHOOK_SECRET || "",
      });
      ctx.reply(
        "✅ <b>Webhook Created!</b>\n\n" +
        "ID: <code>" + wh.webhookID + "</code>\n" +
        "URL: <code>" + wh.webhookURL + "</code>\n" +
        "Type: <b>" + wh.webhookType + "</b>\n\n" +
        "Add this ID to your .env:\n<code>HELIUS_WEBHOOK_ID=" + wh.webhookID + "</code>",
        { parse_mode: "HTML" }
      );
    } catch (err) {
      ctx.reply("❌ Failed to create: " + err.message);
    }
    return;
  }

  // ── /webhook list ────────────────────────────────────────
  if (sub === "list") {
    try {
      const hooks = await getAllWebhooks();
      if (!hooks.length) return ctx.reply("No webhooks found.");
      const lines = hooks.map(function(h, i) {
        return (i + 1) + ". <code>" + h.webhookID + "</code> — " + h.webhookURL + " (" + (h.accountAddresses || []).length + " addrs)";
      });
      ctx.reply("🧠 <b>Your Helius Webhooks</b>\n\n" + lines.join("\n"), { parse_mode: "HTML" });
    } catch (err) {
      ctx.reply("❌ Failed: " + err.message);
    }
    return;
  }

  // ── /webhook delete <id> ─────────────────────────────────
  if (sub === "delete") {
    const id = args[1];
    try {
      await deleteWebhook(id);
      ctx.reply("🗑 Webhook deleted.");
    } catch (err) {
      ctx.reply("❌ Failed: " + err.message);
    }
    return;
  }

  // ── /webhook types <type1,type2> ─────────────────────────
  if (sub === "types") {
    const typesStr = args[1];
    if (!typesStr) return ctx.reply("Usage: <code>/webhook types SWAP,NFT_SALE</code>", { parse_mode: "HTML" });
    const types = typesStr.split(",").map(function(t) { return t.trim().toUpperCase(); });
    try {
      await setWebhookTypes(types);
      ctx.reply("✅ Transaction types updated to: <b>" + types.join(", ") + "</b>", { parse_mode: "HTML" });
    } catch (err) {
      ctx.reply("❌ Failed: " + err.message);
    }
    return;
  }

  // ── Default help ─────────────────────────────────────────
  ctx.reply(
    "🧠 <b>NO BRAIN BOT — Helius Webhook Commands</b>\n\n" +
    "<code>/webhook status</code> — Show current webhook info\n" +
    "<code>/webhook seturl &lt;url&gt;</code> — Update webhook URL\n" +
    "<code>/webhook create &lt;url&gt;</code> — Create new webhook\n" +
    "<code>/webhook list</code> — List all webhooks\n" +
    "<code>/webhook delete &lt;id&gt;</code> — Delete a webhook\n" +
    "<code>/webhook types &lt;SWAP,NFT_SALE&gt;</code> — Set tx types\n\n" +
    "<b>Your webhook URL should be:</b>\n" +
    "<code>https://your-domain.com/webhook</code>\n\n" +
    "<b>Required .env vars:</b>\n" +
    "<code>HELIUS_API_KEY</code> — Your Helius API key\n" +
    "<code>HELIUS_WEBHOOK_ID</code> — Webhook ID (auto-set on create)",
    { parse_mode: "HTML" }
  );
});

// ── Webhook management callbacks ──────────────────────────────
bot.callbackQuery("wh_seturl", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isSuperAdmin(ctx)) return;
  ctx.reply("Send the new webhook URL:\n<code>/webhook seturl https://your-domain.com/webhook</code>", { parse_mode: "HTML" });
});

bot.callbackQuery("wh_listall", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isSuperAdmin(ctx)) return;
  try {
    const hooks = await getAllWebhooks();
    if (!hooks.length) return ctx.reply("No webhooks found.");
    const lines = hooks.map(function(h, i) {
      return (i + 1) + ". <code>" + h.webhookID + "</code> — " + h.webhookURL;
    });
    ctx.reply("🧠 <b>Your Helius Webhooks</b>\n\n" + lines.join("\n"), { parse_mode: "HTML" });
  } catch (err) {
    ctx.reply("❌ " + err.message);
  }
});

bot.callbackQuery("wh_addswap", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isSuperAdmin(ctx)) return;
  try {
    await setWebhookTypes(["SWAP"]);
    ctx.reply("✅ Transaction type set to <b>SWAP</b>", { parse_mode: "HTML" });
  } catch (err) {
    ctx.reply("❌ " + err.message);
  }
});

bot.callbackQuery("wh_delete", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isSuperAdmin(ctx)) return;
  const kb = new InlineKeyboard().text("✅ Yes, delete", "wh_dodelete").text("❌ Cancel", "wh_canceldelete");
  ctx.reply("🗑 Are you sure you want to delete this webhook?", { reply_markup: kb });
});

bot.callbackQuery("wh_dodelete", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isSuperAdmin(ctx)) return;
  try {
    await deleteWebhook();
    ctx.editMessageText("🗑 Webhook deleted.");
  } catch (err) {
    ctx.editMessageText("❌ " + err.message);
  }
});

bot.callbackQuery("wh_canceldelete", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.deleteMessage();
});

bot.callbackQuery("wh_test", async (ctx) => {
  await ctx.answerCallbackQuery("Testing webhook...");
  if (!isSuperAdmin(ctx)) return;
  try {
    const wh = await getWebhook();
    ctx.reply(
      "🧪 <b>Webhook Test</b>\n\n" +
      "ID: <code>" + wh.webhookID + "</code>\n" +
      "URL: <code>" + wh.webhookURL + "</code>\n" +
      "Type: <b>" + wh.webhookType + "</b>\n" +
      "Auth: <b>" + (wh.authHeader ? "Set" : "None") + "</b>\n" +
      "Addresses tracked: <b>" + (wh.accountAddresses || []).length + "</b>\n\n" +
      "✅ Webhook is reachable and configured.",
      { parse_mode: "HTML" }
    );
  } catch (err) {
    ctx.reply("❌ Webhook test failed: " + err.message);
  }
});

// ════════════════════════════════════════════════════════════════
// ═══ HELIUS WEBHOOK ENDPOINT (Swap Events) ═════════════════════
// ════════════════════════════════════════════════════════════════

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
          .url("🚀 Buy", buyUrl)
          .url("🚀 Buy", buyUrl)
          .url("🚀 Buy", buyUrl);

        const msg = formatBuyAlert(buy, updatedGroup, solPrice, s, isWhale, isNewHolder, marketCap);

        const bannerUrl = s.bannerUrl || BANNER_URL;
        if (bannerUrl) {
          try {
            await bot.api.sendPhoto(chatId, bannerUrl, {
              caption: msg,
              parse_mode: "HTML",
              reply_markup: kb,
            });
          } catch {
            await bot.api.sendMessage(chatId, msg, {
              parse_mode: "HTML",
              disable_web_page_preview: true,
              reply_markup: kb,
            });
          }
        } else {
          await bot.api.sendMessage(chatId, msg, {
            parse_mode: "HTML",
            disable_web_page_preview: true,
            reply_markup: kb,
          });
        }

        const nextMilestoneIdx = updatedGroup.milestones || 0;
        if (
          nextMilestoneIdx < MILESTONE_COUNTS.length &&
          updatedGroup.totalBuys >= MILESTONE_COUNTS[nextMilestoneIdx]
        ) {
          const milestoneMsg = formatMilestoneAlert(updatedGroup, MILESTONE_COUNTS[nextMilestoneIdx], solPrice);
          await bot.api.sendMessage(chatId, milestoneMsg, { parse_mode: "HTML" });
          store.recordMilestone(chatId);
        }
      }
    } catch (err) {
      console.error("[NO BRAIN] Webhook error:", err.message);
    }
  }
});

// ════════════════════════════════════════════════════════════════
// ═══ EXPRESS ROUTES ════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════

app.get("/", function(req, res) {
  res.send("🧠 NO BRAIN BOT running | Mode: " + (USE_WEBHOOK ? "Webhook" : "Polling"));
});

app.get("/health", function(req, res) {
  res.json({ status: "ok", mode: USE_WEBHOOK ? "webhook" : "polling", timestamp: Date.now() });
});

// ════════════════════════════════════════════════════════════════
// ═══ START BOT (Webhook or Polling) ════════════════════════════
// ════════════════════════════════════════════════════════════════

if (USE_WEBHOOK && BOT_WEBHOOK_URL) {
  // ── Webhook mode (Railway, production) ────────────────────
  app.use("/bot-webhook", webhookCallback(bot, "express"));

  app.listen(PORT, async function() {
    console.log("🧠 NO BRAIN BOT on port " + PORT + " [WEBHOOK MODE]");
    console.log("📡 Bot webhook: " + BOT_WEBHOOK_URL);
    console.log("🔗 Helius webhook: /webhook");

    try {
      await bot.api.setWebhook(BOT_WEBHOOK_URL);
      console.log("✅ Telegram webhook set successfully");
    } catch (err) {
      console.error("❌ Failed to set Telegram webhook:", err.message);
    }
  });
} else {
  // ── Polling mode (local dev) ──────────────────────────────
  app.listen(PORT, function() {
    console.log("🧠 NO BRAIN BOT on port " + PORT + " [POLLING MODE]");
    console.log("🔗 Helius webhook: /webhook");
  });
  bot.start();
}
'''

with open(os.path.join(output_dir, "index.js"), "w") as f:
    f.write(index_js)
print("✅ index.js (FIXED for Railway webhook mode)")
