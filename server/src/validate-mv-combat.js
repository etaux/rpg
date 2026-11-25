'use strict';

require('dotenv').config();
const { MV_MAPPING } = require('./mv-mapping');
const { dataDirectory, loadDatabase, entryAt } = require('./mv-database');

let failed = false;
function error(message) { failed = true; console.error('[combat native] ' + message); }
function warning(message) { console.warn('[avertissement] ' + message); }

try {
  const database = loadDatabase();
  if (!database.classes || !database.skills) throw new Error('Classes.json ou Skills.json est absent.');
  console.log('Combat MV inspecté : ' + dataDirectory());
  Object.keys(MV_MAPPING.actors).forEach((classKey) => {
    const mapping = MV_MAPPING.actors[classKey];
    const klass = entryAt(database, 'classes', mapping.classId);
    if (!klass) return error(classKey + ' : classe MV #' + mapping.classId + ' absente.');
    const learnings = (klass.learnings || []).slice().sort((a, b) => Number(a.level) - Number(b.level));
    const skills = learnings.map((learning) => {
      const skill = entryAt(database, 'skills', learning.skillId);
      if (!skill) error(classKey + ' : compétence #' + learning.skillId + ' absente.');
      return 'niv. ' + learning.level + ' → #' + learning.skillId + ' ' + (skill ? skill.name : '(absente)');
    });
    console.log('- ' + classKey + ' → Classe #' + mapping.classId + ' « ' + klass.name + ' » : ' + (skills.length ? skills.join(', ') : 'aucun apprentissage'));
    if (!skills.length) warning(classKey + ' ne possède aucune compétence dans Apprentissage. Il n’aura que Attaque et Garde.');
  });
  [MV_MAPPING.skills.attack, MV_MAPPING.skills.guard].forEach((skillId) => {
    if (!entryAt(database, 'skills', skillId)) error('Compétence de base MV #' + skillId + ' absente.');
  });
  if (failed) process.exitCode = 1;
  else console.log('Classes, courbes de paramètres et apprentissages MV valides.');
} catch (err) {
  console.error('[combat native] ' + err.message);
  process.exitCode = 1;
}
