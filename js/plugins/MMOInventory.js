/*:
 * @plugindesc v0.19.0 États, résurrection et croissance MV autoritaires.
 * @author Arena MMO starter
 *
 * @help
 * Requires MMOFoundation above it.
 *
 * The server remains authoritative for ownership and quantities. Every item
 * carrying an MV mapping is mirrored into $gameParty, so Scene_Item and the
 * native menu display battle loot, native RPG Maker items, weapons and armor.
 *
 * Press I on the map to open the native Scene_Item.
 * Press E on the map to open the native Scene_Equip.
 *
 * Plugin commands:
 *   MMO INVENTORY
 *   MMO EQUIPMENT
 *   MMO EQUIP item_id
 *   MMO UNEQUIP etype_1  (ou weapon|armor|accessory pour compatibilité)
 *   MMO OPTIMIZE_EQUIPMENT
 *   MMO CLEAR_EQUIPMENT
 */

var Imported = Imported || {};
Imported.MMOInventory = true;
var MMOInventory = MMOInventory || {};

(function(Inventory, Mmo) {
    'use strict';

    if (!Mmo || typeof Mmo.registerPacketHandler !== 'function') {
        console.error('MMOInventory requires MMOFoundation, loaded above it.');
        return;
    }

    Inventory.data = { items: [], equipment: {}, gold: 0, experience: 0, level: 1, health: null, states: [], paramBonuses: [] };
    Inventory.itemUsePending = false;
    Inventory.managedObjects = {};

    Inventory.objectForSnapshot = function(item) {
        var mv = item && item.mv;
        if (!mv || typeof $dataItems === 'undefined') return null;
        var table = { item: $dataItems, weapon: $dataWeapons, armor: $dataArmors }[mv.kind];
        return table && table[Number(mv.id)] ? table[Number(mv.id)] : null;
    };
    Inventory.keyForObject = function(object) {
        if (!object) return null;
        if (typeof DataManager !== 'undefined' && DataManager.isItem(object)) return 'item:' + object.id;
        if (typeof DataManager !== 'undefined' && DataManager.isWeapon(object)) return 'weapon:' + object.id;
        if (typeof DataManager !== 'undefined' && DataManager.isArmor(object)) return 'armor:' + object.id;
        return null;
    };
    Inventory.isManagedObject = function(object) {
        var key = Inventory.keyForObject(object);
        return !!(key && Inventory.managedObjects[key]);
    };

    // Make the local native inventory a projection of the PostgreSQL snapshot.
    // No item quantity is trusted from a local save file.
    Inventory.syncNativeParty = function() {
        if (!Mmo.activeCharacter || typeof $gameParty === 'undefined' || !$gameParty) return;
        var desired = {};
        (Inventory.data.items || []).forEach(function(item) {
            var object = Inventory.objectForSnapshot(item);
            var key = Inventory.keyForObject(object);
            if (!object || !key) return; // Furniture remains in the housing panel.
            if (!desired[key]) desired[key] = { object: object, quantity: 0 };
            desired[key].quantity += Math.max(0, Number(item.quantity || 0));
        });
        Object.keys(Inventory.managedObjects).forEach(function(key) {
            if (!desired[key]) desired[key] = { object: Inventory.managedObjects[key], quantity: 0 };
        });
        Object.keys(desired).forEach(function(key) {
            var entry = desired[key];
            var current = $gameParty.numItems(entry.object);
            var delta = Number(entry.quantity) - Number(current);
            if (delta) $gameParty.gainItem(entry.object, delta, false);
        });
        Inventory.managedObjects = {};
        Object.keys(desired).forEach(function(key) {
            if (desired[key].quantity > 0) Inventory.managedObjects[key] = desired[key].object;
        });
        var desiredGold = Math.max(0, Number(Inventory.data.gold || 0));
        var currentGold = $gameParty.gold();
        if (desiredGold !== currentGold) $gameParty.gainGold(desiredGold - currentGold);
        if (Mmo.activeCharacter) {
            Mmo.activeCharacter.gold = desiredGold;
            Mmo.activeCharacter.experience = Math.max(0, Number(Inventory.data.experience || 0));
            Mmo.activeCharacter.level = Math.max(1, Number(Inventory.data.level || 1));
        }
        // The selected character's mapped actor is the sole local party member.
        // Feed it the authoritative total EXP so Status/Scene_Menu display the
        // same progression as PostgreSQL, including native level-up handling.
        if (typeof $gameActors !== 'undefined' && $gameActors) {
            var actorId = typeof Mmo.nativeActorId === 'function' ? Mmo.nativeActorId() : 1;
            var actor = $gameActors.actor(actorId);
            var experience = Math.max(0, Number(Inventory.data.experience || 0));
            if (actor && typeof actor.changeExp === 'function' && actor.currentExp() !== experience) actor.changeExp(experience, false);
            if (actor) {
                Inventory.syncNativeEquipment(actor);
                Inventory.syncNativePersistentEffects(actor);
                Inventory.syncNativeVitals(actor);
            }
        }
    };

    Inventory.syncNativeEquipment = function(actor) {
        if (!actor || typeof actor.forceChangeEquip !== 'function' || typeof actor.equipSlots !== 'function') return;
        var desired = {};
        Object.keys(Inventory.data.equipment || {}).forEach(function(serverSlot) {
            var object = Inventory.objectForSnapshot(Inventory.data.equipment[serverSlot]);
            if (!object) return;
            var slots = actor.equipSlots();
            var slotIndex = slots.indexOf(Number(object.etypeId));
            if (slotIndex >= 0) desired[slotIndex] = object;
        });
        actor.equipSlots().forEach(function(_etypeId, index) {
            var current = actor.equips && actor.equips()[index];
            if (current !== (desired[index] || null)) actor.forceChangeEquip(index, desired[index] || null);
        });
        if (typeof actor.refresh === 'function') actor.refresh();
    };

    Inventory.syncNativeVitals = function(actor) {
        var health = Inventory.data && Inventory.data.health;
        if (!actor || !health) return;
        var hp = Math.max(0, Math.min(Number(health.maxHp || 1), Number(health.hp || 0)));
        var mp = Math.max(0, Math.min(Number(health.maxMp || 0), Number(health.mp || 0)));
        if (typeof actor.setHp === 'function') actor.setHp(hp);
        else actor._hp = hp;
        if (typeof actor.setMp === 'function') actor.setMp(mp);
        else actor._mp = mp;
        if (typeof actor.refresh === 'function') actor.refresh();
    };

    Inventory.syncNativePersistentEffects = function(actor) {
        if (!actor) return;
        var bonuses = (Inventory.data.paramBonuses || []).map(function(value) { return Number(value) || 0; });
        actor._mmoPersistentParamBonuses = bonuses;
        var desired = (Inventory.data.states || []).map(Number).filter(function(stateId) { return stateId > 0; });
        var previous = actor._mmoPersistentStates || [];
        previous.forEach(function(stateId) {
            if (desired.indexOf(stateId) === -1 && typeof actor.removeState === 'function') actor.removeState(stateId);
        });
        desired.forEach(function(stateId) {
            if (previous.indexOf(stateId) === -1 && typeof actor.addState === 'function') actor.addState(stateId);
        });
        actor._mmoPersistentStates = desired;
        if (typeof actor.refresh === 'function') actor.refresh();
    };

    Inventory.isNetworkActor = function(actor) {
        return !!(Mmo.activeCharacter && actor && typeof Mmo.nativeActorId === 'function' && Number(actor.actorId ? actor.actorId() : 0) === Number(Mmo.nativeActorId()));
    };
    if (typeof Game_Actor !== 'undefined' && Game_Actor.prototype && typeof Game_Actor.prototype.paramPlus === 'function') {
        var _Game_Actor_paramPlus = Game_Actor.prototype.paramPlus;
        Game_Actor.prototype.paramPlus = function(paramId) {
            var base = _Game_Actor_paramPlus.call(this, paramId);
            if (!Inventory.isNetworkActor(this)) return base;
            return base + Number((this._mmoPersistentParamBonuses || [])[Number(paramId)] || 0);
        };
    }
    Inventory.snapshotForObject = function(object) {
        var key = Inventory.keyForObject(object);
        if (!key) return null;
        return (Inventory.data.items || []).filter(function(entry) {
            return entry.mv && (entry.mv.kind + ':' + Number(entry.mv.id)) === key;
        })[0] || null;
    };
    Inventory.itemIdForObject = function(object) {
        var entry = Inventory.snapshotForObject(object);
        return entry ? entry.itemId : null;
    };
    Inventory.canUseOutOfBattle = function(object) {
        var entry = Inventory.snapshotForObject(object);
        return !!(entry && entry.usableOutOfBattle && !Inventory.itemUsePending);
    };
    Inventory.serverSlotForEquipIndex = function(actor, index) {
        var etypeId = actor && actor.equipSlots ? Number(actor.equipSlots()[index]) : 0;
        return etypeId > 0 ? 'etype_' + etypeId : null;
    };

    Inventory.open = function() {
        if (!Mmo.activeCharacter) return Mmo.toast('Connecte un personnage avant d’ouvrir l’inventaire.', true);
        if (typeof MMOBattle !== 'undefined' && MMOBattle.active) return;
        Mmo.send('inventoryRequest');
        if (typeof Scene_Item !== 'undefined') SceneManager.push(Scene_Item);
    };

    Inventory.equipmentActionPending = null;
    Inventory.refreshEquipScene = function() {
        if (typeof Scene_Equip === 'undefined' || !(SceneManager._scene instanceof Scene_Equip)) return null;
        var scene = SceneManager._scene;
        if (scene._slotWindow) scene._slotWindow.refresh();
        if (scene._itemWindow) scene._itemWindow.refresh();
        if (scene._statusWindow) scene._statusWindow.refresh();
        return scene;
    };
    Inventory.completeEquipmentAction = function() {
        var scene = Inventory.refreshEquipScene();
        Inventory.equipmentActionPending = null;
        Inventory.resumeEquipCommand(scene);
    };
    Inventory.refreshItemScene = function() {
        if (typeof Scene_Item === 'undefined' || !(SceneManager._scene instanceof Scene_Item)) return null;
        var scene = SceneManager._scene;
        if (scene._itemWindow) scene._itemWindow.refresh();
        if (scene._actorWindow) scene._actorWindow.refresh();
        if (scene._helpWindow) scene._helpWindow.refresh();
        return scene;
    };
    Inventory.completeItemUse = function() {
        var scene = Inventory.refreshItemScene();
        Inventory.itemUsePending = false;
        if (scene && scene._itemWindow && typeof scene._itemWindow.activate === 'function') scene._itemWindow.activate();
    };
    Mmo.registerPacketHandler('inventorySnapshot', function(packet) { 
        Inventory.data = {
            items: packet.items || [], equipment: packet.equipment || {}, gold: Number(packet.gold || 0),
            experience: Number(packet.experience || 0), level: Number(packet.level || 1), health: packet.health || null,
            states: packet.states || [], paramBonuses: packet.paramBonuses || []
        };
        Inventory.syncNativeParty();
        var scene = Inventory.refreshEquipScene();
        if (Inventory.equipmentActionPending) {
            Inventory.equipmentActionPending = null;
            Inventory.resumeEquipCommand(scene);
        }
        if (Inventory.itemUsePending) Inventory.completeItemUse();
        else Inventory.refreshItemScene();
    });

    // Server-approved MV menu effects stay selectable in Scene_Item. Every
    // other managed entry remains disabled: local Game_Action must never
    // consume an MMO item or change character state before the server answers.
    var _Window_ItemList_isEnabled = Window_ItemList.prototype.isEnabled;
    Window_ItemList.prototype.isEnabled = function(item) {
        if (Mmo.activeCharacter && Inventory.isManagedObject(item)) return Inventory.canUseOutOfBattle(item);
        return _Window_ItemList_isEnabled.call(this, item);
    };

    // Let Scene_Equip remain the native visual UI, but turn every equipment
    // choice into a server request. No local equip mutation is authoritative.
    // Optimize/Clear keep the native commands but wait for the resulting server
    // snapshot before restoring their focus, so their displayed stats always
    // match the PostgreSQL decision.
    Inventory.resumeEquipCommand = function(scene) {
        if (scene && scene._commandWindow && typeof scene._commandWindow.activate === 'function') scene._commandWindow.activate();
    };
    Inventory.requestEquipmentAction = function(scene, packetType) {
        if (Inventory.equipmentActionPending) {
            Mmo.toast('Une modification d’équipement est déjà en cours.', true);
            Inventory.resumeEquipCommand(scene);
            return false;
        }
        Inventory.equipmentActionPending = packetType;
        if (Mmo.send(packetType)) return true;
        Inventory.equipmentActionPending = null;
        Inventory.resumeEquipCommand(scene);
        return false;
    };
    Inventory.requestItemUse = function(scene, itemId) {
        if (Inventory.itemUsePending) {
            Mmo.toast('Utilisation d’objet déjà en cours.', true);
            if (scene && scene._itemWindow) scene._itemWindow.activate();
            return false;
        }
        Inventory.itemUsePending = true;
        if (Mmo.send('useInventoryItem', { itemId: itemId })) return true;
        Inventory.itemUsePending = false;
        if (scene && scene._itemWindow) scene._itemWindow.activate();
        return false;
    };
    if (typeof Mmo.registerErrorHandler === 'function') {
        Mmo.registerErrorHandler(function() {
            if (Inventory.equipmentActionPending) Inventory.completeEquipmentAction();
            if (Inventory.itemUsePending) Inventory.completeItemUse();
        });
    }
    if (typeof Scene_ItemBase !== 'undefined' && typeof Scene_Item !== 'undefined') {
        var _Scene_ItemBase_onActorOk = Scene_ItemBase.prototype.onActorOk;
        Scene_ItemBase.prototype.onActorOk = function() {
            var item = this.item && this.item();
            if (this instanceof Scene_Item && Mmo.activeCharacter && Inventory.isManagedObject(item)) {
                var itemId = Inventory.itemIdForObject(item);
                if (!itemId || !Inventory.canUseOutOfBattle(item)) {
                    Mmo.toast('Cet objet ne peut pas être utilisé hors combat.', true);
                    if (this.hideSubWindow && this._actorWindow) this.hideSubWindow(this._actorWindow);
                    if (this._itemWindow) this._itemWindow.activate();
                    return;
                }
                if (this.hideSubWindow && this._actorWindow) this.hideSubWindow(this._actorWindow);
                Inventory.requestItemUse(this, itemId);
                return;
            }
            return _Scene_ItemBase_onActorOk.call(this);
        };
    }
    if (typeof Scene_Equip !== 'undefined') {
        var _Scene_Equip_onItemOk = Scene_Equip.prototype.onItemOk;
        Scene_Equip.prototype.onItemOk = function() {
            var actor = this.actor && this.actor();
            if (!Inventory.isNetworkActor(actor)) return _Scene_Equip_onItemOk.call(this);
            var item = this._itemWindow && this._itemWindow.item ? this._itemWindow.item() : null;
            if (item) {
                var itemId = Inventory.itemIdForObject(item);
                if (!itemId) {
                    Mmo.toast('Cet équipement ne vient pas de l’inventaire serveur.', true);
                    if (this._itemWindow) this._itemWindow.deselect();
                    if (this._slotWindow) this._slotWindow.activate();
                    return;
                }
                Mmo.send('equipItem', { itemId: itemId });
            } else {
                var index = this._slotWindow && this._slotWindow.index ? this._slotWindow.index() : 0;
                Mmo.send('unequipItem', { slot: Inventory.serverSlotForEquipIndex(actor, index) });
            }
            if (this._itemWindow) this._itemWindow.deselect();
            if (this._slotWindow) this._slotWindow.activate();
        };
        var _Scene_Equip_commandOptimize = Scene_Equip.prototype.commandOptimize;
        Scene_Equip.prototype.commandOptimize = function() {
            if (Inventory.isNetworkActor(this.actor && this.actor())) {
                Inventory.requestEquipmentAction(this, 'optimizeEquipment');
                return;
            }
            return _Scene_Equip_commandOptimize.call(this);
        };
        var _Scene_Equip_commandClear = Scene_Equip.prototype.commandClear;
        Scene_Equip.prototype.commandClear = function() {
            if (Inventory.isNetworkActor(this.actor && this.actor())) {
                Inventory.requestEquipmentAction(this, 'clearEquipment');
                return;
            }
            return _Scene_Equip_commandClear.call(this);
        };
    }

    Inventory.openEquipment = function() {
        if (!Mmo.activeCharacter) return Mmo.toast('Connecte un personnage avant d’ouvrir l’équipement.', true);
        if (typeof MMOBattle !== 'undefined' && MMOBattle.active) return;
        Mmo.send('inventoryRequest');
        if (typeof Scene_Equip !== 'undefined') SceneManager.push(Scene_Equip);
    };

    Input.keyMapper[73] = 'mmoInventory'; // I
    Input.keyMapper[69] = 'mmoEquipment'; // E
    // Character selection may receive its snapshot while Scene_Title is still
    // active. Reapply it after DataManager creates the native game objects.
    var _Scene_Map_start = Scene_Map.prototype.start;
    Scene_Map.prototype.start = function() {
        _Scene_Map_start.call(this);
        setTimeout(function() { Inventory.syncNativeParty(); }, 20);
    };
    var _Scene_Map_update = Scene_Map.prototype.update;
    Scene_Map.prototype.update = function() {
        _Scene_Map_update.call(this);
        var focused = typeof document !== 'undefined' && document.activeElement &&
            ['INPUT', 'TEXTAREA', 'SELECT'].indexOf(document.activeElement.tagName) !== -1;
        if (Mmo.activeCharacter && !focused && Input.isTriggered('mmoInventory')) Inventory.open();
        if (Mmo.activeCharacter && !focused && Input.isTriggered('mmoEquipment')) Inventory.openEquipment();
    };

    var _Game_Interpreter_pluginCommand = Game_Interpreter.prototype.pluginCommand;
    Game_Interpreter.prototype.pluginCommand = function(command, args) {
        if (String(command).toUpperCase() === 'MMO') {
            var action = String(args[0] || '').toUpperCase();
            var rest = args.slice(1);
            if (action === 'INVENTORY') { Inventory.open(); return; }
            if (action === 'EQUIPMENT') { Inventory.openEquipment(); return; }
            if (action === 'EQUIP') { Mmo.send('equipItem', { itemId: rest[0] }); return; }
            if (action === 'UNEQUIP') { Mmo.send('unequipItem', { slot: rest[0] }); return; }
            if (action === 'OPTIMIZE_EQUIPMENT') { Mmo.send('optimizeEquipment'); return; }
            if (action === 'CLEAR_EQUIPMENT') { Mmo.send('clearEquipment'); return; }
        }
        _Game_Interpreter_pluginCommand.call(this, command, args);
    };

})(MMOInventory, MMOFoundation);
