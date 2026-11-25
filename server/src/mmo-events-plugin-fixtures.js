'use strict';

// Executes the event bridge in a compact RPG Maker MV-shaped VM. The lobby
// test is intentionally case-sensitive at the plugin-command boundary: MV
// preserves OPEN/JOIN as authored, while the bridge normalizes it internally.
// OPEN must still emit battleLobbyOpen rather than accidentally falling into
// the JOIN packet path.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const pluginPath = path.resolve(__dirname, '..', '..', 'rpgmaker', 'js', 'plugins', 'MMOEvents.js');
const source = fs.readFileSync(pluginPath, 'utf8');
const sent = [];
const packetHandlers = {};
const errorHandlers = [];
const localRewardExecutions = [];

function Game_Interpreter() {}
Game_Interpreter.prototype.updateWaitMode = function() { return false; };
Game_Interpreter.prototype.setWaitMode = function(mode) { this._waitMode = mode; };
Game_Interpreter.prototype.command301 = function() { return true; };
Game_Interpreter.prototype.pluginCommand = function() { return true; };
[125, 126, 127, 128, 315].forEach((code) => {
  Game_Interpreter.prototype['command' + code] = function() { localRewardExecutions.push(code); return true; };
});

function Scene_Map() {}
Scene_Map.prototype.onMapLoaded = function() {};

const list = [
  { code: 108, indent: 0, parameters: ['<MMO battle=slime_group_test>'] },
  { code: 356, indent: 0, parameters: ['MMO BATTLE_LOBBY OPEN slime_group_test'] },
  { code: 108, indent: 0, parameters: ['<MMO battle=slime_group_test>'] },
  { code: 356, indent: 0, parameters: ['MMO BATTLE_LOBBY JOIN slime_group_test'] }
];
const context = {
  console: { info() {}, error() {}, warn() {}, log() {} },
  Game_Interpreter,
  Scene_Map,
  MMOFoundation: {
    activeCharacter: { id: 'fixture' },
    connected: true,
    registerPacketHandler(type, handler) { packetHandlers[type] = handler; },
    registerErrorHandler(handler) { errorHandlers.push(handler); },
    send(type, payload) { sent.push({ type, payload }); return true; },
    toast() {}
  },
  $gameMap: {
    mapId() { return 1; },
    event(id) { return id === 1 ? { _pageIndex: 0 } : null; }
  },
  $dataMap: { events: [null, { pages: [{ list }] }] }
};
vm.runInNewContext(source, context, { filename: 'MMOEvents.js' });

const interpreter = new context.Game_Interpreter();
interpreter._eventId = 1;
interpreter._index = 1;
context.MMOEvents.sendBattleLobbyAction(interpreter, 'OPEN', 'slime_group_test');
assert.strictEqual(sent.length, 1);
assert.strictEqual(sent[0].type, 'battleLobbyOpen', 'uppercase MV OPEN must select battleLobbyOpen');
assert.deepStrictEqual(JSON.parse(JSON.stringify(sent[0].payload.eventContext)), { mapId: 1, eventId: 1, pageIndex: 0, commandIndex: 1 });

interpreter._index = 3;
context.MMOEvents.sendBattleLobbyAction(interpreter, 'JOIN', 'slime_group_test');
assert.strictEqual(sent.length, 2);
assert.strictEqual(sent[1].type, 'battleLobbyJoin', 'uppercase MV JOIN must select battleLobbyJoin');
assert.deepStrictEqual(JSON.parse(JSON.stringify(sent[1].payload.eventContext)), { mapId: 1, eventId: 1, pageIndex: 0, commandIndex: 3 });

packetHandlers.battleLobbyState({ lobby: {
  status: 'lobby', battleKey: 'slime_group_test', mapId: 1, instanceId: null, eventId: 1, pageIndex: 0,
  coop: 'optional', ownerCharacterId: 'fixture', memberIds: ['fixture'],
  members: [{ characterId: 'fixture', name: 'Fixture', isOwner: true }], expiresAt: new Date(Date.now() + 60000).toISOString()
} });
assert.strictEqual(context.MMOEvents.activeLobby.battleKey, 'slime_group_test', 'a lobby state activates the map panel state');
packetHandlers.battleLobbyClosed({ battleKey: 'slime_group_test', reason: 'Combat lancé.' });
assert.strictEqual(context.MMOEvents.activeLobby, null, 'a lobby close packet hides the map panel state');

list.splice(0, list.length,
  { code: 108, indent: 0, parameters: ['<MMO npc=quest_giver>'] },
  { code: 108, indent: 0, parameters: ['<MMO npc-action=quest_start quest=slime_group_test mode=solo>'] },
  { code: 356, indent: 0, parameters: ['MMO NPC_ACTION quest_start'] },
  { code: 108, indent: 0, parameters: ['<MMO npc-action=quest_turn_in quest=slime_group_test>'] },
  { code: 356, indent: 0, parameters: ['MMO NPC_ACTION quest_turn_in'] },
  { code: 125, indent: 0, parameters: [0, 0, 18] },
  { code: 315, indent: 0, parameters: [0, 0, 0, 0, 30, false] },
  { code: 126, indent: 0, parameters: [5, 0, 0, 1] }
);
packetHandlers.questSnapshot({ quests: [] });
assert.deepStrictEqual(JSON.parse(JSON.stringify(context.MMOEvents.questMarkerEntries())), [{ eventId: 1, symbol: '!' }], 'an available quest giver shows an exclamation marker');
packetHandlers.questSnapshot({ quests: [{ questId: 'slime_group_test', status: 'ready' }] });
assert.deepStrictEqual(JSON.parse(JSON.stringify(context.MMOEvents.questMarkerEntries())), [{ eventId: 1, symbol: '?' }], 'a ready quest shows a question marker');
packetHandlers.questSnapshot({ quests: [{ questId: 'slime_group_test', status: 'complete' }] });
assert.deepStrictEqual(JSON.parse(JSON.stringify(context.MMOEvents.questMarkerEntries())), [], 'a claimed quest removes its marker');

// A successful native turn-in resumes the same MV branch but must not execute
// its local Change commands: the server has already persisted and synchronized
// this exact reward sequence after rereading MapXXX.json.
interpreter._index = 4;
interpreter.pluginCommand('MMO', ['NPC_ACTION', 'quest_turn_in']);
const turnInPacket = sent[sent.length - 1];
assert.strictEqual(turnInPacket.type, 'npcAction', 'the native hand-in sends the verified NPC request');
assert.deepStrictEqual(JSON.parse(JSON.stringify(turnInPacket.payload.eventContext)), { mapId: 1, eventId: 1, pageIndex: 0, commandIndex: 4 });
assert.strictEqual(interpreter._waitMode, 'mmoNpcAction', 'the event waits for the server before passing its reward commands');
packetHandlers.npcServiceOpen({ requestId: turnInPacket.payload.requestId, service: 'quest_giver', message: 'Récompense validée.' });
assert.strictEqual(interpreter.updateWaitMode(), false, 'a server-authorized hand-in resumes the native branch');
[5, 6, 7].forEach((index) => {
  interpreter._index = index;
  interpreter['command' + list[index].code]();
});
assert.deepStrictEqual(localRewardExecutions, [], 'server-owned native quest rewards are skipped locally to prevent double gain');

console.log('MMOEvents plugin fixtures passed: uppercase OPEN/JOIN commands, quest markers and server-owned native turn-in rewards behave as expected.');
