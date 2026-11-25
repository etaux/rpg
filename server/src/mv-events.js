'use strict';

/**
 * Server-side verifier for RPG Maker MV event metadata.
 *
 * The client can report an event interaction, but it cannot choose an arbitrary
 * troop: this module rereads data/MapXXX.json, verifies the active page, the
 * immediately preceding <MMO ...> comment and the exact Battle Processing
 * command before the authoritative battle is created.
 */
const fs = require('fs');
const path = require('path');
const { dataDirectory, loadDatabase, entryAt } = require('./mv-database');
const { lootForEnemy, nativeItemKey } = require('./mv-inventory');

const mapCache = new Map();

function integer(value) { return Number(value); }
function isInteger(value) { return Number.isInteger(value); }
function mapFilePath(mapId) {
  return path.join(dataDirectory(), 'Map' + String(mapId).padStart(3, '0') + '.json');
}

function readMap(mapId) {
  const filePath = mapFilePath(mapId);
  let stat;
  try { stat = fs.statSync(filePath); } catch (_) { return null; }
  const cached = mapCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.data;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
  mapCache.set(filePath, { mtimeMs: stat.mtimeMs, data });
  return data;
}

function parseMmoMetadata(text) {
  let metadata = null;
  const pattern = /<\s*MMO\s*:?\s*([^>]*)>/ig;
  let match;
  while ((match = pattern.exec(String(text || '')))) {
    metadata = metadata || {};
    const attributePattern = /([a-z][a-z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))/ig;
    let attribute;
    while ((attribute = attributePattern.exec(String(match[1] || '')))) {
      metadata[String(attribute[1]).toLowerCase()] = String(attribute[2] || attribute[3] || attribute[4] || '').trim();
    }
  }
  return metadata;
}

function commentsImmediatelyBefore(list, commandIndex) {
  const lines = [];
  for (let index = commandIndex - 1; index >= 0; index -= 1) {
    const command = list[index];
    if (!command || (command.code !== 108 && command.code !== 408)) break;
    lines.unshift(String((command.parameters || [])[0] || ''));
  }
  return lines.join('\n');
}

function error(code, message) { return { ok: false, code, message }; }

function directPositiveAmount(parameters, operationIndex, operandTypeIndex, amountIndex) {
  const operation = Number(parameters[operationIndex]);
  const operandType = Number(parameters[operandTypeIndex]);
  const amount = Number(parameters[amountIndex]);
  return operation === 0 && operandType === 0 && Number.isFinite(amount) && amount > 0 ? Math.floor(amount) : 0;
}

// Reads direct reward commands from the native Victory branch of Battle
// Processing. Nested conditional branches and variable operands are purposely
// left to future scripted server-event support: only deterministic commands
// authored directly in the branch become authoritative rewards.
function addDirectMvReward(rewards, command, index) {
  const parameters = command.parameters || [];
  if (command.code === 125) {
    const amount = directPositiveAmount(parameters, 0, 1, 2);
    if (amount) { rewards.gold += amount; rewards.commandIndexes.push(index); }
  } else if (command.code === 315) {
    // Change EXP uses [iterateType, actorId, operation, operandType,
    // operand, showLevelUp] in RPG Maker MV.
    const amount = directPositiveAmount(parameters, 2, 3, 4);
    if (amount) { rewards.experience += amount; rewards.commandIndexes.push(index); }
  } else if (command.code === 126 || command.code === 127 || command.code === 128) {
    const amount = directPositiveAmount(parameters, 1, 2, 3);
    const kind = ({ 126: 'item', 127: 'weapon', 128: 'armor' })[command.code];
    const dataId = Number(parameters[0]);
    if (amount && dataId > 0) {
      rewards.loot.push({ itemId: nativeItemKey(kind, dataId), quantity: amount, chance: 1 });
      rewards.commandIndexes.push(index);
    }
  }
}

function victoryRewardsForBattle(list, battleCommandIndex) {
  const battleCommand = list[battleCommandIndex];
  const battleIndent = Number(battleCommand.indent || 0);
  const rewards = { experience: 0, gold: 0, loot: [], commandIndexes: [] };
  let victoryStarted = false;
  for (let index = battleCommandIndex + 1; index < list.length; index += 1) {
    const command = list[index];
    if (!command) break;
    if (command.indent === battleIndent && (command.code === 602 || command.code === 603 || command.code === 0)) break;
    if (command.code === 601 && command.indent === battleIndent) {
      victoryStarted = true;
      continue;
    }
    if (!victoryStarted || command.indent !== battleIndent + 1) continue;
    addDirectMvReward(rewards, command, index);
  }
  return rewards;
}

// Quest rewards are authored as an immediate run of native Change Gold, Change
// EXP and/or Change Item/Weapon/Armor commands directly after the verified
// MMO NPC_ACTION quest_turn_in command. Stopping at the first other command
// keeps arbitrary event scripts, switches and nested conditions non-authoritative.
function turnInRewardsForNpcAction(list, actionCommandIndex) {
  const actionCommand = list && list[actionCommandIndex];
  const actionIndent = Number(actionCommand && actionCommand.indent || 0);
  const rewards = { experience: 0, gold: 0, loot: [], commandIndexes: [] };
  for (let index = actionCommandIndex + 1; index < (list || []).length; index += 1) {
    const command = list[index];
    if (!command || Number(command.indent || 0) !== actionIndent) break;
    if ([125, 126, 127, 128, 315].indexOf(command.code) === -1) break;
    addDirectMvReward(rewards, command, index);
  }
  return rewards;
}

/**
 * Verify a tagged direct Battle Processing command and expose its metadata.
 * The context's page/command coordinates are client-reported but fully checked
 * against the project map file.
 */
function verifyTaggedBattleEvent(context) {
  const mapId = integer(context && context.mapId);
  const eventId = integer(context && context.eventId);
  const pageIndex = integer(context && context.pageIndex);
  const commandIndex = integer(context && context.commandIndex);
  if (![mapId, eventId, pageIndex, commandIndex].every(isInteger) || mapId < 1 || eventId < 1 || pageIndex < 0 || commandIndex < 0) {
    return error('mmo_event_invalid', 'Contexte d’événement MMO invalide.');
  }
  const map = readMap(mapId);
  if (!map || !Array.isArray(map.events)) return error('mmo_event_invalid', 'Carte MV introuvable pour cet événement.');
  const event = map.events[eventId];
  const page = event && Array.isArray(event.pages) ? event.pages[pageIndex] : null;
  const list = page && Array.isArray(page.list) ? page.list : null;
  const command = list && list[commandIndex];
  if (!command || command.code !== 301) return error('mmo_event_invalid', 'Commande de combat MMO introuvable dans cet événement.');
  const metadata = parseMmoMetadata(commentsImmediatelyBefore(list, commandIndex));
  if (!metadata || !metadata.coop) return error('mmo_event_not_tagged', 'Ce combat n’est pas marqué comme événement MMO coopératif.');
  const coop = String(metadata.coop).toLowerCase();
  if (['solo', 'optional', 'required'].indexOf(coop) === -1) return error('mmo_event_invalid', 'Valeur coop MMO invalide dans le commentaire.');
  // RPG Maker MV Battle Processing: parameter 0 is designation type; 0 means
  // a fixed troop in parameter 1. Variable/random designations cannot be
  // securely matched to a single server encounter yet.
  if (Number((command.parameters || [])[0]) !== 0) return error('mmo_event_troop_invalid', 'Le combat MMO doit utiliser une troupe définie directement.');
  const troopId = integer((command.parameters || [])[1]);
  if (!isInteger(troopId) || troopId < 1) return error('mmo_event_troop_invalid', 'Troupe MV invalide dans l’événement.');
  const eventX = integer(event.x);
  const eventY = integer(event.y);
  if (!isInteger(eventX) || !isInteger(eventY)) return error('mmo_event_invalid', 'Position du monstre MV invalide.');
  return {
    ok: true,
    mapId,
    eventId,
    pageIndex,
    commandIndex,
    troopId,
    eventX,
    eventY,
    coop,
    metadata,
    // Battle Processing parameter #2 is the native RPG Maker MV
    // "Can Escape" checkbox. The server rereads it rather than trusting UI.
    canEscape: !!(command.parameters || [])[2],
    rewards: victoryRewardsForBattle(list, commandIndex)
  };
}

function battleKey(value) {
  const key = String(value || '').toLowerCase();
  return /^[a-z][a-z0-9_-]{0,31}$/.test(key) ? key : null;
}

function questKey(value) {
  const key = String(value || '').toLowerCase();
  return /^[a-z][a-z0-9_-]{0,63}$/.test(key) ? key : null;
}

function nativeQuestModes(value) {
  const modes = String(value || '').toLowerCase().split(/[|,]/).map((entry) => entry.trim()).filter(Boolean);
  const unique = modes.filter((entry, index) => ['solo', 'group'].indexOf(entry) !== -1 && modes.indexOf(entry) === index);
  return unique.length ? unique : null;
}

function nativeQuestInteger(value, minimum, maximum) {
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum ? number : null;
}

// A native quest is authored as a page comment on a quest giver, for example:
// <MMO quest=slime_gel_delivery title="Échantillons de gelée"
//      modes=solo|group objective=collect item_id=5 goal=3>
// Rewards are authored as immediate native Change commands in the verified
// quest_turn_in branch, never as objective-comment attributes.
// The server reads MapXXX.json directly; this definition is never accepted from
// a client packet. Existing content.js quests remain a compatibility fallback.
function nativeQuestDefinition(metadata, source) {
  const id = questKey(metadata && metadata.quest);
  const title = String(metadata && metadata.title || '').trim();
  const allowedModes = nativeQuestModes(metadata && metadata.modes);
  const objectiveType = String(metadata && metadata.objective || '').toLowerCase();
  const goal = nativeQuestInteger(metadata && metadata.goal, 1, 100000);
  if (!id || !title || title.length > 96 || !allowedModes || !goal) return null;
  let objective;
  if (objectiveType === 'collect') {
    // `item_id` is the direct RPG Maker MV database Item ID. It resolves to
    // the same canonical mv:item:N inventory key used by native Change Items
    // victory commands and enemy drops, so new quests need no content.js map.
    const nativeItemId = nativeQuestInteger(metadata && metadata.item_id, 1, 999999);
    if (nativeItemId) {
      const item = entryAt(loadDatabase(), 'items', nativeItemId);
      if (!item) return null;
      const itemId = nativeItemKey('item', nativeItemId);
      objective = {
        type: 'collect', itemId, nativeItemId,
        text: String(metadata.objective_text || ('Collecter ' + goal + ' × ' + (item.name || ('objet #' + nativeItemId)) + '.')).trim()
      };
    } else {
      // v0.26 compatibility: pre-existing native definitions can keep their
      // server item key. New definitions should use item_id=MV_ID above.
      const itemId = questKey(metadata && metadata.item);
      if (!itemId) return null;
      objective = { type: 'collect', itemId, text: String(metadata.objective_text || ('Collecter ' + goal + ' × ' + itemId + '.')).trim() };
    }
  } else if (objectiveType === 'defeat') {
    const target = questKey(metadata && metadata.target);
    if (!target) return null;
    objective = { type: 'defeat', target, text: String(metadata.objective_text || ('Vaincre ' + goal + ' × ' + target + '.')).trim() };
  } else {
    return null;
  }
  return {
    id, title, allowedModes, objective, goal,
    // Native quests take their rewards from direct MV Change commands in the
    // quest_turn_in branch, never from metadata supplied beside the objective.
    reward: { experience: 0, gold: 0 },
    native: true,
    source: { mapId: source.mapId, eventId: source.eventId, pageIndex: source.pageIndex }
  };
}

let nativeQuestRegistryCache = null;
function nativeQuestRegistry() {
  const directory = dataDirectory();
  let files;
  try {
    files = fs.readdirSync(directory).filter((name) => /^Map\d+\.json$/i.test(name)).sort();
  } catch (_) {
    return { definitions: {}, declaredIds: {}, errors: {} };
  }
  const signature = files.map((name) => {
    try {
      const stat = fs.statSync(path.join(directory, name));
      return name + ':' + stat.mtimeMs + ':' + stat.size;
    } catch (_) { return name + ':missing'; }
  }).join('|');
  if (nativeQuestRegistryCache && nativeQuestRegistryCache.directory === directory && nativeQuestRegistryCache.signature === signature) {
    return nativeQuestRegistryCache.registry;
  }
  const registry = { definitions: {}, declaredIds: {}, errors: {} };
  files.forEach((name) => {
    const match = /^Map(\d+)\.json$/i.exec(name);
    const mapId = match ? Number(match[1]) : 0;
    const map = mapId ? readMap(mapId) : null;
    if (!map || !Array.isArray(map.events)) return;
    map.events.forEach((event, eventId) => {
      if (!event || !Array.isArray(event.pages)) return;
      event.pages.forEach((page, pageIndex) => {
        const list = page && Array.isArray(page.list) ? page.list : [];
        const pageMetadata = pageMmoMetadata(list);
        if (!pageMetadata || String(pageMetadata.npc || '').toLowerCase() !== 'quest_giver') return;
        list.forEach((command) => {
          if (!command || (command.code !== 108 && command.code !== 408)) return;
          const metadata = parseMmoMetadata(String((command.parameters || [])[0] || ''));
          // Only comments carrying objective data define a native quest. Action
          // comments such as npc-action=quest_start are not definitions.
          if (!metadata || !metadata.quest || !metadata.objective) return;
          const declaredId = questKey(metadata.quest);
          if (!declaredId) return;
          registry.declaredIds[declaredId] = true;
          const definition = nativeQuestDefinition(metadata, { mapId, eventId, pageIndex });
          if (!definition) {
            registry.errors[declaredId] = 'Définition native de quête invalide.';
            delete registry.definitions[declaredId];
            return;
          }
          if (registry.definitions[definition.id] || registry.errors[definition.id]) {
            registry.errors[definition.id] = 'Identifiant de quête native dupliqué.';
            delete registry.definitions[definition.id];
            return;
          }
          registry.definitions[definition.id] = definition;
        });
      });
    });
  });
  nativeQuestRegistryCache = { directory, signature, registry };
  return registry;
}

function nativeQuestById(questId) {
  const id = questKey(questId);
  return id ? nativeQuestRegistry().definitions[id] || null : null;
}

function nativeQuestDefinitions() {
  return Object.assign({}, nativeQuestRegistry().definitions);
}

function nativeQuestForNpcAction(verified, questId) {
  const id = questKey(questId);
  const registry = nativeQuestRegistry();
  if (!id || !registry.declaredIds[id]) return null;
  const definition = registry.definitions[id];
  if (!definition) return { error: 'La définition native de cette quête est invalide ou dupliquée.' };
  const source = definition.source || {};
  if (!verified || Number(source.mapId) !== Number(verified.mapId) || Number(source.eventId) !== Number(verified.eventId) || Number(source.pageIndex) !== Number(verified.pageIndex)) {
    return { error: 'Cette quête doit être acceptée et rendue auprès de son donneur configuré.' };
  }
  return { definition };
}

function pluginBattleLobbyAction(command) {
  if (!command || command.code !== 356) return null;
  // Canonical MV command: MMO BATTLE_LOBBY OPEN|JOIN battle_key.
  // RPG Maker authors commonly type the words separately in the Plugin
  // Command field, so accept BATTLE LOBBY and BATTLELOBBY as harmless
  // aliases. The real map/page/tag/troop is still re-read below.
  const raw = String((command.parameters || [])[0] || '').trim();
  const match = /^MMO\s+(?:BATTLE(?:[_\s-]?LOBBY)|BATTLELOBBY)\s+(OPEN|JOIN)\s+([a-z][a-z0-9_-]{0,31})\s*$/i.exec(raw);
  if (!match) return null;
  const action = String(match[1] || '').toLowerCase();
  const key = battleKey(match[2]);
  return ['open', 'join'].indexOf(action) !== -1 && key ? { action, key } : null;
}

// When an author reports a lobby command failure, the useful fact is the
// command read from the server's own MapXXX.json, not the text visible in a
// possibly different editor/export copy. Keep the diagnostic short and free
// of control characters; it is only returned with a failed, authenticated
// in-game action and does not loosen event verification.
function describeLobbyCommand(command) {
  if (!command) return 'aucune commande';
  if (command.code !== 356) return 'commande MV code ' + String(command.code);
  const raw = String((command.parameters || [])[0] || '').replace(/[\r\n\t]+/g, ' ').trim();
  return raw ? raw.slice(0, 140) : 'commande de plugin vide';
}

// A lobby command does not trust a troop or a free event identifier. It must
// reference a unique, tagged Battle Processing command on the same real MV
// event page. This lets native Show Choices prepare/join a party encounter
// before the ordinary Battle Processing branch starts it.
function verifyTaggedBattleLobbyAction(context, requestedAction, requestedKey) {
  const mapId = integer(context && context.mapId);
  const eventId = integer(context && context.eventId);
  const pageIndex = integer(context && context.pageIndex);
  const commandIndex = integer(context && context.commandIndex);
  const action = String(requestedAction || '').toLowerCase();
  const key = battleKey(requestedKey);
  if (![mapId, eventId, pageIndex, commandIndex].every(isInteger) || mapId < 1 || eventId < 1 || pageIndex < 0 || commandIndex < 0 || ['open', 'join'].indexOf(action) === -1 || !key) {
    return error('battle_lobby_invalid', 'Contexte de lobby de combat invalide.');
  }
  const map = readMap(mapId);
  const event = map && Array.isArray(map.events) ? map.events[eventId] : null;
  const page = event && Array.isArray(event.pages) ? event.pages[pageIndex] : null;
  const list = page && Array.isArray(page.list) ? page.list : null;
  const command = list && list[commandIndex];
  const plugin = pluginBattleLobbyAction(command);
  if (!plugin) {
    return error('battle_lobby_invalid', 'Commande de lobby invalide. Le serveur lit Map' + String(mapId).padStart(3, '0') + '.json' +
      ', événement #' + eventId + ', page ' + (pageIndex + 1) + ', commande ' + (commandIndex + 1) +
      ' : « ' + describeLobbyCommand(command) + ' ». Utilise : MMO BATTLE_LOBBY OPEN identifiant, ou MMO BATTLE_LOBBY JOIN identifiant.');
  }
  if (plugin.action !== action || plugin.key !== key) {
    return error('battle_lobby_invalid', 'Lobby incohérent : la carte lue par le serveur contient « ' + describeLobbyCommand(command) +
      ' », mais le client demande ' + action.toUpperCase() + ' ' + key + '. Vérifie que serveur et client utilisent le même MapXXX.json.');
  }
  const actionMetadata = parseMmoMetadata(commentsImmediatelyBefore(list, commandIndex));
  if (!actionMetadata || battleKey(actionMetadata.battle) !== key) return error('battle_lobby_not_tagged', 'La branche de lobby doit porter <MMO battle=...>.');
  const matches = [];
  (list || []).forEach((candidate, index) => {
    if (!candidate || candidate.code !== 301) return;
    const metadata = parseMmoMetadata(commentsImmediatelyBefore(list, index));
    if (metadata && battleKey(metadata.battle) === key) matches.push(index);
  });
  if (matches.length !== 1) return error('battle_lobby_invalid', 'Le lobby doit référencer exactement un Traiter une bataille marqué par ce battle=.');
  const battle = verifyTaggedBattleEvent({ mapId, eventId, pageIndex, commandIndex: matches[0] });
  if (!battle.ok) return battle;
  if (battle.coop === 'solo') return error('battle_lobby_invalid', 'Un combat coop=solo ne peut pas ouvrir de lobby de groupe.');
  return Object.assign({}, battle, { lobbyAction: action, lobbyCommandIndex: commandIndex, battleKey: key, actionMetadata });
}

// The page-level NPC configuration is the single comment that itself carries
// `npc=...`. Branch action comments are deliberately excluded: otherwise a
// later choice branch could override a merchant's shop/mode configuration.
function pageMmoMetadata(list) {
  let metadata = null;
  for (const command of list || []) {
    if (!command || (command.code !== 108 && command.code !== 408)) continue;
    const parsed = parseMmoMetadata(String((command.parameters || [])[0] || ''));
    if (!parsed || !parsed.npc) continue;
    // One event page represents one physical NPC service. Multiple identities
    // are ambiguous and fail closed rather than selecting whichever comment
    // happened to occur last.
    if (metadata) return null;
    metadata = parsed;
  }
  return metadata;
}

function pluginNpcAction(command) {
  if (!command || command.code !== 356) return null;
  const parts = String((command.parameters || [])[0] || '').trim().split(/\s+/);
  if (parts.length !== 3 || String(parts[0] || '').toUpperCase() !== 'MMO' || String(parts[1] || '').toUpperCase() !== 'NPC_ACTION') return null;
  const action = String(parts[2] || '').toLowerCase();
  return /^[a-z][a-z0-9_-]{0,31}$/.test(action) ? action : null;
}

/**
 * Verify an MMO service action emitted from a native event branch. The client
 * supplies only coordinates and an action token; this module rereads MapXXX,
 * checks the page-level NPC tag, its exact action comment and the actual MV
 * Plugin Command. The server then performs its own proximity check.
 */
function verifyTaggedNpcAction(context, requestedAction) {
  const mapId = integer(context && context.mapId);
  const eventId = integer(context && context.eventId);
  const pageIndex = integer(context && context.pageIndex);
  const commandIndex = integer(context && context.commandIndex);
  const action = String(requestedAction || '').toLowerCase();
  if (![mapId, eventId, pageIndex, commandIndex].every(isInteger) || mapId < 1 || eventId < 1 || pageIndex < 0 || commandIndex < 0 || !/^[a-z][a-z0-9_-]{0,31}$/.test(action)) {
    return error('npc_event_invalid', 'Contexte de PNJ MMO invalide.');
  }
  const map = readMap(mapId);
  if (!map || !Array.isArray(map.events)) return error('npc_event_invalid', 'Carte MV introuvable pour ce PNJ.');
  const event = map.events[eventId];
  const page = event && Array.isArray(event.pages) ? event.pages[pageIndex] : null;
  const list = page && Array.isArray(page.list) ? page.list : null;
  const command = list && list[commandIndex];
  const commandAction = pluginNpcAction(command);
  if (!commandAction || commandAction !== action) return error('npc_event_invalid', 'Commande MMO NPC_ACTION introuvable ou invalide.');
  const pageMetadata = pageMmoMetadata(list);
  const service = String(pageMetadata && pageMetadata.npc || '').toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(service)) return error('npc_event_not_tagged', 'Ce PNJ ne possède pas de commentaire MMO npc valide.');
  const actionMetadata = parseMmoMetadata(commentsImmediatelyBefore(list, commandIndex));
  if (!actionMetadata || String(actionMetadata['npc-action'] || '').toLowerCase() !== action) {
    return error('npc_event_not_tagged', 'L’action du PNJ doit être marquée par un commentaire MMO npc-action.');
  }
  const eventX = integer(event.x);
  const eventY = integer(event.y);
  if (!isInteger(eventX) || !isInteger(eventY)) return error('npc_event_invalid', 'Position du PNJ MV invalide.');
  const rewards = action === 'quest_turn_in' ? turnInRewardsForNpcAction(list, commandIndex) : { experience: 0, gold: 0, loot: [], commandIndexes: [] };
  return { ok: true, mapId, eventId, pageIndex, commandIndex, service, action, eventX, eventY, metadata: pageMetadata, actionMetadata, rewards };
}

// Builds a server-owned fallback encounter from the troop selected in a
// verified MV event. This removes the need to add every ordinary map battle to
// content.js: author the troop and enemies in RPG Maker, then tag the event.
// Explicit ENCOUNTERS still take precedence where bespoke loot/quest rules are
// desired.
function nativeEncounterForTroop(troopId) {
  let database;
  try { database = loadDatabase(); } catch (_) { database = null; }
  const troop = database && entryAt(database, 'troops', troopId);
  if (!troop) return error('mmo_event_troop_invalid', 'Troupe MV introuvable.');
  const members = (troop.members || []).filter((member) => member && Number(member.enemyId) > 0);
  if (!members.length) return error('mmo_event_troop_invalid', 'La troupe MV ne contient aucun ennemi.');
  const enemies = [];
  const loot = [];
  let experience = 0;
  let gold = 0;
  for (const member of members) {
    const enemy = entryAt(database, 'enemies', member.enemyId);
    if (!enemy) return error('mmo_event_troop_invalid', 'Ennemi MV #' + member.enemyId + ' introuvable dans la troupe.');
    const params = enemy.params || [];
    enemies.push({
      templateId: 'mv_enemy_' + Number(enemy.id),
      mvEnemyId: Number(enemy.id),
      name: enemy.name || ('Ennemi ' + enemy.id),
      level: 1,
      hp: Math.max(1, Number(params[0] || 1)),
      mp: Math.max(0, Number(params[1] || 0)),
      atk: Math.max(1, Number(params[2] || 1)),
      def: Math.max(0, Number(params[3] || 0)),
      mat: Math.max(0, Number(params[4] || 0)),
      mdf: Math.max(0, Number(params[5] || 0)),
      agi: Math.max(1, Number(params[6] || 1))
    });
    experience += Math.max(0, Number(enemy.exp || 0));
    gold += Math.max(0, Number(enemy.gold || 0));
    loot.push.apply(loot, lootForEnemy(enemy));
  }
  return {
    ok: true,
    id: 'mv_troop_' + Number(troop.id),
    title: troop.name || ('Troupe ' + troop.id),
    mvTroopId: Number(troop.id),
    allowEvent: true,
    native: true,
    enemies,
    rewards: { experience, gold },
    loot,
    questProgress: []
  };
}

module.exports = {
  parseMmoMetadata,
  commentsImmediatelyBefore,
  victoryRewardsForBattle,
  turnInRewardsForNpcAction,
  verifyTaggedBattleEvent,
  verifyTaggedBattleLobbyAction,
  verifyTaggedNpcAction,
  nativeQuestById,
  nativeQuestDefinitions,
  nativeQuestForNpcAction,
  nativeEncounterForTroop
};
