'use strict';

require('dotenv').config();

const http = require('http');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { WebSocketServer, WebSocket } = require('ws');
const db = require('./db');
const { dataDirectory } = require('./mv-database');
const { verifyTaggedBattleEvent, verifyTaggedBattleLobbyAction, verifyTaggedNpcAction, nativeQuestById, nativeQuestDefinitions, nativeQuestForNpcAction, nativeEncounterForTroop } = require('./mv-events');
const mvCombat = require('./mv-combat');
const mvInventory = require('./mv-inventory');
const { CLASSES, BATTLE_ACTIONS, CLASS_ACTIONS, ITEMS, STARTER_ITEMS, ENCOUNTERS, QUESTS, SHOPS, GUILD_HOUSE, DUNGEONS, START_POSITION } = require('./content');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_CHARACTERS_PER_ACCOUNT = 6;
const MAX_GROUP_MEMBERS = 10;
const MAX_MESSAGE_LENGTH = 200;
const MOVE_INTERVAL_MS = 65;
const CHAT_INTERVAL_MS = 800;
const SAVE_INTERVAL_MS = 2000;

const app = express();
app.disable('x-powered-by');
app.get('/health', (_request, response) => {
  response.json({
    ok: true,
    playersOnline: onlineByCharacterId.size,
    serverTime: new Date().toISOString()
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024 });

// Live state only. PostgreSQL remains the source of truth for characters and solo quests.
const onlineByCharacterId = new Map();
const groups = new Map();
const instances = new Map();
const battles = new Map();
const battleLobbies = new Map();
const worldMonsters = new Map();
const guildInvites = new Map();
const trades = new Map();
const auctionSessions = new Map();
const npcServiceSessions = new Map();
const TRADE_RANGE_TILES = 1;
const TRADE_TIMEOUT_MS = 90 * 1000;
const NPC_SERVICE_RANGE_TILES = 1;
const AUCTION_SESSION_MS = 10 * 60 * 1000;
const AUCTION_LISTING_DURATION_MS = 72 * 60 * 60 * 1000;
const AUCTION_MAX_ACTIVE_LISTINGS = 20;
const AUCTION_PAGE_SIZE = 30;
const AUCTION_MAX_PAGE = 100;
const AUCTION_MAX_UNIT_PRICE = 100000000;
const MAX_CHARACTER_GOLD = 2000000000;
const BATTLE_LOBBY_TIMEOUT_MS = 2 * 60 * 1000;
const MIN_MONSTER_RESPAWN_SECONDS = 5;
const MAX_MONSTER_RESPAWN_SECONDS = 24 * 60 * 60;

function now() { return Date.now(); }
function asId(value) { return String(value); }
function sameId(left, right) { return asId(left) === asId(right); }
function isInteger(value) { return Number.isInteger(value); }
function integer(value) { return Number(value); }
function cleanText(value, maxLength) { return String(value == null ? '' : value).trim().slice(0, maxLength); }

// Appearance is deliberately a small, server-validated recipe rather than a
// client-provided image path. The client composites only official MV Generator
// layers selected here; no arbitrary file or URL can be injected.
function appearancePart(value, max) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= max ? number : null;
}
const GENERATOR_CATEGORIES = new Set(['Body', 'Face', 'FrontHair', 'RearHair', 'Beard', 'Ears', 'Eyes', 'Eyebrows', 'Nose', 'Mouth', 'FacialMark', 'BeastEars', 'Tail', 'Wings', 'Clothing', 'Cloak', 'AccA', 'AccB', 'Glasses']);
const SKIN_TONES = new Set(['porcelaine', 'clair', 'miel', 'brun', 'fonce']);
function normalizeAppearance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const gender = String(value.gender || '').toLowerCase();
  const skin = appearancePart(value.skin, 99);
  const hair = appearancePart(value.hair, 99);
  const eyes = appearancePart(value.eyes, 99);
  const clothing = appearancePart(value.clothing, 99);
  const skinTone = String(value.skinTone || 'porcelaine').toLowerCase();
  if (['male', 'female', 'kid'].indexOf(gender) === -1 || !skin || !hair || !eyes || !clothing || !SKIN_TONES.has(skinTone)) return null;
  const parts = { Body: skin, Face: 1, RearHair: hair, FrontHair: hair, Eyes: eyes, Nose: 1, Mouth: 1, Clothing: clothing };
  if (value.parts !== undefined) {
    if (!value.parts || typeof value.parts !== 'object' || Array.isArray(value.parts) || Object.keys(value.parts).length > GENERATOR_CATEGORIES.size) return null;
    for (const category of Object.keys(value.parts)) {
      const variant = appearancePart(value.parts[category], 99);
      if (!GENERATOR_CATEGORIES.has(category) || !variant) return null;
      parts[category] = variant;
    }
  }
  return { gender, skin, hair, eyes, clothing, skinTone, parts };
}
function worldKey(player) { return String(player.mapId) + ':' + (player.instanceId || 'public'); }
function isOpen(socket) { return socket && socket.readyState === WebSocket.OPEN; }

function send(socket, type, payload) {
  if (!isOpen(socket)) return;
  socket.send(JSON.stringify(Object.assign({ type }, payload || {})));
}

function sendError(socket, code, message) {
  send(socket, 'error', { code, message });
}

function publicPlayer(player) {
  const classData = CLASSES[player.classId];
  return {
    characterId: player.characterId,
    name: player.name,
    classId: player.classId,
    appearance: player.appearance || null,
    mv: classData && classData.mv ? classData.mv : null,
    level: player.level,
    mapId: player.mapId,
    x: player.x,
    y: player.y,
    direction: player.direction,
    moveSpeed: Number(player.moveSpeed || 4),
    instanceId: player.instanceId || null,
    groupId: player.groupId || null
  };
}

function publicClassData(classId) {
  const classData = CLASSES[classId];
  if (!classData) return null;
  // Names are edited in the native RPG Maker class database. Keep every other
  // server-only field for backwards-compatible character creation metadata.
  return Object.assign({}, classData, { label: mvCombat.className(classId, classData.label) });
}

function allPlayersInWorld(player) {
  const key = worldKey(player);
  return Array.from(onlineByCharacterId.values()).filter((candidate) => worldKey(candidate) === key);
}

function broadcastToWorld(player, type, payload, exceptCharacterId) {
  allPlayersInWorld(player).forEach((candidate) => {
    if (exceptCharacterId && sameId(candidate.characterId, exceptCharacterId)) return;
    send(candidate.socket, type, payload);
  });
}

function broadcastToWorldScope(mapId, instanceId, type, payload) {
  onlineByCharacterId.forEach((candidate) => {
    if (Number(candidate.mapId) !== Number(mapId) || (candidate.instanceId || null) !== (instanceId || null)) return;
    send(candidate.socket, type, payload);
  });
}

function broadcastAll(type, payload) {
  onlineByCharacterId.forEach((player) => send(player.socket, type, payload));
}

function profileForCharacter(row) {
  const classData = CLASSES[row.class_id];
  return {
    characterId: asId(row.id),
    name: row.name,
    classId: row.class_id,
    appearance: row.appearance || null,
    mv: classData && classData.mv ? classData.mv : null,
    level: row.level,
    experience: row.experience,
    gold: row.gold,
    mapId: row.map_id,
    x: row.map_x,
    y: row.map_y,
    direction: row.direction
  };
}

function itemDefinition(itemId) {
  return ITEMS[itemId] || mvInventory.definition(itemId);
}

function menuUseDefinition(item) {
  return item && item.type === 'consumable' && item.mv ? mvInventory.menuUseFor(item.mv) : null;
}

function equipmentSlotForItem(item) {
  if (!item || item.type !== 'equipment') return null;
  const etypeId = Number(item.etypeId || (item.slot === 'weapon' ? 1 : item.slot === 'accessory' ? 5 : 4));
  return Number.isInteger(etypeId) && etypeId > 0 && etypeId < 1000 ? 'etype_' + etypeId : null;
}

function normalizeEquipmentSlot(value) {
  const legacy = { weapon: 'etype_1', armor: 'etype_4', accessory: 'etype_5' };
  const slot = legacy[String(value || '')] || String(value || '');
  return /^etype_[1-9]\d{0,2}$/.test(slot) ? slot : null;
}

function itemSnapshot(itemId, quantity) {
  const item = itemDefinition(itemId);
  if (!item) return null;
  return {
    itemId: item.id,
    label: item.label,
    type: item.type,
    slot: item.slot || null,
    equipmentSlot: equipmentSlotForItem(item),
    description: item.description || '',
    stats: item.stats || {},
    mv: item.mv || null,
    usableOutOfBattle: !!menuUseDefinition(item),
    tradable: !!item.tradable,
    color: item.color || null,
    shortLabel: item.shortLabel || null,
    quantity: Number(quantity || 0)
  };
}

async function grantItem(characterId, itemId, quantity) {
  const amount = Math.max(1, Number(quantity || 1));
  if (!itemDefinition(itemId)) throw new Error('Unknown item definition: ' + itemId);
  await db.query(
    `INSERT INTO character_inventory (character_id, item_id, quantity, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (character_id, item_id)
     DO UPDATE SET quantity = character_inventory.quantity + EXCLUDED.quantity, updated_at = NOW()`,
    [characterId, itemId, amount]
  );
}

async function seedStarterItems(characterId, classId, equipItems) {
  const starterItems = STARTER_ITEMS[classId] || [];
  await Promise.all(starterItems.map((entry) => grantItem(characterId, entry.itemId, entry.quantity)));
  if (!equipItems) return;
  await Promise.all(starterItems.filter((entry) => ITEMS[entry.itemId] && ITEMS[entry.itemId].type === 'equipment')
    .map((entry) => db.query(
      `INSERT INTO character_equipment (character_id, slot, item_id, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (character_id, slot)
       DO UPDATE SET item_id = EXCLUDED.item_id, updated_at = NOW()`,
      [characterId, equipmentSlotForItem(ITEMS[entry.itemId]), entry.itemId]
    )));
}

async function ensureStarterInventory(characterId, classId) {
  const result = await db.query('SELECT COUNT(*)::int AS count FROM character_inventory WHERE character_id = $1', [characterId]);
  if (result.rows[0].count === 0) await seedStarterItems(characterId, classId, true);
}

async function loadEquipment(characterId) {
  // Canonical rows sort first. Legacy rows are then upgraded from the actual
  // MV item etype, never from their old broad armor/accessory label.
  const result = await db.query(
    `SELECT slot, item_id FROM character_equipment WHERE character_id = $1
     ORDER BY CASE WHEN slot ~ '^etype_[0-9]+$' THEN 0 ELSE 1 END, updated_at DESC`,
    [characterId]
  );
  const equipment = {};
  const repairs = [];
  result.rows.forEach((row) => {
    const item = itemDefinition(row.item_id);
    const canonicalSlot = equipmentSlotForItem(item);
    if (!canonicalSlot) return;
    if (equipment[canonicalSlot]) {
      if (row.slot !== canonicalSlot) repairs.push({ remove: row.slot });
      return;
    }
    equipment[canonicalSlot] = row.item_id;
    if (row.slot !== canonicalSlot) repairs.push({ remove: row.slot, insert: canonicalSlot, itemId: row.item_id });
  });
  for (const repair of repairs) {
    await db.query('DELETE FROM character_equipment WHERE character_id = $1 AND slot = $2', [characterId, repair.remove]);
    if (repair.insert) {
      await db.query(
        `INSERT INTO character_equipment (character_id, slot, item_id, updated_at) VALUES ($1, $2, $3, NOW())
         ON CONFLICT (character_id, slot) DO NOTHING`,
        [characterId, repair.insert, repair.itemId]
      );
    }
  }
  return equipment;
}

function normalizePersistentStates(value) {
  const values = Array.isArray(value) ? value : [];
  const unique = {};
  values.forEach((entry) => {
    const stateId = Number(entry);
    if (Number.isInteger(stateId) && stateId > 0 && stateId < 10000) unique[stateId] = true;
  });
  return Object.keys(unique).map(Number).sort((left, right) => left - right);
}

function normalizeParamBonuses(value) {
  const values = Array.isArray(value) ? value : [];
  return Array.from({ length: 8 }, (_, index) => {
    const amount = Number(values[index] || 0);
    return Number.isFinite(amount) ? Math.max(-99999, Math.min(99999, Math.trunc(amount))) : 0;
  });
}

function equipmentBonuses(player) {
  const bonuses = { hp: 0, mp: 0, atk: 0, def: 0, mat: 0, mdf: 0, agi: 0, luk: 0 };
  Object.keys(player.equipment || {}).forEach((slot) => {
    const item = itemDefinition(player.equipment[slot]);
    if (!item || item.type !== 'equipment') return;
    Object.keys(item.stats || {}).forEach((stat) => {
      if (Object.prototype.hasOwnProperty.call(bonuses, stat)) bonuses[stat] += Number(item.stats[stat] || 0);
    });
  });
  return bonuses;
}

function vitalsFor(player) {
  const stats = combatStatsFor(player);
  const maxHp = Math.max(1, Number(stats.hp || 1));
  const maxMp = Math.max(0, Number(stats.mp || 0));
  const hasHp = player.currentHp !== null && player.currentHp !== undefined && player.currentHp !== '';
  const hasMp = player.currentMp !== null && player.currentMp !== undefined && player.currentMp !== '';
  const savedHp = Number(player.currentHp);
  const savedMp = Number(player.currentMp);
  return {
    hp: hasHp && Number.isFinite(savedHp) ? Math.max(0, Math.min(maxHp, Math.floor(savedHp))) : maxHp,
    mp: hasMp && Number.isFinite(savedMp) ? Math.max(0, Math.min(maxMp, Math.floor(savedMp))) : maxMp,
    maxHp,
    maxMp
  };
}

function applyVitals(player, vitals) {
  const next = vitals || vitalsFor(player);
  player.currentHp = next.hp;
  player.currentMp = next.mp;
  return next;
}

async function persistVitals(player) {
  const vitals = applyVitals(player);
  await db.query(
    'UPDATE characters SET current_hp = $1, current_mp = $2, updated_at = NOW() WHERE id = $3',
    [vitals.hp, vitals.mp, player.characterId]
  );
  return vitals;
}

async function sendInventorySnapshot(player) {
  const result = await db.query(
    'SELECT item_id, quantity FROM character_inventory WHERE character_id = $1 ORDER BY item_id ASC',
    [player.characterId]
  );
  player.equipment = await loadEquipment(player.characterId);
  const items = result.rows.map((row) => itemSnapshot(row.item_id, row.quantity)).filter(Boolean);
  const equipment = {};
  Object.keys(player.equipment || {}).sort().forEach((slot) => {
    const itemId = player.equipment[slot];
    const snapshot = itemId ? itemSnapshot(itemId, 1) : null;
    if (snapshot && snapshot.equipmentSlot === slot) equipment[slot] = snapshot;
  });
  send(player.socket, 'inventorySnapshot', {
    items, equipment, gold: Number(player.gold || 0),
    experience: Number(player.experience || 0), level: Number(player.level || 1),
    health: vitalsFor(player),
    states: normalizePersistentStates(player.persistentStates),
    paramBonuses: normalizeParamBonuses(player.paramBonuses)
  });
}

async function loadBattleConsumables(characterId) {
  const consumableItemIds = Object.keys(BATTLE_ACTIONS)
    .map((actionId) => BATTLE_ACTIONS[actionId].itemId)
    .filter(Boolean);
  if (!consumableItemIds.length) return {};
  const result = await db.query(
    'SELECT item_id, quantity FROM character_inventory WHERE character_id = $1 AND item_id = ANY($2::varchar[])',
    [characterId, consumableItemIds]
  );
  const items = {};
  result.rows.forEach((row) => { items[row.item_id] = Number(row.quantity); });
  return items;
}

async function consumeInventoryItem(characterId, itemId) {
  // The schema deliberately forbids quantity 0. Delete a final item directly
  // instead of decrementing it to zero and deleting it in a second statement.
  const deleted = await db.query(
    'DELETE FROM character_inventory WHERE character_id = $1 AND item_id = $2 AND quantity = 1 RETURNING item_id',
    [characterId, itemId]
  );
  if (deleted.rows[0]) return true;
  const updated = await db.query(
    `UPDATE character_inventory SET quantity = quantity - 1, updated_at = NOW()
     WHERE character_id = $1 AND item_id = $2 AND quantity > 1
     RETURNING quantity`,
    [characterId, itemId]
  );
  return !!updated.rows[0];
}

async function handleInventoryRequest(socket) {
  const player = socket.player;
  if (!player) return sendError(socket, 'no_character', 'Sélectionne un personnage.');
  await sendInventorySnapshot(player);
}

function canPlayerEquipItem(player, itemId, item) {
  const definition = item || itemDefinition(itemId);
  if (!definition || definition.type !== 'equipment' || !definition.slot) return false;
  if (definition.classes && definition.classes.indexOf(player.classId) === -1) return false;
  const classMvId = CLASSES[player.classId] && CLASSES[player.classId].mv ? Number(CLASSES[player.classId].mv.classId) : 0;
  return !(definition.mv && classMvId && !mvInventory.canClassEquip(classMvId, itemId));
}

function equipmentPerformance(item) {
  // Match RPG Maker MV's Optimize principle: a positive sum of equip params.
  // The MMO server owns the score so the client cannot choose a better item
  // locally and desynchronise combat statistics.
  return Object.keys((item && item.stats) || {}).reduce((total, stat) => total + Number(item.stats[stat] || 0), 0);
}

function optimalEquipmentFor(player, inventoryRows) {
  const result = {};
  (inventoryRows || []).forEach((row) => {
    if (Number(row.quantity) < 1) return;
    const item = itemDefinition(row.item_id);
    if (!canPlayerEquipItem(player, row.item_id, item)) return;
    const slot = equipmentSlotForItem(item);
    const score = equipmentPerformance(item);
    const current = result[slot];
    // MV leaves a slot empty when every candidate makes it worse. Use a stable
    // item-id tie-breaker so all clients receive the same server decision.
    if (!slot || score <= 0 || (current && (score < current.score || (score === current.score && String(row.item_id) >= String(current.itemId))))) return;
    result[slot] = { itemId: row.item_id, score };
  });
  return result;
}

async function handleEquipItem(socket, message) {
  const player = socket.player;
  if (!player) return sendError(socket, 'no_character', 'Sélectionne un personnage.');
  if (player.battleId) return sendError(socket, 'in_battle', 'Équipement impossible pendant le combat.');
  const itemId = cleanText(message.itemId, 64);
  const item = itemDefinition(itemId);
  const equipmentSlot = equipmentSlotForItem(item);
  if (!item || item.type !== 'equipment' || !equipmentSlot) return sendError(socket, 'item_not_equippable', 'Cet objet ne peut pas être équipé.');
  if (!canPlayerEquipItem(player, itemId, item)) return sendError(socket, 'wrong_item_class', 'Ta classe ne peut pas équiper cet objet.');
  const owned = await db.query(
    'SELECT quantity FROM character_inventory WHERE character_id = $1 AND item_id = $2',
    [player.characterId, itemId]
  );
  if (!owned.rows[0] || owned.rows[0].quantity < 1) return sendError(socket, 'item_not_owned', 'Cet objet ne se trouve pas dans ton inventaire.');
  await db.query(
    `INSERT INTO character_equipment (character_id, slot, item_id, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (character_id, slot)
     DO UPDATE SET item_id = EXCLUDED.item_id, updated_at = NOW()`,
    [player.characterId, equipmentSlot, itemId]
  );
  player.equipment = player.equipment || {};
  player.equipment[equipmentSlot] = itemId;
  await persistVitals(player);
  await sendInventorySnapshot(player);
  send(player.socket, 'notification', { message: item.label + ' équipé.' });
}

async function handleUnequipItem(socket, message) {
  const player = socket.player;
  if (!player) return sendError(socket, 'no_character', 'Sélectionne un personnage.');
  if (player.battleId) return sendError(socket, 'in_battle', 'Équipement impossible pendant le combat.');
  const slot = normalizeEquipmentSlot(cleanText(message.slot, 20));
  if (!slot) return sendError(socket, 'invalid_equipment_slot', 'Emplacement MV invalide.');
  await db.query('DELETE FROM character_equipment WHERE character_id = $1 AND slot = $2', [player.characterId, slot]);
  player.equipment = player.equipment || {};
  delete player.equipment[slot];
  await persistVitals(player);
  await sendInventorySnapshot(player);
}

async function handleOptimizeEquipment(socket) {
  const player = socket.player;
  if (!player) return sendError(socket, 'no_character', 'Sélectionne un personnage.');
  if (player.battleId) return sendError(socket, 'in_battle', 'Optimisation impossible pendant le combat.');
  const selection = await inTransaction(async (client) => {
    const inventory = await client.query(
      'SELECT item_id, quantity FROM character_inventory WHERE character_id = $1 ORDER BY item_id ASC FOR UPDATE',
      [player.characterId]
    );
    const best = optimalEquipmentFor(player, inventory.rows);
    await client.query('DELETE FROM character_equipment WHERE character_id = $1', [player.characterId]);
    const slots = Object.keys(best).sort();
    for (const slot of slots) {
      await client.query(
        'INSERT INTO character_equipment (character_id, slot, item_id, updated_at) VALUES ($1, $2, $3, NOW())',
        [player.characterId, slot, best[slot].itemId]
      );
    }
    return best;
  });
  player.equipment = {};
  Object.keys(selection).forEach((slot) => { player.equipment[slot] = selection[slot].itemId; });
  await persistVitals(player);
  await sendInventorySnapshot(player);
  send(player.socket, 'notification', { message: Object.keys(selection).length ? 'Équipement optimisé par le serveur.' : 'Aucun équipement compatible à optimiser.' });
}

async function handleClearEquipment(socket) {
  const player = socket.player;
  if (!player) return sendError(socket, 'no_character', 'Sélectionne un personnage.');
  if (player.battleId) return sendError(socket, 'in_battle', 'Retrait impossible pendant le combat.');
  await db.query('DELETE FROM character_equipment WHERE character_id = $1', [player.characterId]);
  player.equipment = {};
  await persistVitals(player);
  await sendInventorySnapshot(player);
  send(player.socket, 'notification', { message: 'Tous les équipements ont été retirés par le serveur.' });
}

function applyMenuEffects(player, descriptor, character) {
  let states = normalizePersistentStates(character.persistent_states);
  let bonuses = normalizeParamBonuses(character.param_bonuses);
  const changes = { hpRecovered: 0, mpRecovered: 0, addedStates: [], removedStates: [], growth: [] };
  let maxHp = 1;
  let maxMp = 0;
  let hp = 0;
  let mp = 0;
  function refreshMaximums(initial) {
    const stats = combatStatsFor(Object.assign({}, player, { persistentStates: states, paramBonuses: bonuses }));
    maxHp = Math.max(1, Number(stats.hp || 1));
    maxMp = Math.max(0, Number(stats.mp || 0));
    if (initial) {
      hp = character.current_hp === null || character.current_hp === undefined ? maxHp : Math.max(0, Math.min(maxHp, Number(character.current_hp)));
      mp = character.current_mp === null || character.current_mp === undefined ? maxMp : Math.max(0, Math.min(maxMp, Number(character.current_mp)));
    } else {
      hp = Math.max(0, Math.min(maxHp, hp));
      mp = Math.max(0, Math.min(maxMp, mp));
    }
  }
  refreshMaximums(true);
  if (descriptor.requiresDeadTarget ? hp > 0 : hp <= 0) {
    return { error: ['item_wrong_target_state', descriptor.requiresDeadTarget ? 'Cet objet ne peut être utilisé que sur un héros KO.' : 'Un héros KO requiert un objet de résurrection.'] };
  }
  descriptor.effects.forEach((effect) => {
    if (effect.kind === 'recoverHp') {
      const amount = Math.max(0, Math.floor(maxHp * Number(effect.rate || 0) + Number(effect.flat || 0)));
      const next = Math.min(maxHp, hp + amount);
      changes.hpRecovered += next - hp;
      hp = next;
    } else if (effect.kind === 'recoverMp') {
      const amount = Math.max(0, Math.floor(maxMp * Number(effect.rate || 0) + Number(effect.flat || 0)));
      const next = Math.min(maxMp, mp + amount);
      changes.mpRecovered += next - mp;
      mp = next;
    } else if (effect.kind === 'addState' && Math.random() < Math.max(0, Math.min(1, Number(effect.chance || 0)))) {
      if (states.indexOf(effect.stateId) === -1) {
        states.push(effect.stateId);
        states = normalizePersistentStates(states);
        changes.addedStates.push(effect.stateId);
        refreshMaximums(false);
      }
    } else if (effect.kind === 'removeState' && Math.random() < Math.max(0, Math.min(1, Number(effect.chance || 0)))) {
      if (states.indexOf(effect.stateId) !== -1) {
        states = states.filter((stateId) => stateId !== effect.stateId);
        changes.removedStates.push(effect.stateId);
        refreshMaximums(false);
      }
    } else if (effect.kind === 'grow' && Number(effect.amount)) {
      bonuses[effect.paramId] += Number(effect.amount);
      bonuses = normalizeParamBonuses(bonuses);
      changes.growth.push({ paramId: effect.paramId, amount: Number(effect.amount) });
      refreshMaximums(false);
    }
  });
  // RPG Maker removes the death state as soon as HP is restored.
  if (hp > 0 && states.indexOf(1) !== -1) {
    states = states.filter((stateId) => stateId !== 1);
    if (changes.removedStates.indexOf(1) === -1) changes.removedStates.push(1);
    refreshMaximums(false);
  }
  const changed = changes.hpRecovered || changes.mpRecovered || changes.addedStates.length || changes.removedStates.length || changes.growth.length;
  return changed ? {
    health: { hp, mp, maxHp, maxMp }, states, bonuses, changes
  } : { error: ['item_has_no_effect', 'Cet objet n’a aucun effet dans ton état actuel.'] };
}

async function handleUseInventoryItem(socket, message) {
  const player = socket.player;
  if (!player) return sendError(socket, 'no_character', 'Sélectionne un personnage.');
  if (player.battleId) return sendError(socket, 'in_battle', 'Utilise cet objet depuis les commandes du combat.');
  const itemId = cleanText(message.itemId, 64);
  const item = itemDefinition(itemId);
  const descriptor = menuUseDefinition(item);
  if (!item || item.type !== 'consumable' || !descriptor) {
    return sendError(socket, 'item_not_usable', 'Cet objet ne peut pas être utilisé hors combat.');
  }
  const outcome = await inTransaction(async (client) => {
    const character = await client.query(
      'SELECT current_hp, current_mp, persistent_states, param_bonuses FROM characters WHERE id = $1 FOR UPDATE',
      [player.characterId]
    );
    if (!character.rows[0]) return { error: ['character_not_found', 'Personnage introuvable.'] };
    const owned = await client.query(
      'SELECT quantity FROM character_inventory WHERE character_id = $1 AND item_id = $2 FOR UPDATE',
      [player.characterId, itemId]
    );
    if (!owned.rows[0] || Number(owned.rows[0].quantity) < 1) return { error: ['item_not_owned', 'Cet objet ne se trouve pas dans ton inventaire.'] };
    const next = applyMenuEffects(player, descriptor, character.rows[0]);
    if (next.error) return next;
    if (Number(owned.rows[0].quantity) === 1) {
      await client.query('DELETE FROM character_inventory WHERE character_id = $1 AND item_id = $2', [player.characterId, itemId]);
    } else {
      await client.query(
        'UPDATE character_inventory SET quantity = quantity - 1, updated_at = NOW() WHERE character_id = $1 AND item_id = $2',
        [player.characterId, itemId]
      );
    }
    await client.query(
      `UPDATE characters SET current_hp = $1, current_mp = $2, persistent_states = $3::jsonb, param_bonuses = $4::jsonb, updated_at = NOW()
       WHERE id = $5`,
      [next.health.hp, next.health.mp, JSON.stringify(next.states), JSON.stringify(next.bonuses), player.characterId]
    );
    return next;
  });
  if (outcome.error) return sendError(socket, outcome.error[0], outcome.error[1]);
  player.currentHp = outcome.health.hp;
  player.currentMp = outcome.health.mp;
  player.persistentStates = outcome.states;
  player.paramBonuses = outcome.bonuses;
  await sendInventorySnapshot(player);
  const summary = [];
  if (outcome.changes.hpRecovered) summary.push('+' + outcome.changes.hpRecovered + ' PV');
  if (outcome.changes.mpRecovered) summary.push('+' + outcome.changes.mpRecovered + ' PM');
  if (outcome.changes.addedStates.length) summary.push('état appliqué');
  if (outcome.changes.removedStates.length) summary.push('état retiré');
  if (outcome.changes.growth.length) summary.push('paramètre augmenté');
  send(player.socket, 'notification', { message: item.label + ' utilisé : ' + summary.join(', ') + '.' });
}

// ---------------------------------------------------------------------------
// Two-party, proximity-validated player trades.
// ---------------------------------------------------------------------------
function emptyTradeOffer() { return { items: {}, gold: 0 }; }

function tradeMembers(trade) {
  return [
    onlineByCharacterId.get(asId(trade.initiatorId)),
    onlineByCharacterId.get(asId(trade.recipientId))
  ];
}

function tradePartner(trade, characterId) {
  const partnerId = sameId(trade.initiatorId, characterId) ? trade.recipientId : trade.initiatorId;
  return onlineByCharacterId.get(asId(partnerId)) || null;
}

function playersCanTrade(left, right) {
  return !!(left && right && !left.battleId && !right.battleId && worldKey(left) === worldKey(right) &&
    Math.max(Math.abs(Number(left.x) - Number(right.x)), Math.abs(Number(left.y) - Number(right.y))) <= TRADE_RANGE_TILES);
}

function tradeOfferSnapshot(offer) {
  return {
    gold: Math.max(0, Number(offer && offer.gold || 0)),
    items: Object.keys((offer && offer.items) || {}).sort().map((itemId) => itemSnapshot(itemId, offer.items[itemId])).filter(Boolean)
  };
}

function sendTradeState(trade) {
  if (!trade || trade.state !== 'active') return;
  tradeMembers(trade).forEach((player) => {
    if (!player) return;
    const partner = tradePartner(trade, player.characterId);
    send(player.socket, 'tradeState', {
      tradeId: trade.id,
      partner: partner ? { characterId: partner.characterId, name: partner.name } : null,
      myOffer: tradeOfferSnapshot(trade.offers[player.characterId]),
      otherOffer: partner ? tradeOfferSnapshot(trade.offers[partner.characterId]) : emptyTradeOffer(),
      myAccepted: trade.accepted.has(player.characterId),
      otherAccepted: !!(partner && trade.accepted.has(partner.characterId))
    });
  });
}

function cancelTrade(trade, reason) {
  if (!trade || !trades.has(trade.id)) return;
  // A finalization may be awaiting PostgreSQL. Marking it cancelled makes the
  // transaction throw and roll back at its next boundary instead of committing
  // a transfer after a disconnect or an invalidating event.
  trade.cancelled = true;
  trades.delete(trade.id);
  tradeMembers(trade).forEach((player) => {
    if (!player) return;
    if (player.tradeId === trade.id) player.tradeId = null;
    send(player.socket, 'tradeCancelled', { tradeId: trade.id, reason: reason || 'Échange annulé.' });
  });
}

function cancelTradeForPlayer(player, reason) {
  if (!player || !player.tradeId) return;
  const trade = trades.get(player.tradeId);
  if (trade) cancelTrade(trade, reason);
  else player.tradeId = null;
}

function activeTradeFor(player) {
  const trade = player && player.tradeId && trades.get(player.tradeId);
  return trade && trade.state === 'active' ? trade : null;
}

function normalizeTradeOffer(rawItems, rawGold) {
  if (!Array.isArray(rawItems) || rawItems.length > 40) return null;
  const items = {};
  for (const entry of rawItems) {
    const itemId = cleanText(entry && entry.itemId, 64);
    const quantity = Number(entry && entry.quantity);
    if (!itemId || !Number.isInteger(quantity) || quantity < 1 || quantity > 999999 || !itemDefinition(itemId)) return null;
    items[itemId] = Math.min(999999, Number(items[itemId] || 0) + quantity);
  }
  const gold = Number(rawGold || 0);
  if (!Number.isInteger(gold) || gold < 0 || gold > 999999999) return null;
  return { items, gold };
}

async function verifyTradeOfferOwnership(query, characterId, offer, lockRows) {
  for (const itemId of Object.keys(offer.items || {})) {
    const suffix = lockRows ? ' FOR UPDATE' : '';
    const result = await query(
      'SELECT quantity FROM character_inventory WHERE character_id = $1 AND item_id = $2' + suffix,
      [characterId, itemId]
    );
    if (!result.rows[0] || Number(result.rows[0].quantity) < Number(offer.items[itemId])) return false;
  }
  return true;
}

function tradeIsCurrent(trade) {
  return !!(trade && trades.get(trade.id) === trade && !trade.cancelled);
}

function tradeIsFinalizing(trade) {
  return tradeIsCurrent(trade) && trade.state === 'finalizing';
}

function throwIfTradeCannotFinalize(trade) {
  if (tradeIsFinalizing(trade)) return;
  const error = new Error('Trade was cancelled while finalizing.');
  error.code = 'trade_cancelled';
  throw error;
}

function resetTradeAcceptances(trade) {
  trade.accepted.clear();
  trade.revision = Number(trade.revision || 0) + 1;
  trade.updatedAt = now();
}

async function handleTradeRequest(socket, message) {
  const player = socket.player;
  if (!player) return sendError(socket, 'no_character', 'Sélectionne un personnage.');
  if (player.tradeId || player.battleId) return sendError(socket, 'trade_unavailable', 'Tu ne peux pas échanger pour le moment.');
  const targetId = cleanText(message.targetCharacterId, 32);
  const target = onlineByCharacterId.get(asId(targetId));
  if (!target || sameId(target.characterId, player.characterId)) return sendError(socket, 'trade_target_missing', 'Joueur introuvable.');
  if (target.tradeId || target.battleId) return sendError(socket, 'trade_target_busy', 'Ce joueur ne peut pas échanger pour le moment.');
  if (!playersCanTrade(player, target)) return sendError(socket, 'trade_too_far', 'Approche-toi à une tuile ou moins du joueur.');
  const trade = {
    id: crypto.randomUUID(), initiatorId: player.characterId, recipientId: target.characterId,
    state: 'pending', offers: {}, accepted: new Set(), revision: 0, cancelled: false, createdAt: now(), updatedAt: now()
  };
  trade.offers[player.characterId] = emptyTradeOffer();
  trade.offers[target.characterId] = emptyTradeOffer();
  trades.set(trade.id, trade);
  player.tradeId = trade.id;
  target.tradeId = trade.id;
  send(target.socket, 'tradeInvite', { tradeId: trade.id, from: { characterId: player.characterId, name: player.name } });
  send(player.socket, 'tradePending', { tradeId: trade.id, target: { characterId: target.characterId, name: target.name } });
  send(player.socket, 'notification', { message: 'Demande d’échange envoyée à ' + target.name + '.' });
}

function pendingTradeFor(player, tradeId) {
  const trade = player && player.tradeId && trades.get(player.tradeId);
  return trade && trade.id === tradeId && trade.state === 'pending' ? trade : null;
}

async function handleTradeResponse(socket, message) {
  const player = socket.player;
  const tradeId = cleanText(message.tradeId, 80);
  const trade = pendingTradeFor(player, tradeId);
  if (!trade || !sameId(trade.recipientId, player.characterId)) return sendError(socket, 'trade_missing', 'Cette demande d’échange n’existe plus.');
  const initiator = onlineByCharacterId.get(asId(trade.initiatorId));
  if (!message.accepted) return cancelTrade(trade, player.name + ' a refusé l’échange.');
  if (!playersCanTrade(initiator, player)) return cancelTrade(trade, 'Échange annulé : les joueurs ne sont plus côte à côte.');
  trade.state = 'active';
  trade.updatedAt = now();
  sendTradeState(trade);
}

function ensureTradeInteraction(player, tradeId) {
  const trade = activeTradeFor(player);
  if (!trade || trade.id !== tradeId) return { error: ['trade_missing', 'Cet échange n’existe plus.'] };
  const partner = tradePartner(trade, player.characterId);
  if (!playersCanTrade(player, partner)) {
    cancelTrade(trade, 'Échange annulé : les joueurs doivent rester côte à côte.');
    return { error: ['trade_too_far', 'Les joueurs doivent rester côte à côte.'] };
  }
  return { trade, partner };
}

async function handleTradeSetOffer(socket, message) {
  const player = socket.player;
  const tradeId = cleanText(message.tradeId, 80);
  const context = ensureTradeInteraction(player, tradeId);
  if (context.error) return sendError(socket, context.error[0], context.error[1]);
  const trade = context.trade;
  const offer = normalizeTradeOffer(message.items, message.gold);
  if (!offer) return sendError(socket, 'invalid_trade_offer', 'Offre d’échange invalide.');
  if (!(await verifyTradeOfferOwnership(db.query, player.characterId, offer, false))) {
    return sendError(socket, 'trade_item_not_owned', 'Ton offre contient un objet absent ou en quantité insuffisante.');
  }
  const gold = await db.query('SELECT gold FROM characters WHERE id = $1', [player.characterId]);
  if (!gold.rows[0] || Number(gold.rows[0].gold) < offer.gold) return sendError(socket, 'trade_gold_not_owned', 'Tu ne possèdes pas cet or.');
  // A response can arrive while its database checks are pending. Never revive
  // an exchange that was cancelled or began its final transaction in between.
  if (!tradeIsCurrent(trade) || trade.state !== 'active' || player.tradeId !== trade.id) {
    return sendError(socket, 'trade_missing', 'Cet échange a changé ou n’existe plus.');
  }
  trade.offers[player.characterId] = offer;
  resetTradeAcceptances(trade);
  sendTradeState(trade);
}

async function handleTradeAccept(socket, message) {
  const player = socket.player;
  const tradeId = cleanText(message.tradeId, 80);
  const context = ensureTradeInteraction(player, tradeId);
  if (context.error) return sendError(socket, context.error[0], context.error[1]);
  const trade = context.trade;
  if (trade.accepted.has(player.characterId)) return sendTradeState(trade);
  // Offers are replaced, not mutated. The revision prevents an old accepted
  // packet, delayed behind an offer edit, from validating the new offer.
  const revision = Number(trade.revision || 0);
  const ownOffer = trade.offers[player.characterId] || emptyTradeOffer();
  if (!(await verifyTradeOfferOwnership(db.query, player.characterId, ownOffer, false))) {
    return sendError(socket, 'trade_item_not_owned', 'Ton offre a changé : vérifie tes objets.');
  }
  const gold = await db.query('SELECT gold FROM characters WHERE id = $1', [player.characterId]);
  if (!gold.rows[0] || Number(gold.rows[0].gold) < ownOffer.gold) return sendError(socket, 'trade_gold_not_owned', 'Ton offre a changé : vérifie ton or.');
  if (!tradeIsCurrent(trade) || trade.state !== 'active' || player.tradeId !== trade.id || Number(trade.revision || 0) !== revision) {
    if (tradeIsCurrent(trade) && trade.state === 'active') sendTradeState(trade);
    return sendError(socket, 'trade_offer_changed', 'L’offre a été modifiée : valide-la à nouveau.');
  }
  trade.accepted.add(player.characterId);
  trade.updatedAt = now();
  if (trade.accepted.size < 2) return sendTradeState(trade);
  // From here, no offer or movement packet can mutate the agreement. The final
  // database transaction still rechecks both parties, ranges and assets.
  trade.state = 'finalizing';
  await finalizeTrade(trade);
}

async function finalizeTrade(trade) {
  if (!tradeIsFinalizing(trade)) return;
  const [left, right] = tradeMembers(trade);
  if (!playersCanTrade(left, right)) return cancelTrade(trade, 'Échange annulé : les joueurs doivent rester côte à côte.');
  const characterIds = [trade.initiatorId, trade.recipientId];
  let completed;
  try {
    completed = await inTransaction(async (client) => {
      throwIfTradeCannotFinalize(trade);
      const characters = await client.query(
        'SELECT id, gold FROM characters WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE',
        [characterIds]
      );
      throwIfTradeCannotFinalize(trade);
      if (characters.rows.length !== 2) return { error: ['trade_target_missing', 'Un joueur n’est plus disponible.'] };
      const byId = {};
      characters.rows.forEach((row) => { byId[asId(row.id)] = Number(row.gold || 0); });
      for (const characterId of characterIds) {
        const offer = trade.offers[characterId] || emptyTradeOffer();
        if (byId[characterId] < offer.gold || !(await verifyTradeOfferOwnership(client.query.bind(client), characterId, offer, true))) {
          return { error: ['trade_offer_changed', 'Une offre n’est plus disponible.'] };
        }
        throwIfTradeCannotFinalize(trade);
      }
      // A move, transfer or battle may have been received while rows were
      // locked. Recheck adjacency immediately before calculating any delta.
      if (!playersCanTrade(left, right)) return { error: ['trade_too_far', 'Les joueurs ne sont plus côte à côte.'] };
      const deltas = {};
      characterIds.forEach((characterId) => { deltas[characterId] = {}; });
      const addDelta = function(characterId, itemId, amount) {
        deltas[characterId][itemId] = Number(deltas[characterId][itemId] || 0) + amount;
      };
      const leftOffer = trade.offers[trade.initiatorId] || emptyTradeOffer();
      const rightOffer = trade.offers[trade.recipientId] || emptyTradeOffer();
      Object.keys(leftOffer.items).forEach((itemId) => { addDelta(trade.initiatorId, itemId, -leftOffer.items[itemId]); addDelta(trade.recipientId, itemId, leftOffer.items[itemId]); });
      Object.keys(rightOffer.items).forEach((itemId) => { addDelta(trade.recipientId, itemId, -rightOffer.items[itemId]); addDelta(trade.initiatorId, itemId, rightOffer.items[itemId]); });
      for (const characterId of characterIds) {
        for (const itemId of Object.keys(deltas[characterId])) {
          throwIfTradeCannotFinalize(trade);
          const existing = await client.query('SELECT quantity FROM character_inventory WHERE character_id = $1 AND item_id = $2 FOR UPDATE', [characterId, itemId]);
          throwIfTradeCannotFinalize(trade);
          const before = existing.rows[0] ? Number(existing.rows[0].quantity) : 0;
          const after = before + Number(deltas[characterId][itemId]);
          if (after < 0) return { error: ['trade_offer_changed', 'Une quantité d’objet est devenue invalide.'] };
          if (after === 0) await client.query('DELETE FROM character_inventory WHERE character_id = $1 AND item_id = $2', [characterId, itemId]);
          else await client.query(
            `INSERT INTO character_inventory (character_id, item_id, quantity, updated_at) VALUES ($1, $2, $3, NOW())
             ON CONFLICT (character_id, item_id) DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = NOW()`,
            [characterId, itemId, after]
          );
          throwIfTradeCannotFinalize(trade);
        }
        const outgoing = characterId === trade.initiatorId ? leftOffer : rightOffer;
        const outgoingIds = Object.keys(outgoing.items);
        if (outgoingIds.length) await client.query('DELETE FROM character_equipment WHERE character_id = $1 AND item_id = ANY($2::varchar[])', [characterId, outgoingIds]);
        throwIfTradeCannotFinalize(trade);
      }
      const leftGold = byId[trade.initiatorId] - leftOffer.gold + rightOffer.gold;
      const rightGold = byId[trade.recipientId] - rightOffer.gold + leftOffer.gold;
      await client.query('UPDATE characters SET gold = $1, updated_at = NOW() WHERE id = $2', [leftGold, trade.initiatorId]);
      throwIfTradeCannotFinalize(trade);
      await client.query('UPDATE characters SET gold = $1, updated_at = NOW() WHERE id = $2', [rightGold, trade.recipientId]);
      throwIfTradeCannotFinalize(trade);
      return { leftGold, rightGold };
    });
  } catch (error) {
    // cancelTrade has already notified both clients and clearing its live entry
    // is sufficient; the transaction helper rolled back all partial deltas.
    if (error && error.code === 'trade_cancelled') return;
    throw error;
  }
  if (!tradeIsCurrent(trade)) return;
  if (completed.error) {
    if (completed.error[0] === 'trade_too_far') return cancelTrade(trade, 'Échange annulé : les joueurs doivent rester côte à côte.');
    trade.state = 'active';
    resetTradeAcceptances(trade);
    sendTradeState(trade);
    [left, right].forEach((player) => sendError(player && player.socket, completed.error[0], completed.error[1]));
    return;
  }
  left.gold = completed.leftGold;
  right.gold = completed.rightGold;
  trades.delete(trade.id);
  left.tradeId = null;
  right.tradeId = null;
  [left, right].forEach((player) => {
    send(player.socket, 'tradeCompleted', { tradeId: trade.id, message: 'Échange terminé avec succès.' });
    sendInventorySnapshot(player).catch((error) => console.error('[trade inventory snapshot]', error));
  });
}

function handleTradeCancel(socket, message) {
  const player = socket.player;
  const tradeId = cleanText(message.tradeId, 80);
  const trade = player && player.tradeId && trades.get(player.tradeId);
  if (!trade || (tradeId && trade.id !== tradeId)) return sendError(socket, 'trade_missing', 'Cet échange n’existe plus.');
  if (trade.state === 'finalizing') return sendError(socket, 'trade_finalizing', 'La transaction finale est en cours.');
  cancelTrade(trade, player.name + ' a annulé l’échange.');
}

// ---------------------------------------------------------------------------
// Native-event service NPCs and authoritative fixed-price auction house.
// ---------------------------------------------------------------------------
function isTradableAuctionItem(item) {
  return !!(item && item.tradable === true);
}

function npcServiceInRange(player, service) {
  return !!(player && service && !player.battleId && Number(player.mapId) === Number(service.mapId) &&
    (player.instanceId || null) === (service.instanceId || null) &&
    Math.max(Math.abs(Number(player.x) - Number(service.eventX)), Math.abs(Number(player.y) - Number(service.eventY))) <= NPC_SERVICE_RANGE_TILES);
}

function closeAuctionSession(player, reason, notify) {
  if (!player || !player.auctionSessionId) return;
  const session = auctionSessions.get(player.auctionSessionId);
  if (session) auctionSessions.delete(session.id);
  player.auctionSessionId = null;
  if (notify !== false) send(player.socket, 'auctionHouseClosed', { reason: reason || 'Session de l’hôtel des ventes fermée.' });
}

// Merchant, banker and guild-registrar windows use the same server-owned
// proximity session. A session carries the verified MV event location and
// cannot be fabricated from a shortcut or a raw websocket packet.
function closeNpcServiceSession(player, reason, notify) {
  if (!player || !player.npcServiceSessionId) return;
  const session = npcServiceSessions.get(player.npcServiceSessionId);
  if (session) npcServiceSessions.delete(session.id);
  player.npcServiceSessionId = null;
  if (notify !== false) send(player.socket, 'npcServiceClosed', { service: session && session.service || null, reason: reason || 'Session du PNJ fermée.' });
}

function currentNpcServiceSession(player, sessionId, expectedService) {
  const id = cleanText(sessionId, 80);
  const session = player && player.npcServiceSessionId && npcServiceSessions.get(player.npcServiceSessionId);
  if (!session || session.id !== id || !sameId(session.characterId, player.characterId) || (expectedService && session.service !== expectedService)) {
    return { error: ['npc_session_missing', 'La session de ce PNJ n’existe plus.'] };
  }
  if (now() > session.expiresAt) {
    closeNpcServiceSession(player, 'Session du PNJ expirée.');
    return { error: ['npc_session_expired', 'La session de ce PNJ a expiré.'] };
  }
  if (!npcServiceInRange(player, session)) {
    closeNpcServiceSession(player, 'Éloignement du PNJ : session fermée.');
    return { error: ['npc_too_far', 'Reste à une tuile du PNJ pour utiliser ce service.'] };
  }
  session.expiresAt = now() + AUCTION_SESSION_MS;
  return { session };
}

function openNpcServiceSession(player, verified, service, data) {
  closeNpcServiceSession(player, null, false);
  const session = Object.assign({
    id: crypto.randomUUID(), service, characterId: player.characterId,
    mapId: player.mapId, instanceId: player.instanceId || null,
    eventId: verified.eventId, pageIndex: verified.pageIndex,
    eventX: verified.eventX, eventY: verified.eventY,
    expiresAt: now() + AUCTION_SESSION_MS
  }, data || {});
  npcServiceSessions.set(session.id, session);
  player.npcServiceSessionId = session.id;
  return session;
}

function invalidateNpcServiceForMovement(player) {
  if (!player || !player.npcServiceSessionId) return;
  const session = npcServiceSessions.get(player.npcServiceSessionId);
  if (!session || !npcServiceInRange(player, session)) closeNpcServiceSession(player, 'Éloignement du PNJ : session fermée.');
}

function npcInteger(value, minimum, maximum) {
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum ? number : null;
}

function merchantMode(value) {
  const mode = String(value || '').toLowerCase();
  return ['buy', 'sell', 'both'].indexOf(mode) !== -1 ? mode : null;
}

function merchantPermits(mode, direction) {
  return mode === 'both' || mode === direction;
}

function merchantState(shop, mode) {
  const catalogue = Object.keys(shop.items || {}).sort().map((itemId) => {
    const config = shop.items[itemId] || {};
    const item = itemSnapshot(itemId, 1);
    if (!item || !Number.isInteger(Number(config.sellPrice)) || Number(config.sellPrice) < 0 || !Number.isInteger(Number(config.buyPrice)) || Number(config.buyPrice) < 0) return null;
    return { item, sellPrice: Number(config.sellPrice), buyPrice: Number(config.buyPrice) };
  }).filter(Boolean);
  return { shopId: shop.id, title: shop.title || shop.id, mode, catalogue };
}

async function loadBankState(characterId, client) {
  const connection = client || db;
  const bank = await connection.query('SELECT gold FROM character_banks WHERE character_id = $1', [characterId]);
  const inventory = await connection.query(
    'SELECT item_id, quantity FROM character_bank_inventory WHERE character_id = $1 ORDER BY item_id ASC',
    [characterId]
  );
  return {
    gold: Number(bank.rows[0] && bank.rows[0].gold || 0),
    items: inventory.rows.map((row) => itemSnapshot(row.item_id, row.quantity)).filter(Boolean)
  };
}

async function sendBankState(player) {
  send(player.socket, 'bankState', { bank: await loadBankState(player.characterId) });
}

function currentAuctionSession(player, sessionId) {
  const id = cleanText(sessionId, 80);
  const session = player && player.auctionSessionId && auctionSessions.get(player.auctionSessionId);
  if (!session || session.id !== id || !sameId(session.characterId, player.characterId)) {
    return { error: ['auction_session_missing', 'La session de l’hôtel des ventes n’existe plus.'] };
  }
  if (now() > session.expiresAt) {
    closeAuctionSession(player, 'Session de l’hôtel des ventes expirée.');
    return { error: ['auction_session_expired', 'La session de l’hôtel des ventes a expiré.'] };
  }
  if (!npcServiceInRange(player, session)) {
    closeAuctionSession(player, 'Éloignement du PNJ : session de l’hôtel des ventes fermée.');
    return { error: ['auction_too_far', 'Reste à une tuile du PNJ pour utiliser l’hôtel des ventes.'] };
  }
  session.expiresAt = now() + AUCTION_SESSION_MS;
  return { session };
}

function invalidateAuctionForMovement(player) {
  if (!player || !player.auctionSessionId) return;
  const session = auctionSessions.get(player.auctionSessionId);
  if (!session || !npcServiceInRange(player, session)) {
    closeAuctionSession(player, 'Éloignement du PNJ : session de l’hôtel des ventes fermée.');
  }
}

function auctionInteger(value, minimum, maximum) {
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum ? number : null;
}

function normalizeAuctionFilters(raw) {
  const filters = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const query = cleanText(filters.query, 48).toLocaleLowerCase();
  const type = cleanText(filters.type || 'all', 24).toLocaleLowerCase();
  const page = auctionInteger(filters.page, 0, AUCTION_MAX_PAGE);
  const minUnitPrice = filters.minUnitPrice === undefined || filters.minUnitPrice === '' ? null : auctionInteger(filters.minUnitPrice, 1, AUCTION_MAX_UNIT_PRICE);
  const maxUnitPrice = filters.maxUnitPrice === undefined || filters.maxUnitPrice === '' ? null : auctionInteger(filters.maxUnitPrice, 1, AUCTION_MAX_UNIT_PRICE);
  return {
    query,
    type: /^[a-z][a-z0-9_-]{0,23}$/.test(type) ? type : 'all',
    page: page === null ? 0 : page,
    minUnitPrice,
    maxUnitPrice
  };
}

function auctionListingSnapshot(row) {
  const item = itemSnapshot(row.item_id, row.quantity_remaining);
  if (!item || !item.tradable) return null;
  return {
    listingId: asId(row.id),
    sellerCharacterId: asId(row.seller_character_id),
    sellerName: row.seller_name || 'Vendeur',
    item,
    quantityInitial: Number(row.quantity_initial || 0),
    quantityRemaining: Number(row.quantity_remaining || 0),
    unitPrice: Number(row.unit_price || 0),
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    closedAt: row.closed_at || null
  };
}

async function loadAuctionView(player, filters) {
  const normalized = normalizeAuctionFilters(filters);
  const active = await db.query(
    `SELECT l.id, l.seller_character_id, l.item_id, l.quantity_initial, l.quantity_remaining, l.unit_price, l.status, l.created_at, l.expires_at, l.closed_at,
            c.name AS seller_name
     FROM auction_listings l JOIN characters c ON c.id = l.seller_character_id
     WHERE l.status = 'active' AND l.quantity_remaining > 0 AND l.expires_at > NOW()
     ORDER BY l.unit_price ASC, l.id ASC
     LIMIT 500`
  );
  const filtered = active.rows.map(auctionListingSnapshot).filter(Boolean).filter((listing) => {
    const item = listing.item;
    if (normalized.type !== 'all' && item.type !== normalized.type) return false;
    if (normalized.query && (String(item.label || '').toLocaleLowerCase().indexOf(normalized.query) === -1 && String(item.itemId || '').toLocaleLowerCase().indexOf(normalized.query) === -1 && String(listing.sellerName || '').toLocaleLowerCase().indexOf(normalized.query) === -1)) return false;
    if (normalized.minUnitPrice !== null && listing.unitPrice < normalized.minUnitPrice) return false;
    if (normalized.maxUnitPrice !== null && listing.unitPrice > normalized.maxUnitPrice) return false;
    return true;
  });
  const total = filtered.length;
  const start = normalized.page * AUCTION_PAGE_SIZE;
  const mine = await db.query(
    `SELECT l.id, l.seller_character_id, l.item_id, l.quantity_initial, l.quantity_remaining, l.unit_price, l.status, l.created_at, l.expires_at, l.closed_at,
            c.name AS seller_name
     FROM auction_listings l JOIN characters c ON c.id = l.seller_character_id
     WHERE l.seller_character_id = $1
     ORDER BY l.created_at DESC, l.id DESC
     LIMIT 100`,
    [player.characterId]
  );
  return {
    filters: normalized,
    page: normalized.page,
    pageSize: AUCTION_PAGE_SIZE,
    total,
    listings: filtered.slice(start, start + AUCTION_PAGE_SIZE),
    mine: mine.rows.map(auctionListingSnapshot).filter(Boolean),
    activeListingLimit: AUCTION_MAX_ACTIVE_LISTINGS,
    serverTime: new Date().toISOString()
  };
}

async function sendAuctionState(player, session, filters) {
  if (!player || !session || player.auctionSessionId !== session.id || !auctionSessions.has(session.id)) return;
  const state = await loadAuctionView(player, filters === undefined ? session.filters : filters);
  session.filters = state.filters;
  send(player.socket, 'auctionHouseState', { sessionId: session.id, state });
}

async function addAuctionInventory(client, characterId, itemId, quantity) {
  await client.query(
    `INSERT INTO character_inventory (character_id, item_id, quantity, updated_at) VALUES ($1, $2, $3, NOW())
     ON CONFLICT (character_id, item_id)
     DO UPDATE SET quantity = character_inventory.quantity + EXCLUDED.quantity, updated_at = NOW()`,
    [characterId, itemId, quantity]
  );
}

async function expireAuctionListing(listingId, sellerCharacterId) {
  const settled = await inTransaction(async (client) => {
    // Lock the seller before the listing. Purchases lock both characters in ID
    // order before the listing, so expiration cannot create a seller/listing
    // deadlock with a concurrent partial purchase.
    const seller = await client.query('SELECT id FROM characters WHERE id = $1 FOR UPDATE', [sellerCharacterId]);
    if (!seller.rows[0]) return null;
    const listing = await client.query(
      `SELECT id, seller_character_id, item_id, quantity_remaining, status, expires_at
       FROM auction_listings WHERE id = $1 FOR UPDATE`,
      [listingId]
    );
    const row = listing.rows[0];
    if (!row || row.status !== 'active' || Number(row.quantity_remaining) < 1 || new Date(row.expires_at).getTime() > now()) return null;
    await addAuctionInventory(client, row.seller_character_id, row.item_id, Number(row.quantity_remaining));
    await client.query("UPDATE auction_listings SET status = 'expired', closed_at = NOW() WHERE id = $1", [row.id]);
    return { sellerCharacterId: asId(row.seller_character_id) };
  });
  if (settled) {
    const seller = onlineByCharacterId.get(settled.sellerCharacterId);
    if (seller) {
      sendInventorySnapshot(seller).catch((error) => console.error('[auction expiry inventory]', error));
      const session = seller.auctionSessionId && auctionSessions.get(seller.auctionSessionId);
      if (session) sendAuctionState(seller, session).catch((error) => console.error('[auction expiry state]', error));
    }
  }
  return settled;
}

async function expireAuctionListings() {
  const candidates = await db.query(
    `SELECT id, seller_character_id FROM auction_listings
     WHERE status = 'active' AND quantity_remaining > 0 AND expires_at <= NOW()
     ORDER BY expires_at ASC LIMIT 100`
  );
  for (const row of candidates.rows) await expireAuctionListing(row.id, row.seller_character_id);
}

function auctionServiceError(socket, context) {
  if (context.error) sendError(socket, context.error[0], context.error[1]);
  return !!context.error;
}

async function handleNpcAction(socket, message) {
  const player = socket.player;
  if (!player) return sendError(socket, 'no_character', 'Sélectionne un personnage.');
  if (player.battleId) return sendError(socket, 'in_battle', 'Interaction PNJ impossible pendant le combat.');
  const requestId = cleanText(message.requestId, 80);
  if (!requestId) return sendError(socket, 'npc_event_invalid', 'Identifiant de requête PNJ invalide.');
  const action = cleanText(message.action, 32).toLowerCase();
  const verified = verifyTaggedNpcAction(message.eventContext, action);
  if (!verified.ok) return sendError(socket, verified.code, verified.message);
  const service = Object.assign({}, verified, { instanceId: player.instanceId || null });
  if (!npcServiceInRange(player, service)) return sendError(socket, 'npc_too_far', 'Approche-toi à une tuile ou moins du PNJ.');

  // The auction keeps its original specialized session and packet vocabulary.
  if (verified.service === 'auction_house' && verified.action === 'open') {
    closeNpcServiceSession(player, null, false);
    closeAuctionSession(player, null, false);
    const session = {
      id: crypto.randomUUID(), characterId: player.characterId, mapId: player.mapId, instanceId: player.instanceId || null,
      eventId: verified.eventId, pageIndex: verified.pageIndex, eventX: verified.eventX, eventY: verified.eventY,
      expiresAt: now() + AUCTION_SESSION_MS, filters: normalizeAuctionFilters({})
    };
    auctionSessions.set(session.id, session);
    player.auctionSessionId = session.id;
    await expireAuctionListings();
    const state = await loadAuctionView(player, session.filters);
    session.filters = state.filters;
    return send(socket, 'npcServiceOpen', { requestId, service: 'auction_house', sessionId: session.id, state });
  }

  // Quest starts and hand-ins are both committed only from a verified native
  // branch. There is deliberately no public packet route around this gate.
  if (verified.service === 'quest_giver' && verified.action === 'quest_start') {
    const questId = cleanText(verified.actionMetadata && verified.actionMetadata.quest, 64);
    const mode = cleanText(verified.actionMetadata && verified.actionMetadata.mode, 16).toLowerCase();
    const configured = questDefinitionForNpcAction(verified, questId);
    if (configured.error) return sendError(socket, configured.error[0], configured.error[1]);
    const outcome = await startQuestFromNpc(player, questId, mode, configured.definition);
    if (outcome.error) return sendError(socket, outcome.error[0], outcome.error[1]);
    send(socket, 'npcServiceOpen', { requestId, service: 'quest_giver', questId, mode, message: outcome.message });
    return;
  }
  if (verified.service === 'quest_giver' && verified.action === 'quest_turn_in') {
    const questId = cleanText(verified.actionMetadata && verified.actionMetadata.quest, 64);
    // mode is optional here: when a member must claim their own group reward,
    // one native "Rendre" branch can infer solo versus group from their ready
    // authoritative quest state. An explicit mode remains accepted for the
    // rare case where both scopes are ready for the same quest id.
    const mode = cleanText(verified.actionMetadata && verified.actionMetadata.mode, 16).toLowerCase();
    const configured = questDefinitionForNpcAction(verified, questId);
    if (configured.error) return sendError(socket, configured.error[0], configured.error[1]);
    const outcome = await turnInQuestAtNpc(player, questId, mode, configured.definition, verified.rewards);
    if (outcome.error) return sendError(socket, outcome.error[0], outcome.error[1]);
    send(socket, 'npcServiceOpen', { requestId, service: 'quest_giver', questId, mode: outcome.mode, message: outcome.message });
    return;
  }

  // The healer has no UI: its explicitly marked native choice immediately
  // restores the persistent server state, at no gold cost.
  if ((verified.service === 'innkeeper' || verified.service === 'healer') && verified.action === 'heal') {
    const outcome = await healAtNpc(player);
    if (outcome.error) return sendError(socket, outcome.error[0], outcome.error[1]);
    await sendInventorySnapshot(player);
    send(socket, 'npcServiceOpen', { requestId, service: 'innkeeper', message: outcome.message });
    return;
  }

  if (verified.service === 'guild_registrar' && verified.action === 'guild_create') {
    if (player.guildId) return sendError(socket, 'already_in_guild', 'Tu appartiens déjà à une guilde.');
    closeAuctionSession(player, null, false);
    const session = openNpcServiceSession(player, verified, 'guild_registrar');
    return send(socket, 'npcServiceOpen', { requestId, service: 'guild_registrar', sessionId: session.id });
  }

  if (verified.service === 'merchant' && verified.action === 'open') {
    const shopId = cleanText(verified.metadata && verified.metadata.shop, 64);
    const mode = merchantMode(verified.metadata && verified.metadata.mode);
    const shop = SHOPS[shopId];
    if (!shop || !mode || !merchantMode(shop.mode || 'both') || !merchantPermits(shop.mode || 'both', mode === 'both' ? 'buy' : mode) || (mode === 'both' && shop.mode !== 'both')) {
      return sendError(socket, 'merchant_config_invalid', 'Cette configuration de marchand est invalide côté serveur.');
    }
    closeAuctionSession(player, null, false);
    const session = openNpcServiceSession(player, verified, 'merchant', { shopId, mode });
    await sendInventorySnapshot(player);
    return send(socket, 'npcServiceOpen', { requestId, service: 'merchant', sessionId: session.id, state: merchantState(shop, mode) });
  }

  if (verified.service === 'banker' && verified.action === 'open') {
    closeAuctionSession(player, null, false);
    const session = openNpcServiceSession(player, verified, 'banker');
    await sendInventorySnapshot(player);
    return send(socket, 'npcServiceOpen', { requestId, service: 'banker', sessionId: session.id, state: { bank: await loadBankState(player.characterId) } });
  }

  return sendError(socket, 'npc_service_unknown', 'Ce service PNJ ou cette action n’est pas disponible.');
}

async function handleAuctionBrowse(socket, message) {
  const player = socket.player;
  const context = currentAuctionSession(player, message.sessionId);
  if (auctionServiceError(socket, context)) return;
  await expireAuctionListings();
  await sendAuctionState(player, context.session, message.filters);
}

async function handleAuctionCreate(socket, message) {
  const player = socket.player;
  const context = currentAuctionSession(player, message.sessionId);
  if (auctionServiceError(socket, context)) return;
  const itemId = cleanText(message.itemId, 64);
  const quantity = auctionInteger(message.quantity, 1, 999999);
  const unitPrice = auctionInteger(message.unitPrice, 1, AUCTION_MAX_UNIT_PRICE);
  const item = itemDefinition(itemId);
  if (!quantity || !unitPrice || !isTradableAuctionItem(item)) return sendError(socket, 'auction_invalid_listing', 'Objet, quantité ou prix d’annonce invalide.');
  await expireAuctionListings();
  const created = await inTransaction(async (client) => {
    const character = await client.query('SELECT id FROM characters WHERE id = $1 FOR UPDATE', [player.characterId]);
    if (!character.rows[0]) return { error: ['character_not_found', 'Personnage introuvable.'] };
    const count = await client.query(
      "SELECT COUNT(*)::int AS count FROM auction_listings WHERE seller_character_id = $1 AND status = 'active' AND expires_at > NOW()",
      [player.characterId]
    );
    if (Number(count.rows[0] && count.rows[0].count || 0) >= AUCTION_MAX_ACTIVE_LISTINGS) return { error: ['auction_listing_limit', 'Tu as atteint la limite de ' + AUCTION_MAX_ACTIVE_LISTINGS + ' annonces actives.'] };
    const inventory = await client.query('SELECT quantity FROM character_inventory WHERE character_id = $1 AND item_id = $2 FOR UPDATE', [player.characterId, itemId]);
    if (!inventory.rows[0] || Number(inventory.rows[0].quantity) < quantity) return { error: ['auction_item_not_owned', 'Quantité insuffisante pour créer cette annonce.'] };
    if (Number(inventory.rows[0].quantity) === quantity) await client.query('DELETE FROM character_inventory WHERE character_id = $1 AND item_id = $2', [player.characterId, itemId]);
    else await client.query('UPDATE character_inventory SET quantity = quantity - $3, updated_at = NOW() WHERE character_id = $1 AND item_id = $2', [player.characterId, itemId, quantity]);
    // Equipment is a projection of the inventory: an asset cannot remain worn
    // while any copy of that item id is escrowed in an active listing.
    await client.query('DELETE FROM character_equipment WHERE character_id = $1 AND item_id = $2', [player.characterId, itemId]);
    const listing = await client.query(
      `INSERT INTO auction_listings (seller_character_id, item_id, quantity_initial, quantity_remaining, unit_price, status, expires_at)
       VALUES ($1, $2, $3, $3, $4, 'active', NOW() + INTERVAL '72 hours')
       RETURNING id`,
      [player.characterId, itemId, quantity, unitPrice]
    );
    return { listingId: asId(listing.rows[0].id) };
  });
  if (created.error) return sendError(socket, created.error[0], created.error[1]);
  await sendInventorySnapshot(player);
  await sendAuctionState(player, context.session);
  send(socket, 'notification', { message: 'Annonce #' + created.listingId + ' créée pour 72 heures.' });
}

async function handleAuctionBuy(socket, message) {
  const player = socket.player;
  const context = currentAuctionSession(player, message.sessionId);
  if (auctionServiceError(socket, context)) return;
  const listingId = cleanText(message.listingId, 32);
  const quantity = auctionInteger(message.quantity, 1, 999999);
  if (!/^\d+$/.test(listingId) || !quantity) return sendError(socket, 'auction_invalid_purchase', 'Annonce ou quantité d’achat invalide.');
  await expireAuctionListings();
  const lookup = await db.query('SELECT seller_character_id FROM auction_listings WHERE id = $1', [listingId]);
  const sellerId = lookup.rows[0] && asId(lookup.rows[0].seller_character_id);
  if (!sellerId) return sendError(socket, 'auction_listing_missing', 'Cette annonce n’existe plus.');
  if (sameId(sellerId, player.characterId)) return sendError(socket, 'auction_own_listing', 'Tu ne peux pas acheter ta propre annonce.');
  const outcome = await inTransaction(async (client) => {
    const characterIds = [player.characterId, sellerId].sort((left, right) => Number(left) - Number(right));
    const characters = await client.query('SELECT id, gold FROM characters WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE', [characterIds]);
    if (characters.rows.length !== 2) return { error: ['auction_listing_missing', 'Le vendeur n’est plus disponible.'] };
    const goldByCharacter = {};
    characters.rows.forEach((row) => { goldByCharacter[asId(row.id)] = Number(row.gold || 0); });
    const listing = await client.query(
      `SELECT id, seller_character_id, item_id, quantity_remaining, unit_price, status, expires_at
       FROM auction_listings WHERE id = $1 FOR UPDATE`,
      [listingId]
    );
    const row = listing.rows[0];
    if (!row || row.status !== 'active' || Number(row.quantity_remaining) < quantity) return { error: ['auction_listing_changed', 'Cette annonce a changé ou ne contient plus cette quantité.'] };
    if (new Date(row.expires_at).getTime() <= now()) return { error: ['auction_listing_expired', 'Cette annonce vient d’expirer.'] };
    if (!sameId(row.seller_character_id, sellerId)) return { error: ['auction_listing_changed', 'Le vendeur de cette annonce a changé.'] };
    const totalPrice = Number(row.unit_price) * quantity;
    if (!Number.isSafeInteger(totalPrice) || totalPrice < 1 || totalPrice > MAX_CHARACTER_GOLD) return { error: ['auction_invalid_purchase', 'Montant d’achat invalide.'] };
    if (goldByCharacter[player.characterId] < totalPrice) return { error: ['auction_not_enough_gold', 'Tu ne possèdes pas assez d’or.'] };
    if (goldByCharacter[sellerId] > MAX_CHARACTER_GOLD - totalPrice) return { error: ['auction_seller_gold_limit', 'Le vendeur ne peut pas recevoir davantage d’or pour le moment.'] };
    await client.query('UPDATE characters SET gold = $1, updated_at = NOW() WHERE id = $2', [goldByCharacter[player.characterId] - totalPrice, player.characterId]);
    await client.query('UPDATE characters SET gold = $1, updated_at = NOW() WHERE id = $2', [goldByCharacter[sellerId] + totalPrice, sellerId]);
    await addAuctionInventory(client, player.characterId, row.item_id, quantity);
    const remaining = Number(row.quantity_remaining) - quantity;
    await client.query(
      `UPDATE auction_listings
       SET quantity_remaining = $1,
           status = $2::varchar(16),
           closed_at = CASE WHEN $2::varchar(16) = 'sold'::varchar(16) THEN NOW() ELSE closed_at END
       WHERE id = $3`,
      [remaining, remaining === 0 ? 'sold' : 'active', row.id]
    );
    await client.query(
      `INSERT INTO auction_sales (listing_id, seller_character_id, buyer_character_id, item_id, quantity, unit_price, total_price)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [row.id, sellerId, player.characterId, row.item_id, quantity, Number(row.unit_price), totalPrice]
    );
    return { sellerId, buyerGold: goldByCharacter[player.characterId] - totalPrice, sellerGold: goldByCharacter[sellerId] + totalPrice, quantity, itemId: row.item_id, totalPrice };
  });
  if (outcome.error) {
    if (outcome.error[0] === 'auction_listing_expired') await expireAuctionListing(listingId, sellerId);
    return sendError(socket, outcome.error[0], outcome.error[1]);
  }
  player.gold = outcome.buyerGold;
  const seller = onlineByCharacterId.get(outcome.sellerId);
  if (seller) seller.gold = outcome.sellerGold;
  await sendInventorySnapshot(player);
  if (seller) sendInventorySnapshot(seller).catch((error) => console.error('[auction seller inventory]', error));
  await sendAuctionState(player, context.session);
  if (seller && seller.auctionSessionId) {
    const sellerSession = auctionSessions.get(seller.auctionSessionId);
    if (sellerSession) sendAuctionState(seller, sellerSession).catch((error) => console.error('[auction seller state]', error));
  }
  send(socket, 'notification', { message: 'Achat confirmé : ' + outcome.quantity + ' × ' + (itemDefinition(outcome.itemId).label || outcome.itemId) + ' pour ' + outcome.totalPrice + ' or.' });
  if (seller) send(seller.socket, 'notification', { message: 'Une de tes annonces a vendu ' + outcome.quantity + ' × ' + (itemDefinition(outcome.itemId).label || outcome.itemId) + ' pour ' + outcome.totalPrice + ' or.' });
}

async function handleAuctionCancel(socket, message) {
  const player = socket.player;
  const context = currentAuctionSession(player, message.sessionId);
  if (auctionServiceError(socket, context)) return;
  const listingId = cleanText(message.listingId, 32);
  if (!/^\d+$/.test(listingId)) return sendError(socket, 'auction_invalid_listing', 'Annonce invalide.');
  await expireAuctionListings();
  const outcome = await inTransaction(async (client) => {
    const character = await client.query('SELECT id FROM characters WHERE id = $1 FOR UPDATE', [player.characterId]);
    if (!character.rows[0]) return { error: ['character_not_found', 'Personnage introuvable.'] };
    const listing = await client.query(
      `SELECT id, seller_character_id, item_id, quantity_remaining, status, expires_at
       FROM auction_listings WHERE id = $1 FOR UPDATE`,
      [listingId]
    );
    const row = listing.rows[0];
    if (!row || !sameId(row.seller_character_id, player.characterId)) return { error: ['auction_listing_missing', 'Cette annonce ne t’appartient pas ou n’existe plus.'] };
    if (row.status !== 'active' || Number(row.quantity_remaining) < 1) return { error: ['auction_listing_changed', 'Cette annonce ne peut plus être annulée.'] };
    if (new Date(row.expires_at).getTime() <= now()) return { error: ['auction_listing_expired', 'Cette annonce vient d’expirer.'] };
    await addAuctionInventory(client, player.characterId, row.item_id, Number(row.quantity_remaining));
    await client.query("UPDATE auction_listings SET status = 'cancelled', closed_at = NOW() WHERE id = $1", [row.id]);
    return { itemId: row.item_id, quantity: Number(row.quantity_remaining) };
  });
  if (outcome.error) {
    if (outcome.error[0] === 'auction_listing_expired') await expireAuctionListing(listingId, player.characterId);
    return sendError(socket, outcome.error[0], outcome.error[1]);
  }
  await sendInventorySnapshot(player);
  await sendAuctionState(player, context.session);
  send(socket, 'notification', { message: 'Annonce annulée : ' + outcome.quantity + ' × ' + (itemDefinition(outcome.itemId).label || outcome.itemId) + ' retourné dans ton inventaire.' });
}

function handleAuctionClose(socket, message) {
  const player = socket.player;
  const sessionId = cleanText(message.sessionId, 80);
  if (player && player.auctionSessionId && player.auctionSessionId === sessionId) closeAuctionSession(player, 'Session de l’hôtel des ventes fermée.', false);
}

function handleNpcServiceClose(socket, message) {
  const player = socket.player;
  const sessionId = cleanText(message.sessionId, 80);
  if (player && player.npcServiceSessionId && player.npcServiceSessionId === sessionId) closeNpcServiceSession(player, 'Session du PNJ fermée.', false);
}

async function handleMerchantBuy(socket, message) {
  const player = socket.player;
  const context = currentNpcServiceSession(player, message.sessionId, 'merchant');
  if (context.error) return sendError(socket, context.error[0], context.error[1]);
  const session = context.session;
  if (!merchantPermits(session.mode, 'buy')) return sendError(socket, 'merchant_buy_disabled', 'Ce marchand ne vend pas ici.');
  const itemId = cleanText(message.itemId, 64);
  const quantity = npcInteger(message.quantity, 1, 999999);
  const shop = SHOPS[session.shopId];
  const config = shop && shop.items && shop.items[itemId];
  const item = itemDefinition(itemId);
  if (!quantity || !item || !config || !Number.isInteger(Number(config.sellPrice)) || Number(config.sellPrice) < 0) return sendError(socket, 'merchant_item_invalid', 'Cet objet ne figure pas dans le catalogue du marchand.');
  const total = Number(config.sellPrice) * quantity;
  if (!Number.isSafeInteger(total) || total < 0 || total > MAX_CHARACTER_GOLD) return sendError(socket, 'merchant_price_invalid', 'Prix d’achat invalide.');
  const outcome = await inTransaction(async (client) => {
    const character = await client.query('SELECT id, gold FROM characters WHERE id = $1 FOR UPDATE', [player.characterId]);
    const row = character.rows[0];
    if (!row) return { error: ['character_not_found', 'Personnage introuvable.'] };
    if (!npcServiceInRange(player, session)) return { error: ['npc_too_far', 'Reste à une tuile du PNJ pour utiliser ce service.'] };
    const gold = Number(row.gold || 0);
    if (gold < total) return { error: ['merchant_not_enough_gold', 'Tu ne possèdes pas assez d’or.'] };
    await client.query('UPDATE characters SET gold = $1, updated_at = NOW() WHERE id = $2', [gold - total, player.characterId]);
    await client.query(
      `INSERT INTO character_inventory (character_id, item_id, quantity, updated_at)
       VALUES ($1, $2, $3, NOW()) ON CONFLICT (character_id, item_id)
       DO UPDATE SET quantity = character_inventory.quantity + EXCLUDED.quantity, updated_at = NOW()`,
      [player.characterId, itemId, quantity]
    );
    return { gold: gold - total };
  });
  if (outcome.error) return sendError(socket, outcome.error[0], outcome.error[1]);
  player.gold = outcome.gold;
  await sendInventorySnapshot(player);
  send(socket, 'notification', { message: 'Achat confirmé : ' + quantity + ' × ' + item.label + ' pour ' + total + ' or.' });
}

async function handleMerchantSell(socket, message) {
  const player = socket.player;
  const context = currentNpcServiceSession(player, message.sessionId, 'merchant');
  if (context.error) return sendError(socket, context.error[0], context.error[1]);
  const session = context.session;
  if (!merchantPermits(session.mode, 'sell')) return sendError(socket, 'merchant_sell_disabled', 'Ce marchand ne rachète pas ici.');
  const itemId = cleanText(message.itemId, 64);
  const quantity = npcInteger(message.quantity, 1, 999999);
  const shop = SHOPS[session.shopId];
  const config = shop && shop.items && shop.items[itemId];
  const item = itemDefinition(itemId);
  if (!quantity || !item || !config || !Number.isInteger(Number(config.buyPrice)) || Number(config.buyPrice) < 0) return sendError(socket, 'merchant_item_invalid', 'Cet objet ne peut pas être revendu à ce marchand.');
  const total = Number(config.buyPrice) * quantity;
  if (!Number.isSafeInteger(total) || total < 0 || total > MAX_CHARACTER_GOLD) return sendError(socket, 'merchant_price_invalid', 'Prix de rachat invalide.');
  const outcome = await inTransaction(async (client) => {
    const character = await client.query('SELECT id, gold FROM characters WHERE id = $1 FOR UPDATE', [player.characterId]);
    const row = character.rows[0];
    if (!row) return { error: ['character_not_found', 'Personnage introuvable.'] };
    if (!npcServiceInRange(player, session)) return { error: ['npc_too_far', 'Reste à une tuile du PNJ pour utiliser ce service.'] };
    const gold = Number(row.gold || 0);
    if (gold > MAX_CHARACTER_GOLD - total) return { error: ['merchant_gold_limit', 'Tu ne peux pas recevoir davantage d’or pour le moment.'] };
    const inventory = await client.query('SELECT quantity FROM character_inventory WHERE character_id = $1 AND item_id = $2 FOR UPDATE', [player.characterId, itemId]);
    if (!inventory.rows[0] || Number(inventory.rows[0].quantity) < quantity) return { error: ['merchant_item_not_owned', 'Quantité insuffisante dans ton inventaire.'] };
    if (Number(inventory.rows[0].quantity) === quantity) await client.query('DELETE FROM character_inventory WHERE character_id = $1 AND item_id = $2', [player.characterId, itemId]);
    else await client.query('UPDATE character_inventory SET quantity = quantity - $3, updated_at = NOW() WHERE character_id = $1 AND item_id = $2', [player.characterId, itemId, quantity]);
    // Equipped assets cannot remain worn after a server-authorized sale.
    await client.query('DELETE FROM character_equipment WHERE character_id = $1 AND item_id = $2', [player.characterId, itemId]);
    await client.query('UPDATE characters SET gold = $1, updated_at = NOW() WHERE id = $2', [gold + total, player.characterId]);
    return { gold: gold + total };
  });
  if (outcome.error) return sendError(socket, outcome.error[0], outcome.error[1]);
  player.gold = outcome.gold;
  await sendInventorySnapshot(player);
  send(socket, 'notification', { message: 'Vente confirmée : ' + quantity + ' × ' + item.label + ' pour ' + total + ' or.' });
}

async function moveBankAsset(player, message, direction) {
  const context = currentNpcServiceSession(player, message.sessionId, 'banker');
  if (context.error) return context;
  const asset = cleanText(message.asset, 12).toLowerCase();
  const quantity = npcInteger(message.quantity, 1, MAX_CHARACTER_GOLD);
  const itemId = cleanText(message.itemId, 64);
  if (!quantity || ['gold', 'item'].indexOf(asset) === -1 || (asset === 'item' && !itemDefinition(itemId))) return { error: ['bank_asset_invalid', 'Actif ou quantité bancaire invalide.'] };
  const outcome = await inTransaction(async (client) => {
    const characterResult = await client.query('SELECT id, gold FROM characters WHERE id = $1 FOR UPDATE', [player.characterId]);
    const character = characterResult.rows[0];
    if (!character) return { error: ['character_not_found', 'Personnage introuvable.'] };
    if (!npcServiceInRange(player, context.session)) return { error: ['npc_too_far', 'Reste à une tuile du PNJ pour utiliser ce service.'] };
    // Ensure and lock the single gold row before any movement. PostgreSQL keeps
    // both inventory tables and character gold in one atomic transaction.
    await client.query('INSERT INTO character_banks (character_id, gold, updated_at) VALUES ($1, 0, NOW()) ON CONFLICT (character_id) DO NOTHING', [player.characterId]);
    const bankResult = await client.query('SELECT gold FROM character_banks WHERE character_id = $1 FOR UPDATE', [player.characterId]);
    const bankGold = Number(bankResult.rows[0] && bankResult.rows[0].gold || 0);
    const characterGold = Number(character.gold || 0);
    if (asset === 'gold') {
      if (direction === 'deposit') {
        if (characterGold < quantity) return { error: ['bank_not_enough_gold', 'Tu ne possèdes pas assez d’or.'] };
        if (bankGold > MAX_CHARACTER_GOLD - quantity) return { error: ['bank_gold_limit', 'Le coffre ne peut pas recevoir davantage d’or.'] };
        await client.query('UPDATE characters SET gold = $1, updated_at = NOW() WHERE id = $2', [characterGold - quantity, player.characterId]);
        await client.query('UPDATE character_banks SET gold = $1, updated_at = NOW() WHERE character_id = $2', [bankGold + quantity, player.characterId]);
        return { gold: characterGold - quantity };
      }
      if (bankGold < quantity) return { error: ['bank_not_enough_gold', 'Le coffre ne contient pas assez d’or.'] };
      if (characterGold > MAX_CHARACTER_GOLD - quantity) return { error: ['bank_gold_limit', 'Tu ne peux pas porter davantage d’or.'] };
      await client.query('UPDATE characters SET gold = $1, updated_at = NOW() WHERE id = $2', [characterGold + quantity, player.characterId]);
      await client.query('UPDATE character_banks SET gold = $1, updated_at = NOW() WHERE character_id = $2', [bankGold - quantity, player.characterId]);
      return { gold: characterGold + quantity };
    }

    const inventory = await client.query('SELECT quantity FROM character_inventory WHERE character_id = $1 AND item_id = $2 FOR UPDATE', [player.characterId, itemId]);
    const bankInventory = await client.query('SELECT quantity FROM character_bank_inventory WHERE character_id = $1 AND item_id = $2 FOR UPDATE', [player.characterId, itemId]);
    const owned = Number(inventory.rows[0] && inventory.rows[0].quantity || 0);
    const stored = Number(bankInventory.rows[0] && bankInventory.rows[0].quantity || 0);
    if (direction === 'deposit') {
      if (owned < quantity) return { error: ['bank_item_not_owned', 'Quantité insuffisante dans ton inventaire.'] };
      if (owned === quantity) await client.query('DELETE FROM character_inventory WHERE character_id = $1 AND item_id = $2', [player.characterId, itemId]);
      else await client.query('UPDATE character_inventory SET quantity = quantity - $3, updated_at = NOW() WHERE character_id = $1 AND item_id = $2', [player.characterId, itemId, quantity]);
      await client.query('DELETE FROM character_equipment WHERE character_id = $1 AND item_id = $2', [player.characterId, itemId]);
      await client.query(
        `INSERT INTO character_bank_inventory (character_id, item_id, quantity, updated_at)
         VALUES ($1, $2, $3, NOW()) ON CONFLICT (character_id, item_id)
         DO UPDATE SET quantity = character_bank_inventory.quantity + EXCLUDED.quantity, updated_at = NOW()`,
        [player.characterId, itemId, quantity]
      );
      return {};
    }
    if (stored < quantity) return { error: ['bank_item_missing', 'Quantité insuffisante dans le coffre.'] };
    if (stored === quantity) await client.query('DELETE FROM character_bank_inventory WHERE character_id = $1 AND item_id = $2', [player.characterId, itemId]);
    else await client.query('UPDATE character_bank_inventory SET quantity = quantity - $3, updated_at = NOW() WHERE character_id = $1 AND item_id = $2', [player.characterId, itemId, quantity]);
    await client.query(
      `INSERT INTO character_inventory (character_id, item_id, quantity, updated_at)
       VALUES ($1, $2, $3, NOW()) ON CONFLICT (character_id, item_id)
       DO UPDATE SET quantity = character_inventory.quantity + EXCLUDED.quantity, updated_at = NOW()`,
      [player.characterId, itemId, quantity]
    );
    return {};
  });
  if (!outcome.error && Object.prototype.hasOwnProperty.call(outcome, 'gold')) player.gold = outcome.gold;
  return outcome;
}

async function handleBankDeposit(socket, message) {
  const player = socket.player;
  if (!player) return sendError(socket, 'no_character', 'Sélectionne un personnage.');
  const outcome = await moveBankAsset(player, message, 'deposit');
  if (outcome.error) return sendError(socket, outcome.error[0], outcome.error[1]);
  await sendInventorySnapshot(player);
  await sendBankState(player);
  send(socket, 'notification', { message: 'Dépôt bancaire confirmé.' });
}

async function handleBankWithdraw(socket, message) {
  const player = socket.player;
  if (!player) return sendError(socket, 'no_character', 'Sélectionne un personnage.');
  const outcome = await moveBankAsset(player, message, 'withdraw');
  if (outcome.error) return sendError(socket, outcome.error[0], outcome.error[1]);
  await sendInventorySnapshot(player);
  await sendBankState(player);
  send(socket, 'notification', { message: 'Retrait bancaire confirmé.' });
}

// ---------------------------------------------------------------------------
// Persistent guilds, shared stash and guild-house instances.
// ---------------------------------------------------------------------------
function validGuildName(value) {
  return /^[\p{L}0-9 _-]{3,32}$/u.test(value);
}

async function inTransaction(work) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore rollback failure */ }
    throw error;
  } finally {
    client.release();
  }
}

async function loadGuildMembership(characterId) {
  const result = await db.query(
    `SELECT g.id, g.name, gm.role
     FROM guild_members gm JOIN guilds g ON g.id = gm.guild_id
     WHERE gm.character_id = $1`,
    [characterId]
  );
  const row = result.rows[0];
  return row ? { guildId: asId(row.id), guildName: row.name, guildRole: row.role } : null;
}

async function getGuildState(guildId) {
  const guildResult = await db.query('SELECT id, name, leader_character_id FROM guilds WHERE id = $1', [guildId]);
  const guild = guildResult.rows[0];
  if (!guild) return null;
  const membersResult = await db.query(
    `SELECT gm.character_id, gm.role, c.name, c.class_id, c.level
     FROM guild_members gm JOIN characters c ON c.id = gm.character_id
     WHERE gm.guild_id = $1
     ORDER BY CASE gm.role WHEN 'leader' THEN 0 WHEN 'officer' THEN 1 ELSE 2 END, c.name ASC`,
    [guildId]
  );
  return {
    id: asId(guild.id),
    name: guild.name,
    leaderCharacterId: asId(guild.leader_character_id),
    members: membersResult.rows.map((member) => ({
      characterId: asId(member.character_id), name: member.name, classId: member.class_id,
      level: member.level, role: member.role, online: onlineByCharacterId.has(asId(member.character_id))
    }))
  };
}

async function sendGuildSnapshot(player, state) {
  if (!player || !player.guildId) return send(player.socket, 'guildSnapshot', { guild: null });
  const guild = state || await getGuildState(player.guildId);
  if (!guild) {
    player.guildId = null;
    player.guildName = null;
    player.guildRole = null;
    return send(player.socket, 'guildSnapshot', { guild: null });
  }
  const ownMember = guild.members.find((member) => sameId(member.characterId, player.characterId));
  if (!ownMember) {
    player.guildId = null;
    player.guildName = null;
    player.guildRole = null;
    return send(player.socket, 'guildSnapshot', { guild: null });
  }
  player.guildName = guild.name;
  player.guildRole = ownMember.role;
  send(player.socket, 'guildSnapshot', { guild });
}

async function broadcastGuildSnapshot(guildId) {
  const guild = await getGuildState(guildId);
  if (!guild) return;
  guild.members.forEach((member) => {
    const player = onlineByCharacterId.get(asId(member.characterId));
    if (!player) return;
    player.guildId = guild.id;
    player.guildName = guild.name;
    player.guildRole = member.role;
    send(player.socket, 'guildSnapshot', { guild });
  });
}

function requireGuildOfficer(player, socket) {
  if (!player || !player.guildId) {
    sendError(socket, 'not_in_guild', 'Tu n’appartiens à aucune guilde.');
    return false;
  }
  if (['leader', 'officer'].indexOf(player.guildRole) === -1) {
    sendError(socket, 'guild_permission_denied', 'Ce rang ne peut pas inviter de membres.');
    return false;
  }
  return true;
}

async function handleGuildCreate(socket, message) {
  const player = socket.player;
  if (!player) return sendError(socket, 'no_character', 'Sélectionne un personnage.');
  if (player.guildId) return sendError(socket, 'already_in_guild', 'Tu appartiens déjà à une guilde.');
  const context = currentNpcServiceSession(player, message.sessionId, 'guild_registrar');
  if (context.error) return sendError(socket, context.error[0], context.error[1]);
  const name = cleanText(message.name, 32);
  if (!validGuildName(name)) return sendError(socket, 'invalid_guild_name', 'Le nom de guilde doit contenir 3 à 32 caractères.');
  try {
    const guild = await inTransaction(async (client) => {
      if (!npcServiceInRange(player, context.session)) return { error: ['npc_too_far', 'Reste à une tuile du registraire pour créer ta guilde.'] };
      const created = await client.query(
        'INSERT INTO guilds (name, leader_character_id) VALUES ($1, $2) RETURNING id, name, leader_character_id',
        [name, player.characterId]
      );
      await client.query(
        "INSERT INTO guild_members (guild_id, character_id, role) VALUES ($1, $2, 'leader')",
        [created.rows[0].id, player.characterId]
      );
      return created.rows[0];
    });
    if (guild.error) return sendError(socket, guild.error[0], guild.error[1]);
    player.guildId = asId(guild.id);
    player.guildName = guild.name;
    player.guildRole = 'leader';
    closeNpcServiceSession(player, 'Création de guilde terminée.', false);
    await broadcastGuildSnapshot(player.guildId);
    send(player.socket, 'notification', { message: 'Guilde « ' + guild.name + ' » créée.' });
  } catch (error) {
    if (error && error.code === '23505') return sendError(socket, 'guild_name_taken', 'Ce nom de guilde est déjà utilisé.');
    throw error;
  }
}

function handleGuildInvite(socket, message) {
  const player = socket.player;
  if (!requireGuildOfficer(player, socket)) return;
  const target = getPlayerByName(message.targetName);
  if (!target) return sendError(socket, 'target_offline', 'Ce joueur est hors ligne.');
  if (sameId(target.characterId, player.characterId)) return sendError(socket, 'cannot_invite_self', 'Tu ne peux pas t’inviter.');
  if (target.guildId || guildInvites.has(target.characterId)) return sendError(socket, 'target_in_guild', 'Ce joueur est déjà en guilde ou possède une invitation.');
  const invite = { guildId: player.guildId, inviterId: player.characterId, expiresAt: now() + 120000 };
  guildInvites.set(target.characterId, invite);
  send(target.socket, 'guildInvite', {
    guildId: player.guildId, guildName: player.guildName,
    from: { characterId: player.characterId, name: player.name }
  });
  send(player.socket, 'notification', { message: 'Invitation de guilde envoyée à ' + target.name + '.' });
}

async function handleGuildResponse(socket, message) {
  const player = socket.player;
  if (!player) return sendError(socket, 'no_character', 'Sélectionne un personnage.');
  const guildId = cleanText(message.guildId, 80);
  const accepted = message.accepted === true;
  const invite = guildInvites.get(player.characterId);
  if (!invite || invite.guildId !== guildId || invite.expiresAt < now()) {
    guildInvites.delete(player.characterId);
    return sendError(socket, 'guild_invite_expired', 'Cette invitation n’est plus valide.');
  }
  guildInvites.delete(player.characterId);
  if (!accepted) return send(player.socket, 'notification', { message: 'Invitation de guilde refusée.' });
  if (player.guildId) return sendError(socket, 'already_in_guild', 'Tu appartiens déjà à une guilde.');
  try {
    await db.query("INSERT INTO guild_members (guild_id, character_id, role) VALUES ($1, $2, 'member')", [guildId, player.characterId]);
  } catch (error) {
    if (error && error.code === '23505') return sendError(socket, 'already_in_guild', 'Tu appartiens déjà à une guilde.');
    throw error;
  }
  const state = await getGuildState(guildId);
  if (!state) return sendError(socket, 'guild_missing', 'Cette guilde n’existe plus.');
  player.guildId = state.id;
  player.guildName = state.name;
  player.guildRole = 'member';
  instances.forEach((instance) => {
    if (instance.kind === 'guild_house' && sameId(instance.guildId, state.id)) instance.memberIds.add(player.characterId);
  });
  await broadcastGuildSnapshot(state.id);
  send(player.socket, 'notification', { message: 'Tu as rejoint « ' + state.name + ' ».' });
}

async function handleGuildLeave(socket) {
  const player = socket.player;
  if (!player || !player.guildId) return sendError(socket, 'not_in_guild', 'Tu n’appartiens à aucune guilde.');
  if (player.guildRole === 'leader') return sendError(socket, 'leader_cannot_leave', 'Transfère le leadership ou dissous la guilde avant de partir.');
  const guildId = player.guildId;
  if (activeGuildHouse(player)) {
    send(player.socket, 'exitInstance', Object.assign({ instanceId: player.instanceId }, GUILD_HOUSE.exit));
  }
  await db.query('DELETE FROM guild_members WHERE guild_id = $1 AND character_id = $2', [guildId, player.characterId]);
  player.guildId = null;
  player.guildName = null;
  player.guildRole = null;
  send(player.socket, 'guildSnapshot', { guild: null });
  await broadcastGuildSnapshot(guildId);
}

async function handleGuildSetRole(socket, message) {
  const player = socket.player;
  if (!player || !player.guildId || player.guildRole !== 'leader') return sendError(socket, 'guild_permission_denied', 'Seul le chef peut modifier les rangs.');
  const targetId = cleanText(message.characterId, 32);
  const role = cleanText(message.role, 16);
  if (!/^\d+$/.test(targetId) || ['officer', 'member'].indexOf(role) === -1) return sendError(socket, 'invalid_guild_role', 'Rang ou membre invalide.');
  const updated = await db.query(
    "UPDATE guild_members SET role = $1 WHERE guild_id = $2 AND character_id = $3 AND role <> 'leader' RETURNING character_id",
    [role, player.guildId, targetId]
  );
  if (!updated.rows[0]) return sendError(socket, 'guild_member_missing', 'Membre introuvable ou chef de guilde.');
  await broadcastGuildSnapshot(player.guildId);
}

async function handleGuildTransferLeader(socket, message) {
  const player = socket.player;
  if (!player || !player.guildId || player.guildRole !== 'leader') return sendError(socket, 'guild_permission_denied', 'Seul le chef peut transférer le leadership.');
  const targetId = cleanText(message.characterId, 32);
  if (!/^\d+$/.test(targetId) || sameId(targetId, player.characterId)) return sendError(socket, 'invalid_guild_member', 'Choisis un autre membre.');
  const guildId = player.guildId;
  const target = await db.query('SELECT character_id FROM guild_members WHERE guild_id = $1 AND character_id = $2', [guildId, targetId]);
  if (!target.rows[0]) return sendError(socket, 'guild_member_missing', 'Membre introuvable.');
  await inTransaction(async (client) => {
    await client.query("UPDATE guild_members SET role = 'member' WHERE guild_id = $1 AND character_id = $2", [guildId, player.characterId]);
    await client.query("UPDATE guild_members SET role = 'leader' WHERE guild_id = $1 AND character_id = $2", [guildId, targetId]);
    await client.query('UPDATE guilds SET leader_character_id = $1 WHERE id = $2', [targetId, guildId]);
  });
  await broadcastGuildSnapshot(guildId);
}

async function handleGuildDisband(socket) {
  const player = socket.player;
  if (!player || !player.guildId || player.guildRole !== 'leader') return sendError(socket, 'guild_permission_denied', 'Seul le chef peut dissoudre la guilde.');
  const guildId = player.guildId;
  const state = await getGuildState(guildId);
  await inTransaction(async (client) => {
    // Houses must be removed first because a house requires an owner or guild.
    await client.query('DELETE FROM houses WHERE guild_id = $1', [guildId]);
    await client.query('DELETE FROM guilds WHERE id = $1', [guildId]);
  });
  (state ? state.members : []).forEach((member) => {
    const online = onlineByCharacterId.get(asId(member.characterId));
    if (!online) return;
    if (activeGuildHouse(online)) {
      send(online.socket, 'exitInstance', Object.assign({ instanceId: online.instanceId }, GUILD_HOUSE.exit));
    }
    online.guildId = null;
    online.guildName = null;
    online.guildRole = null;
    send(online.socket, 'guildSnapshot', { guild: null });
    send(online.socket, 'notification', { message: 'La guilde a été dissoute.' });
  });
  instances.forEach((instance, instanceId) => {
    if (instance.kind === 'guild_house' && sameId(instance.guildId, guildId)) instances.delete(instanceId);
  });
}

function activeGuildHouse(player) {
  if (!player || !player.instanceId) return null;
  const instance = instances.get(player.instanceId);
  return instance && instance.kind === 'guild_house' && sameId(instance.guildId, player.guildId) ? instance : null;
}

function guildRoleWeight(role) {
  return ({ member: 1, officer: 2, leader: 3 })[role] || 0;
}

function canBuildInGuildHouse(player, instance) {
  return !!instance && guildRoleWeight(player.guildRole) >= guildRoleWeight(instance.buildRole || 'officer');
}

function houseItemSnapshot(row) {
  const item = ITEMS[row.item_key];
  if (!item) return null;
  return {
    houseItemId: asId(row.id),
    itemId: item.id,
    label: item.label,
    type: item.type,
    description: item.description || '',
    color: item.color || '#808fa8',
    shortLabel: item.shortLabel || '?',
    x: row.tile_x,
    y: row.tile_y,
    rotation: row.rotation,
    fixture: item.type === 'fixture'
  };
}

async function sendHouseSnapshot(player) {
  const instance = activeGuildHouse(player);
  if (!instance) return sendError(player.socket, 'guild_house_required', 'Tu dois être dans ta maison de guilde.');
  const result = await db.query(
    'SELECT id, item_key, tile_x, tile_y, rotation FROM house_items WHERE house_id = $1 ORDER BY id ASC',
    [instance.houseId]
  );
  send(player.socket, 'houseSnapshot', {
    instanceId: instance.id,
    houseId: instance.houseId,
    buildRole: instance.buildRole,
    canBuild: canBuildInGuildHouse(player, instance),
    isLeader: player.guildRole === 'leader',
    items: result.rows.map(houseItemSnapshot).filter(Boolean)
  });
}

async function refreshHouseForVisitors(guildId) {
  const visitors = Array.from(onlineByCharacterId.values()).filter((player) => {
    const instance = activeGuildHouse(player);
    return instance && sameId(instance.guildId, guildId);
  });
  await Promise.all(visitors.map((player) => sendHouseSnapshot(player)));
}

async function handleHouseRequest(socket) {
  const player = socket.player;
  if (!player) return sendError(socket, 'no_character', 'Sélectionne un personnage.');
  await sendHouseSnapshot(player);
}

async function handleHousePlace(socket, message) {
  const player = socket.player;
  const instance = activeGuildHouse(player);
  if (!instance) return sendError(socket, 'guild_house_required', 'Place le mobilier depuis une maison de guilde.');
  if (!canBuildInGuildHouse(player, instance)) return sendError(socket, 'house_permission_denied', 'Ton rang ne peut pas construire dans cette maison.');
  const itemId = cleanText(message.itemId, 64);
  const item = ITEMS[itemId];
  const x = integer(message.x);
  const y = integer(message.y);
  const rotation = ((integer(message.rotation) || 0) % 4 + 4) % 4;
  if (!item || item.type !== 'furniture') return sendError(socket, 'not_furniture', 'Cet objet ne peut pas être placé.');
  if (!isInteger(x) || !isInteger(y) || x < 0 || y < 0 || x >= 1000 || y >= 1000) return sendError(socket, 'invalid_house_tile', 'Case de placement invalide.');

  const placed = await inTransaction(async (client) => {
    const inventory = await client.query('SELECT quantity FROM character_inventory WHERE character_id = $1 AND item_id = $2 FOR UPDATE', [player.characterId, itemId]);
    if (!inventory.rows[0] || inventory.rows[0].quantity < 1) return false;
    const inserted = await client.query(
      `INSERT INTO house_items (house_id, item_key, tile_x, tile_y, rotation)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (house_id, tile_x, tile_y) DO NOTHING RETURNING id`,
      [instance.houseId, itemId, x, y, rotation]
    );
    if (!inserted.rows[0]) return false;
    if (Number(inventory.rows[0].quantity) === 1) {
      await client.query('DELETE FROM character_inventory WHERE character_id = $1 AND item_id = $2', [player.characterId, itemId]);
    } else {
      await client.query('UPDATE character_inventory SET quantity = quantity - 1, updated_at = NOW() WHERE character_id = $1 AND item_id = $2', [player.characterId, itemId]);
    }
    return true;
  });
  if (!placed) return sendError(socket, 'house_tile_occupied_or_item_missing', 'Case occupée ou objet absent de ton inventaire.');
  await sendInventorySnapshot(player);
  await refreshHouseForVisitors(player.guildId);
}

async function handleHouseRemove(socket, message) {
  const player = socket.player;
  const instance = activeGuildHouse(player);
  if (!instance) return sendError(socket, 'guild_house_required', 'Tu dois être dans ta maison de guilde.');
  if (!canBuildInGuildHouse(player, instance)) return sendError(socket, 'house_permission_denied', 'Ton rang ne peut pas déplacer le mobilier.');
  const houseItemId = cleanText(message.houseItemId, 32);
  if (!/^\d+$/.test(houseItemId)) return sendError(socket, 'invalid_house_item', 'Mobilier invalide.');
  const removed = await inTransaction(async (client) => {
    const found = await client.query('SELECT item_key FROM house_items WHERE id = $1 AND house_id = $2 FOR UPDATE', [houseItemId, instance.houseId]);
    const row = found.rows[0];
    if (!row || !ITEMS[row.item_key] || ITEMS[row.item_key].type !== 'furniture') return false;
    await client.query('DELETE FROM house_items WHERE id = $1 AND house_id = $2', [houseItemId, instance.houseId]);
    await client.query(
      `INSERT INTO character_inventory (character_id, item_id, quantity, updated_at) VALUES ($1, $2, 1, NOW())
       ON CONFLICT (character_id, item_id) DO UPDATE SET quantity = character_inventory.quantity + 1, updated_at = NOW()`,
      [player.characterId, row.item_key]
    );
    return true;
  });
  if (!removed) return sendError(socket, 'house_fixture_or_missing', 'Ce mobilier ne peut pas être retiré.');
  await sendInventorySnapshot(player);
  await refreshHouseForVisitors(player.guildId);
}

async function handleHouseSetBuildRole(socket, message) {
  const player = socket.player;
  const instance = activeGuildHouse(player);
  if (!instance) return sendError(socket, 'guild_house_required', 'Tu dois être dans ta maison de guilde.');
  if (player.guildRole !== 'leader') return sendError(socket, 'house_permission_denied', 'Seul le chef peut modifier les permissions de construction.');
  const role = cleanText(message.role, 16);
  if (['leader', 'officer', 'member'].indexOf(role) === -1) return sendError(socket, 'invalid_house_role', 'Permission invalide.');
  await db.query('UPDATE houses SET build_role = $1 WHERE id = $2', [role, instance.houseId]);
  instance.buildRole = role;
  await refreshHouseForVisitors(player.guildId);
}

async function sendGuildChestSnapshot(player) {
  if (!activeGuildHouse(player)) return sendError(player.socket, 'guild_house_required', 'Le coffre est accessible dans la maison de guilde uniquement.');
  const result = await db.query('SELECT item_id, quantity FROM guild_stash WHERE guild_id = $1 ORDER BY item_id ASC', [player.guildId]);
  const items = result.rows.map((row) => itemSnapshot(row.item_id, row.quantity)).filter(Boolean);
  send(player.socket, 'guildChestSnapshot', { guildId: player.guildId, items });
}

async function refreshGuildChestForHouseVisitors(guildId) {
  const visitors = Array.from(onlineByCharacterId.values()).filter((player) => activeGuildHouse(player) && sameId(player.guildId, guildId));
  await Promise.all(visitors.map((player) => sendGuildChestSnapshot(player)));
}

async function handleGuildChestRequest(socket) {
  const player = socket.player;
  if (!player || !player.guildId) return sendError(socket, 'not_in_guild', 'Tu n’appartiens à aucune guilde.');
  await sendGuildChestSnapshot(player);
}

async function handleGuildDeposit(socket, message) {
  const player = socket.player;
  if (!player || !player.guildId) return sendError(socket, 'not_in_guild', 'Tu n’appartiens à aucune guilde.');
  if (!activeGuildHouse(player)) return sendError(socket, 'guild_house_required', 'Le coffre est accessible dans la maison de guilde uniquement.');
  const itemId = cleanText(message.itemId, 64);
  const quantity = Math.max(1, Math.min(999, integer(message.quantity) || 1));
  if (!itemDefinition(itemId)) return sendError(socket, 'item_unknown', 'Objet inconnu.');
  const moved = await inTransaction(async (client) => {
    const inventory = await client.query('SELECT quantity FROM character_inventory WHERE character_id = $1 AND item_id = $2 FOR UPDATE', [player.characterId, itemId]);
    if (!inventory.rows[0] || inventory.rows[0].quantity < quantity) return false;
    const remaining = Number(inventory.rows[0].quantity) - quantity;
    if (remaining === 0) {
      await client.query('DELETE FROM character_inventory WHERE character_id = $1 AND item_id = $2', [player.characterId, itemId]);
    } else {
      await client.query('UPDATE character_inventory SET quantity = $1, updated_at = NOW() WHERE character_id = $2 AND item_id = $3', [remaining, player.characterId, itemId]);
    }
    await client.query(
      `INSERT INTO guild_stash (guild_id, item_id, quantity, updated_at) VALUES ($1, $2, $3, NOW())
       ON CONFLICT (guild_id, item_id) DO UPDATE SET quantity = guild_stash.quantity + EXCLUDED.quantity, updated_at = NOW()`,
      [player.guildId, itemId, quantity]
    );
    return true;
  });
  if (!moved) return sendError(socket, 'not_enough_items', 'Quantité insuffisante dans ton inventaire.');
  await sendInventorySnapshot(player);
  await refreshGuildChestForHouseVisitors(player.guildId);
}

async function handleGuildWithdraw(socket, message) {
  const player = socket.player;
  if (!player || !player.guildId) return sendError(socket, 'not_in_guild', 'Tu n’appartiens à aucune guilde.');
  if (!activeGuildHouse(player)) return sendError(socket, 'guild_house_required', 'Le coffre est accessible dans la maison de guilde uniquement.');
  const itemId = cleanText(message.itemId, 64);
  const quantity = Math.max(1, Math.min(999, integer(message.quantity) || 1));
  if (!itemDefinition(itemId)) return sendError(socket, 'item_unknown', 'Objet inconnu.');
  const moved = await inTransaction(async (client) => {
    const stash = await client.query('SELECT quantity FROM guild_stash WHERE guild_id = $1 AND item_id = $2 FOR UPDATE', [player.guildId, itemId]);
    if (!stash.rows[0] || stash.rows[0].quantity < quantity) return false;
    const remaining = Number(stash.rows[0].quantity) - quantity;
    if (remaining === 0) {
      await client.query('DELETE FROM guild_stash WHERE guild_id = $1 AND item_id = $2', [player.guildId, itemId]);
    } else {
      await client.query('UPDATE guild_stash SET quantity = $1, updated_at = NOW() WHERE guild_id = $2 AND item_id = $3', [remaining, player.guildId, itemId]);
    }
    await client.query(
      `INSERT INTO character_inventory (character_id, item_id, quantity, updated_at) VALUES ($1, $2, $3, NOW())
       ON CONFLICT (character_id, item_id) DO UPDATE SET quantity = character_inventory.quantity + EXCLUDED.quantity, updated_at = NOW()`,
      [player.characterId, itemId, quantity]
    );
    return true;
  });
  if (!moved) return sendError(socket, 'guild_stash_missing_item', 'Quantité insuffisante dans le coffre.');
  await sendInventorySnapshot(player);
  await refreshGuildChestForHouseVisitors(player.guildId);
}

async function ensureGuildHouseInstance(guildId) {
  let houseResult = await db.query('SELECT id, guild_id, map_id, instance_key, build_role, starter_furniture_granted FROM houses WHERE guild_id = $1', [guildId]);
  let house = houseResult.rows[0];
  if (!house) {
    const instanceKey = 'guild-house-' + guildId;
    const created = await db.query(
      `INSERT INTO houses (guild_id, map_id, instance_key, build_role)
       VALUES ($1, $2, $3, $4) RETURNING id, guild_id, map_id, instance_key, build_role, starter_furniture_granted`,
      [guildId, GUILD_HOUSE.templateMapId, instanceKey, GUILD_HOUSE.defaultBuildRole || 'officer']
    );
    house = created.rows[0];
    // A permanent fixture renders the chest's place in every guild house.
    await db.query(
      `INSERT INTO house_items (house_id, item_key, tile_x, tile_y, metadata)
       VALUES ($1, 'guild_chest', $2, $3, '{"fixture":true}'::jsonb)
       ON CONFLICT (house_id, tile_x, tile_y) DO NOTHING`,
      [house.id, GUILD_HOUSE.chest.x, GUILD_HOUSE.chest.y]
    );
  }
  // Existing houses from before v0.6 receive their immutable chest on first access.
  await db.query(
    `INSERT INTO house_items (house_id, item_key, tile_x, tile_y, metadata)
     VALUES ($1, 'guild_chest', $2, $3, '{"fixture":true}'::jsonb)
     ON CONFLICT (house_id, tile_x, tile_y) DO NOTHING`,
    [house.id, GUILD_HOUSE.chest.x, GUILD_HOUSE.chest.y]
  );
  // Guilds created before housing decoration receive this package exactly once.
  const starter = await db.query(
    `UPDATE houses SET starter_furniture_granted = TRUE
     WHERE id = $1 AND starter_furniture_granted = FALSE RETURNING guild_id`,
    [house.id]
  );
  if (starter.rows[0]) {
    const leader = await db.query('SELECT leader_character_id FROM guilds WHERE id = $1', [guildId]);
    if (leader.rows[0]) {
      const leaderId = leader.rows[0].leader_character_id;
      await Promise.all([
        grantItem(leaderId, 'guild_banner', 1),
        grantItem(leaderId, 'wooden_table', 2),
        grantItem(leaderId, 'wall_torch', 2)
      ]);
      const onlineLeader = onlineByCharacterId.get(asId(leaderId));
      if (onlineLeader) {
        sendInventorySnapshot(onlineLeader).catch((error) => console.error('[starter furniture inventory]', error));
        send(onlineLeader.socket, 'notification', { message: 'Mobilier de départ ajouté à ton inventaire.' });
      }
    }
  }
  let instance = instances.get(house.instance_key);
  if (!instance) {
    const members = await db.query('SELECT character_id FROM guild_members WHERE guild_id = $1', [guildId]);
    instance = {
      id: house.instance_key,
      kind: 'guild_house',
      guildId: asId(guildId),
      houseId: asId(house.id),
      buildRole: house.build_role || 'officer',
      templateMapId: house.map_id,
      memberIds: new Set(members.rows.map((member) => asId(member.character_id))),
      createdAt: now()
    };
    instances.set(instance.id, instance);
  }
  return instance;
}

async function handleGuildHouseEnter(socket) {
  const player = socket.player;
  if (!player || !player.guildId) return sendError(socket, 'not_in_guild', 'Tu dois appartenir à une guilde.');
  if (player.battleId) return sendError(socket, 'in_battle', 'Entrée impossible pendant le combat.');
  const instance = await ensureGuildHouseInstance(player.guildId);
  instance.memberIds.add(player.characterId);
  send(player.socket, 'enterInstance', {
    instanceId: instance.id,
    title: 'Maison de guilde — ' + player.guildName,
    mapId: instance.templateMapId,
    x: GUILD_HOUSE.spawn.x,
    y: GUILD_HOUSE.spawn.y,
    direction: GUILD_HOUSE.spawn.direction
  });
}

function handleGuildHouseExit(socket) {
  const player = socket.player;
  if (!activeGuildHouse(player)) return sendError(socket, 'not_in_guild_house', 'Tu n’es pas dans une maison de guilde.');
  if (player.battleId) return sendError(socket, 'in_battle', 'Sortie impossible pendant le combat.');
  send(player.socket, 'exitInstance', Object.assign({ instanceId: player.instanceId }, GUILD_HOUSE.exit));
}

function getPlayerByName(name) {
  const needle = cleanText(name, 24).toLocaleLowerCase();
  return Array.from(onlineByCharacterId.values()).find((candidate) => candidate.name.toLocaleLowerCase() === needle) || null;
}

function validUsername(value) {
  return /^[A-Za-z0-9_]{3,20}$/.test(value);
}

function validCharacterName(value) {
  return /^[\p{L}0-9 _-]{3,24}$/u.test(value);
}

function validPosition(mapId, x, y, direction) {
  return isInteger(mapId) && mapId > 0 && mapId < 10000 &&
    isInteger(x) && x >= 0 && x < 1000 &&
    isInteger(y) && y >= 0 && y < 1000 &&
    [2, 4, 6, 8].indexOf(direction) !== -1;
}

async function persistPlayer(player, force) {
  if (!player || !player.dirty) return;
  if (!force && now() - player.lastSavedAt < SAVE_INTERVAL_MS) return;
  player.lastSavedAt = now();
  player.dirty = false;
  try {
    await db.query(
      `UPDATE characters
         SET map_id = $1, map_x = $2, map_y = $3, direction = $4,
             current_hp = $5, current_mp = $6,
             updated_at = NOW(), last_online_at = NOW()
       WHERE id = $7`,
      [player.mapId, player.x, player.y, player.direction, player.currentHp, player.currentMp, player.characterId]
    );
  } catch (error) {
    // Keep a dirty flag so the next movement/disconnect can try again.
    player.dirty = true;
    console.error('[save] could not save character ' + player.characterId, error);
  }
}

function queueSave(player) {
  player.dirty = true;
  if (now() - player.lastSavedAt >= SAVE_INTERVAL_MS) {
    persistPlayer(player, false);
  }
}

function sendWorldSnapshot(player) {
  const players = allPlayersInWorld(player)
    .filter((candidate) => !sameId(candidate.characterId, player.characterId))
    .map(publicPlayer);
  send(player.socket, 'worldSnapshot', {
    players,
    instanceId: player.instanceId || null,
    monsterStates: worldMonsterStatesForWorld(player.mapId, player.instanceId || null)
  });
}

function monsterStatePacket(state) {
  return {
    mapId: Number(state.mapId), instanceId: state.instanceId || null,
    eventId: Number(state.eventId), pageIndex: Number(state.pageIndex),
    battleKey: state.battleKey, status: state.status,
    respawnAt: state.respawnAt ? new Date(state.respawnAt).toISOString() : null
  };
}

function worldMonsterStatesForWorld(mapId, instanceId) {
  return Array.from(worldMonsters.values())
    .filter((state) => Number(state.mapId) === Number(mapId) && (state.instanceId || null) === (instanceId || null))
    .map(monsterStatePacket);
}

function broadcastMonsterState(state) {
  broadcastToWorldScope(state.mapId, state.instanceId || null, 'worldMonsterState', monsterStatePacket(state));
}

function broadcastMonsterAvailable(context) {
  broadcastToWorldScope(context.mapId, context.instanceId || null, 'worldMonsterState', {
    mapId: Number(context.mapId), instanceId: context.instanceId || null,
    eventId: Number(context.eventId), pageIndex: Number(context.pageIndex),
    battleKey: context.battleKey, status: 'available', respawnAt: null
  });
}

function worldMonsterKey(context) {
  return [Number(context.mapId), context.instanceId || 'public', Number(context.eventId), Number(context.pageIndex), context.battleKey].join(':');
}

function battleEventInRange(player, definition) {
  return !!(player && definition && !player.battleId && Number(player.mapId) === Number(definition.mapId) &&
    Math.max(Math.abs(Number(player.x) - Number(definition.eventX)), Math.abs(Number(player.y) - Number(definition.eventY))) <= NPC_SERVICE_RANGE_TILES);
}

function monsterContextForBattle(player, definition) {
  const battleKey = cleanText(definition && definition.metadata && definition.metadata.battle, 32).toLowerCase();
  const respawnSeconds = Number(definition && definition.metadata && definition.metadata.respawn);
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(battleKey) || !Number.isInteger(respawnSeconds) || respawnSeconds < MIN_MONSTER_RESPAWN_SECONDS || respawnSeconds > MAX_MONSTER_RESPAWN_SECONDS) {
    return { error: ['monster_config_invalid', 'Le combat d’événement doit définir battle=identifiant et respawn=5..86400 dans son commentaire MMO.'] };
  }
  const context = {
    mapId: player.mapId, instanceId: player.instanceId || null,
    eventId: definition.eventId, pageIndex: definition.pageIndex,
    eventX: definition.eventX, eventY: definition.eventY,
    battleKey, respawnMs: respawnSeconds * 1000
  };
  context.key = worldMonsterKey(context);
  return { context };
}

function monsterUnavailableError(state) {
  if (!state) return null;
  if (state.status === 'respawning') return ['monster_respawning', 'Ce monstre réapparaîtra bientôt.'];
  if (state.status === 'lobby') return ['monster_reserved', 'Ce monstre est déjà réservé par un autre groupe.'];
  return ['monster_in_battle', 'Ce monstre est déjà en combat.'];
}

function clearMonsterState(context) {
  const state = worldMonsters.get(context.key);
  if (state) worldMonsters.delete(context.key);
  broadcastMonsterAvailable(context);
}

function leaveWorld(player) {
  broadcastToWorld(player, 'playerLeft', { characterId: player.characterId }, player.characterId);
}

function joinWorld(player) {
  sendWorldSnapshot(player);
  broadcastToWorld(player, 'playerJoined', { player: publicPlayer(player) }, player.characterId);
}

function groupMembers(group) {
  return Array.from(group.memberIds)
    .map((characterId) => onlineByCharacterId.get(asId(characterId)))
    .filter(Boolean);
}

function serializeGroup(group) {
  return {
    id: group.id,
    leaderCharacterId: group.leaderCharacterId,
    members: groupMembers(group).map((player) => ({
      characterId: player.characterId,
      name: player.name,
      classId: player.classId,
      level: player.level,
      online: true
    }))
  };
}

function sendGroupUpdate(group) {
  if (!group) return;
  const data = serializeGroup(group);
  groupMembers(group).forEach((member) => send(member.socket, 'groupUpdate', { group: data }));
}

function deleteGroupIfEmpty(group) {
  if (!group || group.memberIds.size > 0 || group.pendingCharacterIds.size > 0) return;
  groups.delete(group.id);
}

function ensureGroupFor(player) {
  if (player.groupId && groups.has(player.groupId)) return groups.get(player.groupId);
  const group = {
    id: crypto.randomUUID(),
    leaderCharacterId: player.characterId,
    memberIds: new Set([player.characterId]),
    pendingCharacterIds: new Set(),
    quests: new Map(),
    createdAt: now()
  };
  player.groupId = group.id;
  groups.set(group.id, group);
  return group;
}

function detachFromGroup(player) {
  if (!player || !player.groupId) return;
  removePlayerFromBattleLobbies(player, 'Un membre a quitté le groupe.');
  const group = groups.get(player.groupId);
  player.groupId = null;
  if (!group) return;
  group.memberIds.delete(player.characterId);
  if (sameId(group.leaderCharacterId, player.characterId)) {
    const successor = Array.from(group.memberIds)[0];
    group.leaderCharacterId = successor || null;
  }
  if (group.memberIds.size > 0) {
    sendGroupUpdate(group);
    sendGroupQuestSnapshots(group);
  }
  deleteGroupIfEmpty(group);
}

function questDefinitionForId(questId) {
  const native = typeof nativeQuestById === 'function' ? nativeQuestById(questId) : null;
  const definition = native || QUESTS[questId] || null;
  if (!definition) return null;
  if (definition.objective && definition.objective.type === 'collect' && !itemDefinition(definition.objective.itemId)) return null;
  return definition;
}

function allQuestDefinitions() {
  const native = typeof nativeQuestDefinitions === 'function' ? nativeQuestDefinitions() : {};
  return Object.assign({}, QUESTS, native || {});
}

function questDefinitionForNpcAction(verified, questId) {
  const native = typeof nativeQuestForNpcAction === 'function' ? nativeQuestForNpcAction(verified, questId) : null;
  if (native) {
    if (native.error) return { error: ['quest_native_invalid', native.error] };
    if (!native.definition || !questDefinitionForId(native.definition.id)) return { error: ['quest_native_invalid', 'La définition native de cette quête référence un objectif invalide.'] };
    return { definition: native.definition };
  }
  const definition = questDefinitionForId(questId);
  return definition ? { definition } : { error: ['quest_unknown', 'Quête inconnue.'] };
}

function nativeQuestProgressForBattle(eventDefinition) {
  const metadata = eventDefinition && eventDefinition.metadata ? eventDefinition.metadata : {};
  const questId = cleanText(metadata.quest_progress, 64).toLowerCase();
  if (!questId) return { rules: [] };
  const amount = integer(metadata.quest_amount === undefined ? 1 : metadata.quest_amount);
  const definition = questDefinitionForId(questId);
  if (!definition || !definition.native || !definition.objective || definition.objective.type !== 'defeat' || !Number.isInteger(amount) || amount < 1 || amount > 100000) {
    return { error: ['quest_native_invalid', 'Le combat doit référencer une quête native de type defeat avec quest_progress et quest_amount=1..100000.'] };
  }
  return { rules: [{ questId: definition.id, amount }] };
}

function questSnapshotEntry(questId, status, progress, mode, extra) {
  const definition = questDefinitionForId(questId);
  return Object.assign({
    questId,
    title: definition ? definition.title : questId,
    objective: definition && definition.objective ? (definition.objective.text || '') : '',
    status,
    readyToTurnIn: status === 'ready',
    completed: status === 'complete',
    progress: Number(progress || 0),
    goal: definition ? Number(definition.goal || 0) : 0,
    scope: mode,
    mode
  }, extra || {});
}

function groupQuestEligibleCharacterIds(group, quest) {
  const configured = quest && quest.eligibleCharacterIds instanceof Set ? quest.eligibleCharacterIds : (group ? group.memberIds : new Set());
  return Array.from(configured).filter((characterId) => group && group.memberIds.has(characterId));
}

function groupQuestClaimedCharacterIds(quest) {
  return quest && quest.claimedCharacterIds instanceof Set ? quest.claimedCharacterIds : new Set();
}

function getGroupQuestState(group, player) {
  if (!group || !player) return [];
  return Array.from(group.quests.values())
    .filter((quest) => groupQuestEligibleCharacterIds(group, quest).some((characterId) => sameId(characterId, player.characterId)))
    .map((quest) => {
      const claimed = groupQuestClaimedCharacterIds(quest).has(player.characterId);
      const status = claimed || quest.status === 'complete' ? 'complete' : quest.status;
      return questSnapshotEntry(quest.questId, status, quest.progress, 'group', { claimed });
    });
}

async function sendQuestSnapshot(player) {
  const result = await db.query(
    'SELECT quest_id, status, progress FROM character_quests WHERE character_id = $1 ORDER BY quest_id',
    [player.characterId]
  );
  const solo = result.rows.map((row) => questSnapshotEntry(row.quest_id, row.status, row.progress, 'solo'));
  const group = player.groupId && groups.get(player.groupId);
  send(player.socket, 'questSnapshot', { quests: solo.concat(group ? getGroupQuestState(group, player) : []) });
}

function sendGroupQuestSnapshots(group) {
  groupMembers(group).forEach((member) => sendQuestSnapshot(member).catch((error) => console.error('[group quest snapshot]', error)));
}

async function handleRegister(socket, message) {
  const username = cleanText(message.username, 20);
  const password = String(message.password || '');
  if (!validUsername(username)) {
    return sendError(socket, 'invalid_username', 'Le pseudo doit contenir 3 à 20 caractères : lettres, chiffres ou _.');
  }
  if (password.length < 8 || password.length > 72) {
    return sendError(socket, 'invalid_password', 'Le mot de passe doit contenir entre 8 et 72 caractères.');
  }
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    await db.query('INSERT INTO users (username, password_hash) VALUES ($1, $2)', [username, passwordHash]);
    send(socket, 'registered', { message: 'Compte créé. Connecte-toi pour continuer.' });
  } catch (error) {
    if (error && error.code === '23505') return sendError(socket, 'username_taken', 'Ce pseudo est déjà utilisé.');
    console.error('[register]', error);
    sendError(socket, 'server_error', 'Impossible de créer le compte actuellement.');
  }
}

async function handleLogin(socket, message) {
  if (socket.account) return sendError(socket, 'already_logged_in', 'Cette connexion est déjà authentifiée.');
  const username = cleanText(message.username, 20);
  const password = String(message.password || '');
  try {
    const userResult = await db.query('SELECT id, username, password_hash FROM users WHERE username = $1', [username]);
    const user = userResult.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return sendError(socket, 'invalid_login', 'Pseudo ou mot de passe incorrect.');
    }
    socket.account = { id: asId(user.id), username: user.username };
    const characterResult = await db.query(
      `SELECT id, name, class_id, appearance, level, experience, gold, current_hp, current_mp, persistent_states, param_bonuses, map_id, map_x, map_y, direction
       FROM characters WHERE user_id = $1 ORDER BY created_at ASC`,
      [user.id]
    );
    send(socket, 'loginSuccess', {
      account: { username: user.username },
      classes: Object.keys(CLASSES).map(publicClassData),
      characters: characterResult.rows.map(profileForCharacter)
    });
  } catch (error) {
    console.error('[login]', error);
    sendError(socket, 'server_error', 'Connexion impossible pour le moment.');
  }
}

async function handleCreateCharacter(socket, message) {
  if (!socket.account) return sendError(socket, 'not_authenticated', 'Connecte-toi d’abord.');
  const name = cleanText(message.name, 24);
  const classId = cleanText(message.classId, 20).toLocaleLowerCase();
  const appearance = normalizeAppearance(message.appearance);
  if (!validCharacterName(name)) {
    return sendError(socket, 'invalid_character_name', 'Le nom doit contenir entre 3 et 24 caractères.');
  }
  if (!CLASSES[classId]) return sendError(socket, 'invalid_class', 'Classe inconnue.');
  if (!appearance) return sendError(socket, 'invalid_appearance', 'Apparence invalide : choisis un profil Generator, une couleur de peau et des variantes autorisées.');
  try {
    const countResult = await db.query('SELECT COUNT(*)::int AS count FROM characters WHERE user_id = $1', [socket.account.id]);
    if (countResult.rows[0].count >= MAX_CHARACTERS_PER_ACCOUNT) {
      return sendError(socket, 'character_limit', 'Maximum de ' + MAX_CHARACTERS_PER_ACCOUNT + ' personnages atteint.');
    }
    const result = await db.query(
      `INSERT INTO characters (user_id, name, class_id, appearance, map_id, map_x, map_y, direction)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
       RETURNING id, name, class_id, appearance, level, experience, gold, current_hp, current_mp, persistent_states, param_bonuses, map_id, map_x, map_y, direction`,
      [socket.account.id, name, classId, JSON.stringify(appearance), START_POSITION.mapId, START_POSITION.x, START_POSITION.y, START_POSITION.direction]
    );
    await seedStarterItems(result.rows[0].id, classId, true);
    send(socket, 'characterCreated', { character: profileForCharacter(result.rows[0]) });
  } catch (error) {
    if (error && error.code === '23505') return sendError(socket, 'character_name_taken', 'Ce nom de personnage est déjà utilisé.');
    console.error('[createCharacter]', error);
    sendError(socket, 'server_error', 'Création du personnage impossible.');
  }
}

async function handleDeleteCharacter(socket, message) {
  if (!socket.account) return sendError(socket, 'not_authenticated', 'Connecte-toi d’abord.');
  const characterId = cleanText(message.characterId, 32);
  if (!/^\d+$/.test(characterId)) return sendError(socket, 'invalid_character', 'Personnage invalide.');
  if (socket.player && sameId(socket.player.characterId, characterId)) {
    return sendError(socket, 'character_active', 'Quitte ce personnage avant de le supprimer.');
  }
  if (onlineByCharacterId.has(asId(characterId))) {
    return sendError(socket, 'character_online', 'Ce personnage est connecté et ne peut pas être supprimé.');
  }
  try {
    // A guild leader is intentionally protected: deleting it would leave a
    // foreign-key orphan. Transfer leadership or dissolve the guild first.
    const leader = await db.query('SELECT id FROM guilds WHERE leader_character_id = $1 LIMIT 1', [characterId]);
    if (leader.rows.length) return sendError(socket, 'guild_leader_delete_blocked', 'Transfère la direction ou dissous la guilde avant de supprimer ce personnage.');
    const result = await db.query(
      'DELETE FROM characters WHERE id = $1 AND user_id = $2 RETURNING id, name',
      [characterId, socket.account.id]
    );
    const character = result.rows[0];
    if (!character) return sendError(socket, 'character_not_found', 'Personnage introuvable.');
    send(socket, 'characterDeleted', { characterId: asId(character.id), name: character.name });
  } catch (error) {
    console.error('[deleteCharacter]', error);
    sendError(socket, 'server_error', 'Suppression du personnage impossible.');
  }
}

async function handleSelectCharacter(socket, message) {
  if (!socket.account) return sendError(socket, 'not_authenticated', 'Connecte-toi d’abord.');
  const characterId = cleanText(message.characterId, 32);
  if (!/^\d+$/.test(characterId)) return sendError(socket, 'invalid_character', 'Personnage invalide.');
  try {
    const result = await db.query(
      `SELECT id, name, class_id, appearance, level, experience, gold, current_hp, current_mp, persistent_states, param_bonuses, map_id, map_x, map_y, direction
       FROM characters WHERE id = $1 AND user_id = $2`,
      [characterId, socket.account.id]
    );
    const character = result.rows[0];
    if (!character) return sendError(socket, 'character_not_found', 'Personnage introuvable.');
    // Existing characters from before the inventory module receive the same starter kit
    // once, on their first selection after this migration.
    await ensureStarterInventory(character.id, character.class_id);
    const equipment = await loadEquipment(character.id);
    const guildMembership = await loadGuildMembership(character.id);

    if (socket.player) {
      cancelTradeForPlayer(socket.player, 'Échange annulé : le joueur a changé de personnage.');
      removePlayerFromBattleLobbies(socket.player, 'Le créateur a changé de personnage.');
      closeAuctionSession(socket.player, 'Session de l’hôtel des ventes fermée : personnage changé.', false);
      closeNpcServiceSession(socket.player, 'Session du PNJ fermée : personnage changé.', false);
      leaveWorld(socket.player);
      onlineByCharacterId.delete(socket.player.characterId);
      detachFromGroup(socket.player);
    }
    const alreadyConnected = onlineByCharacterId.get(asId(character.id));
    if (alreadyConnected && alreadyConnected.socket !== socket) {
      sendError(socket, 'character_online', 'Ce personnage est déjà connecté.');
      return;
    }

    const player = {
      socket,
      accountId: socket.account.id,
      characterId: asId(character.id),
      name: character.name,
      classId: character.class_id,
      appearance: character.appearance || null,
      level: character.level,
      experience: character.experience,
      gold: character.gold,
      currentHp: character.current_hp,
      currentMp: character.current_mp,
      persistentStates: normalizePersistentStates(character.persistent_states),
      paramBonuses: normalizeParamBonuses(character.param_bonuses),
      mapId: character.map_id,
      x: character.map_x,
      y: character.map_y,
      direction: character.direction,
      moveSpeed: 4,
      instanceId: null,
      groupId: null,
      pendingGroupId: null,
      guildId: guildMembership ? guildMembership.guildId : null,
      guildName: guildMembership ? guildMembership.guildName : null,
      guildRole: guildMembership ? guildMembership.guildRole : null,
      battleId: null,
      battleExitPending: false,
      tradeId: null,
      auctionSessionId: null,
      npcServiceSessionId: null,
      equipment,
      lastMoveAt: 0,
      lastChatAt: 0,
      lastSavedAt: 0,
      dirty: false
    };
    applyVitals(player);
    if (character.current_hp === null || character.current_hp === undefined || character.current_mp === null || character.current_mp === undefined) {
      await persistVitals(player);
    }
    socket.player = player;
    onlineByCharacterId.set(player.characterId, player);

    send(socket, 'characterSelected', { character: publicPlayer(player), classData: publicClassData(player.classId) });
    joinWorld(player);
    await sendQuestSnapshot(player);
    await sendInventorySnapshot(player);
    await sendGuildSnapshot(player);
    send(socket, 'enterWorld', {
      mapId: player.mapId, x: player.x, y: player.y, direction: player.direction,
      instanceId: null
    });
  } catch (error) {
    console.error('[selectCharacter]', error);
    sendError(socket, 'server_error', 'Chargement du personnage impossible.');
  }
}

function handleMove(socket, message) {
  const player = socket.player;
  if (!player) return sendError(socket, 'no_character', 'Sélectionne un personnage.');
  if (player.battleId) return sendError(socket, 'in_battle', 'Déplacement impossible pendant le combat.');
  if (now() - player.lastMoveAt < MOVE_INTERVAL_MS) return;
  const x = integer(message.x);
  const y = integer(message.y);
  const direction = integer(message.direction);
  const requestedMoveSpeed = integer(message.moveSpeed);
  if (!validPosition(player.mapId, x, y, direction)) return;
  const pendingTrade = player.tradeId && trades.get(player.tradeId);
  if (pendingTrade && pendingTrade.state === 'finalizing') {
    return sendError(socket, 'trade_finalizing', 'Attends la fin de la transaction d’échange.');
  }

  // This is a first anti-teleport boundary. Collision/path validation belongs to the
  // map-aware movement service added with authoritative NPCs in the next milestone.
  const jump = Math.max(Math.abs(player.x - x), Math.abs(player.y - y));
  if (jump > 3) return sendError(socket, 'invalid_move', 'Déplacement trop important.');

  player.lastMoveAt = now();
  player.x = x;
  player.y = y;
  player.direction = direction;
  // Visual-only movement speed is forwarded so remote clients match native
  // walking versus dashing. It never alters server validation or coordinates.
  player.moveSpeed = requestedMoveSpeed >= 1 && requestedMoveSpeed <= 6 ? requestedMoveSpeed : 4;
  const currentTrade = player.tradeId && trades.get(player.tradeId);
  if (currentTrade && !playersCanTrade(player, tradePartner(currentTrade, player.characterId))) {
    cancelTrade(currentTrade, 'Échange annulé : les joueurs ne sont plus côte à côte.');
  }
  invalidateAuctionForMovement(player);
  invalidateNpcServiceForMovement(player);
  queueSave(player);
  broadcastToWorld(player, 'playerMoved', {
    characterId: player.characterId, x: player.x, y: player.y, direction: player.direction, moveSpeed: player.moveSpeed
  }, player.characterId);
}

function handleTransfer(socket, message) {
  const player = socket.player;
  if (!player) return sendError(socket, 'no_character', 'Sélectionne un personnage.');
  if (player.battleId) return sendError(socket, 'in_battle', 'Transfert impossible pendant le combat.');
  const mapId = integer(message.mapId);
  const x = integer(message.x);
  const y = integer(message.y);
  const direction = integer(message.direction);
  const requestedInstanceId = message.instanceId ? cleanText(message.instanceId, 80) : null;
  if (!validPosition(mapId, x, y, direction)) return sendError(socket, 'invalid_transfer', 'Destination invalide.');

  let instanceId = null;
  if (requestedInstanceId) {
    const instance = instances.get(requestedInstanceId);
    if (!instance || !instance.memberIds.has(player.characterId) || instance.templateMapId !== mapId) {
      return sendError(socket, 'invalid_instance', 'Cette instance n’est pas accessible.');
    }
    instanceId = instance.id;
  }

  const pendingTrade = player.tradeId && trades.get(player.tradeId);
  if (pendingTrade && pendingTrade.state === 'finalizing') {
    return sendError(socket, 'trade_finalizing', 'Attends la fin de la transaction d’échange.');
  }
  cancelTradeForPlayer(player, 'Échange annulé : un joueur a changé de zone.');
  removePlayerFromBattleLobbies(player, 'Un membre a changé de zone.');
  closeAuctionSession(player, 'Session de l’hôtel des ventes fermée : changement de zone.');
  closeNpcServiceSession(player, 'Session du PNJ fermée : changement de zone.');
  leaveWorld(player);
  player.mapId = mapId;
  player.x = x;
  player.y = y;
  player.direction = direction;
  player.instanceId = instanceId;
  queueSave(player);
  joinWorld(player);
}

function handleChat(socket, message) {
  const player = socket.player;
  if (!player) return sendError(socket, 'no_character', 'Sélectionne un personnage.');
  if (now() - player.lastChatAt < CHAT_INTERVAL_MS) return;
  const text = cleanText(message.text, MAX_MESSAGE_LENGTH);
  const scope = cleanText(message.scope || 'global', 12).toLowerCase();
  if (!text) return;
  if (['global', 'local', 'group', 'guild'].indexOf(scope) === -1) return sendError(socket, 'invalid_chat_scope', 'Canal inconnu.');
  if (scope === 'group' && !player.groupId) return sendError(socket, 'not_in_group', 'Tu n’es pas dans un groupe.');
  if (scope === 'guild' && !player.guildId) return sendError(socket, 'not_in_guild', 'Tu n’appartiens à aucune guilde.');

  player.lastChatAt = now();
  const packet = { from: publicPlayer(player), scope, text, sentAt: new Date().toISOString() };
  if (scope === 'global') return broadcastAll('chat', packet);
  if (scope === 'local') return broadcastToWorld(player, 'chat', packet);
  if (scope === 'guild') {
    return onlineByCharacterId.forEach((member) => {
      if (sameId(member.guildId, player.guildId)) send(member.socket, 'chat', packet);
    });
  }
  const group = groups.get(player.groupId);
  if (group) groupMembers(group).forEach((member) => send(member.socket, 'chat', packet));
}

function handleGroupInvite(socket, message) {
  const player = socket.player;
  if (!player) return sendError(socket, 'no_character', 'Sélectionne un personnage.');
  const target = getPlayerByName(message.targetName);
  if (!target) return sendError(socket, 'target_offline', 'Ce joueur est hors ligne.');
  if (sameId(target.characterId, player.characterId)) return sendError(socket, 'cannot_invite_self', 'Tu ne peux pas t’inviter.');
  if (target.groupId || target.pendingGroupId) return sendError(socket, 'target_in_group', 'Ce joueur a déjà un groupe ou une invitation.');
  const group = ensureGroupFor(player);
  if (group.memberIds.size + group.pendingCharacterIds.size >= MAX_GROUP_MEMBERS) return sendError(socket, 'group_full', 'Un groupe est limité à ' + MAX_GROUP_MEMBERS + ' joueurs.');
  group.pendingCharacterIds.add(target.characterId);
  target.pendingGroupId = group.id;
  send(target.socket, 'groupInvite', { groupId: group.id, from: publicPlayer(player) });
  send(player.socket, 'notification', { message: 'Invitation envoyée à ' + target.name + '.' });
  sendGroupUpdate(group);
}

async function handleGroupResponse(socket, message) {
  const player = socket.player;
  if (!player) return sendError(socket, 'no_character', 'Sélectionne un personnage.');
  const groupId = cleanText(message.groupId, 80);
  const accepted = message.accepted === true;
  const group = groups.get(groupId);
  if (!group || !player.pendingGroupId || player.pendingGroupId !== groupId || !group.pendingCharacterIds.has(player.characterId)) {
    return sendError(socket, 'invite_expired', 'Cette invitation n’est plus valide.');
  }
  group.pendingCharacterIds.delete(player.characterId);
  player.pendingGroupId = null;
  if (accepted) {
    player.groupId = group.id;
    group.memberIds.add(player.characterId);
    send(player.socket, 'notification', { message: 'Tu as rejoint le groupe.' });
  } else {
    send(player.socket, 'notification', { message: 'Invitation refusée.' });
  }
  sendGroupUpdate(group);
  if (accepted) await sendQuestSnapshot(player);
  deleteGroupIfEmpty(group);
}

async function handleGroupLeave(socket) {
  const player = socket.player;
  if (!player || !player.groupId) return sendError(socket, 'not_in_group', 'Tu n’es pas dans un groupe.');
  detachFromGroup(player);
  send(player.socket, 'groupUpdate', { group: null });
  await sendQuestSnapshot(player);
  send(player.socket, 'notification', { message: 'Tu as quitté le groupe.' });
}

function normalizedQuestReward(value) {
  const source = value || {};
  const lootByItemId = {};
  (source.loot || []).forEach((entry) => {
    const itemId = cleanText(entry && entry.itemId, 80);
    const quantity = Math.max(0, Math.floor(Number(entry && entry.quantity || 0)));
    if (!itemId || !quantity || !itemDefinition(itemId)) return;
    lootByItemId[itemId] = (lootByItemId[itemId] || 0) + quantity;
  });
  return {
    experience: Math.max(0, Math.floor(Number(source.experience || 0))),
    gold: Math.max(0, Math.floor(Number(source.gold || 0))),
    loot: Object.keys(lootByItemId).sort().map((itemId) => ({ itemId, quantity: lootByItemId[itemId] }))
  };
}

function questTurnInReward(definition, nativeRewards) {
  const parsed = normalizedQuestReward(nativeRewards);
  const hasNativeCommands = !!(nativeRewards && Array.isArray(nativeRewards.commandIndexes) && nativeRewards.commandIndexes.length);
  if (definition && definition.native) {
    if (!hasNativeCommands) return { error: ['quest_reward_missing', 'Ajoute les commandes natives Modifier l’or, Modifier l’EXP ou Modifier les objets juste après MMO NPC_ACTION quest_turn_in.'] };
    return { reward: parsed };
  }
  // Existing content.js quests keep their old reward only until their event is
  // migrated. An authored native reward sequence always takes precedence.
  return { reward: hasNativeCommands ? parsed : normalizedQuestReward(definition && definition.reward) };
}

async function applyQuestReward(client, player, reward) {
  const character = await client.query(
    `UPDATE characters SET experience = experience + $1, gold = gold + $2, updated_at = NOW()
     WHERE id = $3 RETURNING experience, gold`,
    [Number(reward.experience || 0), Number(reward.gold || 0), player.characterId]
  );
  for (const loot of reward.loot || []) {
    await client.query(
      `INSERT INTO character_inventory (character_id, item_id, quantity, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (character_id, item_id)
       DO UPDATE SET quantity = character_inventory.quantity + EXCLUDED.quantity, updated_at = NOW()`,
      [player.characterId, loot.itemId, loot.quantity]
    );
  }
  return character.rows[0] || null;
}

function questRewardMessage(reward) {
  const parts = [];
  if (Number(reward.experience || 0)) parts.push('+' + Number(reward.experience) + ' EXP');
  if (Number(reward.gold || 0)) parts.push('+' + Number(reward.gold) + ' or');
  (reward.loot || []).forEach((loot) => {
    const item = itemDefinition(loot.itemId);
    if (item) parts.push('+' + item.label + ' ×' + Number(loot.quantity));
  });
  return parts.length ? parts.join(', ') : 'récompense validée';
}

async function progressSoloQuest(player, definition, amount) {
  const currentResult = await db.query(
    'SELECT status, progress FROM character_quests WHERE character_id = $1 AND quest_id = $2',
    [player.characterId, definition.id]
  );
  const current = currentResult.rows[0];
  if (!current || current.status !== 'active') return null;
  const progress = Math.min(definition.goal, Number(current.progress) + Math.max(1, Number(amount || 1)));
  const objectiveComplete = progress >= definition.goal;
  const update = {
    questId: definition.id, title: definition.title, progress, goal: definition.goal, mode: 'solo',
    completed: objectiveComplete, readyToTurnIn: objectiveComplete, reward: null
  };
  if (objectiveComplete) {
    // Completing an objective is not a reward claim. Keep the quest pending
    // until the player returns to a verified quest giver branch.
    await db.query(
      `UPDATE character_quests SET status = 'ready', progress = $1, updated_at = NOW()
       WHERE character_id = $2 AND quest_id = $3`,
      [progress, player.characterId, definition.id]
    );
  } else {
    await db.query(
      `UPDATE character_quests SET progress = $1, updated_at = NOW()
       WHERE character_id = $2 AND quest_id = $3`,
      [progress, player.characterId, definition.id]
    );
  }
  return update;
}

async function progressGroupQuest(group, definition, contributor, amount) {
  const quest = group && group.quests.get(definition.id);
  if (!quest || quest.status !== 'active' || !contributor) return null;
  const eligible = groupQuestEligibleCharacterIds(group, quest);
  if (!eligible.some((characterId) => sameId(characterId, contributor.characterId))) return null;
  quest.progress = Math.min(Number(quest.goal), Number(quest.progress) + Math.max(1, Number(amount || 1)));
  const objectiveComplete = quest.progress >= quest.goal;
  const update = {
    questId: definition.id, title: definition.title, progress: quest.progress, goal: quest.goal, mode: 'group',
    completed: objectiveComplete, readyToTurnIn: objectiveComplete, reward: null
  };
  if (objectiveComplete) quest.status = 'ready';
  sendGroupQuestSnapshots(group);
  return update;
}

// Progress is called only by an authoritative server event (loot or a
// validated encounter result), never by a client-supplied quest counter.
async function progressQuestForPlayer(player, questId, amount) {
  const definition = questDefinitionForId(questId);
  if (!player || !definition) return [];
  const updates = [];
  const solo = await progressSoloQuest(player, definition, amount);
  if (solo) updates.push(solo);
  const group = player.groupId && groups.get(player.groupId);
  const shared = await progressGroupQuest(group, definition, player, amount);
  if (shared) updates.push(shared);
  return updates;
}

async function progressCollectionQuestFromLoot(player, itemId, quantity) {
  const definitions = allQuestDefinitions();
  const matching = Object.keys(definitions).filter((questId) => {
    const objective = definitions[questId] && definitions[questId].objective;
    return objective && objective.type === 'collect' && objective.itemId === itemId;
  });
  const updates = [];
  for (const questId of matching) {
    const result = await progressQuestForPlayer(player, questId, quantity);
    result.forEach((entry) => updates.push(entry));
  }
  return updates;
}

async function startQuestFromNpc(player, questId, mode, resolvedDefinition) {
  const definition = resolvedDefinition || questDefinitionForId(questId);
  if (!definition) return { error: ['quest_unknown', 'Quête inconnue.'] };
  if (['solo', 'group'].indexOf(mode) === -1 || !Array.isArray(definition.allowedModes) || definition.allowedModes.indexOf(mode) === -1) {
    return { error: ['quest_mode_invalid', 'Le mode indiqué dans la branche PNJ ne correspond pas à cette quête.'] };
  }
  if (mode === 'group') {
    if (!player.groupId) return { error: ['group_required', 'Cette quête requiert un groupe.'] };
    const group = groups.get(player.groupId);
    if (!group) return { error: ['group_required', 'Le groupe n’est plus disponible.'] };
    const existing = group.quests.get(questId);
    if (!existing) {
      // Only the members present when the common quest is accepted can claim
      // its reward. A player invited after completion cannot farm a hand-in.
      group.quests.set(questId, {
        questId, goal: definition.goal, progress: 0, status: 'active',
        eligibleCharacterIds: new Set(group.memberIds), claimedCharacterIds: new Set()
      });
      sendGroupQuestSnapshots(group);
      return { message: 'Quête de groupe commencée : ' + definition.title + '.' };
    }
    if (existing.status === 'ready') {
      if (groupQuestClaimedCharacterIds(existing).has(player.characterId)) return { message: 'Tu as déjà rendu cette quête de groupe.' };
      return { message: 'Objectif atteint : parle au donneur de quête pour remettre ta récompense.' };
    }
    if (existing.status === 'complete') return { message: 'Cette quête de groupe a déjà été rendue.' };
    return { message: 'Cette quête de groupe est déjà active.' };
  }
  const existing = await db.query(
    'SELECT status, progress FROM character_quests WHERE character_id = $1 AND quest_id = $2',
    [player.characterId, questId]
  );
  const row = existing.rows[0];
  if (row) {
    if (row.status === 'ready') return { message: 'Objectif atteint : parle au donneur de quête pour remettre ta récompense.' };
    if (row.status === 'complete') return { message: 'Cette quête a déjà été rendue.' };
    return { message: 'Cette quête est déjà active.' };
  }
  await db.query(
    `INSERT INTO character_quests (character_id, quest_id, status, progress)
     VALUES ($1, $2, 'active', 0)`,
    [player.characterId, questId]
  );
  await sendQuestSnapshot(player);
  return { message: 'Quête commencée : ' + definition.title + '.' };
}

async function turnInSoloQuestAtNpc(player, definition, reward) {
  const result = await inTransaction(async (client) => {
    const current = await client.query(
      'SELECT status, progress FROM character_quests WHERE character_id = $1 AND quest_id = $2 FOR UPDATE',
      [player.characterId, definition.id]
    );
    const quest = current.rows[0];
    if (!quest) return { error: ['quest_not_active', 'Cette quête n’est pas active pour ce personnage.'] };
    if (quest.status === 'complete') return { error: ['quest_already_turned_in', 'Cette quête a déjà été rendue.'] };
    if (quest.status !== 'ready' || Number(quest.progress) < Number(definition.goal)) {
      return { error: ['quest_not_ready', 'L’objectif de cette quête n’est pas encore terminé.'] };
    }
    const claimed = await client.query(
      `UPDATE character_quests SET status = 'complete', updated_at = NOW()
       WHERE character_id = $1 AND quest_id = $2 AND status = 'ready'
       RETURNING quest_id`,
      [player.characterId, definition.id]
    );
    if (!claimed.rows[0]) return { error: ['quest_claim_conflict', 'La remise de cette quête vient déjà d’être traitée.'] };
    return { reward, character: await applyQuestReward(client, player, reward) };
  });
  if (result.error) return result;
  if (result.character) {
    player.experience = result.character.experience;
    player.gold = result.character.gold;
  }
  await Promise.all([sendQuestSnapshot(player), sendInventorySnapshot(player)]);
  return { mode: 'solo', message: 'Quête rendue : ' + questRewardMessage(result.reward) + '.' };
}

function groupQuestCanBeTurnedInBy(player, definition) {
  const group = player.groupId && groups.get(player.groupId);
  const quest = group && group.quests.get(definition.id);
  if (!group || !quest || quest.status !== 'ready' || Number(quest.progress) < Number(definition.goal)) return false;
  const eligible = groupQuestEligibleCharacterIds(group, quest);
  return eligible.some((characterId) => sameId(characterId, player.characterId)) && !groupQuestClaimedCharacterIds(quest).has(player.characterId);
}

async function turnInGroupQuestAtNpc(player, definition, reward) {
  const group = player.groupId && groups.get(player.groupId);
  if (!group) return { error: ['group_required', 'Cette quête de groupe nécessite encore ton groupe actif.'] };
  const quest = group.quests.get(definition.id);
  if (!quest) return { error: ['quest_not_active', 'Cette quête de groupe n’est pas active.'] };
  const eligible = groupQuestEligibleCharacterIds(group, quest);
  if (!eligible.some((characterId) => sameId(characterId, player.characterId))) {
    return { error: ['quest_group_not_eligible', 'Tu ne participais pas à cette quête de groupe.'] };
  }
  if (quest.status === 'complete') return { error: ['quest_already_turned_in', 'Cette quête de groupe a déjà été rendue.'] };
  if (quest.status !== 'ready' || Number(quest.progress) < Number(definition.goal)) {
    return { error: ['quest_not_ready', 'L’objectif de cette quête de groupe n’est pas encore terminé.'] };
  }
  const claimed = groupQuestClaimedCharacterIds(quest);
  if (claimed.has(player.characterId)) return { error: ['quest_already_turned_in', 'Tu as déjà rendu cette quête de groupe.'] };

  // Reserve this individual claim before the asynchronous transaction. Two
  // simultaneous conversations cannot reward this same character twice.
  claimed.add(player.characterId);
  quest.claimedCharacterIds = claimed;
  let character;
  try {
    character = await inTransaction((client) => applyQuestReward(client, player, reward));
  } catch (error) {
    claimed.delete(player.characterId);
    throw error;
  }
  if (character) {
    player.experience = character.experience;
    player.gold = character.gold;
  }

  const everyoneClaimed = eligible.length > 0 && eligible.every((characterId) => claimed.has(characterId));
  if (everyoneClaimed) quest.status = 'complete';
  sendGroupQuestSnapshots(group);
  await sendInventorySnapshot(player);
  return { mode: 'group', message: 'Récompense de quête reçue : ' + questRewardMessage(reward) + '.' };
}

async function readySoloTurnIn(player, definition) {
  const result = await db.query(
    'SELECT status, progress FROM character_quests WHERE character_id = $1 AND quest_id = $2',
    [player.characterId, definition.id]
  );
  const quest = result.rows[0];
  return !!(quest && quest.status === 'ready' && Number(quest.progress) >= Number(definition.goal));
}

async function turnInQuestAtNpc(player, questId, mode, resolvedDefinition, nativeRewards) {
  const definition = resolvedDefinition || questDefinitionForId(questId);
  if (!definition) return { error: ['quest_unknown', 'Quête inconnue.'] };
  let resolvedMode = String(mode || '').toLowerCase();
  if (resolvedMode && ['solo', 'group'].indexOf(resolvedMode) === -1) {
    return { error: ['quest_mode_invalid', 'Le mode indiqué dans la branche de remise est invalide.'] };
  }
  if (!resolvedMode) {
    const candidates = [];
    if (definition.allowedModes.indexOf('solo') !== -1 && await readySoloTurnIn(player, definition)) candidates.push('solo');
    if (definition.allowedModes.indexOf('group') !== -1 && groupQuestCanBeTurnedInBy(player, definition)) candidates.push('group');
    if (candidates.length > 1) return { error: ['quest_turn_in_ambiguous', 'Cette quête est prête en solo et en groupe : utilise une branche de remise avec mode=solo ou mode=group.'] };
    if (!candidates.length) return { error: ['quest_not_ready', 'Aucune version prête de cette quête ne peut être rendue actuellement.'] };
    resolvedMode = candidates[0];
  }
  if (!Array.isArray(definition.allowedModes) || definition.allowedModes.indexOf(resolvedMode) === -1) {
    return { error: ['quest_mode_invalid', 'Le mode indiqué dans la branche de remise est invalide.'] };
  }
  const rewardResult = questTurnInReward(definition, nativeRewards);
  if (rewardResult.error) return rewardResult;
  return resolvedMode === 'group'
    ? turnInGroupQuestAtNpc(player, definition, rewardResult.reward)
    : turnInSoloQuestAtNpc(player, definition, rewardResult.reward);
}

async function handleQuestStart(socket) {
  const player = socket.player;
  if (!player) return sendError(socket, 'no_character', 'Sélectionne un personnage.');
  // Quests deliberately have no direct packet path. A real Map event must use
  // a verified <MMO npc-action=quest_start quest=... mode=...> branch.
  return sendError(socket, 'quest_npc_required', 'Les quêtes doivent être commencées auprès d’un donneur de quêtes.');
}

async function healAtNpc(player) {
  const outcome = await inTransaction(async (client) => {
    const result = await client.query(
      'SELECT current_hp, current_mp, persistent_states, param_bonuses FROM characters WHERE id = $1 FOR UPDATE',
      [player.characterId]
    );
    if (!result.rows[0]) return { error: ['character_not_found', 'Personnage introuvable.'] };
    const restored = vitalsFor(Object.assign({}, player, { currentHp: null, currentMp: null, persistentStates: [] }));
    await client.query(
      `UPDATE characters SET current_hp = $1, current_mp = $2, persistent_states = '[]'::jsonb, updated_at = NOW()
       WHERE id = $3`,
      [restored.hp, restored.mp, player.characterId]
    );
    return { health: restored };
  });
  if (outcome.error) return outcome;
  player.currentHp = outcome.health.hp;
  player.currentMp = outcome.health.mp;
  player.persistentStates = [];
  return { message: 'Repos terminé : tes PV, PM et états persistants sont restaurés gratuitement.' };
}

async function handleQuestProgress(socket) {
  const player = socket.player;
  if (!player) return sendError(socket, 'no_character', 'Sélectionne un personnage.');
  return sendError(socket, 'quest_progress_server_only', 'La progression de quête vient uniquement du butin ou d’un événement serveur validé.');
}

function handleDungeonEnter(socket, message) {
  const player = socket.player;
  if (!player) return sendError(socket, 'no_character', 'Sélectionne un personnage.');
  if (player.battleId) return sendError(socket, 'in_battle', 'Entrée de donjon impossible pendant le combat.');
  if (player.tradeId) return sendError(socket, 'trade_active', 'Termine ou annule l’échange avant d’entrer dans un donjon.');
  const dungeonId = cleanText(message.dungeonId, 64);
  const dungeon = DUNGEONS[dungeonId];
  if (!dungeon) return sendError(socket, 'dungeon_unknown', 'Donjon inconnu.');
  if (player.level < dungeon.minLevel) return sendError(socket, 'level_too_low', 'Niveau insuffisant.');

  const group = player.groupId && groups.get(player.groupId);
  const members = group ? groupMembers(group).filter((member) => worldKey(member) === worldKey(player)) : [player];
  const instance = {
    id: crypto.randomUUID(),
    dungeonId,
    templateMapId: dungeon.templateMapId,
    memberIds: new Set(members.map((member) => member.characterId)),
    createdAt: now()
  };
  instances.set(instance.id, instance);
  members.forEach((member) => {
    send(member.socket, 'enterInstance', {
      instanceId: instance.id,
      dungeonId,
      title: dungeon.title,
      mapId: dungeon.templateMapId,
      x: dungeon.spawn.x,
      y: dungeon.spawn.y,
      direction: dungeon.spawn.direction
    });
  });
}

function handleDungeonExit(socket) {
  const player = socket.player;
  if (!player || !player.instanceId) return sendError(socket, 'not_in_instance', 'Tu n’es pas dans un donjon.');
  if (player.battleId) return sendError(socket, 'in_battle', 'Sortie de donjon impossible pendant le combat.');
  const instance = instances.get(player.instanceId);
  const dungeon = instance && DUNGEONS[instance.dungeonId];
  if (!dungeon) return sendError(socket, 'instance_missing', 'Instance introuvable.');
  send(player.socket, 'exitInstance', Object.assign({ instanceId: instance.id }, dungeon.exit));
}

// ---------------------------------------------------------------------------
// Authoritative initiative combat. The client only submits an action choice;
// all turn order, MP costs, targets, damage, death and rewards live here.
// ---------------------------------------------------------------------------
const BATTLE_TURN_TIMEOUT_MS = 25000;

function combatStatsFor(player) {
  const classData = CLASSES[player.classId];
  // Native RPG Maker MV class parameter curves are the primary source. The
  // legacy values remain only as a safe fallback if data/ is unavailable.
  const nativeBase = mvCombat.statsForClass(player.classId, player.level);
  const base = nativeBase || (classData ? classData.baseStats : CLASSES.warrior.baseStats);
  const levelSteps = nativeBase ? 0 : Math.max(0, Number(player.level || 1) - 1);
  const equipment = equipmentBonuses(player);
  const growth = normalizeParamBonuses(player.paramBonuses);
  const rates = mvInventory.parameterRatesForStates(normalizePersistentStates(player.persistentStates));
  const raw = [
    Number(base.hp) + levelSteps * 18 + equipment.hp + growth[0],
    Number(base.mp) + levelSteps * 6 + equipment.mp + growth[1],
    Number(base.atk) + levelSteps * 3 + equipment.atk + growth[2],
    Number(base.def) + levelSteps * 2 + equipment.def + growth[3],
    Number(base.mat) + levelSteps * 3 + equipment.mat + growth[4],
    Number(base.mdf) + levelSteps * 2 + equipment.mdf + growth[5],
    Number(base.agi) + levelSteps + equipment.agi + growth[6],
    Number(base.luk || 0) + levelSteps + equipment.luk + growth[7]
  ].map((value, index) => Math.max(index < 2 ? 0 : 1, Math.floor(value * Number(rates[index] || 1))));
  return { hp: Math.max(1, raw[0]), mp: raw[1], atk: raw[2], def: raw[3], mat: raw[4], mdf: raw[5], agi: raw[6], luk: raw[7] };
}

function createPlayerBattler(player, consumables) {
  const stats = combatStatsFor(player);
  const vitals = vitalsFor(player);
  const classData = CLASSES[player.classId];
  return {
    id: player.characterId,
    kind: 'player',
    name: player.name,
    classId: player.classId,
    appearance: player.appearance || null,
    mvActorId: classData && classData.mv ? classData.mv.actorId : null,
    mvClassId: classData && classData.mv ? classData.mv.classId : null,
    level: player.level,
    stats,
    states: normalizePersistentStates(player.persistentStates),
    maxHp: stats.hp,
    hp: vitals.hp,
    maxMp: stats.mp,
    mp: vitals.mp,
    consumables: consumables || {},
    guarding: false
  };
}

function createEnemyBattler(template, index) {
  return {
    id: 'enemy_' + index + '_' + crypto.randomUUID().slice(0, 8),
    kind: 'enemy',
    templateId: template.templateId,
    mvEnemyId: template.mvEnemyId || null,
    name: template.name,
    level: template.level,
    stats: {
      hp: template.hp, mp: template.mp || 0, atk: template.atk, def: template.def,
      mat: template.mat || 0, mdf: template.mdf || 0, agi: template.agi
    },
    maxHp: template.hp,
    hp: template.hp,
    maxMp: template.mp || 0,
    mp: template.mp || 0,
    guarding: false
  };
}

function publicBattler(battler) {
  return {
    id: battler.id,
    kind: battler.kind,
    name: battler.name,
    classId: battler.classId || null,
    appearance: battler.appearance || null,
    mvActorId: battler.mvActorId || null,
    mvClassId: battler.mvClassId || null,
    mvEnemyId: battler.mvEnemyId || null,
    level: battler.level,
    stats: battler.stats || {},
    states: normalizePersistentStates(battler.states),
    hp: Math.max(0, battler.hp),
    maxHp: battler.maxHp,
    mp: Math.max(0, battler.mp),
    maxMp: battler.maxMp,
    guarding: !!battler.guarding,
    defeated: battler.hp <= 0
  };
}

function battlePlayers(battle) {
  return Array.from(battle.players.values());
}

function currentTurn(battle) {
  return battle.turnOrder[battle.turnIndex] || null;
}

function findTurnBattler(battle, turn) {
  if (!turn) return null;
  return turn.kind === 'player' ? battle.players.get(turn.id) : battle.enemies.find((enemy) => enemy.id === turn.id);
}

function livingPlayers(battle) {
  return battlePlayers(battle).filter((battler) => battler.hp > 0);
}

function livingEnemies(battle) {
  return battle.enemies.filter((battler) => battler.hp > 0);
}

function actionPacket(action, quantity) {
  return action ? {
    id: action.id, label: action.label, mpCost: Number(action.mpCost || 0),
    targetType: action.targetType, targetMode: action.targetMode || 'single',
    mvSkillId: action.mvSkillId || null, mvItem: action.mvItem || null,
    itemId: action.itemId || null, quantity: quantity === undefined ? null : Number(quantity)
  } : null;
}

function legacyClassActionsFor(battler) {
  return (CLASS_ACTIONS[battler.classId] || ['attack', 'guard'])
    .map((actionId) => BATTLE_ACTIONS[actionId]).filter(Boolean);
}

function battleActionsFor(battler, battle) {
  // Class learnings in data/Classes.json are the primary skill list. The old
  // content.js list only keeps existing worlds playable if the MV data folder
  // is unavailable to the server.
  const nativeClassActions = mvCombat.actionsForClass(battler.classId, battler.level);
  const classActions = nativeClassActions || legacyClassActionsFor(battler);
  const itemActions = Object.keys(BATTLE_ACTIONS).filter((actionId) => {
    const itemId = BATTLE_ACTIONS[actionId].itemId;
    return itemId && Number(battler.consumables[itemId] || 0) > 0;
  }).map((actionId) => BATTLE_ACTIONS[actionId]).filter(Boolean);
  const fleeAction = battle && battle.allowEscape ? [{ id: 'flee', label: 'Fuir', mpCost: 0, targetType: 'none', targetMode: 'self' }] : [];
  return classActions.map((action) => actionPacket(action))
    .concat(itemActions.map((action) => actionPacket(action, battler.consumables[action.itemId])))
    .concat(fleeAction.map((action) => actionPacket(action)));
}

function battleActionDefinitionFor(battler, actionId) {
  const nativeAction = mvCombat.actionForClass(battler.classId, battler.level, actionId);
  if (nativeAction) return nativeAction;
  const legacy = legacyClassActionsFor(battler).find((action) => action.id === actionId);
  if (legacy) return legacy;
  const item = BATTLE_ACTIONS[actionId];
  return item && item.itemId && Number(battler.consumables[item.itemId] || 0) > 0 ? item : null;
}

function serializeBattle(battle, viewerCharacterId) {
  const turn = currentTurn(battle);
  const myTurn = turn && turn.kind === 'player' && sameId(turn.id, viewerCharacterId);
  const ownBattler = battle.players.get(asId(viewerCharacterId));
  const actions = myTurn && ownBattler ? battleActionsFor(ownBattler, battle) : [];
  return {
    battleId: battle.id,
    title: battle.title,
    encounterId: battle.encounterId,
    mvTroopId: battle.mvTroopId || null,
    players: battlePlayers(battle).map(publicBattler),
    enemies: battle.enemies.map(publicBattler),
    turn: turn ? { kind: turn.kind, id: turn.id, name: findTurnBattler(battle, turn).name } : null,
    myTurn: !!myTurn,
    actions,
    expiresInMs: turn ? Math.max(0, BATTLE_TURN_TIMEOUT_MS - (now() - battle.turnStartedAt)) : 0,
    events: (battle.events || []).slice(-24),
    log: battle.log.slice(-8)
  };
}

function sendBattleState(battle) {
  battle.participantIds.forEach((characterId) => {
    const player = onlineByCharacterId.get(asId(characterId));
    if (player && player.battleId === battle.id) {
      send(player.socket, 'battleState', { battle: serializeBattle(battle, player.characterId) });
    }
  });
}

function addBattleLog(battle, text) {
  battle.log.push({ id: battle.log.length + 1, text: String(text) });
  if (battle.log.length > 30) battle.log.shift();
}

// Rendering events contain no game authority: clients only use them to play
// the native MV animation and refresh visible gauges after server resolution.
function addBattleEvent(battle, event) {
  battle.eventSequence = Number(battle.eventSequence || 0) + 1;
  battle.events.push(Object.assign({ id: battle.eventSequence }, event));
  if (battle.events.length > 60) battle.events.shift();
}

function randomInt(maxInclusive) {
  return Math.floor(Math.random() * (maxInclusive + 1));
}

function calculateDamage(attacker, target, type, power) {
  const attackStat = type === 'magical' ? attacker.stats.mat : attacker.stats.atk;
  const defenseStat = type === 'magical' ? target.stats.mdf : target.stats.def;
  const variance = 0.9 + Math.random() * 0.2;
  let amount = Math.floor((attackStat * Number(power || 1) - defenseStat * 0.42 + 4) * variance);
  let critical = false;
  if (Math.random() < 0.06) {
    amount = Math.floor(amount * 1.5);
    critical = true;
  }
  if (target.guarding) amount = Math.ceil(amount * 0.5);
  return { amount: Math.max(1, amount), critical };
}

function calculateHeal(caster, target, power) {
  const variance = 0.92 + Math.random() * 0.16;
  return Math.max(1, Math.floor((caster.stats.mat * Number(power || 1) + 12) * variance));
}

function resolveBattleResultIfNeeded(battle) {
  if (!livingEnemies(battle).length) {
    finishBattle(battle, 'victory').catch((error) => console.error('[battle finish]', error));
    return true;
  }
  if (!livingPlayers(battle).length) {
    finishBattle(battle, 'defeat').catch((error) => console.error('[battle finish]', error));
    return true;
  }
  return false;
}

function scheduleEnemyTurn(battle) {
  const turn = currentTurn(battle);
  if (!turn || turn.kind !== 'enemy' || battle.ending) return;
  setTimeout(() => runEnemyTurn(battle.id, turn.id), 700);
}

function advanceTurn(battle) {
  if (battle.ending || resolveBattleResultIfNeeded(battle)) return;
  for (let steps = 0; steps < battle.turnOrder.length; steps += 1) {
    battle.turnIndex = (battle.turnIndex + 1) % battle.turnOrder.length;
    const candidate = currentTurn(battle);
    const battler = findTurnBattler(battle, candidate);
    if (battler && battler.hp > 0) {
      battle.turnStartedAt = now();
      sendBattleState(battle);
      scheduleEnemyTurn(battle);
      return;
    }
  }
}

function nativeTargetsForAction(battle, actor, action, selectedTarget) {
  switch (action.targetMode) {
  case 'allEnemies': return livingEnemies(battle);
  case 'randomEnemy': {
    const targets = livingEnemies(battle);
    const rolls = [];
    for (let index = 0; index < Math.max(1, Number(action.randomCount || 1)); index += 1) {
      if (targets.length) rolls.push(targets[randomInt(targets.length - 1)]);
    }
    return rolls;
  }
  case 'allAllies': return livingPlayers(battle);
  case 'allDeadAllies': return battlePlayers(battle).filter((battler) => battler.hp <= 0);
  case 'self': return [actor];
  default: return selectedTarget ? [selectedTarget] : [];
  }
}

function resolveNativeSkill(battle, actor, action, selectedTarget) {
  const targets = nativeTargetsForAction(battle, actor, action, selectedTarget);
  const damage = action.damage || {};
  const damageType = Number(damage.type || 0);
  targets.forEach((target) => {
    let amount = mvCombat.applyVariance(mvCombat.formulaValue(damage.formula, actor, target), damage.variance);
    let critical = false;
    if ([1, 2, 5, 6].indexOf(damageType) !== -1 && damage.critical === true && Math.random() < 0.06) {
      amount *= 3;
      critical = true;
    }
    if ([1, 5].indexOf(damageType) !== -1) {
      amount = Math.max(0, amount);
      if (target.guarding) amount = Math.ceil(amount * 0.5);
      target.hp = Math.max(0, target.hp - amount);
      addBattleLog(battle, actor.name + ' utilise ' + action.label + ' sur ' + target.name + ' : ' + amount + ' dégâts' + (critical ? ' critiques' : '') + '.');
      addBattleEvent(battle, { type: 'damage', actorId: actor.id, targetId: target.id, actionId: action.id, mvSkillId: action.mvSkillId, amount, critical, defeated: target.hp <= 0 });
      if (target.hp <= 0) addBattleLog(battle, target.name + ' est vaincu.');
    } else if (damageType === 2 || damageType === 6) {
      amount = Math.max(0, amount);
      target.mp = Math.max(0, target.mp - amount);
      addBattleLog(battle, actor.name + ' utilise ' + action.label + ' sur ' + target.name + ' : ' + amount + ' MP retirés.');
      addBattleEvent(battle, { type: 'mp_damage', actorId: actor.id, targetId: target.id, actionId: action.id, mvSkillId: action.mvSkillId, amount });
    } else if (damageType === 3) {
      amount = Math.max(0, amount);
      const recovered = Math.min(amount, target.maxHp - target.hp);
      target.hp += recovered;
      addBattleLog(battle, actor.name + ' utilise ' + action.label + ' sur ' + target.name + ' et rend ' + recovered + ' PV.');
      addBattleEvent(battle, { type: 'heal', actorId: actor.id, targetId: target.id, actionId: action.id, mvSkillId: action.mvSkillId, amount: recovered });
    } else if (damageType === 4) {
      amount = Math.max(0, amount);
      const recovered = Math.min(amount, target.maxMp - target.mp);
      target.mp += recovered;
      addBattleLog(battle, actor.name + ' utilise ' + action.label + ' sur ' + target.name + ' et rend ' + recovered + ' MP.');
      addBattleEvent(battle, { type: 'mp_heal', actorId: actor.id, targetId: target.id, actionId: action.id, mvSkillId: action.mvSkillId, amount: recovered });
    } else {
      addBattleLog(battle, actor.name + ' utilise ' + action.label + '.');
      addBattleEvent(battle, { type: 'skill', actorId: actor.id, targetId: target.id, actionId: action.id, mvSkillId: action.mvSkillId });
    }
  });
}

function resolvePlayerAction(battle, actor, action, target, timedOut) {
  actor.guarding = false;
  if (action.mpCost > actor.mp) return false;
  actor.mp -= action.mpCost;

  if (action.kind === 'guard' || action.type === 'guard') {
    actor.guarding = true;
    addBattleLog(battle, actor.name + (timedOut ? ' n’a pas agi : il se défend.' : ' se met en défense.'));
    addBattleEvent(battle, { type: 'guard', actorId: actor.id, targetId: actor.id, actionId: action.id, mvSkillId: action.mvSkillId || null });
  } else if (action.kind === 'mv_skill') {
    resolveNativeSkill(battle, actor, action, target);
  } else if (action.type === 'heal' || action.type === 'item_heal') {
    const amount = action.type === 'item_heal' ? Number(action.recovery || 0) : calculateHeal(actor, target, action.power);
    const recovered = Math.min(amount, target.maxHp - target.hp);
    target.hp += recovered;
    addBattleLog(battle, actor.name + (action.type === 'item_heal' ? ' utilise ' : ' lance ') + action.label + ' sur ' + target.name + ' et rend ' + recovered + ' PV.');
    addBattleEvent(battle, {
      type: 'heal', actorId: actor.id, targetId: target.id, actionId: action.id,
      mvSkillId: action.mvSkillId || null, mvItem: action.mvItem || null, amount: recovered
    });
  } else {
    const hit = calculateDamage(actor, target, action.type, action.power);
    target.hp = Math.max(0, target.hp - hit.amount);
    addBattleLog(battle, actor.name + ' utilise ' + action.label + ' sur ' + target.name + ' : ' + hit.amount + ' dégâts' + (hit.critical ? ' critiques' : '') + '.');
    addBattleEvent(battle, {
      type: 'damage', actorId: actor.id, targetId: target.id, actionId: action.id,
      mvSkillId: action.mvSkillId || null, amount: hit.amount, critical: hit.critical, defeated: target.hp <= 0
    });
    if (target.hp <= 0) addBattleLog(battle, target.name + ' est vaincu.');
  }
  if (resolveBattleResultIfNeeded(battle)) return true;
  advanceTurn(battle);
  return true;
}

function runEnemyTurn(battleId, enemyId) {
  const battle = battles.get(battleId);
  if (!battle || battle.ending) return;
  const turn = currentTurn(battle);
  if (!turn || turn.kind !== 'enemy' || turn.id !== enemyId) return;
  const enemy = battle.enemies.find((candidate) => candidate.id === enemyId);
  const targets = livingPlayers(battle);
  if (!enemy || enemy.hp <= 0 || !targets.length) return advanceTurn(battle);
  const target = targets[randomInt(targets.length - 1)];
  const hit = calculateDamage(enemy, target, 'physical', 1);
  target.hp = Math.max(0, target.hp - hit.amount);
  addBattleLog(battle, enemy.name + ' attaque ' + target.name + ' : ' + hit.amount + ' dégâts' + (hit.critical ? ' critiques' : '') + '.');
  addBattleEvent(battle, {
    type: 'damage', actorId: enemy.id, targetId: target.id, actionId: 'attack',
    mvSkillId: BATTLE_ACTIONS.attack.mvSkillId || null, amount: hit.amount, critical: hit.critical, defeated: target.hp <= 0
  });
  if (target.hp <= 0) addBattleLog(battle, target.name + ' tombe au combat.');
  if (resolveBattleResultIfNeeded(battle)) return;
  advanceTurn(battle);
}

function rollLoot(lootTable) {
  return (lootTable || []).filter((entry) => itemDefinition(entry.itemId) && Math.random() < Number(entry.chance || 0))
    .map((entry) => ({ itemId: entry.itemId, quantity: Math.max(1, Number(entry.quantity || 1)) }));
}

async function finishBattle(battle, result) {
  if (!battle || battle.ending) return;
  battle.ending = true;
  const reward = result === 'victory' ? battle.rewards : { experience: 0, gold: 0 };
  const playerBattlers = battlePlayers(battle);
  const lootByCharacterId = new Map();
  const questUpdatesByCharacterId = new Map();
  if (result === 'victory') {
    await Promise.all(playerBattlers.map(async (battler) => {
      const updated = await db.query(
        `UPDATE characters SET experience = experience + $1, gold = gold + $2, updated_at = NOW()
         WHERE id = $3 RETURNING experience, gold`,
        [Number(reward.experience || 0), Number(reward.gold || 0), battler.id]
      );
      const loot = rollLoot(battle.lootTable);
      await Promise.all(loot.map((drop) => grantItem(battler.id, drop.itemId, drop.quantity)));
      lootByCharacterId.set(asId(battler.id), loot.map((drop) => itemSnapshot(drop.itemId, drop.quantity)));
      const online = onlineByCharacterId.get(asId(battler.id));
      const questUpdates = [];
      // Collection quests consume only this authoritative loot grant. Buying,
      // trading or holding an old item never advances their counter.
      if (online) {
        for (const drop of loot) {
          const collectionUpdates = await progressCollectionQuestFromLoot(online, drop.itemId, drop.quantity);
          collectionUpdates.forEach((update) => questUpdates.push(update));
        }
      }
      if (updated.rows[0]) {
        const newLevel = mvCombat.levelForExperience(battler.classId, updated.rows[0].experience, battler.level);
        if (newLevel !== Number(battler.level)) {
          await db.query('UPDATE characters SET level = $1, updated_at = NOW() WHERE id = $2', [newLevel, battler.id]);
          battler.level = newLevel;
        }
        if (online) {
          online.experience = updated.rows[0].experience;
          online.gold = updated.rows[0].gold;
          online.level = newLevel;
        }
      }
      if (online) {
        for (const progressRule of battle.questProgress || []) {
          const definition = QUESTS[progressRule.questId];
          const battleUpdate = definition && await progressSoloQuest(online, definition, progressRule.amount);
          if (battleUpdate) questUpdates.push(battleUpdate);
        }
      }
      questUpdatesByCharacterId.set(asId(battler.id), questUpdates);
    }));
    // A defeated shared target counts once for each represented group, not
    // once per member who happened to be in the same Scene_Battle. Collection
    // loot above remains per-member by design.
    for (const progressRule of battle.questProgress || []) {
      const definition = QUESTS[progressRule.questId];
      if (!definition) continue;
      const groupIds = {};
      playerBattlers.forEach((battler) => {
        const online = onlineByCharacterId.get(asId(battler.id));
        if (online && online.groupId) groupIds[online.groupId] = true;
      });
      for (const groupId of Object.keys(groupIds)) {
        const shared = await progressGroupQuest(groups.get(groupId), definition, progressRule.amount);
        if (!shared) continue;
        playerBattlers.forEach((battler) => {
          const online = onlineByCharacterId.get(asId(battler.id));
          if (online && sameId(online.groupId, groupId)) questUpdatesByCharacterId.get(asId(battler.id)).push(shared);
        });
      }
    }
    addBattleLog(battle, 'Victoire ! Chaque combattant reçoit ' + reward.experience + ' EXP et ' + reward.gold + ' or.');
  } else if (result === 'escape') {
    addBattleLog(battle, 'Le groupe prend la fuite.');
  } else {
    addBattleLog(battle, 'Défaite. Le groupe reprend ses esprits.');
  }

  // Health and MP now belong to the persistent character, not to the temporary
  // Scene_Battle actor. A defeat restores the group; otherwise a fallen winner
  // leaves the battle at 1 HP so the next native menu can heal them normally.
  await Promise.all(playerBattlers.map(async (battler) => {
    const hp = result === 'defeat' ? Number(battler.maxHp) : Math.max(1, Math.min(Number(battler.maxHp), Number(battler.hp)));
    const mp = result === 'defeat' ? Number(battler.maxMp) : Math.max(0, Math.min(Number(battler.maxMp), Number(battler.mp)));
    const states = hp > 0 ? normalizePersistentStates(battler.states).filter((stateId) => stateId !== 1) : normalizePersistentStates(battler.states);
    await db.query(
      'UPDATE characters SET current_hp = $1, current_mp = $2, persistent_states = $3::jsonb, updated_at = NOW() WHERE id = $4',
      [hp, mp, JSON.stringify(states), battler.id]
    );
    const online = onlineByCharacterId.get(asId(battler.id));
    if (online) {
      online.currentHp = hp;
      online.currentMp = mp;
      online.persistentStates = states;
    }
  }));

  battle.participantIds.forEach((characterId) => {
    const player = onlineByCharacterId.get(asId(characterId));
    if (!player || player.battleId !== battle.id) return;
    // Keep the battle lock until this specific client has confirmed the native
    // result window and returned to the map. This prevents a ready member from
    // launching another group encounter while a teammate still renders the
    // previous Scene_Battle.
    player.battleExitPending = true;
    send(player.socket, 'battleEnded', {
      battleId: battle.id,
      result,
      rewards: reward,
      loot: lootByCharacterId.get(asId(characterId)) || [],
      questUpdates: questUpdatesByCharacterId.get(asId(characterId)) || [],
      events: (battle.events || []).slice(-24),
      log: battle.log.slice(-8)
    });
    sendInventorySnapshot(player).catch((error) => console.error('[inventory after battle]', error));
    sendQuestSnapshot(player).catch((error) => console.error('[quest after battle]', error));
  });
  if (battle.worldMonster) {
    const context = battle.worldMonster;
    const current = worldMonsters.get(context.key);
    if (result === 'victory') {
      const state = Object.assign({}, context, {
        status: 'respawning', battleId: null, respawnAt: now() + Number(context.respawnMs || 0)
      });
      worldMonsters.set(context.key, state);
      broadcastMonsterState(state);
    } else if (current && current.status === 'in_battle' && current.battleId === battle.id) {
      clearMonsterState(context);
    }
  }
  battles.delete(battle.id);
}

function lobbySnapshot(lobby) {
  const memberIds = Array.from(lobby.memberIds);
  return {
    status: 'lobby', battleKey: lobby.battleKey, mapId: lobby.mapId, instanceId: lobby.instanceId || null,
    eventId: lobby.eventId, pageIndex: lobby.pageIndex, coop: lobby.coop,
    ownerCharacterId: lobby.ownerCharacterId,
    memberIds,
    // Names and the owner flag are display-only conveniences. The server still
    // revalidates map, range, group and battle state just before launch.
    members: memberIds.map((characterId) => {
      const member = onlineByCharacterId.get(asId(characterId));
      return {
        characterId,
        name: member ? member.name : 'Membre indisponible',
        isOwner: sameId(characterId, lobby.ownerCharacterId)
      };
    }),
    expiresAt: new Date(lobby.expiresAt).toISOString()
  };
}

function sendBattleLobbyClosed(lobby, reason) {
  if (!lobby) return;
  Array.from(lobby.memberIds).forEach((characterId) => {
    const member = onlineByCharacterId.get(asId(characterId));
    if (member) send(member.socket, 'battleLobbyClosed', { battleKey: lobby.battleKey, reason: reason || 'Lobby de combat fermé.' });
  });
}

function sendLobbyState(lobby, message) {
  Array.from(lobby.memberIds).forEach((characterId) => {
    const member = onlineByCharacterId.get(asId(characterId));
    if (member) send(member.socket, 'battleLobbyState', { lobby: lobbySnapshot(lobby), message: message || '' });
  });
}

function releaseBattleLobby(lobby, reason) {
  if (!lobby) return;
  battleLobbies.delete(lobby.monsterKey);
  const state = worldMonsters.get(lobby.monsterKey);
  if (state && state.status === 'lobby') {
    worldMonsters.delete(lobby.monsterKey);
    broadcastMonsterAvailable(lobby);
  }
  sendBattleLobbyClosed(lobby, reason);
}

function battleLobbyMembers(lobby) {
  return Array.from(lobby.memberIds)
    .map((characterId) => onlineByCharacterId.get(asId(characterId)))
    .filter((member) => member && sameId(member.groupId, lobby.groupId) && Number(member.mapId) === Number(lobby.mapId) &&
      (member.instanceId || null) === (lobby.instanceId || null) &&
      Math.max(Math.abs(Number(member.x) - Number(lobby.eventX)), Math.abs(Number(member.y) - Number(lobby.eventY))) <= NPC_SERVICE_RANGE_TILES &&
      !member.battleId && !member.battleExitPending);
}

function removePlayerFromBattleLobbies(player, reason) {
  if (!player) return;
  battleLobbies.forEach((lobby) => {
    if (!lobby.memberIds.has(player.characterId)) return;
    if (sameId(lobby.ownerCharacterId, player.characterId)) return releaseBattleLobby(lobby, reason || 'Le créateur a quitté le lobby de combat.');
    lobby.memberIds.delete(player.characterId);
    // The removed member no longer receives the shared lobby snapshot, so send
    // an explicit close packet to prevent a stale client panel after transfer,
    // group departure or disconnect handling.
    send(player.socket, 'battleLobbyClosed', { battleKey: lobby.battleKey, reason: reason || 'Tu as quitté le lobby de combat.' });
    sendLobbyState(lobby, player.name + ' a quitté le lobby de combat.');
  });
}

function verifyLobbyMonster(player, verified) {
  if (!battleEventInRange(player, verified)) return { error: ['encounter_too_far', 'Approche-toi du monstre pour interagir avec lui.'] };
  const configured = monsterContextForBattle(player, verified);
  if (configured.error) return configured;
  return configured;
}

// Small, request-scoped trace for configuration problems in native MV lobby
// branches. It deliberately logs only the verified action context and never
// passwords, session tokens or arbitrary packet bodies.
function logBattleLobby(stage, player, message, extra) {
  const eventContext = message && message.eventContext ? message.eventContext : {};
  console.log('[battle-lobby] ' + stage + ' ' + JSON.stringify(Object.assign({
    characterId: player ? player.characterId : null,
    character: player ? player.name : null,
    requestedKey: cleanText(message && message.battleKey, 32).toLowerCase(),
    mapId: Number(eventContext.mapId),
    eventId: Number(eventContext.eventId),
    pageIndex: Number(eventContext.pageIndex),
    commandIndex: Number(eventContext.commandIndex)
  }, extra || {})));
}

function handleBattleLobbyOpen(socket, message) {
  const player = socket.player;
  logBattleLobby('OPEN received', player, message);
  if (!player) return sendError(socket, 'no_character', 'Sélectionne un personnage.');
  if (player.battleId) return sendError(socket, 'in_battle', 'Impossible de préparer un combat pendant une bataille.');
  if (!player.groupId || !groups.has(player.groupId)) return sendError(socket, 'group_required', 'Crée ou rejoins un groupe pour préparer ce combat.');
  const battleKey = cleanText(message.battleKey, 32).toLowerCase();
  const verified = verifyTaggedBattleLobbyAction(message.eventContext, 'open', battleKey);
  if (!verified.ok) {
    logBattleLobby('OPEN refused by map verification', player, message, { code: verified.code, reason: verified.message });
    return sendError(socket, verified.code, verified.message);
  }
  logBattleLobby('OPEN map verification passed', player, message, {
    verifiedMapId: verified.mapId, verifiedEventId: verified.eventId, verifiedPageIndex: verified.pageIndex,
    verifiedCommandIndex: verified.lobbyCommandIndex, verifiedBattleCommandIndex: verified.commandIndex
  });
  const configured = verifyLobbyMonster(player, verified);
  if (configured.error) {
    logBattleLobby('OPEN refused by world state', player, message, { code: configured.error[0], reason: configured.error[1] });
    return sendError(socket, configured.error[0], configured.error[1]);
  }
  const context = configured.context;
  const existing = worldMonsters.get(context.key);
  if (existing) {
    const lobby = battleLobbies.get(context.key);
    if (existing.status === 'lobby' && lobby && sameId(lobby.groupId, player.groupId)) return sendBattleLobbyStateForPlayer(player, lobby, 'Ce combat de groupe est déjà en attente.');
    const unavailable = monsterUnavailableError(existing);
    return sendError(socket, unavailable[0], unavailable[1]);
  }
  const lobby = Object.assign({}, context, {
    monsterKey: context.key, groupId: player.groupId, ownerCharacterId: player.characterId,
    memberIds: new Set([player.characterId]), createdAt: now(), expiresAt: now() + BATTLE_LOBBY_TIMEOUT_MS,
    coop: verified.coop, troopId: verified.troopId
  });
  battleLobbies.set(context.key, lobby);
  const state = Object.assign({}, context, { status: 'lobby', groupId: player.groupId, ownerCharacterId: player.characterId, expiresAt: lobby.expiresAt });
  worldMonsters.set(context.key, state);
  broadcastMonsterState(state);
  sendLobbyState(lobby, 'Combat de groupe préparé. Les membres doivent cliquer ce même monstre pour rejoindre.');
}

function sendBattleLobbyStateForPlayer(player, lobby, message) {
  send(player.socket, 'battleLobbyState', { lobby: lobbySnapshot(lobby), message: message || '' });
}

function handleBattleLobbyJoin(socket, message) {
  const player = socket.player;
  logBattleLobby('JOIN received', player, message);
  if (!player) return sendError(socket, 'no_character', 'Sélectionne un personnage.');
  if (player.battleId || player.battleExitPending) return sendError(socket, 'in_battle', 'Termine ton combat avant de rejoindre ce groupe.');
  const battleKey = cleanText(message.battleKey, 32).toLowerCase();
  const verified = verifyTaggedBattleLobbyAction(message.eventContext, 'join', battleKey);
  if (!verified.ok) {
    logBattleLobby('JOIN refused by map verification', player, message, { code: verified.code, reason: verified.message });
    return sendError(socket, verified.code, verified.message);
  }
  logBattleLobby('JOIN map verification passed', player, message, {
    verifiedMapId: verified.mapId, verifiedEventId: verified.eventId, verifiedPageIndex: verified.pageIndex,
    verifiedCommandIndex: verified.lobbyCommandIndex, verifiedBattleCommandIndex: verified.commandIndex
  });
  const configured = verifyLobbyMonster(player, verified);
  if (configured.error) {
    logBattleLobby('JOIN refused by world state', player, message, { code: configured.error[0], reason: configured.error[1] });
    return sendError(socket, configured.error[0], configured.error[1]);
  }
  const context = configured.context;
  const lobby = battleLobbies.get(context.key);
  const state = worldMonsters.get(context.key);
  if (!lobby || !state || state.status !== 'lobby') {
    const unavailable = monsterUnavailableError(state);
    return sendError(socket, unavailable ? unavailable[0] : 'battle_lobby_missing', unavailable ? unavailable[1] : 'Aucun combat de groupe n’attend ici.');
  }
  if (!player.groupId || !sameId(player.groupId, lobby.groupId)) return sendError(socket, 'battle_lobby_group_only', 'Seuls les membres du groupe qui a préparé ce combat peuvent le rejoindre.');
  lobby.memberIds.add(player.characterId);
  sendLobbyState(lobby, player.name + ' a rejoint le combat de groupe.');
}

async function handleBattleStart(socket, message) {
  const initiator = socket.player;
  if (!initiator) return sendError(socket, 'no_character', 'Sélectionne un personnage.');
  if (initiator.auctionSessionId) closeAuctionSession(initiator, 'Session de l’hôtel des ventes fermée : entrée en combat.');
  if (initiator.npcServiceSessionId) closeNpcServiceSession(initiator, 'Session du PNJ fermée : entrée en combat.');
  if (initiator.tradeId) {
    const trade = trades.get(initiator.tradeId);
    if (trade && trade.state === 'finalizing') return sendError(socket, 'trade_finalizing', 'Attends la fin de la transaction d’échange.');
    cancelTradeForPlayer(initiator, 'Échange annulé : un joueur est entré en combat.');
  }
  if (initiator.battleId) return sendError(socket, initiator.battleExitPending ? 'battle_exit_pending' : 'already_in_battle', initiator.battleExitPending ? 'Confirme d’abord la fin du combat précédent.' : 'Un combat est déjà en cours.');
  const encounterId = cleanText(message.encounterId, 64);
  const source = cleanText(message.source || 'event', 12).toLowerCase();
  if (source !== 'event' && source !== 'random') return sendError(socket, 'invalid_battle_source', 'Source de combat invalide.');

  // A tagged RPG Maker event never trusts encounterId from its client. The
  // server reopens the real MapXXX.json, validates the comment and command,
  // then resolves its direct MV troop through server-owned encounter content.
  let eventDefinition = null;
  let monster = null;
  let lobby = null;
  let encounter = null;
  let eventQuestProgress = [];
  if (source === 'event' && message.eventContext) {
    eventDefinition = verifyTaggedBattleEvent(message.eventContext);
    if (!eventDefinition.ok) return sendError(socket, eventDefinition.code, eventDefinition.message);
    const nativeQuestProgress = nativeQuestProgressForBattle(eventDefinition);
    if (nativeQuestProgress.error) return sendError(socket, nativeQuestProgress.error[0], nativeQuestProgress.error[1]);
    eventQuestProgress = nativeQuestProgress.rules;
    if (eventDefinition.mapId !== Number(initiator.mapId)) {
      return sendError(socket, 'encounter_not_here', 'Cet événement ne se trouve pas sur ta carte actuelle.');
    }
    if (!battleEventInRange(initiator, eventDefinition)) return sendError(socket, 'encounter_too_far', 'Approche-toi du monstre pour lancer ce combat.');
    const monsterConfigured = monsterContextForBattle(initiator, eventDefinition);
    if (monsterConfigured.error) return sendError(socket, monsterConfigured.error[0], monsterConfigured.error[1]);
    monster = monsterConfigured.context;
    const currentMonster = worldMonsters.get(monster.key);
    if (eventDefinition.coop === 'solo') {
      if (currentMonster) {
        const unavailable = monsterUnavailableError(currentMonster);
        return sendError(socket, unavailable[0], unavailable[1]);
      }
    } else {
      lobby = battleLobbies.get(monster.key);
      if (!lobby || !currentMonster || currentMonster.status !== 'lobby') {
        const unavailable = monsterUnavailableError(currentMonster);
        return sendError(socket, unavailable ? unavailable[0] : 'battle_lobby_missing', unavailable ? unavailable[1] : 'Prépare d’abord ce combat de groupe avec la branche native dédiée.');
      }
      if (!sameId(lobby.ownerCharacterId, initiator.characterId)) return sendError(socket, 'battle_lobby_owner_required', 'Le joueur qui a préparé le combat doit le lancer.');
      if (!initiator.groupId || !sameId(initiator.groupId, lobby.groupId)) return sendError(socket, 'battle_lobby_group_only', 'Le groupe de ce combat n’est plus valide.');
    }
    const nativeEncounter = nativeEncounterForTroop(eventDefinition.troopId);
    if (!nativeEncounter.ok) return sendError(socket, nativeEncounter.code, nativeEncounter.message);
    const configuredEncounter = Object.keys(ENCOUNTERS).map((id) => ENCOUNTERS[id])
      .find((candidate) => Number(candidate.mvTroopId) === Number(eventDefinition.troopId));
    // Events are authored in MV: enemy stats, EXP, gold and drops always come
    // from the native troop/enemy records. content.js can still add MMO-only
    // quest hooks and a friendlier title for a mapped encounter.
    const eventRewards = eventDefinition.rewards || { experience: 0, gold: 0, loot: [] };
    const rewardedNativeEncounter = Object.assign({}, nativeEncounter, {
      rewards: {
        experience: Number(nativeEncounter.rewards.experience || 0) + Number(eventRewards.experience || 0),
        gold: Number(nativeEncounter.rewards.gold || 0) + Number(eventRewards.gold || 0)
      },
      loot: (nativeEncounter.loot || []).concat(eventRewards.loot || [])
    });
    encounter = configuredEncounter ? Object.assign({}, rewardedNativeEncounter, {
      id: configuredEncounter.id,
      title: configuredEncounter.title || rewardedNativeEncounter.title,
      questProgress: (configuredEncounter.questProgress || []).concat(eventQuestProgress)
    }) : Object.assign({}, rewardedNativeEncounter, { questProgress: eventQuestProgress });
  } else {
    // Backward compatibility for MMO BATTLE_START encounter_id.
    encounter = ENCOUNTERS[encounterId];
  }
  if (!encounter) return sendError(socket, 'encounter_unknown', 'Rencontre inconnue.');
  if ((source === 'event' && !encounter.allowEvent) || (source === 'random' && !encounter.allowRandom)) {
    return sendError(socket, 'encounter_source_forbidden', 'Cette rencontre ne peut pas démarrer ainsi.');
  }
  // A tagged event has already been verified in its actual MapXXX.json, so it
  // may be authored on any map. Random and legacy plugin-command encounters
  // retain their explicit content.js map allowlist.
  if (!eventDefinition && encounter.allowedMapIds.indexOf(initiator.mapId) === -1) {
    return sendError(socket, 'encounter_not_here', 'Cette rencontre n’est pas disponible sur cette carte.');
  }

  let participants = [initiator];
  if (eventDefinition && eventDefinition.coop !== 'solo') {
    participants = battleLobbyMembers(lobby);
    if (!participants.some((member) => sameId(member.characterId, initiator.characterId))) {
      return sendError(socket, 'battle_lobby_owner_missing', 'Le créateur doit rester prêt dans le lobby pour lancer ce combat.');
    }
  }
  if (eventDefinition && eventDefinition.coop === 'required' && participants.length < 2) {
    return sendError(socket, 'coop_requires_group', 'Cet événement nécessite au moins deux membres prêts dans son lobby.');
  }
  if (participants.some((member) => member.battleId || member.battleExitPending)) {
    const exitingMember = participants.find((member) => member.battleExitPending);
    return sendError(socket, exitingMember ? 'group_member_exit_pending' : 'group_member_in_battle', exitingMember
      ? exitingMember.name + ' doit confirmer la fin du combat précédent avant un nouveau combat.'
      : 'Un membre du lobby est déjà en combat.');
  }
  if (!participants.length) return sendError(socket, 'no_participants', 'Aucun combattant disponible.');
  const finalizingTradeMember = participants.find((member) => {
    const trade = member.tradeId && trades.get(member.tradeId);
    return trade && trade.state === 'finalizing';
  });
  if (finalizingTradeMember) return sendError(socket, 'trade_finalizing', finalizingTradeMember.name + ' termine un échange.');
  participants.forEach((member) => {
    if (member.tradeId) cancelTradeForPlayer(member, 'Échange annulé : un joueur est entré en combat.');
    if (member.auctionSessionId) closeAuctionSession(member, 'Session de l’hôtel des ventes fermée : entrée en combat.');
    if (member.npcServiceSessionId) closeNpcServiceSession(member, 'Session du PNJ fermée : entrée en combat.');
  });
  // Reserve the world monster before the first await below. Without this
  // provisional state, two nearly simultaneous sockets could both pass the
  // availability check while their consumable inventories load.
  const battleId = crypto.randomUUID();
  if (monster) {
    const state = Object.assign({}, monster, { status: 'in_battle', battleId, groupId: lobby ? lobby.groupId : null });
    worldMonsters.set(monster.key, state);
    broadcastMonsterState(state);
  }
  const consumablesByCharacterId = new Map();
  try {
    await Promise.all(participants.map(async (member) => {
      consumablesByCharacterId.set(member.characterId, await loadBattleConsumables(member.characterId));
    }));
  } catch (error) {
    if (monster) {
      if (lobby) {
        const restored = Object.assign({}, monster, { status: 'lobby', groupId: lobby.groupId, ownerCharacterId: lobby.ownerCharacterId, expiresAt: lobby.expiresAt });
        worldMonsters.set(monster.key, restored);
        battleLobbies.set(monster.key, lobby);
        broadcastMonsterState(restored);
        sendLobbyState(lobby, 'Le lancement a échoué : le lobby est rétabli.');
      } else {
        clearMonsterState(monster);
      }
    }
    throw error;
  }

  const battle = {
    id: battleId,
    encounterId: encounter.id,
    mvTroopId: encounter.mvTroopId || null,
    title: encounter.title,
    allowEscape: eventDefinition ? !!eventDefinition.canEscape : !!encounter.allowEscape,
    world: worldKey(initiator),
    worldMonster: monster,
    participantIds: participants.map((player) => player.characterId),
    players: new Map(),
    enemies: encounter.enemies.map((template, index) => createEnemyBattler(template, index + 1)),
    turnOrder: [],
    turnIndex: 0,
    turnStartedAt: now(),
    rewards: encounter.rewards || { experience: 0, gold: 0 },
    lootTable: encounter.loot || [],
    questProgress: encounter.questProgress || [],
    log: [],
    events: [],
    eventSequence: 0,
    ending: false
  };
  if (monster && lobby) {
    battleLobbies.delete(monster.key);
    // The lobby panel belongs to the waiting phase only. Close it before the
    // authoritative battle state is sent to the locked participant roster.
    sendBattleLobbyClosed(lobby, 'Combat lancé.');
  }
  participants.forEach((player) => {
    player.battleId = battle.id;
    player.battleExitPending = false;
    battle.players.set(player.characterId, createPlayerBattler(player, consumablesByCharacterId.get(player.characterId)));
  });
  battle.turnOrder = battlePlayers(battle).map((battler) => ({ kind: 'player', id: battler.id, initiative: battler.stats.agi }))
    .concat(battle.enemies.map((battler) => ({ kind: 'enemy', id: battler.id, initiative: battler.stats.agi })))
    .sort((left, right) => right.initiative - left.initiative || String(left.id).localeCompare(String(right.id)));
  battle.turnOrder.forEach((turn) => { delete turn.initiative; });
  battles.set(battle.id, battle);
  addBattleLog(battle, 'Combat engagé contre ' + encounter.title + '.');
  sendBattleState(battle);
  scheduleEnemyTurn(battle);
}

async function handleBattleAction(socket, message) {
  const player = socket.player;
  if (!player || !player.battleId) return sendError(socket, 'not_in_battle', 'Tu n’es pas en combat.');
  const battleId = cleanText(message.battleId, 80);
  const battle = battles.get(battleId);
  if (!battle || battle.id !== player.battleId || battle.ending) return sendError(socket, 'battle_missing', 'Ce combat est terminé.');
  const turn = currentTurn(battle);
  if (!turn || turn.kind !== 'player' || !sameId(turn.id, player.characterId)) {
    return sendError(socket, 'not_your_turn', 'Ce n’est pas ton tour.');
  }
  const actor = battle.players.get(player.characterId);
  const actionId = cleanText(message.actionId, 32);
  if (!actor || actor.hp <= 0) return sendError(socket, 'invalid_action', 'Action impossible.');
  if (actionId === 'flee') {
    if (!battle.allowEscape) return sendError(socket, 'escape_forbidden', 'La fuite n’est pas autorisée dans ce combat.');
    addBattleLog(battle, actor.name + ' ordonne la fuite du groupe.');
    await finishBattle(battle, 'escape');
    return;
  }
  const action = battleActionDefinitionFor(actor, actionId);
  if (!action) return sendError(socket, 'invalid_action', 'Action impossible.');
  if (actor.mp < Number(action.mpCost || 0)) return sendError(socket, 'not_enough_mp', 'Pas assez de MP.');

  let target = null;
  const targetId = cleanText(message.targetId, 80);
  const targetIndex = integer(message.targetIndex);
  if (action.targetType === 'enemy') {
    target = battle.enemies.find((candidate) => candidate.id === targetId && candidate.hp > 0);
    // The native MV enemy window is refreshed as battlers collapse. If the
    // selected object belongs to the immediately previous refresh, recover via
    // its current visible living-enemy index instead of leaving the turn stuck.
    if (!target && isInteger(targetIndex) && targetIndex >= 0) target = livingEnemies(battle)[targetIndex] || null;
  } else if (action.targetType === 'ally') {
    target = battle.players.get(targetId);
    if (target && target.hp <= 0) target = null;
    if (!target && isInteger(targetIndex) && targetIndex >= 0) {
      const indexedAlly = battlePlayers(battle)[targetIndex];
      target = indexedAlly && indexedAlly.hp > 0 ? indexedAlly : null;
    }
  } else if (action.targetType === 'deadAlly') {
    target = battle.players.get(targetId);
    if (target && target.hp > 0) target = null;
    if (!target && isInteger(targetIndex) && targetIndex >= 0) {
      const indexedAlly = battlePlayers(battle)[targetIndex];
      target = indexedAlly && indexedAlly.hp <= 0 ? indexedAlly : null;
    }
  } else {
    target = actor;
  }
  if (!target) {
    sendError(socket, 'invalid_target', 'Cible invalide.');
    // Restore the authoritative target list immediately so an outdated native
    // selection cannot trap the player in a pending client turn.
    sendBattleState(battle);
    return;
  }
  if (action.itemId) {
    if (battle.actionPending) return sendError(socket, 'action_pending', 'Action en cours de validation.');
    battle.actionPending = true;
    try {
      const consumed = await consumeInventoryItem(player.characterId, action.itemId);
      if (!consumed) {
        actor.consumables[action.itemId] = 0;
        sendBattleState(battle);
        return sendError(socket, 'item_not_owned', 'Cet objet n’est plus disponible.');
      }
      actor.consumables[action.itemId] = Math.max(0, Number(actor.consumables[action.itemId] || 0) - 1);
      sendInventorySnapshot(player).catch((error) => console.error('[inventory consume]', error));
      resolvePlayerAction(battle, actor, action, target, false);
      return;
    } finally {
      battle.actionPending = false;
    }
  }
  resolvePlayerAction(battle, actor, action, target, false);
}

function handleBattleClosed(socket, message) {
  const player = socket.player;
  if (!player || !player.battleId) return;
  const battleId = cleanText(message && message.battleId, 80);
  if (!battleId || !sameId(player.battleId, battleId)) return sendError(socket, 'battle_close_invalid', 'Confirmation de fin de combat invalide.');
  // A packet forged during a live battle cannot clear its server-side lock.
  if (battles.has(player.battleId) || !player.battleExitPending) return sendError(socket, 'battle_still_active', 'Le combat n’est pas encore terminé.');
  player.battleId = null;
  player.battleExitPending = false;
}

function handleBattleDisconnect(player) {
  if (!player || !player.battleId) return;
  const battle = battles.get(player.battleId);
  if (!battle || battle.ending) return;
  const battler = battle.players.get(player.characterId);
  if (battler) {
    battler.hp = 0;
    addBattleLog(battle, battler.name + ' a quitté le combat.');
  }
  player.battleId = null;
  if (!resolveBattleResultIfNeeded(battle)) {
    const turn = currentTurn(battle);
    if (turn && turn.kind === 'player' && sameId(turn.id, player.characterId)) advanceTurn(battle);
    else sendBattleState(battle);
  }
}

setInterval(() => {
  battles.forEach((battle) => {
    if (battle.ending || now() - battle.turnStartedAt < BATTLE_TURN_TIMEOUT_MS) return;
    const turn = currentTurn(battle);
    const battler = findTurnBattler(battle, turn);
    if (!turn || !battler || battler.hp <= 0) return advanceTurn(battle);
    if (turn.kind === 'enemy') return runEnemyTurn(battle.id, turn.id);
    resolvePlayerAction(battle, battler, BATTLE_ACTIONS.guard, battler, true);
  });
}, 1000).unref();


const handlers = {
  register: handleRegister,
  login: handleLogin,
  createCharacter: handleCreateCharacter,
  deleteCharacter: handleDeleteCharacter,
  selectCharacter: handleSelectCharacter,
  move: handleMove,
  transfer: handleTransfer,
  chat: handleChat,
  groupInvite: handleGroupInvite,
  groupResponse: handleGroupResponse,
  groupLeave: handleGroupLeave,
  questStart: handleQuestStart,
  questProgress: handleQuestProgress,
  dungeonEnter: handleDungeonEnter,
  dungeonExit: handleDungeonExit,
  inventoryRequest: handleInventoryRequest,
  equipItem: handleEquipItem,
  unequipItem: handleUnequipItem,
  optimizeEquipment: handleOptimizeEquipment,
  clearEquipment: handleClearEquipment,
  useInventoryItem: handleUseInventoryItem,
  npcAction: handleNpcAction,
  auctionBrowse: handleAuctionBrowse,
  auctionCreate: handleAuctionCreate,
  auctionBuy: handleAuctionBuy,
  auctionCancel: handleAuctionCancel,
  auctionClose: handleAuctionClose,
  npcServiceClose: handleNpcServiceClose,
  merchantBuy: handleMerchantBuy,
  merchantSell: handleMerchantSell,
  bankDeposit: handleBankDeposit,
  bankWithdraw: handleBankWithdraw,
  tradeRequest: handleTradeRequest,
  tradeResponse: handleTradeResponse,
  tradeSetOffer: handleTradeSetOffer,
  tradeAccept: handleTradeAccept,
  tradeCancel: handleTradeCancel,
  guildCreate: handleGuildCreate,
  guildInvite: handleGuildInvite,
  guildResponse: handleGuildResponse,
  guildLeave: handleGuildLeave,
  guildSetRole: handleGuildSetRole,
  guildTransferLeader: handleGuildTransferLeader,
  guildDisband: handleGuildDisband,
  guildChestRequest: handleGuildChestRequest,
  guildDeposit: handleGuildDeposit,
  guildWithdraw: handleGuildWithdraw,
  guildHouseEnter: handleGuildHouseEnter,
  guildHouseExit: handleGuildHouseExit,
  houseRequest: handleHouseRequest,
  housePlace: handleHousePlace,
  houseRemove: handleHouseRemove,
  houseSetBuildRole: handleHouseSetBuildRole,
  battleLobbyOpen: handleBattleLobbyOpen,
  battleLobbyJoin: handleBattleLobbyJoin,
  battleStart: handleBattleStart,
  battleAction: handleBattleAction,
  battleClosed: handleBattleClosed
};

wss.on('connection', (socket, request) => {
  socket.account = null;
  socket.player = null;
  const ip = request.socket.remoteAddress || 'unknown';
  console.log('[connection] open from ' + ip);
  send(socket, 'hello', { protocol: 1, message: 'Serveur MMO prêt.' });

  socket.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString('utf8'));
    } catch (_) {
      return sendError(socket, 'invalid_json', 'Paquet invalide.');
    }
    if (!message || typeof message.type !== 'string' || message.type.length > 32) {
      return sendError(socket, 'invalid_packet', 'Paquet invalide.');
    }
    const handler = handlers[message.type];
    if (!handler) return sendError(socket, 'unknown_packet', 'Action inconnue.');
    Promise.resolve(handler(socket, message)).catch((error) => {
      console.error('[packet ' + message.type + ']', error);
      sendError(socket, 'server_error', 'Une erreur serveur est survenue.');
    });
  });

  socket.on('close', () => {
    const player = socket.player;
    if (player) {
      cancelTradeForPlayer(player, 'Échange annulé : un joueur s’est déconnecté.');
      removePlayerFromBattleLobbies(player, 'Un membre s’est déconnecté.');
      closeAuctionSession(player, 'Session de l’hôtel des ventes fermée : déconnexion.', false);
      closeNpcServiceSession(player, 'Session du PNJ fermée : déconnexion.', false);
      handleBattleDisconnect(player);
      leaveWorld(player);
      onlineByCharacterId.delete(player.characterId);
      if (player.guildId) broadcastGuildSnapshot(player.guildId).catch((error) => console.error('[guild disconnect snapshot]', error));
      detachFromGroup(player);
      persistPlayer(player, true).catch((error) => console.error('[disconnect save]', error));
      socket.player = null;
      console.log('[connection] ' + player.name + ' disconnected');
    }
  });

  socket.on('error', (error) => {
    console.warn('[websocket] error:', error.message);
  });
});

// Expire abandoned invitations/offers so neither participant stays locked.
function expireTrades(referenceTime) {
  const timestamp = Number(referenceTime || now());
  trades.forEach((trade) => {
    if (timestamp - trade.updatedAt > TRADE_TIMEOUT_MS) cancelTrade(trade, 'Échange annulé : délai dépassé.');
  });
}
setInterval(() => expireTrades(), 5000).unref();

function expireAuctionSessions(referenceTime) {
  const timestamp = Number(referenceTime || now());
  auctionSessions.forEach((session) => {
    if (timestamp <= session.expiresAt) return;
    const player = onlineByCharacterId.get(asId(session.characterId));
    if (player && player.auctionSessionId === session.id) closeAuctionSession(player, 'Session de l’hôtel des ventes expirée.');
    else auctionSessions.delete(session.id);
  });
}
setInterval(() => expireAuctionSessions(), 10000).unref();
function expireNpcServiceSessions(referenceTime) {
  const timestamp = Number(referenceTime || now());
  npcServiceSessions.forEach((session) => {
    if (timestamp <= session.expiresAt) return;
    const player = onlineByCharacterId.get(asId(session.characterId));
    if (player && player.npcServiceSessionId === session.id) closeNpcServiceSession(player, 'Session du PNJ expirée.');
    else npcServiceSessions.delete(session.id);
  });
}
setInterval(() => expireNpcServiceSessions(), 10000).unref();
function expireWorldMonsters(referenceTime) {
  const timestamp = Number(referenceTime || now());
  battleLobbies.forEach((lobby) => {
    if (timestamp >= Number(lobby.expiresAt || 0)) releaseBattleLobby(lobby, 'Lobby de combat expiré.');
  });
  worldMonsters.forEach((state, key) => {
    if (state.status !== 'respawning' || timestamp < Number(state.respawnAt || Infinity)) return;
    worldMonsters.delete(key);
    broadcastMonsterAvailable(state);
  });
}
setInterval(() => expireWorldMonsters(), 1000).unref();
setInterval(() => {
  expireAuctionListings().catch((error) => console.error('[auction expiry]', error));
}, 60000).unref();

// Clean empty instances. A live instance stays available while one of its members is inside it.
setInterval(() => {
  instances.forEach((instance, instanceId) => {
    const occupied = Array.from(instance.memberIds).some((characterId) => {
      const player = onlineByCharacterId.get(asId(characterId));
      return player && player.instanceId === instanceId;
    });
    if (!occupied && now() - instance.createdAt > 60 * 1000) instances.delete(instanceId);
  });
}, 30000).unref();

async function shutdown(signal) {
  console.log('\n[server] received ' + signal + ', saving connected characters...');
  const saves = Array.from(onlineByCharacterId.values()).map((player) => persistPlayer(player, true));
  await Promise.allSettled(saves);
  wss.clients.forEach((socket) => socket.close(1001, 'Server shutting down'));
  server.close(async () => {
    await db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(PORT, HOST, () => {
  console.log('[server] HTTP health: http://' + HOST + ':' + PORT + '/health');
  console.log('[server] WebSocket: ws://' + HOST + ':' + PORT + '/ws');
  console.log('[server] RPG Maker data read from: ' + dataDirectory());
});
