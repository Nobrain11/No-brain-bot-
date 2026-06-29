const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";
const HELIUS_WEBHOOK_ID = process.env.HELIUS_WEBHOOK_ID || "";
const BASE_URL = "https://api.helius.xyz/v0";

async function getWebhook() {
  const res = await fetch(BASE_URL + "/webhooks/" + HELIUS_WEBHOOK_ID + "?api-key=" + HELIUS_API_KEY, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error("getWebhook failed: " + res.status);
  return res.json();
}

async function updateWebhookAddresses(addresses) {
  const current = await getWebhook();
  const body = { webhookURL: current.webhookURL, transactionTypes: current.transactionTypes, accountAddresses: addresses, webhookType: current.webhookType || "enhanced", authHeader: current.authHeader };
  const res = await fetch(BASE_URL + "/webhooks/" + HELIUS_WEBHOOK_ID + "?api-key=" + HELIUS_API_KEY, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error("updateWebhook failed: " + res.status + " " + await res.text());
  return res.json();
}

async function addMintToHelius(mint) {
  try {
    if (!HELIUS_API_KEY || !HELIUS_WEBHOOK_ID) { console.warn("Helius not configured"); return true; }
    const current = await getWebhook();
    const existing = current.accountAddresses || [];
    if (existing.includes(mint)) return true;
    await updateWebhookAddresses(existing.concat([mint]));
    console.log("[HELIUS] Added mint:", mint);
    return true;
  } catch (err) { console.error("[HELIUS] addMint error:", err.message); return false; }
}

async function removeMintFromHelius(mint) {
  try {
    if (!HELIUS_API_KEY || !HELIUS_WEBHOOK_ID) return true;
    const current = await getWebhook();
    const updated = (current.accountAddresses || []).filter(function(a) { return a !== mint; });
    await updateWebhookAddresses(updated);
    console.log("[HELIUS] Removed mint:", mint);
    return true;
  } catch (err) { console.error("[HELIUS] removeMint error:", err.message); return false; }
}

module.exports = { addMintToHelius, removeMintFromHelius };
