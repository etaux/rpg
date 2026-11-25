'use strict';

// Exercises the new native-service handlers against a small transactional
// PostgreSQL-shaped adapter: merchant buyback, personal bank, healer, direct
// quest rejection and range-bound generic NPC sessions.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8') + `
module.exports = {
  handleNpcAction, handleMerchantBuy, handleMerchantSell, handleBankDeposit,
  handleBankWithdraw, handleQuestStart, npcServiceSessions, onlineByCharacterId
};`;

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function makeDatabase(seed) {
  const state = clone(seed);
  let rollback = null;
  function bag(id) { if (!state.inventory[String(id)]) state.inventory[String(id)] = {}; return state.inventory[String(id)]; }
  function bankBag(id) { if (!state.bankInventory[String(id)]) state.bankInventory[String(id)] = {}; return state.bankInventory[String(id)]; }
  function quantity(collection, id, itemId) { return Number((collection[String(id)] || {})[String(itemId)] || 0); }
  function rows(collection, id) { return Object.keys(collection[String(id)] || {}).filter((itemId) => quantity(collection, id, itemId) > 0).sort().map((item_id) => ({ item_id, quantity: quantity(collection, id, item_id) })); }
  async function query(text, values) {
    const sql = String(text).replace(/\s+/g, ' ').trim().toLowerCase();
    const args = values || [];
    if (sql === 'begin') { rollback = clone(state); return { rows: [] }; }
    if (sql === 'commit') { rollback = null; return { rows: [] }; }
    if (sql === 'rollback') {
      if (rollback) { Object.keys(state).forEach((key) => delete state[key]); Object.assign(state, clone(rollback)); }
      rollback = null;
      return { rows: [] };
    }
    if (sql.indexOf('select item_id, quantity from character_inventory where character_id = $1 order by item_id asc') === 0) return { rows: rows(state.inventory, args[0]) };
    if (sql.indexOf('select item_id, quantity from character_bank_inventory where character_id = $1 order by item_id asc') === 0) return { rows: rows(state.bankInventory, args[0]) };
    if (sql.indexOf('select slot, item_id from character_equipment where character_id = $1') === 0) {
      const equipment = state.equipment[String(args[0])] || {};
      return { rows: Object.keys(equipment).map((slot) => ({ slot, item_id: equipment[slot] })) };
    }
    if (sql.indexOf('select id, gold from characters where id = $1 for update') === 0) {
      const character = state.characters[String(args[0])];
      return { rows: character ? [{ id: String(args[0]), gold: character.gold }] : [] };
    }
    if (sql.indexOf('select current_hp, current_mp, persistent_states, param_bonuses from characters where id = $1 for update') === 0) {
      const character = state.characters[String(args[0])];
      return { rows: character ? [clone(character)] : [] };
    }
    if (sql.indexOf('select quantity from character_inventory where character_id = $1 and item_id = $2') === 0) {
      const amount = quantity(state.inventory, args[0], args[1]);
      return { rows: amount ? [{ quantity: amount }] : [] };
    }
    if (sql.indexOf('select quantity from character_bank_inventory where character_id = $1 and item_id = $2') === 0) {
      const amount = quantity(state.bankInventory, args[0], args[1]);
      return { rows: amount ? [{ quantity: amount }] : [] };
    }
    if (sql.indexOf('select gold from character_banks where character_id = $1') === 0) {
      const value = Number(state.banks[String(args[0])] || 0);
      return { rows: state.banks[String(args[0])] === undefined ? [] : [{ gold: value }] };
    }
    if (sql.indexOf('insert into character_banks') === 0) {
      const id = String(args[0]);
      if (state.banks[id] === undefined) state.banks[id] = 0;
      return { rows: [] };
    }
    if (sql.indexOf('update character_banks set gold = $1') === 0) { state.banks[String(args[1])] = Number(args[0]); return { rows: [] }; }
    if (sql.indexOf('update characters set gold = $1') === 0) { state.characters[String(args[1])].gold = Number(args[0]); return { rows: [] }; }
    if (sql.indexOf("update characters set current_hp = $1, current_mp = $2, persistent_states = '[]'::jsonb") === 0) {
      const character = state.characters[String(args[2])];
      character.current_hp = Number(args[0]); character.current_mp = Number(args[1]); character.persistent_states = [];
      return { rows: [] };
    }
    if (sql.indexOf('delete from character_inventory where character_id = $1 and item_id = $2') === 0) { delete bag(args[0])[String(args[1])]; return { rows: [] }; }
    if (sql.indexOf('update character_inventory set quantity = quantity - $3') === 0) { bag(args[0])[String(args[1])] -= Number(args[2]); return { rows: [] }; }
    if (sql.indexOf('insert into character_inventory ') === 0) { bag(args[0])[String(args[1])] = quantity(state.inventory, args[0], args[1]) + Number(args[2]); return { rows: [] }; }
    if (sql.indexOf('delete from character_bank_inventory where character_id = $1 and item_id = $2') === 0) { delete bankBag(args[0])[String(args[1])]; return { rows: [] }; }
    if (sql.indexOf('update character_bank_inventory set quantity = quantity - $3') === 0) { bankBag(args[0])[String(args[1])] -= Number(args[2]); return { rows: [] }; }
    if (sql.indexOf('insert into character_bank_inventory ') === 0) { bankBag(args[0])[String(args[1])] = quantity(state.bankInventory, args[0], args[1]) + Number(args[2]); return { rows: [] }; }
    if (sql.indexOf('delete from character_equipment where character_id = $1 and item_id = $2') === 0) {
      const equipment = state.equipment[String(args[0])] || {};
      Object.keys(equipment).forEach((slot) => { if (equipment[slot] === String(args[1])) delete equipment[slot]; });
      return { rows: [] };
    }
    throw new Error('Unhandled SQL in service fixture: ' + text);
  }
  return { state, query, pool: { async connect() { return { query, release() {} }; } }, async close() {} };
}

function makeHarness() {
  const db = makeDatabase({
    characters: { '1': { gold: 500, current_hp: 15, current_mp: 2, persistent_states: [4], param_bonuses: [] } },
    inventory: { '1': { potion: 5, bronze_sword: 1 } }, equipment: { '1': { etype_1: 'bronze_sword' } },
    banks: {}, bankInventory: {}
  });
  const content = {
    CLASSES: { warrior: { baseStats: { hp: 100, mp: 20, atk: 10, def: 8, mat: 4, mdf: 5, agi: 6, luk: 4 }, mv: {} } },
    BATTLE_ACTIONS: {}, CLASS_ACTIONS: {}, ENCOUNTERS: {}, QUESTS: {}, GUILD_HOUSE: {}, DUNGEONS: {}, START_POSITION: {},
    ITEMS: {
      potion: { id: 'potion', label: 'Potion', type: 'consumable', description: 'Soin', stats: {}, tradable: true },
      bronze_sword: { id: 'bronze_sword', label: 'Épée de bronze', type: 'equipment', slot: 'weapon', etypeId: 1, description: 'Arme', stats: { atk: 7 }, tradable: true }
    },
    STARTER_ITEMS: {},
    SHOPS: { starter_general: { id: 'starter_general', title: 'Boutique test', mode: 'both', items: { potion: { sellPrice: 25, buyPrice: 10 }, bronze_sword: { sellPrice: 100, buyPrice: 45 } } } }
  };
  class Wss { constructor() { this.clients = []; } on() {} }
  const fakeRequire = function(request) {
    if (request === 'dotenv') return { config() {} };
    if (request === 'http') return { createServer() { return { listen(_p, _h, callback) { if (callback) callback(); }, close(callback) { if (callback) callback(); } }; } };
    if (request === 'crypto') return crypto;
    if (request === 'express') return function() { return { disable() {}, get() {} }; };
    if (request === 'bcryptjs') return {};
    if (request === 'ws') return { WebSocketServer: Wss, WebSocket: { OPEN: 1 } };
    if (request === './db') return db;
    if (request === './mv-database') return { dataDirectory() { return '/fixture/mv-data'; } };
    if (request === './mv-events') return {
      verifyTaggedBattleEvent() { return {}; }, nativeEncounterForTroop() { return {}; },
      verifyTaggedNpcAction(context, action) {
        return { ok: true, mapId: 1, eventId: 1, pageIndex: 0, commandIndex: 1, service: context.service, action, eventX: 10, eventY: 10, metadata: context.metadata || {}, actionMetadata: context.actionMetadata || {} };
      }
    };
    if (request === './mv-combat') return { statsForClass() { return null; }, className(_id, fallback) { return fallback; } };
    if (request === './mv-inventory') return { definition() { return null; }, menuUseFor() { return null; }, parameterRatesForStates() { return [1, 1, 1, 1, 1, 1, 1, 1]; }, canClassEquip() { return true; } };
    if (request === './content') return content;
    throw new Error('Unexpected module: ' + request);
  };
  const module = { exports: {} };
  vm.runInNewContext(source, { require: fakeRequire, module, exports: module.exports, console: { log() {}, warn() {}, error() {} }, process: { env: {}, on() {}, exit() {} }, Buffer, setInterval() { return { unref() {} }; }, setTimeout() { return { unref() {} }; } }, { filename: 'server.js' });
  return { db, api: module.exports };
}

function socket() { const messages = []; return { readyState: 1, messages, send(raw) { messages.push(JSON.parse(raw)); } }; }
function player(sock) {
  return { socket: sock, characterId: '1', name: 'Aline', classId: 'warrior', level: 1, experience: 0, gold: 500, currentHp: 15, currentMp: 2, persistentStates: [4], paramBonuses: [], equipment: { etype_1: 'bronze_sword' }, mapId: 1, instanceId: null, x: 10, y: 10, direction: 2, battleId: null, tradeId: null, auctionSessionId: null, npcServiceSessionId: null };
}
async function open(harness, sock, spec) {
  await harness.api.handleNpcAction(sock, { requestId: 'r-' + spec.service, action: spec.action || 'open', eventContext: spec });
  assert.ok(sock.player.npcServiceSessionId, spec.service + ' must open an NPC-bound session');
  return sock.player.npcServiceSessionId;
}

(async function main() {
  const harness = makeHarness();
  const sock = socket();
  const person = player(sock);
  sock.player = person;
  harness.api.onlineByCharacterId.set(person.characterId, person);

  const merchantSession = await open(harness, sock, { service: 'merchant', metadata: { shop: 'starter_general', mode: 'both' } });
  await harness.api.handleMerchantBuy(sock, { sessionId: merchantSession, itemId: 'potion', quantity: 2 });
  assert.strictEqual(harness.db.state.characters['1'].gold, 450);
  assert.strictEqual(harness.db.state.inventory['1'].potion, 7);
  await harness.api.handleMerchantSell(sock, { sessionId: merchantSession, itemId: 'bronze_sword', quantity: 1 });
  assert.strictEqual(harness.db.state.characters['1'].gold, 495);
  assert.strictEqual(harness.db.state.inventory['1'].bronze_sword, undefined);
  assert.strictEqual(harness.db.state.equipment['1'].etype_1, undefined, 'selling equipped gear must clear its server slot');

  const bankSession = await open(harness, sock, { service: 'banker' });
  await harness.api.handleBankDeposit(sock, { sessionId: bankSession, asset: 'gold', quantity: 100 });
  await harness.api.handleBankDeposit(sock, { sessionId: bankSession, asset: 'item', itemId: 'potion', quantity: 3 });
  assert.strictEqual(harness.db.state.characters['1'].gold, 395);
  assert.strictEqual(harness.db.state.banks['1'], 100);
  assert.strictEqual(harness.db.state.inventory['1'].potion, 4);
  assert.strictEqual(harness.db.state.bankInventory['1'].potion, 3);
  await harness.api.handleBankWithdraw(sock, { sessionId: bankSession, asset: 'gold', quantity: 60 });
  await harness.api.handleBankWithdraw(sock, { sessionId: bankSession, asset: 'item', itemId: 'potion', quantity: 2 });
  assert.strictEqual(harness.db.state.characters['1'].gold, 455);
  assert.strictEqual(harness.db.state.banks['1'], 40);
  assert.strictEqual(harness.db.state.inventory['1'].potion, 6);
  assert.strictEqual(harness.db.state.bankInventory['1'].potion, 1);

  await harness.api.handleNpcAction(sock, { requestId: 'heal', action: 'heal', eventContext: { service: 'innkeeper' } });
  assert.strictEqual(harness.db.state.characters['1'].current_hp, 100);
  assert.strictEqual(harness.db.state.characters['1'].current_mp, 20);
  assert.deepStrictEqual(harness.db.state.characters['1'].persistent_states, []);
  await harness.api.handleQuestStart(sock, { questId: 'anything' });
  assert.ok(sock.messages.some((packet) => packet.type === 'error' && packet.code === 'quest_npc_required'), 'direct quest packets must be rejected');

  person.x = 12;
  await harness.api.handleBankWithdraw(sock, { sessionId: bankSession, asset: 'gold', quantity: 1 });
  assert.strictEqual(person.npcServiceSessionId, null, 'leaving range must close generic service session');
  assert.ok(sock.messages.some((packet) => packet.type === 'npcServiceClosed'));
  console.log('Service fixtures passed: merchant transactions, personal bank, free healing, quest gate and range invalidation.');
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
