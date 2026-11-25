'use strict';

// Native MV items stored in PostgreSQL receive a stable textual key. It keeps
// the existing character_inventory schema while allowing any MV Item, Weapon
// or Armor to be granted by an Enemy drop table.
const { loadDatabase, entryAt } = require('./mv-database');

const KEY_PATTERN = /^mv:(item|weapon|armor):(\d+)$/;
let cachedDatabase = null;
let attemptedLoad = false;

function database() {
  if (attemptedLoad) return cachedDatabase;
  attemptedLoad = true;
  try {
    const loaded = loadDatabase();
    cachedDatabase = loaded.items && loaded.weapons && loaded.armors ? loaded : null;
  } catch (error) {
    console.warn('[mv inventory] Base MV indisponible : ' + error.message);
    cachedDatabase = null;
  }
  return cachedDatabase;
}

function nativeItemKey(kind, id) {
  return 'mv:' + kind + ':' + Number(id);
}

function parseNativeItemKey(value) {
  const match = KEY_PATTERN.exec(String(value || ''));
  return match ? { kind: match[1], id: Number(match[2]) } : null;
}

function collectionForKind(kind) {
  return ({ item: 'items', weapon: 'weapons', armor: 'armors' })[kind] || null;
}

function statsFromParams(params) {
  const values = params || [];
  const fields = ['hp', 'mp', 'atk', 'def', 'mat', 'mdf', 'agi', 'luk'];
  const stats = {};
  fields.forEach((field, index) => {
    const value = Number(values[index] || 0);
    if (value) stats[field] = value;
  });
  return stats;
}

function definition(itemId) {
  const parsed = parseNativeItemKey(itemId);
  const db = database();
  const collection = parsed && collectionForKind(parsed.kind);
  const entry = parsed && collection && db ? entryAt(db, collection, parsed.id) : null;
  if (!entry) return null;
  const isEquipment = parsed.kind === 'weapon' || parsed.kind === 'armor';
  // The concrete MV etypeId is carried separately below. Keep this broad
  // legacy label only for callers that need to distinguish weapon vs armor.
  const slot = parsed.kind === 'weapon' ? 'weapon' : 'armor';
  return {
    id: nativeItemKey(parsed.kind, parsed.id),
    mv: { kind: parsed.kind, id: parsed.id },
    label: entry.name || (parsed.kind + ' ' + parsed.id),
    type: isEquipment ? 'equipment' : 'consumable',
    slot: isEquipment ? slot : null,
    etypeId: isEquipment ? Number(entry.etypeId || 0) : null,
    wtypeId: parsed.kind === 'weapon' ? Number(entry.wtypeId || 0) : null,
    atypeId: parsed.kind === 'armor' ? Number(entry.atypeId || 0) : null,
    classes: null,
    description: entry.description || '',
    stats: isEquipment ? statsFromParams(entry.params) : {},
    native: true
  };
}

function entryForMapping(mapping) {
  const kind = mapping && mapping.kind;
  const id = Number(mapping && mapping.id);
  const db = database();
  const collection = collectionForKind(kind);
  return collection && db && Number.isInteger(id) && id > 0 ? entryAt(db, collection, id) : null;
}

function stateEntry(stateId) {
  const db = database();
  return db ? entryAt(db, 'states', stateId) : null;
}

function parameterRatesForStates(stateIds) {
  const rates = [1, 1, 1, 1, 1, 1, 1, 1];
  (stateIds || []).forEach((stateId) => {
    const state = stateEntry(stateId);
    (state && state.traits || []).forEach((trait) => {
      // RPG Maker MV trait 21 is PARAM_RATE. Other state traits remain native
      // presentation until their combat rule receives a dedicated server model.
      const paramId = Number(trait.dataId);
      if (Number(trait.code) === 21 && paramId >= 0 && paramId < rates.length) {
        rates[paramId] *= Number(trait.value || 1);
      }
    });
  });
  return rates.map((rate) => Math.max(0, Math.min(100, rate)));
}

function menuUseFor(mapping) {
  const entry = entryForMapping(mapping);
  if (!entry || !entry.consumable || [0, 2].indexOf(Number(entry.occasion)) === -1) return null;
  // Scene_Item can target the local character only. Both living and dead
  // ally scopes are supported; offensive and event effects stay server-closed.
  if ([7, 8, 9, 10, 11].indexOf(Number(entry.scope)) === -1) return null;
  const effects = [];
  (entry.effects || []).forEach((effect) => {
    const code = Number(effect.code);
    const stateId = Number(effect.dataId);
    if (code === 11) effects.push({ kind: 'recoverHp', rate: Number(effect.value1 || 0), flat: Number(effect.value2 || 0) });
    else if (code === 12) effects.push({ kind: 'recoverMp', rate: Number(effect.value1 || 0), flat: Number(effect.value2 || 0) });
    else if (code === 21 && stateEntry(stateId)) effects.push({ kind: 'addState', stateId, chance: Number(effect.value1 || 0) });
    else if (code === 22 && stateEntry(stateId)) effects.push({ kind: 'removeState', stateId, chance: Number(effect.value1 || 0) });
    else if (code === 42 && stateId >= 0 && stateId < 8) effects.push({ kind: 'grow', paramId: stateId, amount: Math.trunc(Number(effect.value1 || 0)) });
  });
  if (!effects.length) return null;
  return {
    scope: Number(entry.scope),
    requiresDeadTarget: [9, 10].indexOf(Number(entry.scope)) !== -1,
    effects
  };
}

function canClassEquip(classId, itemId) {
  const item = definition(itemId);
  const db = database();
  const classEntry = db && entryAt(db, 'classes', classId);
  if (!item || !classEntry || !item.mv || !item.etypeId) return !!item;
  const traitCode = item.mv.kind === 'weapon' ? 51 : 52; // MV: equip weapon / armor type
  const requiredType = item.mv.kind === 'weapon' ? item.wtypeId : item.atypeId;
  if (!requiredType) return false;
  return (classEntry.traits || []).some((trait) => Number(trait.code) === traitCode && Number(trait.dataId) === Number(requiredType));
}

function lootForEnemy(enemy) {
  const drops = [];
  (enemy && enemy.dropItems || []).forEach((drop) => {
    const kind = ({ 1: 'item', 2: 'weapon', 3: 'armor' })[Number(drop.kind)];
    const id = Number(drop.dataId);
    const denominator = Math.max(1, Number(drop.denominator || 1));
    if (!kind || id < 1 || !definition(nativeItemKey(kind, id))) return;
    drops.push({ itemId: nativeItemKey(kind, id), quantity: 1, chance: 1 / denominator });
  });
  return drops;
}

module.exports = {
  nativeItemKey,
  parseNativeItemKey,
  definition,
  menuUseFor,
  parameterRatesForStates,
  canClassEquip,
  lootForEnemy
};
