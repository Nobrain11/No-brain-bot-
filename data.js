const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";
const HELIUS_RPC = "https://mainnet.helius-rpc.com/?api-key=" + HELIUS_API_KEY;

let _solPriceCache = { price: 150, fetchedAt: 0 };

async function getSolPrice() {
  if (Date.now() - _solPriceCache.fetchedAt < 60000) return _solPriceCache.price;
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    const price = data && data.solana ? data.solana.usd : null;
    if (price) { _solPriceCache = { price, fetchedAt: Date.now() }; return price; }
  } catch {}
  return _solPriceCache.price;
}

const _tokenCache = {};

async function getTokenInfo(mint) {
  if (_tokenCache[mint]) return _tokenCache[mint];
  try {
    const res = await fetch(HELIUS_RPC, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "nb", method: "getAsset", params: { id: mint } }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    const asset = data && data.result ? data.result : null;
    if (asset && asset.content && asset.content.metadata && asset.content.metadata.name) {
      const info = { name: asset.content.metadata.name, symbol: asset.content.metadata.symbol || "???", decimals: asset.token_info ? asset.token_info.decimals || 6 : 6 };
      _tokenCache[mint] = info; return info;
    }
  } catch {}
  try {
    const res = await fetch("https://api.dexscreener.com/latest/dex/tokens/" + mint, { signal: AbortSignal.timeout(6000) });
    const data = await res.json();
    const pair = data && data.pairs && data.pairs[0] ? data.pairs[0] : null;
    if (pair && pair.baseToken && pair.baseToken.name) {
      const info = { name: pair.baseToken.name, symbol: pair.baseToken.symbol || "???", decimals: 6 };
      _tokenCache[mint] = info; return info;
    }
  } catch {}
  try {
    const res = await fetch("https://pump.fun/api/token/" + mint, { signal: AbortSignal.timeout(6000) });
    if (res.ok) {
      const data = await res.json();
      if (data && data.name) { const info = { name: data.name, symbol: data.symbol || "???", decimals: 6 }; _tokenCache[mint] = info; return info; }
    }
  } catch {}
  return null;
}

const _mcCache = {};

async function getMarketCap(mint) {
  const cached = _mcCache[mint];
  if (cached && Date.now() - cached.fetchedAt < 30000) return cached.value;
  try {
    const res = await fetch("https://api.dexscreener.com/latest/dex/tokens/" + mint, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    const pair = data && data.pairs && data.pairs[0] ? data.pairs[0] : null;
    if (pair && pair.fdv) { _mcCache[mint] = { value: pair.fdv, fetchedAt: Date.now() }; return pair.fdv; }
  } catch {}
  return null;
}

async function getMarketData(mint) {
  try {
    const res = await fetch("https://api.dexscreener.com/latest/dex/tokens/" + mint, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    const pair = data && data.pairs && data.pairs[0] ? data.pairs[0] : null;
    if (!pair) return null;
    const buyPct = pair.txns && pair.txns.h24 ? Math.round((pair.txns.h24.buys / (pair.txns.h24.buys + pair.txns.h24.sells)) * 100) : null;
    return {
      marketCap: pair.fdv || null,
      volume24h: pair.volume && pair.volume.h24 ? pair.volume.h24 : null,
      price: pair.priceUsd || null,
      buyPct: buyPct || null,
      sellPct: buyPct ? 100 - buyPct : null,
    };
  } catch { return null; }
}

module.exports = { getSolPrice, getTokenInfo, getMarketCap, getMarketData };
