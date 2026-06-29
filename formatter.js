function formatNum(n) {
  if (!n && n !== 0) return "?";
  if (n >= 1000000000) return (n / 1000000000).toFixed(2) + "B";
  if (n >= 1000000) return (n / 1000000).toFixed(2) + "M";
  if (n >= 1000) return (n / 1000).toFixed(2) + "K";
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function getBuyBar(sol, emoji) {
  const e = emoji || "🟢";
  if (!sol) return e + e;
  if (sol < 0.5) return e;
  if (sol < 1) return e + e;
  if (sol < 2) return e + e + e;
  if (sol < 5) return e + e + e + e + e;
  if (sol < 10) return "🟡🟡🟡🟡🟡🟡🟡🟡🟡🟡";
  if (sol < 50) return "🟠🟠🟠🟠🟠🟠🟠🟠🟠🟠🟠🟠🟠🟠🟠";
  return "🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴";
}

function formatWelcome(groupName) {
  return (
    "<b>🧠 NO BRAIN Buy Bot joined " + groupName + "!</b>\n\n" +
    "Real-time Solana buy alerts — whale detection, market cap, milestones, raids & more.\n\n" +
    "<b>Get started:</b>\n" +
    "<code>/add YOUR_TOKEN_MINT_ADDRESS</code>\n\n" +
    "Type /help for all commands."
  );
}

function formatBuyAlert(buy, group, solPrice, settings, isWhale, isNewHolder, marketCap) {
  const tokenName = group.tokenName || buy.tokenName;
  const tokenSymbol = group.tokenSymbol || buy.tokenSymbol;
  const solSpent = buy.solSpent;
  const usdValue = solSpent && solPrice ? "$" + (solSpent * solPrice).toFixed(2) : null;
  const bar = getBuyBar(solSpent, settings.buyEmoji);

  const walletUrl = "https://solscan.io/account/" + buy.buyer;
  const txUrl = "https://solscan.io/tx/" + buy.signature;
  const dexUrl = "https://dexscreener.com/solana/" + buy.tokenMint;

  const solLine = solSpent !== null
    ? solSpent.toFixed(3) + " SOL" + (usdValue ? " (" + usdValue + ")" : "")
    : "Token swap";

  const positionLabel = isNewHolder ? "New" : "Existing";
  const mcLine = marketCap ? "$" + formatNum(marketCap) : null;
  const s = settings || {};

  const lines = [];
  if (isWhale) lines.push("🐳 <b>WHALE BUY!</b>");
  lines.push("🧠 <b>" + tokenName + " [" + tokenSymbol + "] Buy!</b>");
  lines.push("");
  lines.push(bar);
  lines.push("");
  lines.push("💰 " + solLine);
  lines.push("📦 Got: " + formatNum(buy.tokenAmount) + " " + tokenSymbol);
  lines.push("👤 <a href='" + walletUrl + "'>Buyer</a> | <a href='" + txUrl + "'>Txn</a>");
  lines.push("📊 Position: " + positionLabel);
  if (mcLine) lines.push("💎 Market Cap: " + mcLine);
  if (s.showPrice !== false && solPrice) lines.push("💲 SOL: $" + solPrice.toFixed(2));
  lines.push("📈 <a href='" + dexUrl + "'>DexScreener</a>");
  if (s.tgLink) lines.push("📢 <a href='" + s.tgLink + "'>Telegram</a>");

  return lines.join("\n");
}

function formatMilestoneAlert(group, milestone, solPrice) {
  const usdVol = solPrice ? "$" + ((group.totalVolumeSol || 0) * solPrice).toFixed(0) : null;
  return (
    "🏆 <b>MILESTONE: " + milestone + " Buys!</b>\n\n" +
    "🧠 <b>" + group.tokenName + " [" + group.tokenSymbol + "]</b>\n\n" +
    "📦 Total Buys: <b>" + group.totalBuys + "</b>\n" +
    "👥 Unique Buyers: <b>" + (group.uniqueBuyers || []).length + "</b>\n" +
    "💧 Volume: <b>" + (group.totalVolumeSol || 0).toFixed(2) + " SOL" + (usdVol ? " (" + usdVol + ")" : "") + "</b>\n" +
    "🐳 Biggest Buy: <b>" + (group.biggestBuy || 0).toFixed(2) + " SOL</b>\n\n" +
    "<i>Powered by NO BRAIN Buy Bot 🧠</i>"
  );
}

function formatSpotlight(group, marketData, solPrice) {
  const mc = marketData && marketData.marketCap ? "$" + formatNum(marketData.marketCap) : "N/A";
  const vol24 = marketData && marketData.volume24h ? "$" + formatNum(marketData.volume24h) : "N/A";
  const buyers = marketData && marketData.buyPct ? marketData.buyPct + "%" : "N/A";
  const sellers = marketData && marketData.sellPct ? marketData.sellPct + "%" : "N/A";
  const holders = (group.uniqueBuyers || []).length;
  const biggestBuyUsd = group.biggestBuy && solPrice ? "$" + (group.biggestBuy * solPrice).toFixed(0) : "N/A";

  return (
    "📊 <b>" + group.tokenName + " [" + group.tokenSymbol + "] Data Spotlight</b>\n\n" +
    "<b>Chart</b>\n\n" +
    "📈 " + mc + " marketcap\n" +
    "💰 " + vol24 + " 24 hour trading volume\n" +
    "⚖️ " + buyers + " buyers " + sellers + " sellers\n\n" +
    "<b>Holders</b>\n\n" +
    "👤 " + holders + " holders\n" +
    "💰 " + biggestBuyUsd + " recent biggest buy\n\n" +
    "<i>Powered by NO BRAIN Buy Bot 🧠</i>"
  );
}

function formatChannelListing(tokenName, tokenSymbol, mint, marketCap, solPrice, settings) {
  const mc = marketCap ? "$" + formatNum(marketCap) : "N/A";
  const s = settings || {};
  return (
    "🆕 <b>New Token Listed!</b>\n\n" +
    "🧠 Token: <b>" + tokenName + " [" + tokenSymbol + "]</b>\n" +
    "📍 CA: <code>" + mint + "</code>\n" +
    "💎 Market Cap: <b>" + mc + "</b>\n\n" +
    (s.tgLink ? "📢 <a href='" + s.tgLink + "'>Telegram</a>  " : "") +
    (s.xLink ? "🐦 <a href='" + s.xLink + "'>X / Twitter</a>  " : "") +
    (s.website ? "🌐 <a href='" + s.website + "'>Website</a>" : "") +
    "\n\n" +
    "📊 <a href='https://dexscreener.com/solana/" + mint + "'>DexScreener</a>  " +
    "🐦 <a href='https://birdeye.so/token/" + mint + "'>Birdeye</a>  " +
    "🟡 <a href='https://jup.ag/swap/SOL-" + mint + "'>Buy on Jupiter</a>\n\n" +
    "#solana #newlisting #nobrain"
  );
}

module.exports = { formatBuyAlert, formatMilestoneAlert, formatWelcome, formatSpotlight, formatChannelListing };
