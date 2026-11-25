'use strict';

/**
 * RPG Maker MV database mapping — project G:\\mmorpg\\mmorpg
 * =============================================================
 *
 * Updated from `npm run inspect:mv` on 18 November 2026.
 *
 * This is the explicit contract between persistent MMO IDs and MV database
 * IDs. The server remains authoritative for damage, rewards and ownership;
 * MV supplies the actor/enemy presentation, native windows, icons and
 * animations.
 */

const MV_MAPPING = {
  // Actor templates used when a shared MMO party is represented in
  // Scene_Battle. Harold supplies the Archer visual template and is switched
  // to the Archer class (ID 5) for the temporary in-battle actor.
  actors: {
    warrior: { actorId: 2, classId: 2 }, // Thérèse · Guerrier
    mage: { actorId: 3, classId: 3 }, // Marsha · Mage
    archer: { actorId: 1, classId: 5 }, // Harold · Archer
    priest: { actorId: 4, classId: 4 } // Lucius · Prêtre
  },

  // Server action keys → RPG Maker MV Skills IDs. Native visuals and MP
  // labels come from these skills; the server still validates every action.
  skills: {
    attack: 1, // Attaque
    guard: 2, // Garde
    shield_bash: 3, // Coup double — temporary presentation for Coup de bouclier
    firebolt: 9, // Feu
    power_shot: 4, // Double attaque — temporary presentation for Tir puissant
    heal: 8 // Soin
  },

  // Persistent MMO item key → MV database entry.
  // kind is one of item, weapon or armor. `null` means that the MMO item has
  // no matching entry in this MV database yet and retains its server label.
  items: {
    training_sword: { kind: 'weapon', id: 1 }, // Épée
    apprentice_staff: { kind: 'weapon', id: 3 }, // Bâton de bois
    hunter_bow: { kind: 'weapon', id: 4 }, // Arc
    novice_relic: { kind: 'weapon', id: 3 }, // Bâton de bois, priest presentation
    cloth_tunic: { kind: 'armor', id: 3 }, // Vêtements d'aventurier
    healing_potion: { kind: 'item', id: 1 }, // Potion
    slime_gel: { kind: 'item', id: 5 }, // Gelée de slime
    wolf_pelt: null, // server material; map it to an MV Item when the project adds one

    // Furniture is drawn by MMOHousing and has no native inventory entry.
    guild_banner: null,
    wooden_table: null,
    wall_torch: null,
    guild_chest: null
  },

  // The existing database only has one slime enemy. All three authoritative
  // slime variants use its native battler graphic in the shared battle.
  enemies: {
    green_slime: 2, // Slime
    blue_slime: 2, // Slime
    red_slime: 2, // Slime
    crypt_guardian: 4 // Minotaure
  },

  // A troop controls the troop layout and battleback shown by Scene_Battle.
  troops: {
    slime_pack: 5, // Slime ×3
    crypt_guardian: 4 // Minotaure
  }
};

module.exports = { MV_MAPPING };
