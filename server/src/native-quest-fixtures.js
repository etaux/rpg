'use strict';

// Validates the map-authored quest registry independently from content.js.
// The server must read a real quest-giver event page, reject a wrong giver and
// fail closed on a duplicated native quest id.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mmo-native-quest-'));
process.env.RPG_MV_DATA_PATH = dataDirectory;
const events = require('./mv-events');

const items = Array(6).fill(null);
items[5] = { id: 5, name: 'Gelée de slime', description: 'Un échantillon visqueux.', consumable: false, occasion: 0, scope: 0, effects: [] };
fs.writeFileSync(path.join(dataDirectory, 'Items.json'), JSON.stringify(items));

function questPage() {
  return {
    list: [
      { code: 108, indent: 0, parameters: ['<MMO npc=quest_giver>'] },
      { code: 108, indent: 0, parameters: ['<MMO quest=slime_gel_delivery title="Échantillons de gelée" modes=solo|group objective=collect item_id=5 goal=3>'] },
      { code: 108, indent: 0, parameters: ['<MMO npc-action=quest_start quest=slime_gel_delivery mode=solo>'] },
      { code: 356, indent: 0, parameters: ['MMO NPC_ACTION quest_start'] },
      // One shared hand-in branch needs no mode. The server infers solo or
      // group eligibility, while rewards come from the immediate native run.
      { code: 108, indent: 0, parameters: ['<MMO npc-action=quest_turn_in quest=slime_gel_delivery>'] },
      { code: 356, indent: 0, parameters: ['MMO NPC_ACTION quest_turn_in'] },
      { code: 125, indent: 0, parameters: [0, 0, 18] },
      { code: 315, indent: 0, parameters: [0, 0, 0, 0, 30, false] },
      { code: 126, indent: 0, parameters: [5, 0, 0, 1] },
      { code: 127, indent: 0, parameters: [2, 0, 0, 1] },
      { code: 128, indent: 0, parameters: [3, 0, 0, 1] },
      { code: 0, indent: 0, parameters: [] }
    ]
  };
}

fs.writeFileSync(path.join(dataDirectory, 'Map001.json'), JSON.stringify({ events: [null, { id: 1, x: 4, y: 6, pages: [questPage()] }] }));
const definitions = events.nativeQuestDefinitions();
const quest = definitions.slime_gel_delivery;
assert.ok(quest, 'a valid quest-giver page produces a native quest definition');
assert.strictEqual(quest.title, 'Échantillons de gelée');
assert.deepStrictEqual(Array.from(quest.allowedModes), ['solo', 'group']);
assert.deepStrictEqual(JSON.parse(JSON.stringify(quest.objective)), { type: 'collect', itemId: 'mv:item:5', nativeItemId: 5, text: 'Collecter 3 × Gelée de slime.' });
assert.deepStrictEqual(JSON.parse(JSON.stringify(quest.reward)), { experience: 0, gold: 0 }, 'native objective metadata cannot award rewards');

const verifiedTurnIn = events.verifyTaggedNpcAction({ mapId: 1, eventId: 1, pageIndex: 0, commandIndex: 5 }, 'quest_turn_in');
assert.strictEqual(verifiedTurnIn.ok, true, 'the native hand-in command is verified from the map');
assert.strictEqual(verifiedTurnIn.actionMetadata.mode, undefined, 'one hand-in branch has no forced solo/group mode');
assert.deepStrictEqual(JSON.parse(JSON.stringify(verifiedTurnIn.rewards)), {
  experience: 30, gold: 18,
  loot: [
    { itemId: 'mv:item:5', quantity: 1, chance: 1 },
    { itemId: 'mv:weapon:2', quantity: 1, chance: 1 },
    { itemId: 'mv:armor:3', quantity: 1, chance: 1 }
  ],
  commandIndexes: [6, 7, 8, 9, 10]
}, 'only immediate native Change commands become the authoritative quest reward');

const ownGiver = events.nativeQuestForNpcAction({ mapId: 1, eventId: 1, pageIndex: 0 }, 'slime_gel_delivery');
assert.strictEqual(ownGiver.definition.id, 'slime_gel_delivery');
const wrongGiver = events.nativeQuestForNpcAction({ mapId: 1, eventId: 2, pageIndex: 0 }, 'slime_gel_delivery');
assert.ok(wrongGiver.error, 'the quest cannot be accepted through another event page');

fs.writeFileSync(path.join(dataDirectory, 'Map002.json'), JSON.stringify({ events: [null, { id: 1, x: 1, y: 1, pages: [questPage()] }] }));
assert.strictEqual(events.nativeQuestById('slime_gel_delivery'), null, 'duplicated map-authored quest ids fail closed');
assert.ok(events.nativeQuestForNpcAction({ mapId: 1, eventId: 1, pageIndex: 0 }, 'slime_gel_delivery').error);

fs.rmSync(dataDirectory, { recursive: true, force: true });
console.log('Native quest fixtures passed: direct MV item objective, native turn-in rewards, shared hand-in mode and duplicate rejection.');
