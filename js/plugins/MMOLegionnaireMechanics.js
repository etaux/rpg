/*:
 * @plugindesc v1.0 — Mécaniques avancées du Légionnaire des Cendres (RPG Maker MV).
 * @author Arena
 *
 * @param État Bastion immobile
 * @type state
 * @default 56
 * @desc État appliqué par Bastion immobile à l'allié protégé.
 *
 * @param État Rempart noir
 * @type state
 * @default 58
 * @desc État utilisé comme icône et durée de la Barrière.
 *
 * @param État Contre-coup sacrilège
 * @type state
 * @default 61
 * @desc État de posture qui déclenche une riposte après chaque dégât physique reçu.
 *
 * @help
 * ========================================================================
 * MMOLegionnaireMechanics
 * ========================================================================
 * Ce plugin complète les effets que RPG Maker MV ne sait pas faire seul :
 * - Interception d'une partie des dégâts par Bastion immobile ;
 * - Barrière chiffrée à partir de la DEF du lanceur ;
 * - État de protection appliqué à tout le groupe ;
 * - État personnel appliqué après une compétence ennemie/de zone ;
 * - Riposte APRES avoir subi chaque coup physique.
 *
 * Le plugin ne remplace pas MMOParameterCaps. Activez les deux.
 * Ordre conseillé :
 *   1. vos plugins tiers de combat
 *   2. MMOParameterCaps
 *   3. MMOLegionnaireMechanics
 *
 * PARAMÈTRES DE COMPÉTENCE (zone Notes de la compétence)
 *
 * <MMOBastion: 0.25>
 *   Ajoute l'État Bastion à l'allié ciblé. Le Légionnaire qui lance la
 *   compétence reçoit 25 % des dégâts finaux de cet allié pendant la durée
 *   de l'état. L'auto-ciblage ne crée pas de lien d'interception.
 *
 * <MMOBarrier: 1.20>
 *   Ajoute l'État Rempart noir et crée une barrière de DEF x 1,20 sur
 *   chaque allié ciblé. Un nouveau Rempart ne s'additionne pas : la plus
 *   grande valeur entre l'ancienne et la nouvelle est conservée.
 *
 * <MMOPartyState: 59>
 *   Ajoute l'état 59 à tous les alliés vivants du combat. Utilisé par
 *   Aube avortée pour la réduction de dégâts de groupe.
 *
 * <MMOSelfState: 53>
 *   Ajoute l'état 53 au lanceur une seule fois, même si la compétence vise
 *   plusieurs ennemis. Utilisé pour Provocation et Fureur du Halo.
 *
 * IMPORTANT
 * Les IDs 56, 58 et 61 doivent correspondre à vos États de base de données,
 * ou être modifiés dans les paramètres du plugin. Les tags 59 et 53 doivent
 * également être adaptés si vous choisissez d'autres IDs.
 */

(function() {
    'use strict';

    var pluginName = 'MMOLegionnaireMechanics';
    var parameters = PluginManager.parameters(pluginName);

    function stateParam(name, fallback) {
        var value = Number(parameters[name]);
        return isFinite(value) && value > 0 ? Math.floor(value) : fallback;
    }

    var STATE_BASTION = stateParam('État Bastion immobile', 56);
    var STATE_BARRIER = stateParam('État Rempart noir', 58);
    var STATE_COUNTER = stateParam('État Contre-coup sacrilège', 61);
    var counterInProgress = false;

    function numberFromMeta(item, key, fallback) {
        if (!item || !item.meta || item.meta[key] === undefined) {
            return fallback;
        }
        var value = Number(item.meta[key]);
        return isFinite(value) ? value : fallback;
    }

    function hasMeta(item, key) {
        return !!(item && item.meta && item.meta[key] !== undefined);
    }

    function alivePartyMembers(subject) {
        if (subject && subject.isActor && subject.isActor()) {
            return $gameParty.battleMembers().filter(function(member) {
                return member.isAlive();
            });
        }
        return subject.friendsUnit().aliveMembers();
    }

    function absorbBarrier(target, damage) {
        var shield = Number(target._mmoLegionnaireBarrier || 0);
        if (damage <= 0 || shield <= 0 || !target.isStateAffected(STATE_BARRIER)) {
            return damage;
        }

        var absorbed = Math.min(damage, shield);
        shield -= absorbed;
        target._mmoLegionnaireBarrier = shield;

        if (shield <= 0) {
            target._mmoLegionnaireBarrier = 0;
            target.removeState(STATE_BARRIER);
        }
        return damage - absorbed;
    }

    function showLog(text) {
        if (typeof BattleManager !== 'undefined' && BattleManager._logWindow) {
            BattleManager._logWindow.push('addText', text);
        }
    }

    // Applique les tags de compétence après le traitement MV habituel.
    var _Game_Action_apply = Game_Action.prototype.apply;
    Game_Action.prototype.apply = function(target) {
        _Game_Action_apply.call(this, target);

        var item = this.item();
        var subject = this.subject();
        if (!item || !subject) {
            return;
        }

        if (hasMeta(item, 'MMOBastion') && target && target.isAlive()) {
            var redirectRate = Math.max(0, Math.min(1, numberFromMeta(item, 'MMOBastion', 0.25)));
            target.addState(STATE_BASTION);
            if (target !== subject) {
                target._mmoLegionnaireBastion = {
                    protector: subject,
                    rate: redirectRate
                };
            }
        }

        if (hasMeta(item, 'MMOBarrier') && target && target.isAlive()) {
            var barrierRate = Math.max(0, numberFromMeta(item, 'MMOBarrier', 1.20));
            var barrierValue = Math.max(0, Math.floor(subject.def * barrierRate));
            target.addState(STATE_BARRIER);
            // Le Rempart est renouvelé, mais ne s'empile pas indéfiniment.
            target._mmoLegionnaireBarrier = Math.max(
                Number(target._mmoLegionnaireBarrier || 0),
                barrierValue
            );
        }

        if (hasMeta(item, 'MMOPartyState') && !this._mmoPartyStateApplied) {
            this._mmoPartyStateApplied = true;
            var partyStateId = Math.floor(numberFromMeta(item, 'MMOPartyState', 0));
            if (partyStateId > 0) {
                alivePartyMembers(subject).forEach(function(member) {
                    member.addState(partyStateId);
                });
            }
        }

        if (hasMeta(item, 'MMOSelfState') && !this._mmoSelfStateApplied) {
            this._mmoSelfStateApplied = true;
            var selfStateId = Math.floor(numberFromMeta(item, 'MMOSelfState', 0));
            if (selfStateId > 0) {
                subject.addState(selfStateId);
            }
        }
    };

    // Supprime les données invisibles lorsque l'état correspondant expire.
    var _Game_BattlerBase_eraseState = Game_BattlerBase.prototype.eraseState;
    Game_BattlerBase.prototype.eraseState = function(stateId) {
        _Game_BattlerBase_eraseState.call(this, stateId);
        if (stateId === STATE_BASTION) {
            this._mmoLegionnaireBastion = null;
        }
        if (stateId === STATE_BARRIER) {
            this._mmoLegionnaireBarrier = 0;
        }
    };

    // La barrière absorbe les dégâts avant les PV. Bastion intercepte ensuite
    // 25 % des dégâts restants. Les dégâts interceptés peuvent à leur tour
    // être absorbés par le Rempart du Légionnaire.
    var _Game_Action_executeDamage = Game_Action.prototype.executeDamage;
    Game_Action.prototype.executeDamage = function(target, value) {
        var protector = null;
        var redirected = 0;
        var finalValue = value;

        if (value > 0) {
            finalValue = absorbBarrier(target, finalValue);

            var bastion = target._mmoLegionnaireBastion;
            if (finalValue > 0 && bastion && target.isStateAffected(STATE_BASTION) &&
                    bastion.protector && bastion.protector.isAlive()) {
                redirected = Math.floor(finalValue * bastion.rate);
                finalValue -= redirected;
                protector = bastion.protector;
            }
        }

        _Game_Action_executeDamage.call(this, target, finalValue);

        if (protector && redirected > 0) {
            var protectedDamage = absorbBarrier(protector, redirected);
            if (protectedDamage > 0) {
                protector.gainHp(-protectedDamage);
                protector.onDamage(protectedDamage);
                protector.result().hpDamage += protectedDamage;
            }
            showLog(protector.name() + ' intercepte ' + redirected + ' dégâts.');
        }

        // Contrairement au contre natif de MV, cette riposte intervient APRÈS
        // les dégâts : le Légionnaire ne les esquive donc pas gratuitement.
        if (!counterInProgress && value > 0 && finalValue > 0 && this.isPhysical() &&
                target.isAlive() && target.isStateAffected(STATE_COUNTER) &&
                this.subject() && this.subject().isAlive() && this.subject() !== target) {
            counterInProgress = true;
            showLog(target.name() + ' déclenche Contre-coup sacrilège !');
            var counterAction = new Game_Action(target);
            counterAction.setAttack();
            counterAction.apply(this.subject());
            counterInProgress = false;
        }
    };

    window.MMOLegionnaireMechanics = window.MMOLegionnaireMechanics || {};
    window.MMOLegionnaireMechanics.barrierValue = function(battler) {
        return Number(battler._mmoLegionnaireBarrier || 0);
    };
})();
