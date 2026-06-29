const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CLIENT_ID = process.env.X_CLIENT_ID || "";
const CLIENT_SECRET = process.env.X_CLIENT_SECRET || "";
const CALLBACK_URL = process.env.X_CALLBACK_URL || "";
const USERS_PATH = path.join(__dirname, "xusers.json");

let xUsers = {};
let pendingStates = {};

function loadUsers() {
  try { if (fs.existsSync(USERS_PATH)) xUsers = JSON.parse(fs.readFileSync(USERS_PATH, "utf8")); }
  catch { xUsers = {}; }
}

function saveUsers() {
  try { fs.writeFileSync(USERS_PATH, JSON.stringify(xUsers, null, 2)); }
  catch (e) { console.error("Failed to save xusers:", e.message); }
}

loadUsers();

function generateCodeVerifier() { return crypto.randomBytes(32).toString("base64url"); }
function generateCodeChallenge(v) { return crypto.createHash("sha256").update(v).digest("base64url"); }
function generateState() { return crypto.randomBytes(16).toString("hex"); }

function buildAuthUrl(telegramUserId) {
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  pendingStates[state] = { telegramUserId, codeVerifier };
  setTimeout(function() { delete pendingStates[state]; }, 10 * 60 * 1000);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: CALLBACK_URL,
    scope: "tweet.read tweet.write users.read like.write follows.write offline.access",
    state, code_challenge: codeChallenge, code_challenge_method: "S256",
  });
  return "https://twitter.com/i/oauth2/authorize?" + params.toString();
}

async function exchangeCode(code, state) {
  const pending = pendingStates[state];
  if (!pending) throw new Error("Invalid or expired state");
  const { telegramUserId, codeVerifier } = pending;
  delete pendingStates[state];

  const body = new URLSearchParams({
    grant_type: "authorization_code", code,
    redirect_uri: CALLBACK_URL, code_verifier: codeVerifier, client_id: CLIENT_ID,
  });
  const credentials = Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString("base64");
  const res = await fetch("https://api.twitter.com/2/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Authorization": "Basic " + credentials },
    body: body.toString(), signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error("Token exchange failed: " + await res.text());
  const data = await res.json();

  const userRes = await fetch("https://api.twitter.com/2/users/me", {
    headers: { "Authorization": "Bearer " + data.access_token },
    signal: AbortSignal.timeout(8000),
  });
  const userData = await userRes.json();
  const xUsername = userData.data ? userData.data.username : "unknown";
  const xId = userData.data ? userData.data.id : null;

  xUsers[telegramUserId] = { accessToken: data.access_token, refreshToken: data.refresh_token, xUsername, xId, connectedAt: Date.now() };
  saveUsers();
  return { xUsername, xId };
}

async function getToken(telegramUserId) {
  const user = xUsers[telegramUserId];
  if (!user) return null;
  try {
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: user.refreshToken, client_id: CLIENT_ID });
    const credentials = Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString("base64");
    const res = await fetch("https://api.twitter.com/2/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Authorization": "Basic " + credentials },
      body: body.toString(), signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return user.accessToken;
    const data = await res.json();
    xUsers[telegramUserId].accessToken = data.access_token;
    if (data.refresh_token) xUsers[telegramUserId].refreshToken = data.refresh_token;
    saveUsers();
    return data.access_token;
  } catch { return user.accessToken; }
}

function extractTweetId(url) { const m = url.match(/status\/(\d+)/); return m ? m[1] : null; }
function extractUsername(url) { const m = url.match(/(?:twitter|x)\.com\/([^/]+)\/status/); return m ? m[1] : null; }

async function likeTweet(telegramUserId, tweetUrl) {
  const token = await getToken(telegramUserId);
  if (!token) throw new Error("Not connected");
  const tweetId = extractTweetId(tweetUrl);
  if (!tweetId) throw new Error("Invalid tweet URL");
  const user = xUsers[telegramUserId];
  const res = await fetch("https://api.twitter.com/2/users/" + user.xId + "/likes", {
    method: "POST",
    headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ tweet_id: tweetId }), signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error("Like failed: " + await res.text());
  return true;
}

async function retweet(telegramUserId, tweetUrl) {
  const token = await getToken(telegramUserId);
  if (!token) throw new Error("Not connected");
  const tweetId = extractTweetId(tweetUrl);
  if (!tweetId) throw new Error("Invalid tweet URL");
  const user = xUsers[telegramUserId];
  const res = await fetch("https://api.twitter.com/2/users/" + user.xId + "/retweets", {
    method: "POST",
    headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ tweet_id: tweetId }), signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error("Retweet failed: " + await res.text());
  return true;
}

async function commentTweet(telegramUserId, tweetUrl, comment) {
  const token = await getToken(telegramUserId);
  if (!token) throw new Error("Not connected");
  const tweetId = extractTweetId(tweetUrl);
  if (!tweetId) throw new Error("Invalid tweet URL");
  const res = await fetch("https://api.twitter.com/2/tweets", {
    method: "POST",
    headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ text: comment, reply: { in_reply_to_tweet_id: tweetId } }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error("Comment failed: " + await res.text());
  return true;
}

async function bookmarkTweet(telegramUserId, tweetUrl) {
  const token = await getToken(telegramUserId);
  if (!token) throw new Error("Not connected");
  const tweetId = extractTweetId(tweetUrl);
  if (!tweetId) throw new Error("Invalid tweet URL");
  const user = xUsers[telegramUserId];
  const res = await fetch("https://api.twitter.com/2/users/" + user.xId + "/bookmarks", {
    method: "POST",
    headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ tweet_id: tweetId }), signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error("Bookmark failed: " + await res.text());
  return true;
}

async function followUser(telegramUserId, tweetUrl) {
  const token = await getToken(telegramUserId);
  if (!token) throw new Error("Not connected");
  const targetUsername = extractUsername(tweetUrl);
  if (!targetUsername) throw new Error("Cannot extract username");
  const userRes = await fetch("https://api.twitter.com/2/users/by/username/" + targetUsername, {
    headers: { "Authorization": "Bearer " + token }, signal: AbortSignal.timeout(8000),
  });
  const userData = await userRes.json();
  const targetId = userData.data ? userData.data.id : null;
  if (!targetId) throw new Error("User not found");
  const myUser = xUsers[telegramUserId];
  const res = await fetch("https://api.twitter.com/2/users/" + myUser.xId + "/following", {
    method: "POST",
    headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ target_user_id: targetId }), signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error("Follow failed: " + await res.text());
  return true;
}

async function getTweetStats(tweetUrl) {
  const tweetId = extractTweetId(tweetUrl);
  if (!tweetId) return null;
  // Use first available connected user token to read tweet
  const firstUser = Object.values(xUsers)[0];
  if (!firstUser) return null;
  try {
    const res = await fetch(
      "https://api.twitter.com/2/tweets/" + tweetId + "?tweet.fields=public_metrics",
      { headers: { "Authorization": "Bearer " + firstUser.accessToken }, signal: AbortSignal.timeout(8000) }
    );
    const data = await res.json();
    const m = data.data && data.data.public_metrics ? data.data.public_metrics : {};
    return {
      likes: m.like_count || 0,
      retweets: m.retweet_count || 0,
      replies: m.reply_count || 0,
      views: m.impression_count || 0,
      bookmarks: m.bookmark_count || 0,
    };
  } catch { return null; }
}

function getUser(telegramUserId) { return xUsers[telegramUserId] || null; }
function isConnected(telegramUserId) { return !!xUsers[telegramUserId]; }
function disconnectUser(telegramUserId) { delete xUsers[telegramUserId]; saveUsers(); }

module.exports = {
  buildAuthUrl, exchangeCode, getTweetStats,
  likeTweet, retweet, commentTweet, bookmarkTweet, followUser,
  getUser, isConnected, disconnectUser, extractTweetId,
};
