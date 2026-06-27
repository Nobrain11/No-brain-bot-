const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";
const HELIUS_WEBHOOK_ID = process.env.HELIUS_WEBHOOK_ID || "";
const BASE_URL = "https://api.helius.xyz/v0";

async function getWebhook() {
  const res = await fetch(BASE_URL + "/webhooks/" + HELIUS_WEBHOOK_ID + "?api-key=" + HELIUS_API_KEY, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error("Helius getWebhook failed: " + res.status);
  return res.json();
}

async function updateWebhookAddresses(addresses) {
  const current = await getWebhook();
  const body = {
    webhookURL: current.webhookURL,
    transactionTypes: current.transactionTypes,
    accountAddresses: addresses,
    webhookType: current.webhookType || "enhanced",
    authHeader: current.authHeader,
  };
  const res = await fetch(BASE_URL + "/webhooks/" + HELIUS_WEBHOOK_ID + "?api-key=" + HELIUS_API_KEY, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error("Helius updateWebhook failed: " + res.status + " " + text);
  }
  return res.json();
}

async function addMintToHelius(mint) {
  try {
    if (!HELIUS_API_KEY || !HELIUS_WEBHOOK_ID) {
      console.warn("[NO BRAIN] HELIUS_API_KEY or HELIUS_WEBHOOK_ID not set");
      return true;
    }
    const current = await getWebhook();
    const existing = current.accountAddresses || [];
    if (existing.includes(mint)) return true;
    await updateWebhookAddresses(existing.concat([mint]));
    console.log("[NO BRAIN] Added mint to Helius:", mint);
    return true;
  } catch (err) {
    console.error("[NO BRAIN] addMintToHelius error:", err.message);
    return false;
  }
}

async function removeMintFromHelius(mint) {
  try {
    if (!HELIUS_API_KEY || !HELIUS_WEBHOOK_ID) return true;
    const current = await getWebhook();
    const existing = current.accountAddresses || [];
    const updated = existing.filter(function(a) { return a !== mint; });
    await updateWebhookAddresses(updated);
    console.log("[NO BRAIN] Removed mint from Helius:", mint);
    return true;
  } catch (err) {
    console.error("[NO BRAIN] removeMintFromHelius error:", err.message);
    return false;
  }
}

module.exports = { addMintToHelius, removeMintFromHelius };
