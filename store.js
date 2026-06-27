const fs = require("fs");
const path = require("path");

const STORE_PATH = path.join(__dirname, "store.json");

let state = {
  groups: {},
  mintGroups: {},
  walletCooldowns: {},
};

function load() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const saved = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
      state = Object.assign({}, state, saved);
    }
  } catch {
    console.warn("[NO BRAIN] store.json not found, starting fresh.");
  }
}

function save() {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error("[NO BRAIN] Failed to save store:", e.message);
  }
}

load();

function getAllGroups() { return state.groups; }
function getGroup(chatId) { return state.groups[chatId] || null; }

function addGroup(chatId, data) {
  if (!state.groups[chatId]) {
    state.groups[chatId] = data;
    save();
  }
}

function updateGroup(chatId, updates) {
  if (!state.groups[chatId]) state.groups[chatId] = {};
  state.groups[chatId] = Object.assign({}, state.groups[chatId], updates);
  save();
}

function removeGroup(chatId) {
  delete state.groups[chatId];
  save();
}

function updateGroupSetting(chatId, key, value) {
  if (!state.groups[chatId]) return;
  if (!state.groups[chatId].settings) state.groups[chatId].settings = {};
  state.groups[chatId].settings[key] = value;
  save();
}

function recordGroupBuy(chatId, solSpent, buyerAddress) {
  const group = state.groups[chatId];
  if (!group) return;
  group.totalBuys = (group.totalBuys || 0) + 1;
  group.totalVolumeSol = (group.totalVolumeSol || 0) + (solSpent || 0);
  if (solSpent > (group.biggestBuy || 0)) group.biggestBuy = solSpent;
  if (buyerAddress) {
    if (!group.uniqueBuyers) group.uniqueBuyers = [];
    if (!group.uniqueBuyers.includes(buyerAddress)) group.uniqueBuyers.push(buyerAddress);
  }
  save();
}

function recordMilestone(chatId) {
  if (state.groups[chatId]) {
    state.groups[chatId].milestones = (state.groups[chatId].milestones || 0) + 1;
    save();
  }
}

function getGroupsForMint(mint) { return state.mintGroups[mint] || []; }

function addMintGroup(mint, chatId) {
  if (!state.mintGroups[mint]) state.mintGroups[mint] = [];
  if (!state.mintGroups[mint].includes(chatId)) {
    state.mintGroups[mint].push(chatId);
    save();
  }
}

function removeMintGroup(mint, chatId) {
  if (!state.mintGroups[mint]) return;
  state.mintGroups[mint] = state.mintGroups[mint].filter(function(id) { return id !== chatId; });
  if (state.mintGroups[mint].length === 0) delete state.mintGroups[mint];
  save();
}

function getWalletLastAlert(key) { return state.walletCooldowns[key] || null; }

function setWalletLastAlert(key) {
  state.walletCooldowns[key] = Date.now();
  const keys = Object.keys(state.walletCooldowns);
  if (keys.length > 10000) {
    const oldest = keys.sort(function(a, b) {
      return state.walletCooldowns[a] - state.walletCooldowns[b];
    }).slice(0, 2000);
    oldest.forEach(function(k) { delete state.walletCooldowns[k]; });
  }
  save();
}

module.exports = {
  getAllGroups, getGroup, addGroup, updateGroup, removeGroup,
  updateGroupSetting, recordGroupBuy, recordMilestone,
  getGroupsForMint, addMintGroup, removeMintGroup,
  getWalletLastAlert, setWalletLastAlert,
};
