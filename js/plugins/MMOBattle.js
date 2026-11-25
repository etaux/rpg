/*:
 * @plugindesc v0.19.0 Combat coopératif MMO, états et PV/PM persistants.
 * @author Arena MMO starter
 *
 * @param UseNativeSceneBattle
 * @text Utiliser Scene_Battle native
 * @type boolean
 * @default true
 * @desc Utilise les fenêtres, troupes, sprites et animations de RPG Maker MV.
 *
 * @param EnableRandomEncounters
 * @text Enable random encounters
 * @type boolean
 * @default false
 *
 * @param RandomEncounterId
 * @text Random encounter id
 * @type string
 * @default slime_pack
 *
 * @param RandomEncounterMapIds
 * @text Random encounter map ids
 * @type string
 * @default 1,10
 *
 * @param RandomEncounterRegions
 * @text Random encounter regions
 * @type string
 * @default 1
 *
 * @param RandomChancePercent
 * @text Chance per walked tile
 * @type number
 * @min 0
 * @max 100
 * @decimals 2
 * @default 7
 *
 * @help
 * MMOBattle must be loaded below MMOFoundation.
 *
 * This plugin opens RPG Maker MV's native Scene_Battle for every member of a
 * shared battle. Its troop, actors, target lists, battle log, gauges, sprites
 * and skill/item animations are native MV components. The Node.js server keeps
 * authority: it alone validates turns, targets, MP, damage, death, loot and
 * rewards. The client never runs BattleManager's damage resolution.
 *
 * Event battle: MMO BATTLE_START slime_pack
 * Random battles: MMO RANDOM_ON / MMO RANDOM_OFF
 */

var Imported = Imported || {};
Imported.MMOBattle = true;
var MMOBattle = MMOBattle || {};

(function(Battle, Mmo) {
    'use strict';

    if (!Mmo || typeof Mmo.registerPacketHandler !== 'function') {
        console.error('MMOBattle requires MMOFoundation, loaded above it.');
        return;
    }

    var parameters = PluginManager.parameters('MMOBattle');
    function boolParameter(name, fallback) {
        var value = parameters[name];
        if (value === undefined || value === '') return fallback;
        return String(value).toLowerCase() === 'true';
    }
    function numberParameter(name, fallback) {
        var value = Number(parameters[name]);
        return isNaN(value) ? fallback : value;
    }
    function idList(value) {
        return String(value || '').split(',').map(function(item) { return item.trim(); }).filter(function(item) { return item !== ''; });
    }
    function numberOr(value, fallback) {
        var number = Number(value);
        return isNaN(number) ? fallback : number;
    }

    Battle.config = {
        useNativeScene: boolParameter('UseNativeSceneBattle', true),
        randomEnabled: boolParameter('EnableRandomEncounters', false),
        randomEncounterId: String(parameters.RandomEncounterId || 'slime_pack'),
        randomMapIds: idList(parameters.RandomEncounterMapIds || '1,10'),
        randomRegions: idList(parameters.RandomEncounterRegions || '1'),
        randomChance: Math.max(0, Math.min(100, numberParameter('RandomChancePercent', 7))) / 100
    };
    Battle.randomEnabled = Battle.config.randomEnabled;
    Battle.active = null;
    Battle.nativeActors = [];
    Battle.nativeBattleId = null;
    Battle.pendingAction = false;
    Battle.selectedAction = null;
    Battle.lastRandomRequestAt = 0;
    Battle.lastEventId = 0;
    Battle.lastLog = '';
    Battle.leavingScene = false;

    Battle.isNativeActive = function() {
        return !!(Battle.config.useNativeScene && Battle.active && Battle.nativeBattleId === Battle.active.battleId);
    };
    Battle.currentScene = function() {
        return typeof Scene_Battle !== 'undefined' && SceneManager._scene instanceof Scene_Battle ? SceneManager._scene : null;
    };
    Battle.currentActions = function() {
        return Battle.active && Battle.active.myTurn ? (Battle.active.actions || []) : [];
    };
    Battle.actorForId = function(id) {
        var key = String(id);
        return Battle.nativeActors.filter(function(actor) { return String(actor._mmoBattlerId) === key; })[0] || null;
    };
    Battle.enemyForId = function(id) {
        if (typeof $gameTroop === 'undefined' || !$gameTroop) return null;
        var key = String(id);
        return $gameTroop.members().filter(function(enemy) { return String(enemy._mmoBattlerId) === key; })[0] || null;
    };
    Battle.battlerForId = function(id) {
        return Battle.actorForId(id) || Battle.enemyForId(id);
    };

    // A network actor is a short-lived Game_Actor used only in the shared
    // battle scene. It deliberately receives all visible parameters from the
    // authoritative server packet; it never changes a local save file.
    Battle.NetworkActor = function(data) {
        this.initialize(data);
    };
    Battle.NetworkActor.prototype = Object.create(Game_Actor.prototype);
    Battle.NetworkActor.prototype.constructor = Battle.NetworkActor;
    Battle.NetworkActor.prototype.initialize = function(data) {
        var actorId = Math.max(1, numberOr(data.mvActorId, 1));
        Game_Actor.prototype.initialize.call(this, actorId);
        this._mmoBattlerId = String(data.id);
        this._mmoParams = {};
        this.applyMmoState(data);
    };
    Battle.NetworkActor.prototype.applyMmoState = function(data) {
        var classId = numberOr(data.mvClassId, this._classId);
        if (classId > 0 && typeof $dataClasses !== 'undefined' && $dataClasses && $dataClasses[classId]) {
            this.changeClass(classId, false);
        }
        if (data.appearance && typeof MMOAppearance !== 'undefined' && typeof MMOAppearance.applyToActor === 'function') {
            MMOAppearance.applyToActor(this, data.appearance);
        }
        this._mmoBattlerId = String(data.id);
        this._name = String(data.name || this._name || 'Aventurier');
        this._level = Math.max(1, numberOr(data.level, 1));
        var stats = data.stats || {};
        this._mmoParams = {
            0: Math.max(1, numberOr(data.maxHp, 1)),
            1: Math.max(0, numberOr(data.maxMp, 0)),
            2: Math.max(1, numberOr(stats.atk, 1)), 3: Math.max(1, numberOr(stats.def, 1)),
            4: Math.max(1, numberOr(stats.mat, 1)), 5: Math.max(1, numberOr(stats.mdf, 1)),
            6: Math.max(1, numberOr(stats.agi, 1)), 7: Math.max(0, numberOr(stats.luk, 0))
        };
        var desiredStates = (data.states || []).map(Number).filter(function(stateId) { return stateId > 0; });
        var previousStates = this._mmoPersistentStates || [];
        previousStates.forEach(function(stateId) {
            if (desiredStates.indexOf(stateId) === -1 && typeof this.removeState === 'function') this.removeState(stateId);
        }, this);
        desiredStates.forEach(function(stateId) {
            if (previousStates.indexOf(stateId) === -1 && typeof this.addState === 'function') this.addState(stateId);
        }, this);
        this._mmoPersistentStates = desiredStates;
        this._hp = Math.max(0, Math.min(this._mmoParams[0], numberOr(data.hp, 0)));
        this._mp = Math.max(0, Math.min(this._mmoParams[1], numberOr(data.mp, 0)));
        this._mmoGuarding = !!data.guarding;
    };
    Battle.NetworkActor.prototype.paramBase = function(paramId) {
        if (this._mmoParams && Object.prototype.hasOwnProperty.call(this._mmoParams, paramId)) return this._mmoParams[paramId];
        return Game_Actor.prototype.paramBase.call(this, paramId);
    };
    Battle.NetworkActor.prototype.paramRate = function(paramId) {
        // The server packet already includes persistent state parameter rates.
        if (this._mmoParams && Object.prototype.hasOwnProperty.call(this._mmoParams, paramId)) return 1;
        return Game_Actor.prototype.paramRate.call(this, paramId);
    };

    // Native Game_Enemy sprites are created from the mapped troop. The server
    // overwrites their visible values with authoritative combat state here.
    var _Game_Enemy_paramBase = Game_Enemy.prototype.paramBase;
    Game_Enemy.prototype.paramBase = function(paramId) {
        if (this._mmoParams && Object.prototype.hasOwnProperty.call(this._mmoParams, paramId)) return this._mmoParams[paramId];
        return _Game_Enemy_paramBase.call(this, paramId);
    };

    // Scene_Battle and its standard status/target windows ask Game_Party for
    // battle members. During an MMO battle they receive transient network
    // actors instead of the single local save-game party.
    var _Game_Party_battleMembers = Game_Party.prototype.battleMembers;
    Game_Party.prototype.battleMembers = function() {
        if (Battle.isNativeActive()) return Battle.nativeActors;
        return _Game_Party_battleMembers.call(this);
    };
    var _Game_Party_maxBattleMembers = Game_Party.prototype.maxBattleMembers;
    Game_Party.prototype.maxBattleMembers = function() {
        // Spriteset_Battle creates one Sprite_Actor per maxBattleMembers().
        // Allocate enough native sprites for a large MMO boss party instead of
        // silently reusing the four classic-party positions.
        if (Battle.isNativeActive()) return Math.max(_Game_Party_maxBattleMembers.call(this), Battle.nativeActors.length);
        return _Game_Party_maxBattleMembers.call(this);
    };

    function Window_MMOAction() {
        this.initialize.apply(this, arguments);
    }
    Window_MMOAction.prototype = Object.create(Window_Command.prototype);
    Window_MMOAction.prototype.constructor = Window_MMOAction;
    Window_MMOAction.prototype.initialize = function() {
        Window_Command.prototype.initialize.call(this, 0, 0);
        this.hide();
        this.deactivate();
    };
    Window_MMOAction.prototype.windowWidth = function() { return 280; };
    Window_MMOAction.prototype.numVisibleRows = function() {
        return Math.max(1, Math.min(5, Battle.currentActions().length || 1));
    };
    Window_MMOAction.prototype.makeCommandList = function() {
        Battle.currentActions().forEach(function(action) {
            var suffix = action.quantity !== null && action.quantity !== undefined ? ' ×' + Number(action.quantity) : (action.mpCost ? ' · ' + Number(action.mpCost) + ' MP' : '');
            this.addCommand(String(action.label || action.id) + suffix, 'mmoAction', true, action);
        }, this);
    };
    Window_MMOAction.prototype.setActions = function() {
        this.refresh();
        this.updatePlacement();
        this.select(0);
    };
    Window_MMOAction.prototype.updatePlacement = function() {
        var scene = Battle.currentScene();
        var statusHeight = scene && scene._statusWindow ? scene._statusWindow.height : 0;
        this.move(0, Graphics.boxHeight - statusHeight - this.windowHeight(), this.windowWidth(), this.windowHeight());
    };

    // Compact native battle HUD: it draws face graphics, gauges and turn state
    // from the same transient authoritative NetworkActor instances that power
    // the standard MV target and status windows.
    function Window_MMOCombatParty() {
        this.initialize.apply(this, arguments);
    }
    Window_MMOCombatParty.prototype = Object.create(Window_Base.prototype);
    Window_MMOCombatParty.prototype.constructor = Window_MMOCombatParty;
    Window_MMOCombatParty.prototype.initialize = function() {
        var width = Math.min(390, Math.max(250, Graphics.boxWidth - 16));
        Window_Base.prototype.initialize.call(this, Graphics.boxWidth - width - 8, 8, width, 156);
        this.opacity = 205;
        this._signature = '';
        this._battle = null;
        this._mmoPlayerCount = 0;
    };
    Window_MMOCombatParty.prototype.columnsForPlayerCount = function(count) {
        var normalizedCount = Math.max(1, Number(count || 1));
        return normalizedCount > 4 ? Math.min(5, normalizedCount) : (normalizedCount > 2 ? 2 : 1);
    };
    Window_MMOCombatParty.prototype.layoutForPlayerCount = function(count) {
        var normalizedCount = Math.max(1, Number(count || 1));
        if (normalizedCount === this._mmoPlayerCount) return;
        this._mmoPlayerCount = normalizedCount;
        var width = Math.min(390, Math.max(250, Graphics.boxWidth - 16));
        var rows = Math.ceil(normalizedCount / this.columnsForPlayerCount(normalizedCount));
        var height = Math.min(Graphics.boxHeight - 16, 52 + rows * 58 + this.standardPadding() * 2);
        this.move(Graphics.boxWidth - width - 8, 8, width, height);
        this.createContents();
    };
    Window_MMOCombatParty.prototype.setBattle = function(battle) {
        var players = battle.players || [];
        this.layoutForPlayerCount(players.length);
        var signature = JSON.stringify({
            players: players.map(function(player) { return [player.id, player.name, player.hp, player.maxHp, player.mp, player.maxMp]; }),
            turn: battle.turn ? [battle.turn.kind, battle.turn.id, battle.turn.name] : null
        });
        this._battle = battle;
        if (signature === this._signature) return;
        this._signature = signature;
        this.refresh();
    };
    Window_MMOCombatParty.prototype.refresh = function() {
        this.contents.clear();
        var battle = this._battle || { players: [] };
        var players = battle.players || [];
        var turn = battle.turn || null;
        this.contents.fontSize = 12;
        this.changeTextColor(this.systemColor());
        this.drawText(turn ? 'Tour : ' + String(turn.name || '') : 'Combat partagé', 0, 0, this.contentsWidth(), 18);
        this.resetTextColor();
        var columns = this.columnsForPlayerCount(players.length);
        var compact = players.length > 4;
        var cellWidth = Math.floor(this.contentsWidth() / columns);
        players.forEach(function(player, index) {
            var x = (index % columns) * cellWidth;
            var y = 25 + Math.floor(index / columns) * 58;
            var actor = Battle.actorForId(player.id);
            var faceName = actor && typeof actor.faceName === 'function' ? actor.faceName() : '';
            var faceIndex = actor && typeof actor.faceIndex === 'function' ? actor.faceIndex() : 0;
            var isTurn = turn && turn.kind === 'player' && String(turn.id) === String(player.id);
            var hpRate = Math.max(0, Number(player.hp || 0)) / Math.max(1, Number(player.maxHp || 1));
            var mpRate = Math.max(0, Number(player.mp || 0)) / Math.max(1, Number(player.maxMp || 1));
            if (compact) {
                var faceX = x + Math.max(0, Math.floor((cellWidth - 34) / 2));
                if (actor) this.drawActorFace(actor, faceX, y, 34, 34);
                else if (faceName) this.drawFace(faceName, faceIndex, faceX, y, 34, 34);
                else this.drawText('?', faceX, y + 6, 34, 'center');
                this.contents.fontSize = 10;
                this.changeTextColor(isTurn ? this.powerUpColor() : this.normalColor());
                this.drawText((isTurn ? '▶' : '') + String(player.name || 'Aventurier'), x + 1, y + 33, cellWidth - 2, 'center');
                this.drawGauge(x + 3, y + 45, Math.max(18, cellWidth - 6), hpRate, this.hpGaugeColor1(), this.hpGaugeColor2());
                this.drawGauge(x + 3, y + 52, Math.max(18, cellWidth - 6), mpRate, this.mpGaugeColor1(), this.mpGaugeColor2());
                this.contents.fontSize = 12;
                this.resetTextColor();
                return;
            }
            if (actor) this.drawActorFace(actor, x, y, 44, 44);
            else if (faceName) this.drawFace(faceName, faceIndex, x, y, 44, 44);
            else {
                this.changeTextColor(this.systemColor());
                this.drawText('?', x, y + 10, 42, 'center');
                this.resetTextColor();
            }
            var textX = x + 49;
            var textWidth = Math.max(54, cellWidth - 52);
            this.changeTextColor(isTurn ? this.powerUpColor() : this.normalColor());
            this.drawText((isTurn ? '▶ ' : '') + String(player.name || 'Aventurier'), textX, y - 2, textWidth);
            this.drawGauge(textX, y + 16, textWidth, hpRate, this.hpGaugeColor1(), this.hpGaugeColor2());
            this.drawGauge(textX, y + 33, textWidth, mpRate, this.mpGaugeColor1(), this.mpGaugeColor2());
            this.contents.fontSize = 10;
            this.changeTextColor(this.normalColor());
            this.drawText('PV ' + Number(player.hp || 0) + '/' + Number(player.maxHp || 0), textX + 3, y + 14, textWidth - 5);
            this.drawText('PM ' + Number(player.mp || 0) + '/' + Number(player.maxMp || 0), textX + 3, y + 31, textWidth - 5);
            this.contents.fontSize = 12;
            this.resetTextColor();
        }, this);
    };

    function Sprite_MMOEnemyBar() {
        this.initialize.apply(this, arguments);
    }
    Sprite_MMOEnemyBar.prototype = Object.create(Sprite.prototype);
    Sprite_MMOEnemyBar.prototype.constructor = Sprite_MMOEnemyBar;
    Sprite_MMOEnemyBar.prototype.initialize = function() {
        Sprite.prototype.initialize.call(this);
        this.bitmap = new Bitmap(156, 38);
        this.anchor.x = 0.5;
        this._signature = '';
        this.visible = false;
    };
    Sprite_MMOEnemyBar.prototype.setEnemy = function(enemy) {
        var signature = [enemy.id, enemy.name, enemy.hp, enemy.maxHp].join('|');
        if (signature === this._signature) return;
        this._signature = signature;
        var bitmap = this.bitmap;
        var width = bitmap.width;
        var hp = Math.max(0, Number(enemy.hp || 0));
        var maxHp = Math.max(1, Number(enemy.maxHp || 1));
        var rate = Math.max(0, Math.min(1, hp / maxHp));
        bitmap.clear();
        bitmap.fontSize = 13;
        bitmap.textColor = '#ffffff';
        bitmap.outlineColor = 'rgba(0,0,0,.9)';
        bitmap.outlineWidth = 3;
        bitmap.drawText(String(enemy.name || 'Ennemi'), 0, 0, width, 16, 'center');
        bitmap.fillRect(6, 19, width - 12, 13, 'rgba(0,0,0,.82)');
        bitmap.fillRect(8, 21, width - 16, 9, '#441b22');
        bitmap.gradientFillRect(8, 21, Math.floor((width - 16) * rate), 9, '#d44d55', '#f28a63', false);
        bitmap.fontSize = 10;
        bitmap.drawText(hp + ' / ' + maxHp, 0, 18, width, 14, 'center');
    };

    Battle.buildNativeActors = function(players) {
        Battle.nativeActors = (players || []).map(function(player) { return new Battle.NetworkActor(player); });
    };
    Battle.requestCollapse = function(battler) {
        if (!battler || battler._mmoCollapseRequested) return;
        battler._mmoCollapseRequested = true;
        if (typeof battler.performCollapse === 'function') battler.performCollapse();
        // Scene_Battle normally removes an enemy through BattleManager after a
        // local action. MMO battles bypass that local resolver, so guarantee
        // removal after the native collapse animation has had time to play.
        if (typeof battler.isEnemy === 'function' && battler.isEnemy()) {
            setTimeout(function() {
                if (Number(battler._mmoServerHp) <= 0 && typeof battler.hide === 'function') battler.hide();
            }, 550);
        }
    };
    Battle.applyEnemyState = function(enemy, data) {
        if (!enemy || !data) return;
        var previousHp = Number(enemy._mmoServerHp);
        enemy._mmoBattlerId = String(data.id);
        enemy._mmoParams = {
            0: Math.max(1, numberOr(data.maxHp, 1)),
            1: Math.max(0, numberOr(data.maxMp, 0)),
            2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 0
        };
        enemy._hp = Math.max(0, Math.min(enemy._mmoParams[0], numberOr(data.hp, 0)));
        enemy._mp = Math.max(0, Math.min(enemy._mmoParams[1], numberOr(data.mp, 0)));
        enemy._mmoServerHp = enemy._hp;
        enemy._originalName = String(data.name || enemy._originalName);
        enemy._letter = '';
        enemy._plural = false;
        // Setting HP to zero alone does not make a native Sprite_Enemy vanish.
        // Request the standard MV collapse effect exactly once on the transition.
        if (previousHp > 0 && enemy._hp <= 0) Battle.requestCollapse(enemy);
        if (enemy._hp > 0) enemy._mmoCollapseRequested = false;
    };
    Battle.syncBattlers = function(battle) {
        if (!battle) return;
        if (Battle.nativeActors.length !== (battle.players || []).length) Battle.buildNativeActors(battle.players);
        (battle.players || []).forEach(function(player, index) {
            if (Battle.nativeActors[index]) Battle.nativeActors[index].applyMmoState(player);
        });
        if (typeof $gameTroop !== 'undefined' && $gameTroop) {
            var enemies = $gameTroop.members();
            (battle.enemies || []).forEach(function(enemyData, index) {
                Battle.applyEnemyState(enemies[index], enemyData);
            });
        }
    };

    Battle.createCombatHud = function(scene) {
        if (!scene || scene._mmoCombatPartyWindow) return;
        scene._mmoCombatPartyWindow = new Window_MMOCombatParty();
        scene.addWindow(scene._mmoCombatPartyWindow);
        scene._mmoEnemyBars = [];
        var field = scene._spriteset && (scene._spriteset._battleField || scene._spriteset);
        (Battle.active && Battle.active.enemies || []).forEach(function() {
            var bar = new Sprite_MMOEnemyBar();
            scene._mmoEnemyBars.push(bar);
            if (field && field.addChild) field.addChild(bar);
        });
    };
    Battle.syncEnemyBars = function(scene, battle) {
        if (!scene || !scene._mmoEnemyBars) return;
        var sprites = scene._spriteset && scene._spriteset._enemySprites ? scene._spriteset._enemySprites : [];
        (battle.enemies || []).forEach(function(enemy, index) {
            var bar = scene._mmoEnemyBars[index];
            if (!bar) return;
            bar.setEnemy(enemy);
            // Spriteset_Battle sorts enemy sprites by their visual Y position,
            // while $gameTroop keeps editor/member order. Match the server's
            // stable battler id instead of array index so a bar always follows
            // the exact enemy currently selected by the native target window.
            var sprite = sprites.filter(function(candidate) {
                return candidate && candidate._battler && String(candidate._battler._mmoBattlerId) === String(enemy.id);
            })[0] || null;
            var spriteHeight = sprite ? Math.max(0, Number(sprite.height || (sprite.bitmap && sprite.bitmap.height) || 0)) : 0;
            bar.visible = !!(sprite && sprite.visible && Number(enemy.hp || 0) > 0);
            if (bar.visible) {
                bar.x = Number(sprite.x || 0);
                bar.y = Math.max(4, Number(sprite.y || 0) - Math.max(25, spriteHeight) - 20);
            }
        });
        for (var index = (battle.enemies || []).length; index < scene._mmoEnemyBars.length; index += 1) scene._mmoEnemyBars[index].visible = false;
    };
    Battle.refreshCombatHud = function(scene, battle) {
        if (!scene || !battle) return;
        Battle.createCombatHud(scene);
        if (scene._mmoCombatPartyWindow) scene._mmoCombatPartyWindow.setBattle(battle);
        Battle.syncEnemyBars(scene, battle);
    };
    Battle.positionActorSprites = function(scene) {
        if (!scene || !scene._spriteset || !scene._spriteset._actorSprites) return;
        var count = Math.max(1, Math.min(Battle.nativeActors.length, scene._spriteset._actorSprites.length));
        // Up to five participants fit on a single row. Larger boss groups use
        // two rows of at most five, giving every one of ten actors an explicit
        // native Sprite_Actor home with enough vertical and horizontal space.
        var rows = count > 5 ? 2 : 1;
        var columns = Math.ceil(count / rows);
        var spacing = columns === 1 ? 0 : Math.min(98, Math.floor((Graphics.boxWidth - 360) / Math.max(1, columns - 1)));
        var startX = columns === 1 ? Graphics.boxWidth - 110 : Math.max(350, Graphics.boxWidth - 85 - spacing * (columns - 1));
        var baseY = Math.max(300, Graphics.boxHeight - 144);
        scene._spriteset._actorSprites.forEach(function(sprite, index) {
            if (!sprite || index >= count || typeof sprite.setHome !== 'function') return;
            var column = index % columns;
            var row = Math.floor(index / columns);
            // MV's classic party homes are intentionally close together. An MMO
            // boss party needs a grid so actor battlers never occupy one home.
            var homeX = startX + column * spacing;
            var homeY = baseY - (rows - 1 - row) * 132;
            if (sprite._mmoHomeX === homeX && sprite._mmoHomeY === homeY) return;
            sprite._mmoHomeX = homeX;
            sprite._mmoHomeY = homeY;
            sprite.setHome(homeX, homeY);
        });
    };
    Battle.updateCombatHud = function(scene) {
        if (!scene || !scene._mmoNativeBattle || !Battle.active) return;
        Battle.positionActorSprites(scene);
        Battle.syncEnemyBars(scene, Battle.active);
    };

    Battle.setupNativeBattle = function(battle) {
        var troopId = numberOr(battle.mvTroopId, 0);
        if (!troopId || typeof $dataTroops === 'undefined' || !$dataTroops || !$dataTroops[troopId]) {
            Mmo.toast('La troupe MV de cette rencontre est absente : vérifie le mapping.', true);
            return false;
        }
        Battle.nativeBattleId = battle.battleId;
        Battle.lastEventId = 0;
        Battle.lastLog = '';
        Battle.pendingAction = false;
        Battle.selectedAction = null;
        Battle.leavingScene = false;
        Battle.buildNativeActors(battle.players || []);
        BattleManager.setup(troopId, false, true);
        Battle.syncBattlers(battle);
        return true;
    };

    Battle.openNativeScene = function(battle) {
        if (!Battle.config.useNativeScene || !battle) return;
        if (Battle.currentScene()) return Battle.syncNativeScene(Battle.currentScene());
        if (!Battle.setupNativeBattle(battle)) return;
        Mmo.hideHud();
        SceneManager.push(Scene_Battle);
    };

    Battle.hideInputWindows = function(scene) {
        if (!scene) return;
        ['_partyCommandWindow', '_actorCommandWindow', '_skillWindow', '_itemWindow', '_enemyWindow', '_actorWindow'].forEach(function(name) {
            var window = scene[name];
            if (window) {
                window.hide();
                window.deactivate();
            }
        });
        if (scene._mmoActionWindow) {
            scene._mmoActionWindow.hide();
            scene._mmoActionWindow.deactivate();
        }
    };
    Battle.showActionWindow = function(scene) {
        if (!scene || !scene._mmoActionWindow || !Battle.active || !Battle.active.myTurn || Battle.pendingAction) return;
        Battle.hideInputWindows(scene);
        scene._mmoActionWindow.setActions();
        if (!Battle.currentActions().length) return;
        scene._mmoActionWindow.show();
        scene._mmoActionWindow.activate();
        scene._mmoActionWindow.open();
    };
    Battle.openEnemyTargets = function(scene) {
        if (!scene || !scene._enemyWindow) return;
        Battle.hideInputWindows(scene);
        scene._enemyWindow.refresh();
        scene._enemyWindow.show();
        scene._enemyWindow.activate();
        scene._enemyWindow.select(0);
    };
    Battle.openActorTargets = function(scene) {
        if (!scene || !scene._actorWindow) return;
        Battle.hideInputWindows(scene);
        scene._actorWindow.refresh();
        scene._actorWindow.show();
        scene._actorWindow.activate();
        scene._actorWindow.select(0);
    };
    Battle.submit = function(targetId, targetKind, targetIndex) {
        var battle = Battle.active;
        var action = Battle.selectedAction;
        if (!battle || !battle.myTurn || !action || Battle.pendingAction) return;
        Battle.pendingAction = true;
        var scene = Battle.currentScene();
        Battle.hideInputWindows(scene);
        var packet = { battleId: battle.battleId, actionId: action.id, targetId: targetId };
        // MV target windows expose both the battler object and a visible index.
        // The stable id is used first; the index lets the server recover safely
        // if a packet arrives exactly while it refreshes a defeated battler.
        if (targetKind) {
            packet.targetKind = targetKind;
            packet.targetIndex = Number(targetIndex || 0);
        }
        if (!Mmo.send('battleAction', packet)) {
            Battle.pendingAction = false;
            Battle.showActionWindow(scene);
            return;
        }
        setTimeout(function() {
            // A battle result can require database writes before battleEnded is
            // broadcast. Do not reopen a stale command window too quickly.
            if (!Battle.pendingAction || !Battle.active || !Battle.active.myTurn) return;
            Battle.pendingAction = false;
            Battle.showActionWindow(Battle.currentScene());
        }, 6000);
    };

    Battle.playNewEvents = function(battle) {
        (battle.events || []).forEach(function(event) {
            var id = numberOr(event.id, 0);
            if (id <= Battle.lastEventId) return;
            Battle.lastEventId = id;
            var target = Battle.battlerForId(event.targetId);
            var animationId = 0;
            if (event.mvSkillId && typeof $dataSkills !== 'undefined' && $dataSkills[event.mvSkillId]) {
                animationId = Number($dataSkills[event.mvSkillId].animationId || 0);
            } else if (event.mvItem && event.mvItem.kind === 'item' && typeof $dataItems !== 'undefined' && $dataItems[event.mvItem.id]) {
                animationId = Number($dataItems[event.mvItem.id].animationId || 0);
            }
            if (target && animationId > 0 && typeof target.startAnimation === 'function') target.startAnimation(animationId, false, 0);
            if (target && event.type === 'damage' && typeof target.performDamage === 'function') target.performDamage();
            if (target && event.defeated) {
                // battleEnded can arrive before one final battleState. Apply the
                // authoritative defeat locally so the last enemy also collapses
                // while the native result log is displayed.
                target._hp = 0;
                target._mmoServerHp = 0;
                Battle.requestCollapse(target);
            }
        });
    };
    Battle.refreshLog = function(scene, battle) {
        if (!scene || !scene._logWindow) return;
        var lines = (battle.log || []).map(function(entry) { return String(entry.text || ''); });
        var signature = lines.join('\n');
        if (signature === Battle.lastLog) return;
        Battle.lastLog = signature;
        scene._logWindow.clear();
        lines.forEach(function(text) { scene._logWindow.addText(text); });
        scene._logWindow._waitCount = 0;
    };
    Battle.syncNativeScene = function(scene) {
        var battle = Battle.active;
        if (!scene || !battle || !scene._mmoNativeBattle) return;
        Battle.syncBattlers(battle);
        if (scene._statusWindow) scene._statusWindow.refresh();
        if (scene._enemyWindow) scene._enemyWindow.refresh();
        if (scene._actorWindow) scene._actorWindow.refresh();
        Battle.refreshCombatHud(scene, battle);
        Battle.playNewEvents(battle);
        Battle.refreshLog(scene, battle);
        if (battle.myTurn) {
            Battle.pendingAction = false;
            Battle.showActionWindow(scene);
        } else {
            Battle.hideInputWindows(scene);
        }
    };

    Battle.onServerError = function(packet) {
        var recoverable = ['invalid_target', 'invalid_action', 'not_enough_mp', 'item_not_owned'];
        if (!Battle.active || !Battle.active.myTurn || recoverable.indexOf(String(packet.code || '')) === -1) return;
        Battle.pendingAction = false;
        Battle.selectedAction = null;
        Battle.showActionWindow(Battle.currentScene());
    };

    Battle.startEventBattle = function(encounterId) {
        if (Battle.active || Battle.pendingAction) return;
        Battle.pendingAction = true;
        Mmo.send('battleStart', { encounterId: encounterId || 'slime_pack', source: 'event' });
        setTimeout(function() { if (!Battle.active) Battle.pendingAction = false; }, 1800);
    };
    Battle.mapIsEligible = function() {
        return typeof $gameMap !== 'undefined' && $gameMap && Battle.config.randomMapIds.indexOf(String($gameMap.mapId())) !== -1;
    };
    Battle.regionIsEligible = function(regionId) {
        return Battle.config.randomRegions.indexOf('*') !== -1 ? Number(regionId) > 0 : Battle.config.randomRegions.indexOf(String(regionId)) !== -1;
    };
    Battle.maybeRandomEncounter = function(player) {
        if (!Battle.randomEnabled || Battle.active || Battle.pendingAction || !Mmo.activeCharacter || !Mmo.connected) return;
        if (!Battle.mapIsEligible() || !Battle.regionIsEligible($gameMap.regionId(player.x, player.y))) return;
        if (Date.now() - Battle.lastRandomRequestAt < 1200 || Math.random() >= Battle.config.randomChance) return;
        Battle.lastRandomRequestAt = Date.now();
        Battle.pendingAction = true;
        Mmo.send('battleStart', { encounterId: Battle.config.randomEncounterId, source: 'random' });
        setTimeout(function() { if (!Battle.active) Battle.pendingAction = false; }, 1800);
    };

    Battle.resultLines = function(packet) {
        var rewards = packet.rewards || {};
        var firstLine = packet.result === 'victory'
            ? 'Victoire ! +' + Number(rewards.experience || 0) + ' EXP, +' + Number(rewards.gold || 0) + ' or.'
            : (packet.result === 'escape' ? 'Fuite réussie. Le groupe se replie.' : 'Défaite. Réessaie avec une meilleure stratégie.');
        var lines = [firstLine];
        var loot = packet.loot || [];
        var questUpdates = packet.questUpdates || [];
        if (loot.length) lines.push('Butin : ' + loot.map(function(item) { return item.label + ' ×' + Number(item.quantity); }).join(', ') + '.');
        if (questUpdates.length) lines.push('Quête : ' + questUpdates.map(function(quest) {
            var suffix = quest.readyToTurnIn ? ' — à rendre au donneur de quête' : (quest.completed ? ' terminée' : '');
            return quest.title + ' ' + Number(quest.progress) + '/' + Number(quest.goal) + suffix;
        }).join(', ') + '.');
        return lines;
    };
    Battle.closeNativeBattle = function(scene) {
        var completedBattleId = Battle._endingBattleId || Battle.nativeBattleId || (Battle.active && Battle.active.battleId);
        // Do not release the authoritative server lock when battleEnded arrives.
        // It is released only after this client confirms the native result and
        // actually leaves Scene_Battle, preventing a new group battle from
        // starting while another member still has the prior result on screen.
        if (completedBattleId) Mmo.send('battleClosed', { battleId: completedBattleId });
        if (scene && scene._mmoNativeBattle && Battle.currentScene() === scene) {
            BattleManager._phase = null;
            if (typeof BattleManager.replayBgmAndBgs === 'function') BattleManager.replayBgmAndBgs();
            SceneManager.pop();
        }
        Battle.active = null;
        Battle.nativeActors = [];
        Battle.nativeBattleId = null;
        Battle._endingBattleId = null;
        Battle.awaitingResultConfirm = false;
        Battle.resultConfirmAt = 0;
        Mmo.showHud();
    };
    Battle.showNativeNotice = function(scene, text) {
        if (!scene || !scene._logWindow) return;
        scene._logWindow.addText(String(text));
        scene._logWindow._waitCount = 0;
    };
    Battle.showNativeResult = function(scene, lines) {
        if (!scene || !scene._logWindow) return;
        // Window_BattleLog is RPG Maker MV's own result/message window. No DOM
        // toast is used for battle rewards, loot or quest progress.
        Battle.hideInputWindows(scene);
        scene._logWindow.clear();
        scene._logWindow._methods = [];
        lines.concat(['Appuie sur OK pour continuer.']).forEach(function(line) { scene._logWindow.addText(line); });
        scene._logWindow._waitCount = 0;
    };

    Mmo.registerPacketHandler('battleState', function(packet) {
        Battle.pendingAction = false;
        Battle.active = packet.battle || null;
        if (!Battle.active) return;
        var scene = Battle.currentScene();
        if (scene) Battle.syncNativeScene(scene);
        else Battle.openNativeScene(Battle.active);
    });
    Mmo.registerPacketHandler('battleEnded', function(packet) {
        Battle.pendingAction = false;
        Battle.selectedAction = null;
        Battle.leavingScene = true;
        Battle._endingBattleId = packet.battleId;
        var scene = Battle.currentScene();
        var lines = Battle.resultLines(packet);
        if (scene && scene._mmoNativeBattle) {
            Battle.playNewEvents({ events: packet.events || [] });
            BattleManager._phase = 'mmo_result';
            Battle.showNativeResult(scene, lines);
            // Like a native MV result window, the outcome stays visible until
            // the player deliberately confirms it with the standard OK input.
            Battle.awaitingResultConfirm = true;
            Battle.resultConfirmAt = Date.now() + 350;
        } else {
            Battle.closeNativeBattle(null);
        }
    });

    var _Scene_Battle_create = Scene_Battle.prototype.create;
    Scene_Battle.prototype.create = function() {
        _Scene_Battle_create.call(this);
        if (!Battle.isNativeActive()) return;
        this._mmoNativeBattle = true;
        // The custom party HUD is itself a native Window_Base and scales to ten
        // participants. Hide MV's fixed four-slot status strip to avoid a second
        // overlapping roster at the bottom of large MMO encounters.
        if (this._statusWindow) {
            this._statusWindow.hide();
            this._statusWindow.deactivate();
        }
        this._mmoActionWindow = new Window_MMOAction();
        this._mmoActionWindow.setHandler('mmoAction', this.onMmoAction.bind(this));
        this._mmoActionWindow.setHandler('cancel', this.onMmoActionCancel.bind(this));
        this.addWindow(this._mmoActionWindow);
        this._enemyWindow.setHandler('ok', this.onMmoEnemyOk.bind(this));
        this._enemyWindow.setHandler('cancel', this.onMmoTargetCancel.bind(this));
        this._actorWindow.setHandler('ok', this.onMmoActorOk.bind(this));
        this._actorWindow.setHandler('cancel', this.onMmoTargetCancel.bind(this));
        Battle.createCombatHud(this);
    };
    var _Scene_Battle_start = Scene_Battle.prototype.start;
    Scene_Battle.prototype.start = function() {
        _Scene_Battle_start.call(this);
        if (!this._mmoNativeBattle) return;
        // Stop the local BattleManager loop: all resolution comes from WebSocket
        // battleState packets. Native windows/sprites remain fully active.
        BattleManager._phase = 'mmo_wait';
        Battle.syncNativeScene(this);
    };
    var _Scene_Battle_update = Scene_Battle.prototype.update;
    Scene_Battle.prototype.update = function() {
        _Scene_Battle_update.call(this);
        if (this._mmoNativeBattle) Battle.updateCombatHud(this);
        if (!this._mmoNativeBattle || !Battle.awaitingResultConfirm || Battle.currentScene() !== this) return;
        if (Date.now() < Number(Battle.resultConfirmAt || 0)) return;
        var confirmed = Input.isTriggered('ok') || (typeof TouchInput !== 'undefined' && TouchInput.isTriggered());
        if (confirmed) Battle.closeNativeBattle(this);
    };

    Scene_Battle.prototype.onMmoAction = function() {
        var action = this._mmoActionWindow.currentExt();
        if (!action) return;
        Battle.selectedAction = action;
        if (action.targetType === 'enemy') Battle.openEnemyTargets(this);
        else if (action.targetType === 'ally' || action.targetType === 'deadAlly') Battle.openActorTargets(this);
        else Battle.submit(null);
    };
    Scene_Battle.prototype.onMmoActionCancel = function() {
        // Right-click is MV's cancel input. Deactivating the only MMO command
        // window left it visible but inert, which looked like a frozen battle.
        // Keep the action list active so cancel is always harmless and usable.
        this._mmoActionWindow.select(Math.max(0, this._mmoActionWindow.index()));
        this._mmoActionWindow.activate();
    };
    Scene_Battle.prototype.onMmoEnemyOk = function() {
        var enemy = this._enemyWindow.enemy();
        if (enemy) Battle.submit(enemy._mmoBattlerId, 'enemy', this._enemyWindow.index());
    };
    Scene_Battle.prototype.onMmoActorOk = function() {
        var actor = this._actorWindow.actor();
        var selected = Battle.selectedAction || {};
        var needsDeadAlly = selected.targetType === 'deadAlly';
        if (!actor || (needsDeadAlly ? actor.isAlive() : !actor.isAlive())) {
            Battle.showNativeNotice(this, needsDeadAlly ? 'Choisis un allié hors combat.' : 'Cette cible est hors combat.');
            return Battle.openActorTargets(this);
        }
        Battle.submit(actor._mmoBattlerId, needsDeadAlly ? 'deadAlly' : 'ally', this._actorWindow.index());
    };
    Scene_Battle.prototype.onMmoTargetCancel = function() {
        Battle.showActionWindow(this);
    };

    var _Game_Player_canMove = Game_Player.prototype.canMove;
    Game_Player.prototype.canMove = function() {
        if (Battle.active) return false;
        return _Game_Player_canMove.call(this);
    };
    var _Game_Player_moveStraight = Game_Player.prototype.moveStraight;
    Game_Player.prototype.moveStraight = function(direction) {
        _Game_Player_moveStraight.call(this, direction);
        if (this.isMovementSucceeded()) Battle.maybeRandomEncounter(this);
    };

    var _Game_Interpreter_pluginCommand = Game_Interpreter.prototype.pluginCommand;
    Game_Interpreter.prototype.pluginCommand = function(command, args) {
        if (String(command).toUpperCase() === 'MMO') {
            var action = String(args[0] || '').toUpperCase();
            var rest = args.slice(1);
            if (action === 'BATTLE_START') { Battle.startEventBattle(rest[0] || 'slime_pack'); return; }
            if (action === 'RANDOM_ON') { Battle.randomEnabled = true; Mmo.toast('Rencontres aléatoires activées.'); return; }
            if (action === 'RANDOM_OFF') { Battle.randomEnabled = false; Mmo.toast('Rencontres aléatoires désactivées.'); return; }
        }
        _Game_Interpreter_pluginCommand.call(this, command, args);
    };

})(MMOBattle, MMOFoundation);
