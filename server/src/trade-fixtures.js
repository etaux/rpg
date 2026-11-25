'use strict';

// Focused no-database fixtures for the authoritative trade state machine.
// They execute the actual server handlers in a VM with an in-memory PostgreSQL
// shaped adapter, including BEGIN/COMMIT/ROLLBACK boundaries.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const serverSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8') + `
module.exports = {
  handleTradeRequest, handleTradeResponse, handleTradeSetOffer, handleTradeAccept,
  handleTradeCancel, cancelTrade, expireTrades, trades, onlineByCharacterId,
  TRADE_TIMEOUT_MS
};`;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeDatabase(seed) {
  const state = clone(seed);
  let transactionSnapshot = null;

  function inventoryRow(characterId, itemId) {
    const inventory = state.inventory[String(characterId)] || {};
    const quantity = Number(inventory[String(itemId)] || 0);
    return quantity > 0 ? { quantity } : null;
  }

  async function query(text, values) {
    const sql = String(text).replace(/\s+/g, ' ').trim().toLowerCase();
    const args = values || [];
    if (sql === 'begin') {
      transactionSnapshot = clone(state);
      return { rows: [] };
    }
    if (sql === 'commit') {
      transactionSnapshot = null;
      return { rows: [] };
    }
    if (sql === 'rollback') {
      if (transactionSnapshot) {
        Object.keys(state).forEach((key) => delete state[key]);
        Object.assign(state, clone(transactionSnapshot));
      }
      transactionSnapshot = null;
      return { rows: [] };
    }
    if (sql.indexOf('select id, gold from characters where id = any') === 0) {
      const ids = (args[0] || []).map(String).sort((left, right) => Number(left) - Number(right));
      return { rows: ids.filter((id) => state.characters[id]).map((id) => ({ id, gold: state.characters[id].gold })) };
    }
    if (sql.indexOf('select gold from characters where id = $1') === 0) {
      const character = state.characters[String(args[0])];
      return { rows: character ? [{ gold: character.gold }] : [] };
    }
    if (sql.indexOf('select item_id, quantity from character_inventory where character_id = $1 order by item_id asc') === 0) {
      const inventory = state.inventory[String(args[0])] || {};
      return { rows: Object.keys(inventory).sort().filter((itemId) => Number(inventory[itemId]) > 0).map((item_id) => ({ item_id, quantity: Number(inventory[item_id]) })) };
    }
    if (sql.indexOf('select quantity from character_inventory where character_id = $1 and item_id = $2') === 0) {
      const row = inventoryRow(args[0], args[1]);
      return { rows: row ? [row] : [] };
    }
    if (sql.indexOf('select slot, item_id from character_equipment where character_id = $1') === 0) {
      const equipment = state.equipment[String(args[0])] || {};
      return { rows: Object.keys(equipment).sort().map((slot) => ({ slot, item_id: equipment[slot] })) };
    }
    if (sql.indexOf('delete from character_inventory where character_id = $1 and item_id = $2') === 0) {
      const inventory = state.inventory[String(args[0])] || {};
      delete inventory[String(args[1])];
      return { rows: [] };
    }
    if (sql.indexOf('insert into character_inventory ') === 0) {
      const characterId = String(args[0]);
      if (!state.inventory[characterId]) state.inventory[characterId] = {};
      state.inventory[characterId][String(args[1])] = Number(args[2]);
      return { rows: [] };
    }
    if (sql.indexOf('delete from character_equipment where character_id = $1 and item_id = any') === 0) {
      const equipment = state.equipment[String(args[0])] || {};
      const outgoing = new Set((args[1] || []).map(String));
      Object.keys(equipment).forEach((slot) => {
        if (outgoing.has(String(equipment[slot]))) delete equipment[slot];
      });
      return { rows: [] };
    }
    if (sql.indexOf('update characters set gold = $1') === 0) {
      state.characters[String(args[1])].gold = Number(args[0]);
      return { rows: [] };
    }
    throw new Error('Unhandled SQL in trade fixture: ' + text);
  }

  return {
    state,
    query,
    pool: {
      async connect() {
        return { query, release() {} };
      }
    },
    async close() {}
  };
}

function makeHarness(seed) {
  const db = makeDatabase(seed);
  const app = { disable() {}, get() {} };
  const httpServer = { listen(_port, _host, callback) { if (callback) callback(); }, close(callback) { if (callback) callback(); } };
  class FakeWss {
    constructor() { this.clients = []; }
    on() {}
  }
  const content = {
    CLASSES: {
      warrior: { baseStats: { hp: 100, mp: 20, atk: 10, def: 8, mat: 4, mdf: 5, agi: 6, luk: 4 }, mv: {} }
    },
    BATTLE_ACTIONS: {},
    CLASS_ACTIONS: {},
    ITEMS: {
      potion: { id: 'potion', label: 'Potion', description: 'Soin', type: 'consumable', slot: null, stats: {} },
      bronze_sword: { id: 'bronze_sword', label: 'Épée de bronze', description: 'Arme', type: 'equipment', slot: 'weapon', etypeId: 1, stats: { atk: 7 } },
      leather_armor: { id: 'leather_armor', label: 'Armure de cuir', description: 'Armure', type: 'equipment', slot: 'armor', etypeId: 4, stats: { def: 5 } }
    },
    STARTER_ITEMS: {}, ENCOUNTERS: {}, QUESTS: {}, GUILD_HOUSE: {}, DUNGEONS: {}, START_POSITION: {}
  };
  const fakeRequire = function(request) {
    if (request === 'dotenv') return { config() {} };
    if (request === 'http') return { createServer() { return httpServer; } };
    if (request === 'crypto') return crypto;
    if (request === 'express') return function() { return app; };
    if (request === 'bcryptjs') return {};
    if (request === 'ws') return { WebSocketServer: FakeWss, WebSocket: { OPEN: 1 } };
    if (request === './db') return db;
    if (request === './mv-database') return { dataDirectory() { return '/fixture/mv-data'; } };
    if (request === './mv-events') return { verifyTaggedBattleEvent() { return {}; }, nativeEncounterForTroop() { return {}; } };
    if (request === './mv-combat') return { statsForClass() { return null; }, className(_id, fallback) { return fallback; } };
    if (request === './mv-inventory') return { definition() { return null; }, menuUseFor() { return null; }, parameterRatesForStates() { return [1, 1, 1, 1, 1, 1, 1, 1]; }, canClassEquip() { return true; } };
    if (request === './content') return content;
    throw new Error('Unexpected module request: ' + request);
  };
  const module = { exports: {} };
  const context = {
    require: fakeRequire, module, exports: module.exports, console: { log() {}, warn() {}, error() {} },
    process: { env: {}, on() {}, exit() {} }, Buffer, setTimeout() { return { unref() {} }; },
    setInterval() { return { unref() {} }; }
  };
  vm.runInNewContext(serverSource, context, { filename: 'server.js' });
  return { api: module.exports, db };
}

function socketFor() {
  const messages = [];
  return {
    readyState: 1,
    messages,
    send(raw) { messages.push(JSON.parse(raw)); }
  };
}

function player(id, name, x, socket) {
  return {
    socket, characterId: String(id), name, classId: 'warrior', level: 1, experience: 0, gold: 0,
    currentHp: 100, currentMp: 20, persistentStates: [], paramBonuses: [], equipment: {},
    mapId: 1, instanceId: null, x: Number(x), y: 10, direction: 2, battleId: null, tradeId: null
  };
}

function seedState() {
  return {
    characters: { '101': { gold: 60 }, '202': { gold: 12 } },
    inventory: {
      '101': { potion: 5, bronze_sword: 1 },
      '202': { leather_armor: 1 }
    },
    equipment: {
      '101': { etype_1: 'bronze_sword' },
      '202': { etype_4: 'leather_armor' }
    }
  };
}

async function activeTrade(harness) {
  const leftSocket = socketFor();
  const rightSocket = socketFor();
  const left = player('101', 'Aline', 10, leftSocket);
  const right = player('202', 'Bastien', 11, rightSocket);
  leftSocket.player = left;
  rightSocket.player = right;
  harness.api.onlineByCharacterId.set(left.characterId, left);
  harness.api.onlineByCharacterId.set(right.characterId, right);
  await harness.api.handleTradeRequest(leftSocket, { targetCharacterId: right.characterId });
  const tradeId = left.tradeId;
  assert.ok(tradeId, 'the request must create a pending trade');
  await harness.api.handleTradeResponse(rightSocket, { tradeId, accepted: true });
  assert.strictEqual(harness.api.trades.get(tradeId).state, 'active');
  return { left, right, leftSocket, rightSocket, tradeId };
}

function itemTotal(state, itemId) {
  return Object.keys(state.inventory).reduce((total, characterId) => total + Number((state.inventory[characterId] || {})[itemId] || 0), 0);
}

async function fixtureSuccessfulAtomicTransfer() {
  const harness = makeHarness(seedState());
  const trade = await activeTrade(harness);
  await harness.api.handleTradeSetOffer(trade.leftSocket, { tradeId: trade.tradeId, items: [{ itemId: 'potion', quantity: 2 }, { itemId: 'bronze_sword', quantity: 1 }], gold: 15 });
  await harness.api.handleTradeSetOffer(trade.rightSocket, { tradeId: trade.tradeId, items: [{ itemId: 'leather_armor', quantity: 1 }], gold: 2 });
  await harness.api.handleTradeAccept(trade.leftSocket, { tradeId: trade.tradeId });
  await harness.api.handleTradeAccept(trade.rightSocket, { tradeId: trade.tradeId });
  const state = harness.db.state;
  assert.deepStrictEqual(state.inventory['101'], { potion: 3, leather_armor: 1 });
  assert.deepStrictEqual(state.inventory['202'], { potion: 2, bronze_sword: 1 });
  assert.strictEqual(state.characters['101'].gold, 47);
  assert.strictEqual(state.characters['202'].gold, 25);
  assert.deepStrictEqual(state.equipment['101'], {});
  assert.deepStrictEqual(state.equipment['202'], {});
  assert.strictEqual(itemTotal(state, 'potion'), 5);
  assert.strictEqual(itemTotal(state, 'bronze_sword'), 1);
  assert.strictEqual(itemTotal(state, 'leather_armor'), 1);
  assert.ok(trade.leftSocket.messages.some((packet) => packet.type === 'tradeCompleted'));
  assert.ok(trade.rightSocket.messages.some((packet) => packet.type === 'tradeCompleted'));
}

async function fixtureRefusalAndDistance() {
  const harness = makeHarness(seedState());
  const leftSocket = socketFor();
  const rightSocket = socketFor();
  const left = player('101', 'Aline', 10, leftSocket);
  const right = player('202', 'Bastien', 11, rightSocket);
  leftSocket.player = left;
  rightSocket.player = right;
  harness.api.onlineByCharacterId.set(left.characterId, left);
  harness.api.onlineByCharacterId.set(right.characterId, right);
  await harness.api.handleTradeRequest(leftSocket, { targetCharacterId: right.characterId });
  const tradeId = left.tradeId;
  await harness.api.handleTradeResponse(rightSocket, { tradeId, accepted: false });
  assert.strictEqual(left.tradeId, null);
  assert.strictEqual(right.tradeId, null);
  assert.deepStrictEqual(harness.db.state, seedState());

  const farHarness = makeHarness(seedState());
  const farLeftSocket = socketFor();
  const farRightSocket = socketFor();
  const farLeft = player('101', 'Aline', 10, farLeftSocket);
  const farRight = player('202', 'Bastien', 13, farRightSocket);
  farLeftSocket.player = farLeft;
  farRightSocket.player = farRight;
  farHarness.api.onlineByCharacterId.set(farLeft.characterId, farLeft);
  farHarness.api.onlineByCharacterId.set(farRight.characterId, farRight);
  await farHarness.api.handleTradeRequest(farLeftSocket, { targetCharacterId: farRight.characterId });
  assert.strictEqual(farLeft.tradeId, null);
  assert.ok(farLeftSocket.messages.some((packet) => packet.code === 'trade_too_far'));

  const movedHarness = makeHarness(seedState());
  const moved = await activeTrade(movedHarness);
  moved.right.x = 13;
  await movedHarness.api.handleTradeSetOffer(moved.leftSocket, { tradeId: moved.tradeId, items: [{ itemId: 'potion', quantity: 1 }], gold: 0 });
  assert.strictEqual(moved.left.tradeId, null, 'leaving range during an active exchange cancels it');
  assert.strictEqual(moved.right.tradeId, null);
  assert.deepStrictEqual(movedHarness.db.state, seedState());
}

async function fixtureOfferChangeCancellationAndTimeout() {
  const harness = makeHarness(seedState());
  const trade = await activeTrade(harness);
  await harness.api.handleTradeSetOffer(trade.leftSocket, { tradeId: trade.tradeId, items: [{ itemId: 'potion', quantity: 1 }], gold: 0 });
  await harness.api.handleTradeAccept(trade.leftSocket, { tradeId: trade.tradeId });
  let live = harness.api.trades.get(trade.tradeId);
  assert.ok(live.accepted.has('101'));
  await harness.api.handleTradeSetOffer(trade.rightSocket, { tradeId: trade.tradeId, items: [{ itemId: 'leather_armor', quantity: 1 }], gold: 0 });
  live = harness.api.trades.get(trade.tradeId);
  assert.strictEqual(live.accepted.size, 0, 'editing either offer invalidates both confirmations');
  await harness.api.handleTradeCancel(trade.leftSocket, { tradeId: trade.tradeId });
  assert.deepStrictEqual(harness.db.state, seedState());

  const timedHarness = makeHarness(seedState());
  const timed = await activeTrade(timedHarness);
  timedHarness.api.trades.get(timed.tradeId).updatedAt = Date.now() - timedHarness.api.TRADE_TIMEOUT_MS - 1;
  timedHarness.api.expireTrades(Date.now());
  assert.strictEqual(timed.left.tradeId, null);
  assert.strictEqual(timed.right.tradeId, null);
  assert.deepStrictEqual(timedHarness.db.state, seedState());
}

async function fixtureUnavailableOfferDoesNotDuplicate() {
  const harness = makeHarness(seedState());
  const trade = await activeTrade(harness);
  await harness.api.handleTradeSetOffer(trade.leftSocket, { tradeId: trade.tradeId, items: [{ itemId: 'potion', quantity: 5 }], gold: 0 });
  // Simulate a server-authorized consumption after the offer was composed.
  harness.db.state.inventory['101'].potion = 4;
  await harness.api.handleTradeAccept(trade.leftSocket, { tradeId: trade.tradeId });
  assert.strictEqual(harness.db.state.inventory['101'].potion, 4);
  assert.strictEqual(harness.db.state.inventory['202'].potion, undefined);
  assert.strictEqual(harness.db.state.characters['101'].gold, 60);
  assert.strictEqual(harness.db.state.characters['202'].gold, 12);
  assert.ok(trade.leftSocket.messages.some((packet) => packet.code === 'trade_item_not_owned'));
}

(async function main() {
  await fixtureSuccessfulAtomicTransfer();
  await fixtureRefusalAndDistance();
  await fixtureOfferChangeCancellationAndTimeout();
  await fixtureUnavailableOfferDoesNotDuplicate();
  console.log('Trade fixtures passed: atomic transfer, equipped-item cleanup, refusal, distance, offer reset, cancellation, timeout and no duplication.');
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
