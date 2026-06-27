/**
 * xauth.js
 * Twitter/X OAuth 2.0 PKCE flow.
 * Stores user tokens in memory + persists to xusers.json
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CLIENT_ID = process.env.X_CLIENT_ID || "";
const CLIENT_SECRET = process.env.X_CLIENT_SECRET || "";
const CALLBACK_URL = process.env.X_CALLBACK_URL || "";
const USERS_PATH = path.join(__dirname, "xusers.json");

// In-memory stores
let xUsers = {}; // telegramUserId -> { accessToken, refreshToken, xUsername, xId }
let pendingStates = {}; // state -> { telegramUserId, codeVerifier }

// ── Persistence ───────────────────────────────────────────────
function loadUsers() {
  try {
    if (fs.existsSync(USERS_PATH)) {
      xUsers = JSON.parse(fs.readFileSync(USERS_PATH, "utf8"));
    }
  } catch { xUsers = {}; }
}

function saveUsers() {
  try {
    fs.writeFileSync(USERS_PATH, JSON.stringify(xUsers, null, 2));
  } catch (e) {
    console.error("Failed to save xusers:", e.message);
  }
}

loadUsers();

// ── PKCE helpers ──────────────────────────────────────────────
function generateCodeVerifier() {
  return crypto.randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function generateState() {
  return crypto.randomBytes(16).toString("hex");
}

// ── Build OAuth URL ───────────────────────────────────────────
function buildAuthUrl(telegramUserId) {
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  pendingStates[state] = { telegramUserId, codeVerifier };

  // Clean up old states after 10 minutes
  setTimeout(function() { delete pendingStates[state]; }, 10 * 60 * 1000);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: CALLBACK_URL,
    scope: "tweet.read tweet.write users.read like.write follows.write offline.access",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  return "https://twitter.com/i/oauth2/authorize?" + params.toString();
}

// ── Exchange code for tokens ──────────────────────────────────
async function exchangeCode(code, state) {
  const pending = pendingStates[state];
  if (!pending) throw new Error("Invalid or expired state");

  const { telegramUserId, codeVerifier } = pending;
  delete pendingStates[state];

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: CALLBACK_URL,
    code_verifier: codeVerifier,
    client_id: CLIENT_ID,
  });

  const credentials = Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString("base64");

  const res = await fetch("https://api.twitter.com/2/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": "Basic " + credentials,
    },
    body: body.toString(),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error("Token exchange failed: " + text);
  }

  const data = await res.json();

  // Get user info
  const userRes = await fetch("https://api.twitter.com/2/users/me", {
    headers: { "Authorization": "Bearer " + data.access_token },
    signal: AbortSignal.timeout(8000),
  });
  const userData = await userRes.json();
  const xUsername = userData.data ? userData.data.username : "unknown";
  const xId = userData.data ? userData.data.id : null;

  xUsers[telegramUserId] = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    xUsername,
    xId,
    connectedAt: Date.now(),
  };
  saveUsers();

  return { xUsername, xId };
}

// ── Refresh token ─────────────────────────────────────────────
async function refreshAccessToken(telegramUserId) {
  const user = xUsers[telegramUserId];
  if (!user || !user.refreshToken) throw new Error("No refresh token");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: user.refreshToken,
    client_id: CLIENT_ID,
  });

  const credentials = Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString("base64");

  const res = await fetch("https://api.twitter.com/2/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": "Basic " + credentials,
    },
    body: body.toString(),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) throw new Error("Token refresh failed");

  const data = await res.json();
  xUsers[telegramUserId].accessToken = data.access_token;
  if (data.refresh_token) xUsers[telegramUserId].refreshToken = data.refresh_token;
  saveUsers();

  return data.access_token;
}

// ── Get valid token ───────────────────────────────────────────
async function getToken(telegramUserId) {
  const user = xUsers[telegramUserId];
  if (!user) return null;
  try {
    // Try refresh to get fresh token
    const token = await refreshAccessToken(telegramUserId);
    return token;
  } catch {
    return user.accessToken;
  }
}

// ── Twitter API Actions ───────────────────────────────────────

// Extract tweet ID from URL
function extractTweetId(url) {
  const match = url.match(/status\/(\d+)/);
  return match ? match[1] : null;
}

// Extract username from tweet URL
function extractUsername(url) {
  const match = url.match(/(?:twitter|x)\.com\/([^/]+)\/status/);
  return match ? match[1] : null;
}

// Like a tweet
async function likeTweet(telegramUserId, tweetUrl) {
  const token = await getToken(telegramUserId);
  if (!token) throw new Error("Not connected");

  const tweetId = extractTweetId(tweetUrl);
  if (!tweetId) throw new Error("Invalid tweet URL");

  const user = xUsers[telegramUserId];
  if (!user || !user.xId) throw new Error("User not found");

  const res = await fetch("https://api.twitter.com/2/users/" + user.xId + "/likes", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ tweet_id: tweetId }),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error("Like failed: " + text);
  }
  return true;
}

// Retweet
async function retweet(telegramUserId, tweetUrl) {
  const token = await getToken(telegramUserId);
  if (!token) throw new Error("Not connected");

  const tweetId = extractTweetId(tweetUrl);
  if (!tweetId) throw new Error("Invalid tweet URL");

  const user = xUsers[telegramUserId];
  if (!user || !user.xId) throw new Error("User not found");

  const res = await fetch("https://api.twitter.com/2/users/" + user.xId + "/retweets", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ tweet_id: tweetId }),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error("Retweet failed: " + text);
  }
  return true;
}

// Reply/Comment on a tweet
async function commentTweet(telegramUserId, tweetUrl, comment) {
  const token = await getToken(telegramUserId);
  if (!token) throw new Error("Not connected");

  const tweetId = extractTweetId(tweetUrl);
  if (!tweetId) throw new Error("Invalid tweet URL");

  const res = await fetch("https://api.twitter.com/2/tweets", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: comment,
      reply: { in_reply_to_tweet_id: tweetId },
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error("Comment failed: " + text);
  }
  return true;
}

// Follow a user
async function followUser(telegramUserId, tweetUrl) {
  const token = await getToken(telegramUserId);
  if (!token) throw new Error("Not connected");

  const targetUsername = extractUsername(tweetUrl);
  if (!targetUsername) throw new Error("Cannot extract username from URL");

  // Get target user ID
  const userRes = await fetch("https://api.twitter.com/2/users/by/username/" + targetUsername, {
    headers: { "Authorization": "Bearer " + token },
    signal: AbortSignal.timeout(8000),
  });
  const userData = await userRes.json();
  const targetId = userData.data ? userData.data.id : null;
  if (!targetId) throw new Error("User not found: " + targetUsername);

  const myUser = xUsers[telegramUserId];
  if (!myUser || !myUser.xId) throw new Error("User not found");

  const res = await fetch("https://api.twitter.com/2/users/" + myUser.xId + "/following", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ target_user_id: targetId }),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error("Follow failed: " + text);
  }
  return true;
}

// ── User helpers ──────────────────────────────────────────────
function getUser(telegramUserId) {
  return xUsers[telegramUserId] || null;
}

function isConnected(telegramUserId) {
  return !!xUsers[telegramUserId];
}

function disconnectUser(telegramUserId) {
  delete xUsers[telegramUserId];
  saveUsers();
}

module.exports = {
  buildAuthUrl,
  exchangeCode,
  likeTweet,
  retweet,
  commentTweet,
  followUser,
  getUser,
  isConnected,
  disconnectUser,
  extractTweetId,
};
