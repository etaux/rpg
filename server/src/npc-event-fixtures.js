'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mmo-npc-event-'));
process.env.RPG_MV_DATA_PATH = dataDirectory;

const eventPage = {
  list: [
    { code: 108, indent: 0, parameters: ['<MMO npc=auction_house>'] },
    { code: 102, indent: 0, parameters: [['Ouvrir l’hôtel des ventes', 'En savoir plus', 'Partir'], 0, 0, 2, 0] },
    { code: 402, indent: 0, parameters: [0, 'Ouvrir l’hôtel des ventes'] },
    { code: 108, indent: 1, parameters: ['<MMO npc-action=open>'] },
    { code: 356, indent: 1, parameters: ['MMO NPC_ACTION open'] },
    { code: 0, indent: 0, parameters: [] }
  ]
};
fs.writeFileSync(path.join(dataDirectory, 'Map001.json'), JSON.stringify({ events: [null, { id: 1, x: 10, y: 8, pages: [eventPage] }] }));

const events = require('./mv-events');
const valid = events.verifyTaggedNpcAction({ mapId: 1, eventId: 1, pageIndex: 0, commandIndex: 4 }, 'open');
assert.strictEqual(valid.ok, true);
assert.strictEqual(valid.service, 'auction_house');
assert.strictEqual(valid.eventX, 10);
assert.strictEqual(valid.eventY, 8);
assert.strictEqual(events.verifyTaggedNpcAction({ mapId: 1, eventId: 1, pageIndex: 0, commandIndex: 4 }, 'buy').ok, false);

const invalidPage = JSON.parse(JSON.stringify(eventPage));
invalidPage.list[3] = { code: 108, indent: 1, parameters: ['<MMO npc-action=buy>'] };
fs.writeFileSync(path.join(dataDirectory, 'Map002.json'), JSON.stringify({ events: [null, { id: 1, x: 10, y: 8, pages: [invalidPage] }] }));
assert.strictEqual(events.verifyTaggedNpcAction({ mapId: 2, eventId: 1, pageIndex: 0, commandIndex: 4 }, 'open').ok, false);

const questPage = {
  list: [
    { code: 108, indent: 0, parameters: ['<MMO npc=quest_giver>'] },
    { code: 108, indent: 0, parameters: ['<MMO npc-action=quest_start quest=rat_problem mode=solo>'] },
    { code: 356, indent: 0, parameters: ['MMO NPC_ACTION quest_start'] },
    { code: 108, indent: 0, parameters: ['<MMO npc-action=quest_turn_in quest=rat_problem mode=solo>'] },
    { code: 356, indent: 0, parameters: ['MMO NPC_ACTION quest_turn_in'] },
    { code: 0, indent: 0, parameters: [] }
  ]
};
const merchantPage = {
  list: [
    { code: 108, indent: 0, parameters: ['<MMO npc=merchant shop=starter_general mode=both>'] },
    { code: 108, indent: 0, parameters: ['<MMO npc-action=open>'] },
    { code: 356, indent: 0, parameters: ['MMO NPC_ACTION open'] },
    { code: 0, indent: 0, parameters: [] }
  ]
};
fs.writeFileSync(path.join(dataDirectory, 'Map003.json'), JSON.stringify({ events: [null,
  { id: 1, x: 5, y: 5, pages: [questPage] }, { id: 2, x: 7, y: 5, pages: [merchantPage] }
] }));
const quest = events.verifyTaggedNpcAction({ mapId: 3, eventId: 1, pageIndex: 0, commandIndex: 2 }, 'quest_start');
assert.strictEqual(quest.ok, true);
assert.strictEqual(quest.service, 'quest_giver');
assert.strictEqual(quest.actionMetadata.quest, 'rat_problem');
assert.strictEqual(quest.actionMetadata.mode, 'solo');
const questTurnIn = events.verifyTaggedNpcAction({ mapId: 3, eventId: 1, pageIndex: 0, commandIndex: 4 }, 'quest_turn_in');
assert.strictEqual(questTurnIn.ok, true);
assert.strictEqual(questTurnIn.actionMetadata.quest, 'rat_problem');
assert.strictEqual(questTurnIn.actionMetadata.mode, 'solo');
const merchant = events.verifyTaggedNpcAction({ mapId: 3, eventId: 2, pageIndex: 0, commandIndex: 2 }, 'open');
assert.strictEqual(merchant.ok, true);
assert.strictEqual(merchant.metadata.shop, 'starter_general');
assert.strictEqual(merchant.metadata.mode, 'both');

const lobbyPage = {
  list: [
    { code: 108, indent: 0, parameters: ['<MMO battle=wolf_alpha>'] },
    { code: 356, indent: 0, parameters: ['MMO BATTLE_LOBBY OPEN wolf_alpha'] },
    { code: 108, indent: 0, parameters: ['<MMO battle=wolf_alpha>'] },
    { code: 356, indent: 0, parameters: ['MMO BATTLE_LOBBY JOIN wolf_alpha'] },
    { code: 108, indent: 0, parameters: ['<MMO coop=optional battle=wolf_alpha respawn=30>'] },
    { code: 301, indent: 0, parameters: [0, 5, false, false] },
    { code: 0, indent: 0, parameters: [] }
  ]
};
fs.writeFileSync(path.join(dataDirectory, 'Map004.json'), JSON.stringify({ events: [null, { id: 1, x: 9, y: 7, pages: [lobbyPage] }] }));
const lobbyOpen = events.verifyTaggedBattleLobbyAction({ mapId: 4, eventId: 1, pageIndex: 0, commandIndex: 1 }, 'open', 'wolf_alpha');
assert.strictEqual(lobbyOpen.ok, true);
assert.strictEqual(lobbyOpen.coop, 'optional');
assert.strictEqual(lobbyOpen.troopId, 5);
assert.strictEqual(lobbyOpen.eventX, 9);
assert.strictEqual(events.verifyTaggedBattleLobbyAction({ mapId: 4, eventId: 1, pageIndex: 0, commandIndex: 3 }, 'join', 'wrong_key').ok, false);
const badLobbyPage = JSON.parse(JSON.stringify(lobbyPage));
badLobbyPage.list[1] = { code: 356, indent: 0, parameters: ['MMO BATTLE8LOBBY OPEN wolf_alpha'] };
fs.writeFileSync(path.join(dataDirectory, 'Map007.json'), JSON.stringify({ events: [null, { id: 1, x: 9, y: 7, pages: [badLobbyPage] }] }));
const badLobby = events.verifyTaggedBattleLobbyAction({ mapId: 7, eventId: 1, pageIndex: 0, commandIndex: 1 }, 'open', 'wolf_alpha');
assert.strictEqual(badLobby.ok, false);
assert.match(badLobby.message, /Map007\.json/);
assert.match(badLobby.message, /BATTLE8LOBBY/);
const spacedLobbyPage = JSON.parse(JSON.stringify(lobbyPage));
spacedLobbyPage.list[1] = { code: 356, indent: 0, parameters: ['MMO BATTLE LOBBY OPEN wolf_alpha'] };
fs.writeFileSync(path.join(dataDirectory, 'Map006.json'), JSON.stringify({ events: [null, { id: 1, x: 9, y: 7, pages: [spacedLobbyPage] }] }));
assert.strictEqual(events.verifyTaggedBattleLobbyAction({ mapId: 6, eventId: 1, pageIndex: 0, commandIndex: 1 }, 'open', 'wolf_alpha').ok, true);
const soloPage = JSON.parse(JSON.stringify(lobbyPage));
soloPage.list[4] = { code: 108, indent: 0, parameters: ['<MMO coop=solo battle=wolf_alpha respawn=30>'] };
fs.writeFileSync(path.join(dataDirectory, 'Map005.json'), JSON.stringify({ events: [null, { id: 1, x: 9, y: 7, pages: [soloPage] }] }));
assert.strictEqual(events.verifyTaggedBattleEvent({ mapId: 5, eventId: 1, pageIndex: 0, commandIndex: 5 }).coop, 'solo');

fs.rmSync(dataDirectory, { recursive: true, force: true });
console.log('NPC event fixtures passed: native tags, action parameters, battle lobby tags and forged-action rejection.');
