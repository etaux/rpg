'use strict';

// Runs the real pre-battle lobby and monster-reservation handlers in a compact
// VM harness. It proves that only the originating group can join a reserved
// event and that exactly one shared battle owns a world monster.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8') + `
module.exports = {
  handleBattleLobbyOpen, handleBattleLobbyJoin, handleBattleStart, nativeQuestProgressForBattle,
  battleLobbies, worldMonsters, battles, onlineByCharacterId, groups, expireWorldMonsters
};`;

function makeHarness() {
  const db = { query: async function() { throw new Error('No database query expected before battle resolution.'); }, pool: { async connect() { throw new Error('No transaction expected.'); } }, async close() {} };
  const content = {
    CLASSES: { warrior: { baseStats: { hp: 100, mp: 20, atk: 10, def: 8, mat: 4, mdf: 5, agi: 6, luk: 4 }, mv: {} } },
    BATTLE_ACTIONS: {}, CLASS_ACTIONS: {}, ITEMS: {}, STARTER_ITEMS: {}, ENCOUNTERS: {}, QUESTS: {}, SHOPS: {}, GUILD_HOUSE: {}, DUNGEONS: {}, START_POSITION: {}
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
      verifyTaggedNpcAction() { return {}; },
      verifyTaggedBattleEvent(context) {
        return { ok: true, mapId: 1, eventId: 7, pageIndex: 0, commandIndex: 5, eventX: 10, eventY: 10, troopId: 1,
          coop: context.coop || 'optional', metadata: { battle: 'wolf_alpha', respawn: '30' }, canEscape: false, rewards: { experience: 0, gold: 0, loot: [] } };
      },
      verifyTaggedBattleLobbyAction(context, action, key) {
        if (key !== 'wolf_alpha' || context.action !== action) return { ok: false, code: 'battle_lobby_invalid', message: 'invalid' };
        return { ok: true, mapId: 1, eventId: 7, pageIndex: 0, commandIndex: 5, eventX: 10, eventY: 10, troopId: 1,
          coop: 'optional', battleKey: 'wolf_alpha', metadata: { battle: 'wolf_alpha', respawn: '30' }, canEscape: false, rewards: { experience: 0, gold: 0, loot: [] } };
      },
      nativeQuestById(questId) {
        return questId === 'slime_patrol' ? { id: 'slime_patrol', native: true, objective: { type: 'defeat', target: 'slime' }, goal: 3, allowedModes: ['solo'], reward: { experience: 3, gold: 1 } } : null;
      },
      nativeQuestDefinitions() { return {}; },
      nativeQuestForNpcAction() { return null; },
      nativeEncounterForTroop() { return { ok: true, id: 'wolf', title: 'Loup', mvTroopId: 1, allowEvent: true, enemies: [{ templateId: 'wolf', name: 'Loup', hp: 30, mp: 0, atk: 8, def: 2, mat: 1, mdf: 1, agi: 4 }], rewards: { experience: 3, gold: 1 }, loot: [], questProgress: [] }; }
    };
    if (request === './mv-combat') return { statsForClass() { return null; }, className(_id, fallback) { return fallback; }, levelForExperience(_id, xp, level) { return level; }, actionsForClass() { return []; } };
    if (request === './mv-inventory') return { definition() { return null; }, menuUseFor() { return null; }, parameterRatesForStates() { return [1, 1, 1, 1, 1, 1, 1, 1]; }, canClassEquip() { return true; } };
    if (request === './content') return content;
    throw new Error('Unexpected module: ' + request);
  };
  const module = { exports: {} };
  vm.runInNewContext(source, { require: fakeRequire, module, exports: module.exports, console: { log() {}, warn() {}, error() {} }, process: { env: {}, on() {}, exit() {} }, Buffer, setInterval() { return { unref() {} }; }, setTimeout() { return { unref() {} }; } }, { filename: 'server.js' });
  return module.exports;
}

function socket() { const messages = []; return { readyState: 1, messages, send(raw) { messages.push(JSON.parse(raw)); } }; }
function player(id, groupId, sock) {
  return { socket: sock, characterId: String(id), name: 'P' + id, classId: 'warrior', level: 1, experience: 0, gold: 0,
    currentHp: 100, currentMp: 20, persistentStates: [], paramBonuses: [], equipment: {}, mapId: 1, instanceId: null,
    x: 10, y: 9, direction: 2, battleId: null, battleExitPending: false, tradeId: null, auctionSessionId: null, npcServiceSessionId: null, groupId }; }
function context(action, coop) { return { action, coop: coop || 'optional' }; }
function hasError(sock, code) { return sock.messages.some((packet) => packet.type === 'error' && packet.code === code); }

(async function main() {
  const api = makeHarness();
  const nativeProgress = api.nativeQuestProgressForBattle({ metadata: { quest_progress: 'slime_patrol', quest_amount: '2' } });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(nativeProgress.rules)), [{ questId: 'slime_patrol', amount: 2 }], 'a native defeat tag becomes an authoritative progress rule');
  assert.ok(api.nativeQuestProgressForBattle({ metadata: { quest_progress: 'missing_quest', quest_amount: '1' } }).error, 'unknown native defeat tags fail closed');
  const oneSocket = socket(); const twoSocket = socket(); const outsiderSocket = socket();
  const one = player(1, 'group-a', oneSocket); const two = player(2, 'group-a', twoSocket); const outsider = player(3, null, outsiderSocket);
  oneSocket.player = one; twoSocket.player = two; outsiderSocket.player = outsider;
  [one, two, outsider].forEach((entry) => api.onlineByCharacterId.set(entry.characterId, entry));
  api.groups.set('group-a', { id: 'group-a', leaderCharacterId: one.characterId, memberIds: new Set([one.characterId, two.characterId]), pendingCharacterIds: new Set(), quests: new Map() });

  api.handleBattleLobbyOpen(oneSocket, { battleKey: 'wolf_alpha', eventContext: context('open') });
  assert.strictEqual(api.battleLobbies.size, 1, 'the first group member must reserve this exact monster');
  assert.strictEqual(api.worldMonsters.size, 1);
  const initialLobbyPacket = oneSocket.messages.find((packet) => packet.type === 'battleLobbyState');
  assert.ok(initialLobbyPacket && initialLobbyPacket.lobby, 'the lobby owner receives a display snapshot');
  assert.strictEqual(initialLobbyPacket.lobby.status, 'lobby');
  assert.strictEqual(initialLobbyPacket.lobby.mapId, 1);
  assert.strictEqual(initialLobbyPacket.lobby.coop, 'optional');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(initialLobbyPacket.lobby.members)), [{ characterId: '1', name: 'P1', isOwner: true }]);
  api.handleBattleLobbyJoin(outsiderSocket, { battleKey: 'wolf_alpha', eventContext: context('join') });
  assert.ok(hasError(outsiderSocket, 'battle_lobby_group_only'), 'a non-grouped player cannot join another group’s monster');
  api.handleBattleLobbyJoin(twoSocket, { battleKey: 'wolf_alpha', eventContext: context('join') });
  const lobby = Array.from(api.battleLobbies.values())[0];
  assert.strictEqual(lobby.memberIds.size, 2);
  const joinedLobbyPacket = twoSocket.messages.find((packet) => packet.type === 'battleLobbyState');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(joinedLobbyPacket.lobby.members)), [
    { characterId: '1', name: 'P1', isOwner: true },
    { characterId: '2', name: 'P2', isOwner: false }
  ]);

  await api.handleBattleStart(oneSocket, { source: 'event', eventContext: context('start', 'optional') });
  assert.ok(one.battleId && one.battleId === two.battleId, 'joined group members must receive exactly one shared battle');
  assert.strictEqual(api.battleLobbies.size, 0, 'the lobby closes once the battle starts');
  assert.ok(oneSocket.messages.some((packet) => packet.type === 'battleLobbyClosed' && packet.reason === 'Combat lancé.'), 'the owner lobby panel closes when the battle starts');
  assert.ok(twoSocket.messages.some((packet) => packet.type === 'battleLobbyClosed' && packet.reason === 'Combat lancé.'), 'the member lobby panel closes when the battle starts');
  assert.strictEqual(Array.from(api.worldMonsters.values())[0].status, 'in_battle');
  await api.handleBattleStart(outsiderSocket, { source: 'event', eventContext: context('start', 'solo') });
  assert.ok(hasError(outsiderSocket, 'monster_in_battle'), 'the same monster cannot create a parallel combat for another player');
  const monster = Array.from(api.worldMonsters.values())[0];
  monster.status = 'respawning'; monster.respawnAt = Date.now() - 1;
  api.expireWorldMonsters(Date.now());
  assert.strictEqual(api.worldMonsters.size, 0, 'a defeated monster must become available only after its respawn timer');
  assert.ok(oneSocket.messages.some((packet) => packet.type === 'worldMonsterState' && packet.status === 'available'));

  console.log('World-event fixtures passed: group lobby, exclusive monster reservation, respawn release and no parallel encounter.');
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
