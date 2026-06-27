function shortAddr(addr) {
  if (!addr || addr === "Unknown") return "Unknown";
  return addr.slice(0, 4) + "..." + addr.slice(-4);
}

function formatNum(n) {
  if (!n && n !== 0) return "?";
  if (n >= 1000000000) return (n / 1000000000).toFixed(2) + "B";
  if (n >= 1000000) return (n / 1000000).toFixed(2) + "M";
  if (n >= 1000) return (n / 1000).toFixed(2) + "K";
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function getBuyBarEmoji(sol) {
  if (!sol) return "🟢🟢";
  if (sol < 0.5) return "🟢";
  if (sol < 1) return "🟢🟢";
  if (sol < 2) return "🟢🟢🟢";
  if (sol < 5) return "🟢🟢🟢🟢🟢";
  if (sol < 10) return "🟡🟡🟡🟡🟡🟡🟡🟡🟡🟡";
  if (sol < 50) return "🟠🟠🟠🟠🟠🟠🟠🟠🟠🟠🟠🟠🟠🟠🟠";
  return "🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴";
}

function formatWelcome(groupName) {
  return (
    "🧠 <b>NO BRAIN BOT joined " + groupName + "!</b>\n\n" +
    "Real-time Solana buy alerts with whale detection, market cap, wallet profiling and more.\n\n" +
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
  const bar = getBuyBarEmoji(solSpent);

  const walletUrl = "https://solscan.io/account/" + buy.buyer;
  const txUrl = "https://solscan.io/tx/" + buy.signature;
  const dexUrl = "https://dexscreener.com/solana/" + buy.tokenMint;

  const solLine = solSpent !== null
    ? solSpent.toFixed(3) + " SOL" + (usdValue ? " (" + usdValue + ")" : "")
    : "Token swap";

  const positionLabel = isNewHolder ? "New" : "Existing";
  const mcLine = marketCap ? "$" + formatNum(marketCap) : null;

  let lines = [];

  if (isWhale) lines.push("🐋 WHALE BUY! 🐋");

  lines.push("🧠 " + tokenName + " [" + tokenSymbol + "] Buy!");
  lines.push("");
  lines.push(bar);
  lines.push("");
  lines.push("💰 " + solLine);
  lines.push("📦 Got: " + formatNum(buy.tokenAmount) + " " + tokenSymbol);
  lines.push("👤 <a href=\"" + walletUrl + "\">Buyer</a> | <a href=\"" + txUrl + "\">Txn</a>");
  lines.push("📊 Position: " + positionLabel);

  if (mcLine) lines.push("🏦 Market Cap: " + mcLine);

  lines.push("📈 <a href=\"" + dexUrl + "\">DexScreener</a>");

  return lines.join("\n");
}

function formatMilestoneAlert(group, milestone, solPrice) {
  const usdVol = solPrice ? "$" + ((group.totalVolumeSol || 0) * solPrice).toFixed(0) : null;
  return (
    "🎉 <b>MILESTONE: " + milestone + " Buys!</b>\n\n" +
    "🧠 <b>" + group.tokenName + " [" + group.tokenSymbol + "]</b>\n\n" +
    "Total Buys: <b>" + group.totalBuys + "</b>\n" +
    "Unique Buyers: <b>" + (group.uniqueBuyers || []).length + "</b>\n" +
    "Volume: <b>" + (group.totalVolumeSol || 0).toFixed(2) + " SOL" + (usdVol ? " (" + usdVol + ")" : "") + "</b>\n" +
    "Biggest Buy: <b>" + (group.biggestBuy || 0).toFixed(2) + " SOL</b>"
  );
}

module.exports = { formatBuyAlert, formatMilestoneAlert, formatWelcome };
