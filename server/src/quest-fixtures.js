'use strict';

// Verifies the authoritative quest lifecycle: server-controlled combat/loot
// progress makes a quest ready, but rewards are granted only by a verified NPC
// hand-in. Group members must each hand in their own share exactly once.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8') + `
module.exports = {
  startQuestFromNpc, progressCollectionQuestFromLoot, turnInQuestAtNpc,
  groups, onlineByCharacterId
};`;

function makeHarness() {
  const state = {
    characters: { '1': { experience: 0, gold: 0 }, '2': { experience: 0, gold: 0 } },
    quests: {}, inventory: {}, equipment: {}
  };
  async function query(text, values) {
    const sql = String(text).replace(/\s+/g, ' ').trim().toLowerCase();
    const args = values || [];
    const characterId = String(args[0]);
    if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [] };
    if (sql.indexOf('select quest_id, status, progress from character_quests where character_id = $1') === 0) {
      return { rows: Object.keys(state.quests[characterId] || {}).sort().map((quest_id) => Object.assign({ quest_id }, state.quests[characterId][quest_id])) };
    }
    if (sql.indexOf('select status, progress from character_quests where character_id = $1 and quest_id = $2') === 0) {
      const row = state.quests[characterId] && state.quests[characterId][String(args[1])];
      return { rows: row ? [Object.assign({}, row)] : [] };
    }
    if (sql.indexOf('insert into character_quests') === 0) {
      const questId = String(args[1]);
      state.quests[characterId] = state.quests[characterId] || {};
      if (state.quests[characterId][questId]) throw new Error('duplicate quest fixture insert');
      state.quests[characterId][questId] = { status: 'active', progress: 0 };
      return { rows: [] };
    }
    if (sql.indexOf("update character_quests set status = 'ready'") === 0) {
      const id = String(args[1]); const questId = String(args[2]);
      state.quests[id][questId] = { status: 'ready', progress: Number(args[0]) };
      return { rows: [] };
    }
    if (sql.indexOf("update character_quests set status = 'complete'") === 0) {
      const id = String(args[0]); const questId = String(args[1]);
      const row = state.quests[id] && state.quests[id][questId];
      if (!row || row.status !== 'ready') return { rows: [] };
      row.status = 'complete';
      return { rows: [{ quest_id: questId }] };
    }
    if (sql.indexOf('update character_quests set progress = $1') === 0) {
      const id = String(args[1]); const questId = String(args[2]);
      state.quests[id][questId].progress = Number(args[0]);
      return { rows: [] };
    }
    if (sql.indexOf('update characters set experience = experience + $1') === 0) {
      const character = state.characters[String(args[2])];
      character.experience += Number(args[0]); character.gold += Number(args[1]);
      return { rows: [{ experience: character.experience, gold: character.gold }] };
    }
    if (sql.indexOf('insert into character_inventory') === 0) {
      const id = String(args[0]); const itemId = String(args[1]); const quantity = Number(args[2]);
      state.inventory[id] = state.inventory[id] || {};
      state.inventory[id][itemId] = Number(state.inventory[id][itemId] || 0) + quantity;
      return { rows: [] };
    }
    if (sql.indexOf('select item_id, quantity from character_inventory where character_id = $1') === 0) {
      return { rows: Object.keys(state.inventory[characterId] || {}).map((item_id) => ({ item_id, quantity: state.inventory[characterId][item_id] })) };
    }
    if (sql.indexOf('select slot, item_id from character_equipment where character_id = $1') === 0) return { rows: [] };
    throw new Error('Unhandled SQL in quest fixture: ' + text);
  }
  const db = {
    query,
    pool: { async connect() { return { query, release() {} }; } },
    async close() {}
  };
  const content = {
    CLASSES: { warrior: { baseStats: { hp: 100, mp: 20, atk: 10, def: 8, mat: 4, mdf: 5, agi: 6, luk: 4 }, mv: {} } },
    BATTLE_ACTIONS: {}, CLASS_ACTIONS: {}, ITEMS: {
      wolf_pelt: { id: 'wolf_pelt', label: 'Peau de loup', type: 'material', stats: {} },
      slime_gel: { id: 'slime_gel', label: 'Gelée de slime', type: 'material', stats: {} }
    }, STARTER_ITEMS: {}, ENCOUNTERS: {}, SHOPS: {}, GUILD_HOUSE: {}, DUNGEONS: {}, START_POSITION: {},
    QUESTS: { wolf_pelts: { id: 'wolf_pelts', title: 'Peaux de loup', allowedModes: ['solo', 'group'], objective: { type: 'collect', itemId: 'wolf_pelt', text: 'Collecter 5 peaux.' }, goal: 5, reward: { experience: 10, gold: 4 } } }
  };
  const nativeQuest = {
    id: 'slime_gel_delivery', title: 'Échantillons de gelée', allowedModes: ['solo', 'group'],
    objective: { type: 'collect', itemId: 'mv:item:5', nativeItemId: 5, text: 'Collecter 3 gelées.' }, goal: 3,
    // Metadata rewards are intentionally ignored for native quests: the
    // verified turn-in command sequence is the sole reward source.
    reward: { experience: 0, gold: 0 }, native: true, source: { mapId: 1, eventId: 9, pageIndex: 0 }
  };
  const nativeTurnInRewards = {
    experience: 30, gold: 18, loot: [{ itemId: 'mv:item:5', quantity: 1 }], commandIndexes: [6, 7, 8]
  };
  class Wss { constructor() { this.clients = []; } on() {} }
  const fakeRequire = function(request) {
    if (request === 'dotenv') return { config() {} };
    if (request === 'http') return { createServer() { return { listen(_p, _h, cb) { if (cb) cb(); }, close(cb) { if (cb) cb(); } }; } };
    if (request === 'crypto') return crypto;
    if (request === 'express') return function() { return { disable() {}, get() {} }; };
    if (request === 'bcryptjs') return {};
    if (request === 'ws') return { WebSocketServer: Wss, WebSocket: { OPEN: 1 } };
    if (request === './db') return db;
    if (request === './mv-database') return { dataDirectory() { return '/fixture/mv-data'; } };
    if (request === './mv-events') return {
      verifyTaggedBattleEvent() { return {}; }, verifyTaggedBattleLobbyAction() { return {}; }, verifyTaggedNpcAction() { return {}; }, nativeEncounterForTroop() { return {}; },
      nativeQuestById(questId) { return questId === nativeQuest.id ? nativeQuest : null; },
      nativeQuestDefinitions() { return { slime_gel_delivery: nativeQuest }; },
      nativeQuestForNpcAction() { return null; }
    };
    if (request === './mv-combat') return { statsForClass() { return null; }, className(_id, fallback) { return fallback; } };
    if (request === './mv-inventory') return {
      definition(itemId) { return itemId === 'mv:item:5' ? { id: 'mv:item:5', label: 'Gelée de slime', type: 'consumable', mv: { kind: 'item', id: 5 }, stats: {} } : null; },
      menuUseFor() { return null; }, parameterRatesForStates() { return [1, 1, 1, 1, 1, 1, 1, 1]; }, canClassEquip() { return true; }
    };
    if (request === './content') return content;
    throw new Error('Unexpected module: ' + request);
  };
  const module = { exports: {} };
  vm.runInNewContext(source, { require: fakeRequire, module, exports: module.exports, console: { log() {}, warn() {}, error() {} }, process: { env: {}, on() {}, exit() {} }, Buffer, setInterval() { return { unref() {} }; }, setTimeout() { return { unref() {} }; } }, { filename: 'server.js' });
  return { api: module.exports, state, nativeQuest, nativeTurnInRewards };
}
function socket() { return { readyState: 1, send() {} }; }
function player(id, groupId) {
  return {
    socket: socket(), characterId: String(id), name: 'P' + id, classId: 'warrior', level: 1, experience: 0, gold: 0,
    currentHp: 100, currentMp: 20, persistentStates: [], paramBonuses: [], equipment: {}, groupId: groupId || null
  };
}

(async function main() {
  const harness = makeHarness();
  const first = player(1); const second = player(2);
  harness.api.onlineByCharacterId.set(first.characterId, first);
  harness.api.onlineByCharacterId.set(second.characterId, second);

  await harness.api.startQuestFromNpc(first, 'wolf_pelts', 'solo');
  const soloUpdates = await harness.api.progressCollectionQuestFromLoot(first, 'wolf_pelt', 5);
  assert.strictEqual(harness.state.quests['1'].wolf_pelts.status, 'ready', 'a completed objective is ready, not automatically claimed');
  assert.strictEqual(harness.state.characters['1'].experience, 0, 'objective completion grants no automatic experience');
  assert.strictEqual(soloUpdates[0].readyToTurnIn, true);
  const soloClaim = await harness.api.turnInQuestAtNpc(first, 'wolf_pelts', 'solo');
  assert.strictEqual(soloClaim.error, undefined);
  assert.strictEqual(harness.state.quests['1'].wolf_pelts.status, 'complete');
  assert.strictEqual(harness.state.characters['1'].experience, 10, 'the verified hand-in grants the solo reward once');
  assert.strictEqual((await harness.api.turnInQuestAtNpc(first, 'wolf_pelts', 'solo')).error[0], 'quest_already_turned_in');

  first.groupId = 'g'; second.groupId = 'g';
  harness.api.groups.set('g', { id: 'g', leaderCharacterId: first.characterId, memberIds: new Set([first.characterId, second.characterId]), pendingCharacterIds: new Set(), quests: new Map() });
  await harness.api.startQuestFromNpc(first, 'wolf_pelts', 'group');
  const groupUpdates = await harness.api.progressCollectionQuestFromLoot(first, 'wolf_pelt', 5);
  const groupQuest = harness.api.groups.get('g').quests.get('wolf_pelts');
  assert.strictEqual(groupQuest.status, 'ready', 'the shared objective waits for individual hand-ins');
  assert.strictEqual(harness.state.characters['1'].experience, 10, 'the group objective itself grants no automatic reward');
  assert.strictEqual(groupUpdates[0].readyToTurnIn, true);
  await harness.api.turnInQuestAtNpc(first, 'wolf_pelts', 'group');
  assert.strictEqual(harness.state.characters['1'].experience, 20, 'first member receives only their own group reward');
  assert.strictEqual(harness.state.characters['2'].experience, 0, 'second member receives nothing before personally speaking to the giver');
  assert.strictEqual(groupQuest.status, 'ready', 'the group quest remains ready until every eligible member has claimed');
  await harness.api.turnInQuestAtNpc(second, 'wolf_pelts', 'group');
  assert.strictEqual(harness.state.characters['2'].experience, 10, 'second member receives their reward after their own hand-in');
  assert.strictEqual(groupQuest.status, 'complete', 'the group quest closes only after all eligible members claim');

  await harness.api.startQuestFromNpc(first, 'slime_gel_delivery', 'solo');
  await harness.api.progressCollectionQuestFromLoot(first, 'mv:item:5', 3);
  assert.strictEqual(harness.state.quests['1'].slime_gel_delivery.status, 'ready', 'a map-authored collect quest progresses without content.js');
  assert.strictEqual(harness.state.characters['1'].experience, 20, 'native objective completion still has no automatic reward');
  const missingNativeReward = await harness.api.turnInQuestAtNpc(first, 'slime_gel_delivery', '', harness.nativeQuest);
  assert.strictEqual(missingNativeReward.error[0], 'quest_reward_missing', 'a native quest cannot fall back to comment rewards when its turn-in commands are absent');
  assert.strictEqual(harness.state.quests['1'].slime_gel_delivery.status, 'ready', 'a refused native hand-in leaves the ready objective claimable');
  const nativeSolo = await harness.api.turnInQuestAtNpc(first, 'slime_gel_delivery', '', harness.nativeQuest, harness.nativeTurnInRewards);
  assert.strictEqual(nativeSolo.error, undefined, 'the single native hand-in branch infers the ready solo mode');
  assert.strictEqual(harness.state.characters['1'].experience, 50, 'native quest hand-in applies its verified MV EXP reward');
  assert.strictEqual(harness.state.characters['1'].gold, 26, 'native quest hand-in applies its verified MV gold reward');
  assert.strictEqual(harness.state.inventory['1']['mv:item:5'], 1, 'native quest hand-in applies its verified MV item reward');

  await harness.api.startQuestFromNpc(first, 'slime_gel_delivery', 'group');
  await harness.api.progressCollectionQuestFromLoot(first, 'mv:item:5', 3);
  const nativeGroup = harness.api.groups.get('g').quests.get('slime_gel_delivery');
  assert.strictEqual(nativeGroup.status, 'ready', 'the native group objective waits for claims');
  // Simulate the rare state where this player has both an independently ready
  // solo run and the shared group run. The unqualified branch must fail closed.
  harness.state.quests['1'].slime_gel_delivery = { status: 'ready', progress: 3 };
  const ambiguousNativeTurnIn = await harness.api.turnInQuestAtNpc(first, 'slime_gel_delivery', '', harness.nativeQuest, harness.nativeTurnInRewards);
  assert.strictEqual(ambiguousNativeTurnIn.error[0], 'quest_turn_in_ambiguous', 'a shared hand-in branch refuses an ambiguous ready solo/group state');
  harness.state.quests['1'].slime_gel_delivery = { status: 'complete', progress: 3 };
  const nativeFirstClaim = await harness.api.turnInQuestAtNpc(first, 'slime_gel_delivery', '', harness.nativeQuest, harness.nativeTurnInRewards);
  assert.strictEqual(nativeFirstClaim.mode, 'group', 'one hand-in branch infers the ready group mode');
  assert.strictEqual(nativeGroup.status, 'ready', 'the group stays ready until every eligible member has spoken to the giver');
  const nativeSecondClaim = await harness.api.turnInQuestAtNpc(second, 'slime_gel_delivery', '', harness.nativeQuest, harness.nativeTurnInRewards);
  assert.strictEqual(nativeSecondClaim.mode, 'group', 'the other eligible member uses the same native hand-in branch');
  assert.strictEqual(nativeGroup.status, 'complete', 'the native group quest completes after every individual claim');
  assert.strictEqual(harness.state.characters['1'].experience, 80, 'the first native group claim grants one personal reward');
  assert.strictEqual(harness.state.characters['2'].experience, 40, 'the second native group claim grants their own personal reward');

  console.log('Quest fixtures passed: static/native objectives wait for verified NPC hand-ins and every group member claims the same native turn-in branch once.');
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
