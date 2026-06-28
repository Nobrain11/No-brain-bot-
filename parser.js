function parseHeliusWebhook(event) {
  try {
    const transfers = event.tokenTransfers || [];
    const nativeTransfers = event.nativeTransfers || [];
    const buyer = event.feePayer || "Unknown";
    const signature = event.signature || "";
    const timestamp = event.timestamp ? new Date(event.timestamp * 1000) : new Date();

    let tokenOut = transfers.find(function(t) { return t.toUserAccount === buyer; });
    if (!tokenOut) {
      tokenOut = transfers.find(function(t) {
        return t.mint && t.mint !== "So11111111111111111111111111111111111111112";
      });
    }
    if (!tokenOut) return null;

    const tokenMint = tokenOut.mint;
    if (!tokenMint || tokenMint === "So11111111111111111111111111111111111111112") return null;

    const tokenAmount = tokenOut.tokenAmount || 0;
    const solOut = nativeTransfers.find(function(t) { return t.fromUserAccount === buyer; });
    const solSpent = solOut ? solOut.amount / 1e9 : null;

    const swap = event.events && event.events.swap ? event.events.swap : null;
    let finalSolSpent = solSpent;
    let finalTokenAmount = tokenAmount;

    if (swap && swap.nativeInput && swap.tokenOutputs && swap.tokenOutputs.length) {
      finalSolSpent = swap.nativeInput.amount / 1e9;
      const out = swap.tokenOutputs[0];
      try {
        const raw = out.rawTokenAmount;
        if (raw) finalTokenAmount = raw.tokenAmount / Math.pow(10, raw.decimals);
      } catch (e) {}
    }

    return {
      buyer,
      tokenMint,
      tokenAmount: finalTokenAmount,
      solSpent: finalSolSpent,
      signature,
      timestamp,
      tokenSymbol: tokenOut.symbol || "???",
      tokenName: tokenOut.tokenName || tokenMint.slice(0, 6) + "...",
    };
  } catch (err) {
    console.error("Parser error:", err.message);
    return null;
  }
}

module.exports = { parseHeliusWebhook };
