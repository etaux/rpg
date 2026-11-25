'use strict';

const { MV_MAPPING } = require('./mv-mapping');

// This is server-owned game data. Keep rewards, objectives, combat data and
// dungeon access rules here rather than trusting the RPG Maker client.
const startMapId = Number(process.env.START_MAP_ID || 1);
const startX = Number(process.env.START_X || 10);
const startY = Number(process.env.START_Y || 10);

const CLASSES = {
  warrior: {
    id: 'warrior', label: 'Guerrier', description: 'Défenseur de mêlée résistant.', mv: MV_MAPPING.actors.warrior,
    baseStats: { hp: 140, mp: 20, atk: 16, def: 14, mat: 4, mdf: 8, agi: 8, luk: 10 }
  },
  mage: {
    id: 'mage', label: 'Mage', description: 'Lanceur de sorts offensifs.', mv: MV_MAPPING.actors.mage,
    baseStats: { hp: 75, mp: 70, atk: 5, def: 6, mat: 18, mdf: 13, agi: 10, luk: 12 }
  },
  archer: {
    id: 'archer', label: 'Archer', description: 'Attaquant agile à distance.', mv: MV_MAPPING.actors.archer,
    baseStats: { hp: 95, mp: 30, atk: 14, def: 8, mat: 6, mdf: 8, agi: 16, luk: 14 }
  },
  priest: {
    id: 'priest', label: 'Prêtre', description: 'Soutien, soin et protection.', mv: MV_MAPPING.actors.priest,
    baseStats: { hp: 90, mp: 60, atk: 6, def: 8, mat: 13, mdf: 16, agi: 9, luk: 13 }
  }
};

// Consumables and legacy fallback actions. With data/Classes.json and
// data/Skills.json available, class skills are read natively from MV class
// learnings; the server keeps these definitions only as a safe fallback.
const BATTLE_ACTIONS = {
  attack: { id: 'attack', mvSkillId: MV_MAPPING.skills.attack, label: 'Attaquer', type: 'physical', power: 1, mpCost: 0, targetType: 'enemy' },
  guard: { id: 'guard', mvSkillId: MV_MAPPING.skills.guard, label: 'Défendre', type: 'guard', power: 0, mpCost: 0, targetType: 'self' },
  shield_bash: { id: 'shield_bash', mvSkillId: MV_MAPPING.skills.shield_bash, label: 'Coup de bouclier', type: 'physical', power: 1.5, mpCost: 5, targetType: 'enemy' },
  firebolt: { id: 'firebolt', mvSkillId: MV_MAPPING.skills.firebolt, label: 'Éclair de feu', type: 'magical', power: 1.65, mpCost: 8, targetType: 'enemy' },
  power_shot: { id: 'power_shot', mvSkillId: MV_MAPPING.skills.power_shot, label: 'Tir puissant', type: 'physical', power: 1.55, mpCost: 6, targetType: 'enemy' },
  heal: { id: 'heal', mvSkillId: MV_MAPPING.skills.heal, label: 'Soin', type: 'heal', power: 1.55, mpCost: 8, targetType: 'ally' },
  healing_potion: { id: 'healing_potion', mvItem: MV_MAPPING.items.healing_potion, label: 'Potion de soin', type: 'item_heal', recovery: 55, mpCost: 0, targetType: 'ally', itemId: 'healing_potion' }
};

const CLASS_ACTIONS = {
  warrior: ['attack', 'guard', 'shield_bash'],
  mage: ['attack', 'guard', 'firebolt'],
  archer: ['attack', 'guard', 'power_shot'],
  priest: ['attack', 'guard', 'heal']
};

// Inventory definitions are also server-owned. The MV client only displays the
// snapshot it receives and asks the server to equip an owned valid item.
const ITEMS = {
  training_sword: { id: 'training_sword', mv: MV_MAPPING.items.training_sword, label: 'Épée d’entraînement', type: 'equipment', slot: 'weapon', etypeId: 1, classes: ['warrior'], description: 'Une lame robuste pour débuter.', tradable: true, stats: { atk: 5 } },
  apprentice_staff: { id: 'apprentice_staff', mv: MV_MAPPING.items.apprentice_staff, label: 'Bâton d’apprenti', type: 'equipment', slot: 'weapon', etypeId: 1, classes: ['mage'], description: 'Canalise les premiers sorts.', tradable: true, stats: { mat: 5, mp: 8 } },
  hunter_bow: { id: 'hunter_bow', mv: MV_MAPPING.items.hunter_bow, label: 'Arc de chasseur', type: 'equipment', slot: 'weapon', etypeId: 1, classes: ['archer'], description: 'Un arc léger et précis.', tradable: true, stats: { atk: 4, agi: 2 } },
  novice_relic: { id: 'novice_relic', mv: MV_MAPPING.items.novice_relic, label: 'Relique du novice', type: 'equipment', slot: 'weapon', etypeId: 1, classes: ['priest'], description: 'Une relique vouée au soutien.', tradable: true, stats: { mat: 4, mdf: 3 } },
  cloth_tunic: { id: 'cloth_tunic', mv: MV_MAPPING.items.cloth_tunic, label: 'Tunique de toile', type: 'equipment', slot: 'armor', etypeId: 4, classes: ['warrior', 'mage', 'archer', 'priest'], description: 'Une protection légère.', tradable: true, stats: { hp: 12, def: 2 } },
  slime_gel: { id: 'slime_gel', mv: MV_MAPPING.items.slime_gel, label: 'Gelée de slime', type: 'material', description: 'Un matériau visqueux à utiliser plus tard en artisanat.', tradable: true, stats: {} },
  // This server item intentionally has no native MV entry yet. It remains a
  // valid persistent material and is counted only when an authoritative wolf
  // loot/gathering source grants it after the quest has started.
  wolf_pelt: { id: 'wolf_pelt', mv: MV_MAPPING.items.wolf_pelt, label: 'Peau de loup', type: 'material', description: 'Une peau récupérée sur un loup vaincu.', tradable: true, stats: {} },
  healing_potion: { id: 'healing_potion', mv: MV_MAPPING.items.healing_potion, label: 'Potion de soin', type: 'consumable', description: 'Restaure 55 PV à un allié pendant un combat.', tradable: true, stats: {} },
  guild_banner: { id: 'guild_banner', mv: MV_MAPPING.items.guild_banner, label: 'Bannière de guilde', type: 'furniture', description: 'Une bannière à placer dans la maison de guilde.', tradable: true, color: '#8c5bd8', shortLabel: 'B' },
  wooden_table: { id: 'wooden_table', mv: MV_MAPPING.items.wooden_table, label: 'Table en bois', type: 'furniture', description: 'Une table simple pour la salle commune.', tradable: true, color: '#a8794c', shortLabel: 'T' },
  wall_torch: { id: 'wall_torch', mv: MV_MAPPING.items.wall_torch, label: 'Torche murale', type: 'furniture', description: 'Éclaire une pièce de guilde.', tradable: true, color: '#e5a642', shortLabel: 'F' },
  guild_chest: { id: 'guild_chest', mv: MV_MAPPING.items.guild_chest, label: 'Coffre de guilde', type: 'fixture', description: 'Coffre commun de la guilde.', tradable: false, color: '#c99b4c', shortLabel: 'C' }
};

const STARTER_ITEMS = {
  warrior: [{ itemId: 'training_sword', quantity: 1 }, { itemId: 'cloth_tunic', quantity: 1 }, { itemId: 'healing_potion', quantity: 3 }],
  mage: [{ itemId: 'apprentice_staff', quantity: 1 }, { itemId: 'cloth_tunic', quantity: 1 }, { itemId: 'healing_potion', quantity: 3 }],
  archer: [{ itemId: 'hunter_bow', quantity: 1 }, { itemId: 'cloth_tunic', quantity: 1 }, { itemId: 'healing_potion', quantity: 3 }],
  priest: [{ itemId: 'novice_relic', quantity: 1 }, { itemId: 'cloth_tunic', quantity: 1 }, { itemId: 'healing_potion', quantity: 3 }]
};

// A first troop usable from both a map event and optional random encounters.
// allowedMapIds should contain only actual map IDs from the MV project.
const ENCOUNTERS = {
  slime_pack: {
    id: 'slime_pack', title: 'Meute de slimes', mvTroopId: MV_MAPPING.troops.slime_pack,
    allowedMapIds: [1, 10],
    allowEvent: true,
    allowRandom: true,
    enemies: [
      { templateId: 'green_slime', mvEnemyId: MV_MAPPING.enemies.green_slime, name: 'Slime vert', level: 1, hp: 42, mp: 0, atk: 10, def: 4, mat: 0, mdf: 3, agi: 6 },
      { templateId: 'blue_slime', mvEnemyId: MV_MAPPING.enemies.blue_slime, name: 'Slime bleu', level: 1, hp: 38, mp: 0, atk: 9, def: 3, mat: 0, mdf: 5, agi: 8 },
      { templateId: 'red_slime', mvEnemyId: MV_MAPPING.enemies.red_slime, name: 'Slime rouge', level: 1, hp: 48, mp: 0, atk: 12, def: 4, mat: 0, mdf: 3, agi: 5 }
    ],
    rewards: { experience: 35, gold: 12 },
    loot: [
      { itemId: 'slime_gel', quantity: 1, chance: 1 },
      { itemId: 'healing_potion', quantity: 1, chance: 0.25 }
    ],
    questProgress: [
      { questId: 'rat_problem', amount: 3 }
    ]
  }
};

const QUESTS = {
  rat_problem: {
    id: 'rat_problem', title: 'Le problème des slimes', allowedModes: ['solo', 'group'],
    objective: { type: 'defeat', target: 'slime', text: 'Vaincre 5 slimes.' }, goal: 5, reward: { experience: 50, gold: 25 }
  },
  wolf_pelts: {
    id: 'wolf_pelts', title: 'Peaux pour le tanneur', allowedModes: ['solo', 'group'],
    objective: { type: 'collect', itemId: 'wolf_pelt', text: 'Collecter 5 peaux de loup.' }, goal: 5, reward: { experience: 65, gold: 35 }
  },
  crypt_sweep: {
    id: 'crypt_sweep', title: 'Nettoyage de la crypte', allowedModes: ['group'],
    objective: { type: 'defeat', target: 'crypt_guardian', text: 'Éliminer le gardien de la crypte.' }, goal: 1, reward: { experience: 100, gold: 60 }
  }
};

// Server-owned, unlimited starter catalogue. sellPrice is the price paid by
// the character; buyPrice is the buyback price paid by the merchant. Add or
// remove entries without changing a map event.
const SHOPS = {
  starter_general: {
    id: 'starter_general', title: 'Échoppe du voyageur', mode: 'both',
    items: {
      healing_potion: { sellPrice: 25, buyPrice: 10 },
      slime_gel: { sellPrice: 8, buyPrice: 3 },
      cloth_tunic: { sellPrice: 90, buyPrice: 35 },
      training_sword: { sellPrice: 110, buyPrice: 45 },
      apprentice_staff: { sellPrice: 110, buyPrice: 45 },
      hunter_bow: { sellPrice: 110, buyPrice: 45 },
      novice_relic: { sellPrice: 110, buyPrice: 45 },
      guild_banner: { sellPrice: 160, buyPrice: 60 },
      wooden_table: { sellPrice: 55, buyPrice: 20 },
      wall_torch: { sellPrice: 40, buyPrice: 15 }
    }
  }
};

// Every guild house uses the same MV map template but a separate logical
// instance and persistent house row. Create this map in the MV project.
const GUILD_HOUSE = {
  templateMapId: 11,
  spawn: { x: 10, y: 12, direction: 2 },
  chest: { x: 12, y: 12 },
  defaultBuildRole: 'officer',
  exit: { mapId: startMapId, x: startX, y: startY, direction: 2 }
};

const DUNGEONS = {
  forgotten_crypt: {
    id: 'forgotten_crypt', title: 'Crypte oubliée',
    // Create this map in RPG Maker MV and keep the same map id in the plugin/project.
    templateMapId: 10,
    spawn: { x: 10, y: 12, direction: 2 },
    exit: { mapId: startMapId, x: startX, y: startY, direction: 2 },
    minLevel: 1
  }
};

const START_POSITION = { mapId: startMapId, x: startX, y: startY, direction: 2 };

module.exports = {
  CLASSES, BATTLE_ACTIONS, CLASS_ACTIONS, ITEMS, STARTER_ITEMS, ENCOUNTERS,
  QUESTS, SHOPS, GUILD_HOUSE, DUNGEONS, START_POSITION
};
