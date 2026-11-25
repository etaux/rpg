'use strict';

require('dotenv').config();
const { FILES, dataDirectory, loadDatabase, describeEntry } = require('./mv-database');

function entries(list) {
  return (list || []).filter((entry) => entry && entry.id > 0);
}

function printSection(title, list, extra) {
  console.log('\n=== ' + title + ' ===');
  if (!list) {
    console.log('Fichier absent.');
    return;
  }
  entries(list).forEach((entry) => {
    console.log(describeEntry(entry) + (extra ? extra(entry) : ''));
  });
}

try {
  const database = loadDatabase();
  console.log('Base MV inspectée : ' + dataDirectory());
  console.log('Fichiers attendus : ' + Object.keys(FILES).map((key) => FILES[key]).join(', '));
  printSection('ACTORS', database.actors, (entry) => ' · classe #' + entry.classId);
  printSection('CLASSES', database.classes, (entry) => {
    const learnings = (entry.learnings || []).map((learning) => {
      const skill = database.skills && database.skills[learning.skillId];
      return 'niv. ' + learning.level + ' → #' + learning.skillId + ' ' + (skill ? skill.name : '(absente)');
    });
    return ' · apprentissages : ' + (learnings.length ? learnings.join(', ') : 'aucun');
  });
  printSection('SKILLS', database.skills, (entry) => {
    const damage = entry.damage || {};
    return ' · animation #' + entry.animationId + ' · MP ' + entry.mpCost + ' · portée ' + entry.scope +
      ' · dégâts type ' + damage.type + ' · formule ' + String(damage.formula || '0');
  });
  printSection('ITEMS', database.items, (entry) => ' · icône #' + entry.iconIndex);
  printSection('WEAPONS', database.weapons, (entry) => ' · icône #' + entry.iconIndex);
  printSection('ARMORS', database.armors, (entry) => ' · icône #' + entry.iconIndex);
  printSection('ENEMIES', database.enemies);
  printSection('TROOPS', database.troops, (entry) => ' · ' + (entry.members || []).filter((member) => member).length + ' ennemi(s)');
} catch (error) {
  console.error('[mv inspect] ' + error.message);
  process.exitCode = 1;
}
