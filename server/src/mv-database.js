'use strict';

const fs = require('fs');
const path = require('path');
const { MV_MAPPING } = require('./mv-mapping');

const FILES = {
  actors: 'Actors.json',
  classes: 'Classes.json',
  skills: 'Skills.json',
  items: 'Items.json',
  weapons: 'Weapons.json',
  armors: 'Armors.json',
  states: 'States.json',
  enemies: 'Enemies.json',
  troops: 'Troops.json'
};

function dataDirectory() {
  // npm start runs from server/, therefore ../data is the normal project layout:
  // PROJECT/data and PROJECT/server.
  return path.resolve(process.cwd(), process.env.RPG_MV_DATA_PATH || '../data');
}

function readJson(fileName) {
  const filePath = path.join(dataDirectory(), fileName);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error('Impossible de lire ' + filePath + ' : ' + error.message);
  }
}

function loadDatabase() {
  const database = {};
  Object.keys(FILES).forEach((key) => { database[key] = readJson(FILES[key]); });
  return database;
}

function entryAt(database, collection, id) {
  const list = database[collection];
  const numberId = Number(id);
  if (!list || !Number.isInteger(numberId) || numberId < 1) return null;
  return list[numberId] || null;
}

function itemCollection(kind) {
  return ({ item: 'items', weapon: 'weapons', armor: 'armors' })[kind] || null;
}

function validateMapping(database) {
  const errors = [];
  const warnings = [];
  Object.keys(FILES).forEach((collection) => {
    if (!database[collection]) warnings.push('Fichier absent : data/' + FILES[collection]);
  });

  Object.keys(MV_MAPPING.actors).forEach((classId) => {
    const map = MV_MAPPING.actors[classId];
    if (!entryAt(database, 'actors', map.actorId)) errors.push('Actor ID invalide pour ' + classId + ' : ' + map.actorId);
    if (!entryAt(database, 'classes', map.classId)) errors.push('Class ID invalide pour ' + classId + ' : ' + map.classId);
  });
  Object.keys(MV_MAPPING.skills).forEach((actionId) => {
    if (!entryAt(database, 'skills', MV_MAPPING.skills[actionId])) errors.push('Skill ID invalide pour ' + actionId + ' : ' + MV_MAPPING.skills[actionId]);
  });
  Object.keys(MV_MAPPING.items).forEach((itemId) => {
    const map = MV_MAPPING.items[itemId];
    if (!map) return;
    const collection = itemCollection(map.kind);
    if (!collection || !entryAt(database, collection, map.id)) errors.push('Objet MV invalide pour ' + itemId + ' : ' + map.kind + ' #' + map.id);
  });
  Object.keys(MV_MAPPING.enemies).forEach((enemyId) => {
    if (!entryAt(database, 'enemies', MV_MAPPING.enemies[enemyId])) errors.push('Enemy ID invalide pour ' + enemyId + ' : ' + MV_MAPPING.enemies[enemyId]);
  });
  Object.keys(MV_MAPPING.troops).forEach((encounterId) => {
    if (!entryAt(database, 'troops', MV_MAPPING.troops[encounterId])) errors.push('Troop ID invalide pour ' + encounterId + ' : ' + MV_MAPPING.troops[encounterId]);
  });
  return { errors, warnings };
}

function describeEntry(entry) {
  if (!entry) return '(vide)';
  return '#' + entry.id + ' · ' + (entry.name || '(sans nom)');
}

module.exports = {
  FILES,
  dataDirectory,
  loadDatabase,
  entryAt,
  itemCollection,
  validateMapping,
  describeEntry
};
