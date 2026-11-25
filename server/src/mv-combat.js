'use strict';

/**
 * Native RPG Maker MV class/skill bridge.
 *
 * Class parameter curves, class learnings, skill names, MP costs, scope,
 * formulas, variance and animations are read from data/Classes.json and
 * data/Skills.json. The server owns the resulting calculation; it never asks
 * the RPG Maker client to resolve a value.
 */
const { loadDatabase, entryAt } = require('./mv-database');
const { MV_MAPPING } = require('./mv-mapping');

let cachedDatabase = null;
let attemptedLoad = false;

function number(value, fallback) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function database() {
  if (attemptedLoad) return cachedDatabase;
  attemptedLoad = true;
  try {
    const loaded = loadDatabase();
    cachedDatabase = loaded.classes && loaded.skills ? loaded : null;
  } catch (error) {
    console.warn('[mv combat] Base MV indisponible : ' + error.message);
    cachedDatabase = null;
  }
  return cachedDatabase;
}

function mappingForClass(classKey) {
  return MV_MAPPING.actors[classKey] || null;
}

function classEntry(classKey) {
  const map = mappingForClass(classKey);
  const db = database();
  return map && db ? entryAt(db, 'classes', map.classId) : null;
}

function skillEntry(skillId) {
  const db = database();
  return db ? entryAt(db, 'skills', skillId) : null;
}

function className(classKey, fallback) {
  const entry = classEntry(classKey);
  return entry && entry.name ? entry.name : fallback;
}

function valueAtCurve(curve, level) {
  if (!Array.isArray(curve) || !curve.length) return 0;
  const index = Math.max(0, Math.min(curve.length - 1, Math.floor(number(level, 1))));
  return number(curve[index], 0);
}

function statsForClass(classKey, level) {
  const entry = classEntry(classKey);
  if (!entry || !Array.isArray(entry.params)) return null;
  const params = entry.params;
  return {
    hp: valueAtCurve(params[0], level),
    mp: valueAtCurve(params[1], level),
    atk: valueAtCurve(params[2], level),
    def: valueAtCurve(params[3], level),
    mat: valueAtCurve(params[4], level),
    mdf: valueAtCurve(params[5], level),
    agi: valueAtCurve(params[6], level),
    luk: valueAtCurve(params[7], level)
  };
}

function expForLevel(entry, level) {
  const params = entry && entry.expParams;
  if (!Array.isArray(params) || params.length < 4) return 0;
  const basis = number(params[0], 30);
  const extra = number(params[1], 20);
  const accA = number(params[2], 30);
  const accB = Math.max(1, number(params[3], 30));
  const value = basis * Math.pow(level - 1, 0.9 + accA / 250) * level * (level + 1) /
    (6 + Math.pow(level, 2) / 50 / accB) + (level - 1) * extra;
  return Math.round(value);
}

function levelForExperience(classKey, experience, fallbackLevel) {
  const entry = classEntry(classKey);
  if (!entry || !Array.isArray(entry.expParams)) return Math.max(1, number(fallbackLevel, 1));
  const exp = Math.max(0, number(experience, 0));
  let level = 1;
  // RPG Maker MV's standard maximum actor level is 99 unless a project/plugin
  // deliberately overrides it. The client and server share this curve.
  for (let candidate = 2; candidate <= 99; candidate += 1) {
    if (exp < expForLevel(entry, candidate)) break;
    level = candidate;
  }
  return level;
}

function descriptorForScope(scope) {
  switch (Number(scope)) {
  case 1: return { targetType: 'enemy', targetMode: 'single' };
  case 2: return { targetType: 'allEnemies', targetMode: 'allEnemies' };
  case 3:
  case 4:
  case 5:
  case 6: return { targetType: 'randomEnemy', targetMode: 'randomEnemy', randomCount: Number(scope) - 2 };
  case 7: return { targetType: 'ally', targetMode: 'single' };
  case 8: return { targetType: 'allAllies', targetMode: 'allAllies' };
  case 9: return { targetType: 'deadAlly', targetMode: 'singleDeadAlly' };
  case 10: return { targetType: 'allDeadAllies', targetMode: 'allDeadAllies' };
  case 11: return { targetType: 'self', targetMode: 'self' };
  default: return { targetType: 'self', targetMode: 'self' };
  }
}

function actionForSkill(skill) {
  if (!skill || !skill.id) return null;
  const scope = descriptorForScope(skill.scope);
  const damage = skill.damage || {};
  const guardSkillId = Number(MV_MAPPING.skills.guard || 0);
  return {
    id: 'skill_' + Number(skill.id),
    kind: Number(skill.id) === guardSkillId ? 'guard' : 'mv_skill',
    label: skill.name || ('Compétence ' + skill.id),
    mvSkillId: Number(skill.id),
    mpCost: Math.max(0, number(skill.mpCost, 0)),
    targetType: scope.targetType,
    targetMode: scope.targetMode,
    randomCount: scope.randomCount || 0,
    scope: Number(skill.scope || 0),
    damage: {
      type: Number(damage.type || 0),
      formula: String(damage.formula || '0'),
      variance: Math.max(0, Math.min(100, number(damage.variance, 0))),
      critical: damage.critical === true
    }
  };
}

function actionsForClass(classKey, level) {
  const entry = classEntry(classKey);
  if (!entry) return null;
  const ids = [];
  [MV_MAPPING.skills.attack, MV_MAPPING.skills.guard].forEach((id) => {
    const numericId = Number(id);
    if (numericId > 0 && ids.indexOf(numericId) === -1) ids.push(numericId);
  });
  (entry.learnings || []).filter((learning) => number(learning.level, 1) <= number(level, 1))
    .sort((left, right) => number(left.level, 1) - number(right.level, 1) || number(left.skillId, 0) - number(right.skillId, 0))
    .forEach((learning) => {
      const skillId = Number(learning.skillId);
      if (skillId > 0 && ids.indexOf(skillId) === -1) ids.push(skillId);
    });
  return ids.map(skillEntry).map(actionForSkill).filter(Boolean);
}

function actionForClass(classKey, level, actionId) {
  const actions = actionsForClass(classKey, level);
  if (!actions) return null;
  return actions.find((action) => action.id === actionId) || null;
}

// Safe arithmetic evaluator for the common RPG Maker MV damage-formula subset:
// numbers, parentheses, + - * / %, and a./b. stats. It intentionally rejects
// arbitrary JavaScript; project data cannot turn a combat formula into server
// code execution.
function formulaValue(formula, attacker, target) {
  const source = String(formula || '0').trim();
  if (!source) return 0;
  const tokens = [];
  const matcher = /\s*(?:(\d+(?:\.\d+)?)|([ab]\.(?:hp|mp|atk|def|mat|mdf|agi|luk|level))|([()+\-*/%]))/gy;
  let position = 0;
  let match;
  while (position < source.length) {
    matcher.lastIndex = position;
    match = matcher.exec(source);
    if (!match || match.index !== position) return 0;
    position = matcher.lastIndex;
    if (match[1]) tokens.push({ type: 'number', value: number(match[1], 0) });
    else if (match[2]) tokens.push({ type: 'stat', value: match[2] });
    else tokens.push({ type: 'operator', value: match[3] });
  }
  let index = 0;
  function statValue(identifier) {
    const pieces = identifier.split('.');
    const battler = pieces[0] === 'a' ? attacker : target;
    const stat = pieces[1];
    if (stat === 'level') return number(battler.level, 1);
    if (stat === 'luk') return number((battler.stats || {}).luk, 0);
    if (stat === 'hp' || stat === 'mp') return number(battler[stat], 0);
    return number((battler.stats || {})[stat], 0);
  }
  function peek() { return tokens[index]; }
  function consume() { return tokens[index++]; }
  function factor() {
    const token = consume();
    if (!token) throw new Error('formule incomplète');
    if (token.type === 'number') return token.value;
    if (token.type === 'stat') return statValue(token.value);
    if (token.value === '+') return factor();
    if (token.value === '-') return -factor();
    if (token.value === '(') {
      const value = expression();
      const closing = consume();
      if (!closing || closing.value !== ')') throw new Error('parenthèse manquante');
      return value;
    }
    throw new Error('facteur invalide');
  }
  function term() {
    let value = factor();
    while (peek() && ['*', '/', '%'].indexOf(peek().value) !== -1) {
      const operator = consume().value;
      const right = factor();
      if (operator === '*') value *= right;
      else if (operator === '/') value = right === 0 ? 0 : value / right;
      else value = right === 0 ? 0 : value % right;
    }
    return value;
  }
  function expression() {
    let value = term();
    while (peek() && ['+', '-'].indexOf(peek().value) !== -1) {
      const operator = consume().value;
      const right = term();
      value = operator === '+' ? value + right : value - right;
    }
    return value;
  }
  try {
    const value = expression();
    return index === tokens.length && Number.isFinite(value) ? Math.floor(value) : 0;
  } catch (_) {
    return 0;
  }
}

function applyVariance(value, variancePercent) {
  const amount = Math.max(0, Math.floor(Math.abs(number(value, 0)) * number(variancePercent, 0) / 100));
  if (!amount) return Math.floor(number(value, 0));
  return Math.floor(number(value, 0)) + Math.floor(Math.random() * (amount * 2 + 1)) - amount;
}

module.exports = {
  className,
  statsForClass,
  levelForExperience,
  actionsForClass,
  actionForClass,
  formulaValue,
  applyVariance,
  isAvailable: () => !!database()
};
