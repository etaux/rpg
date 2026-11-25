/*:
 * @plugindesc v0.28.0 Pont d'événements MMO : monstres partagés, lobbies et PNJ autoritaires.
 * @author Arena MMO starter
 *
 * @help
 * MMOEvents requires MMOFoundation and MMOBattle above it.
 * Load this plugin AFTER MMOFoundation, MMOInventory, MMOTrade, MMOAuction,
 * MMOServices, MMOGuild and MMOHousing.
 *
 * EVENT METADATA
 * Place a comment directly before an RPG Maker MV Battle Processing command:
 *
 *   <MMO coop=solo battle=wolf_alpha respawn=30>
 *
 * The server reserves this exact event for one combat. `solo` starts only the
 * initiator; `optional` and `required` use native lobby branches first:
 *
 *   <MMO battle=wolf_alpha>
 *   MMO BATTLE_LOBBY OPEN wolf_alpha
 *   <MMO battle=wolf_alpha>
 *   MMO BATTLE_LOBBY JOIN wolf_alpha
 *   <MMO coop=optional battle=wolf_alpha respawn=30>
 *   Battle Processing: troop selected in RPG Maker
 *
 * Only joined members of the initiating group enter the shared Scene_Battle.
 * `required` needs at least two ready lobby members. At victory the server
 * hides the event globally and respawns it after the validated delay.
 * Without an MMO comment, Battle Processing keeps its default local behavior.
 *
 * The comment syntax is deliberately generic for future systems:
 *   <MMO quest=crypt_sweep persistent=true>
 *   <MMO loot=shared>
 * MMOEvents exposes parsed metadata to future bridge modules while the server
 * verifies every tagged event from the project's data/MapXXX.json.
 *
 * SERVICE NPC
 * Put one NPC tag anywhere in the event page, use native Show Choices, then
 * mark each MMO branch immediately before its command. Examples:
 *
 *   <MMO npc=auction_house>                 <MMO npc-action=open>
 *   <MMO npc=merchant shop=starter_general mode=both>  MMO NPC_ACTION open
 *   <MMO npc=banker>                        <MMO npc-action=open>
 *   <MMO npc=guild_registrar>               <MMO npc-action=guild_create>
 *   <MMO npc=quest_giver>                   <MMO npc-action=quest_start quest=rat_problem mode=solo>
 *   <MMO npc=quest_giver>                   <MMO npc-action=quest_turn_in quest=rat_problem mode=solo>
 *   <MMO npc=innkeeper>                     <MMO npc-action=heal>
 *
 * The native interpreter waits for server validation before a service UI can
 * open or a persistent action can occur. Informational/leave branches remain
 * ordinary RPG Maker MV commands.
 */

var Imported = Imported || {};
Imported.MMOEvents = true;
var MMOEvents = MMOEvents || {};

(function(Events, Mmo) {
    'use strict';

    if (!Mmo || typeof Mmo.registerPacketHandler !== 'function' || typeof Mmo.registerErrorHandler !== 'function') {
        console.error('MMOEvents requires the current MMOFoundation plugin, loaded above it.');
        return;
    }

    Events.pending = {};
    Events.sequence = 0;

    // Lobby requests are security-sensitive because the server rechecks the
    // exact MV command. These concise browser-console traces make a stale
    // client map/page index visible without logging credentials or packets.
    Events.traceLobby = function(stage, details) {
        if (typeof console === 'undefined' || !console || typeof console.info !== 'function') return;
        console.info('[MMO lobby] ' + stage, details || {});
    };

    Events.parseMetadata = function(text) {
        var metadata = null;
        var pattern = /<\s*MMO\s*:?\s*([^>]*)>/ig;
        var match;
        while ((match = pattern.exec(String(text || '')))) {
            metadata = metadata || {};
            var attributes = String(match[1] || '');
            var attributePattern = /([a-z][a-z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))/ig;
            var attribute;
            while ((attribute = attributePattern.exec(attributes))) {
                metadata[String(attribute[1]).toLowerCase()] = String(attribute[2] || attribute[3] || attribute[4] || '').trim();
            }
        }
        return metadata;
    };

    Events.commentsImmediatelyBefore = function(list, commandIndex) {
        var lines = [];
        var index = Number(commandIndex) - 1;
        while (index >= 0) {
            var command = list[index];
            if (!command || (command.code !== 108 && command.code !== 408)) break;
            lines.unshift(String((command.parameters || [])[0] || ''));
            index -= 1;
        }
        return lines.join('\n');
    };

    // Public helper for future event bridges. It returns the metadata from the
    // contiguous comment block immediately above the interpreter's command.
    Events.metadataForInterpreterCommand = function(interpreter) {
        if (!interpreter || !interpreter._eventId || typeof $gameMap === 'undefined' || !$gameMap) return null;
        var event = $gameMap.event(interpreter._eventId);
        if (!event || event._pageIndex < 0 || typeof $dataMap === 'undefined' || !$dataMap) return null;
        var dataEvent = $dataMap.events[interpreter._eventId];
        var page = dataEvent && dataEvent.pages ? dataEvent.pages[event._pageIndex] : null;
        var list = page && page.list;
        if (!list || !list[interpreter._index]) return null;
        return Events.parseMetadata(Events.commentsImmediatelyBefore(list, interpreter._index));
    };

    Events.directRewardAmount = function(parameters, operationIndex, operandTypeIndex, amountIndex) {
        return Number(parameters[operationIndex]) === 0 && Number(parameters[operandTypeIndex]) === 0 && Number(parameters[amountIndex]) > 0;
    };
    Events.victoryRewardCommandIndexes = function(interpreter) {
        if (!interpreter || !interpreter._eventId || typeof $gameMap === 'undefined' || !$gameMap || typeof $dataMap === 'undefined' || !$dataMap) return [];
        var event = $gameMap.event(interpreter._eventId);
        var dataEvent = event && $dataMap.events[interpreter._eventId];
        var page = dataEvent && dataEvent.pages && dataEvent.pages[event._pageIndex];
        var list = page && page.list;
        if (!list) return [];
        var battleIndent = Number(interpreter._indent);
        var indexes = [];
        var victoryStarted = false;
        for (var index = Number(interpreter._index) + 1; index < list.length; index++) {
            var command = list[index];
            if (!command) break;
            if (command.indent === battleIndent && (command.code === 602 || command.code === 603 || command.code === 0)) break;
            if (command.code === 601 && command.indent === battleIndent) { victoryStarted = true; continue; }
            if (!victoryStarted || command.indent !== battleIndent + 1) continue;
            var parameters = command.parameters || [];
            var valid = (command.code === 125 && Events.directRewardAmount(parameters, 0, 1, 2)) ||
                // Change EXP: [iterateType, actorId, operation, operandType, operand, showLevelUp]
                (command.code === 315 && Events.directRewardAmount(parameters, 2, 3, 4)) ||
                ([126, 127, 128].indexOf(command.code) !== -1 && Events.directRewardAmount(parameters, 1, 2, 3));
            if (valid) indexes.push(index);
        }
        return indexes;
    };

    Events.battleSpecForInterpreter = function(interpreter) {
        if (!interpreter || !interpreter._eventId || typeof $gameMap === 'undefined' || !$gameMap || typeof $dataMap === 'undefined' || !$dataMap) return null;
        var metadata = Events.metadataForInterpreterCommand(interpreter);
        if (!metadata || !metadata.coop) return null;
        var coop = String(metadata.coop).toLowerCase();
        if (['solo', 'optional', 'required'].indexOf(coop) === -1) {
            Mmo.toast('Valeur MMO coop invalide : utilise solo, optional ou required.', true);
            return { invalid: true };
        }
        // Fixed troop selection is required so the server can verify this exact
        // Battle Processing command from MapXXX.json. Variable/random troop
        // selection can be added later as an explicit server-owned feature.
        if (Number(interpreter._params[0]) !== 0) {
            Mmo.toast('Un combat MMO d’événement doit utiliser une troupe définie directement.', true);
            return { invalid: true };
        }
        var event = $gameMap.event(interpreter._eventId);
        if (!event || event._pageIndex < 0) return { invalid: true };
        return {
            metadata: metadata,
            coop: coop,
            mapId: Number($gameMap.mapId()),
            eventId: Number(interpreter._eventId),
            pageIndex: Number(event._pageIndex),
            commandIndex: Number(interpreter._index),
            troopId: Number(interpreter._params[1]),
            indent: Number(interpreter._indent),
            rewardCommandIndexes: Events.victoryRewardCommandIndexes(interpreter)
        };
    };

    Events.complete = function(entry, result) {
        if (!entry || entry.ready) return;
        entry.ready = true;
        // MV Battle Processing branch result: 0 victory, 1 escape, 2 defeat.
        // A server-authorized flee resumes the event through its native Escape
        // branch; every other non-victory outcome uses the Defeat branch.
        entry.branchResult = result === 'victory' ? 0 : (result === 'escape' ? 1 : 2);
    };

    Events.beginBattle = function(interpreter, spec) {
        if (!Mmo.activeCharacter || !Mmo.connected) {
            Mmo.toast('Connexion MMO requise pour cet événement coopératif.', true);
            return false;
        }
        if (typeof MMOBattle !== 'undefined' && MMOBattle.active) {
            Mmo.toast('Un combat MMO est déjà en cours.', true);
            return false;
        }
        Events.sequence += 1;
        var key = 'event-battle-' + Date.now() + '-' + Events.sequence;
        var entry = {
            key: key,
            interpreter: interpreter,
            indent: spec.indent,
            context: {
                mapId: spec.mapId,
                eventId: spec.eventId,
                pageIndex: spec.pageIndex,
                commandIndex: spec.commandIndex
            },
            coop: spec.coop,
            rewardCommandIndexes: spec.rewardCommandIndexes || [],
            battleId: null,
            ready: false,
            branchResult: 2
        };
        Events.pending[key] = entry;
        interpreter._mmoEventBattleKey = key;
        interpreter.setWaitMode('mmoEventBattle');
        var sent = Mmo.send('battleStart', { source: 'event', eventContext: entry.context });
        if (!sent) {
            Events.complete(entry, 'defeat');
            return true;
        }
        return true;
    };

    Mmo.registerPacketHandler('battleState', function(packet) {
        var battle = packet.battle;
        if (!battle) return;
        Object.keys(Events.pending).forEach(function(key) {
            var entry = Events.pending[key];
            if (entry && !entry.battleId) entry.battleId = battle.battleId;
        });
    });

    Mmo.registerPacketHandler('battleEnded', function(packet) {
        Object.keys(Events.pending).forEach(function(key) {
            var entry = Events.pending[key];
            if (!entry || (entry.battleId && entry.battleId !== packet.battleId)) return;
            Events.complete(entry, packet.result);
        });
    });

    Mmo.registerErrorHandler(function(packet) {
        // battleStart validation errors have no battleState/battleId. Resume the
        // event through its Defeat branch instead of leaving its interpreter
        // permanently waiting for a battle that was never created.
        var codes = [
            'encounter_unknown', 'encounter_not_here', 'encounter_source_forbidden',
            'mmo_event_invalid', 'mmo_event_not_tagged', 'mmo_event_troop_invalid',
            'coop_requires_group', 'already_in_battle', 'battle_exit_pending',
            'group_member_in_battle', 'group_member_exit_pending', 'no_participants',
            'encounter_too_far', 'monster_config_invalid', 'monster_respawning',
            'monster_reserved', 'monster_in_battle', 'battle_lobby_missing',
            'battle_lobby_owner_required', 'battle_lobby_group_only', 'battle_lobby_owner_missing'
        ];
        if (codes.indexOf(String(packet.code || '')) === -1) return;
        Object.keys(Events.pending).forEach(function(key) {
            var entry = Events.pending[key];
            if (entry && !entry.battleId) Events.complete(entry, 'defeat');
        });
    });

    var _Game_Interpreter_updateWaitMode = Game_Interpreter.prototype.updateWaitMode;
    Game_Interpreter.prototype.updateWaitMode = function() {
        if (this._waitMode === 'mmoEventBattle') {
            var key = this._mmoEventBattleKey;
            var entry = Events.pending[key];
            if (entry && !entry.ready) return true;
            if (entry) {
                this._branch[entry.indent] = entry.branchResult;
                // The server has already persisted direct Change Gold / Change
                // EXP / Change Item commands from the victory branch. Skip their
                // local execution so native $gameParty does not briefly show a
                // duplicated client-only reward before the server snapshot.
                if (entry.branchResult === 0 && entry.rewardCommandIndexes.length) {
                    this._mmoSkipRewardCommands = {};
                    entry.rewardCommandIndexes.forEach(function(index) { this._mmoSkipRewardCommands[index] = true; }, this);
                }
                delete Events.pending[key];
            }
            delete this._mmoEventBattleKey;
            this._waitMode = '';
            return false;
        }
        return _Game_Interpreter_updateWaitMode.call(this);
    };

    [125, 126, 127, 128, 315].forEach(function(code) {
        var methodName = 'command' + code;
        var original = Game_Interpreter.prototype[methodName];
        Game_Interpreter.prototype[methodName] = function() {
            if (this._mmoSkipRewardCommands && this._mmoSkipRewardCommands[this._index]) {
                delete this._mmoSkipRewardCommands[this._index];
                return true;
            }
            return original.call(this);
        };
    });

    var _Game_Interpreter_command301 = Game_Interpreter.prototype.command301;
    Game_Interpreter.prototype.command301 = function() {
        var spec = Events.battleSpecForInterpreter(this);
        if (!spec) return _Game_Interpreter_command301.call(this);
        if (spec.invalid) {
            // Keep native event branch semantics even for malformed metadata.
            this._branch[this._indent] = 2;
            return true;
        }
        if (!Events.beginBattle(this, spec)) {
            this._branch[this._indent] = 2;
        }
        return true;
    };

    // Group battle lobbies are native event choices, not a party-wide auto
    // enrolment. OPEN and JOIN are harmless plugin commands; the actual native
    // Battle Processing branch later starts the locked lobby owner roster.
    Events.battleLobbySpecForInterpreter = function(interpreter, action, battleKey) {
        if (!interpreter || !interpreter._eventId || typeof $gameMap === 'undefined' || !$gameMap || typeof $dataMap === 'undefined' || !$dataMap) return null;
        var event = $gameMap.event(interpreter._eventId);
        var dataEvent = $dataMap.events[interpreter._eventId];
        var page = dataEvent && dataEvent.pages ? dataEvent.pages[event && event._pageIndex] : null;
        var list = page && page.list;
        var metadata = list ? Events.parseMetadata(Events.commentsImmediatelyBefore(list, interpreter._index)) : null;
        var normalizedAction = String(action || '').toLowerCase();
        var key = String(battleKey || '').toLowerCase();
        var currentCommand = list && list[interpreter._index];
        Events.traceLobby('client command resolved', {
            requestedAction: normalizedAction,
            battleKey: key,
            mapId: Number($gameMap.mapId()),
            eventId: Number(interpreter._eventId),
            pageIndex: event ? Number(event._pageIndex) : null,
            commandIndex: Number(interpreter._index),
            currentCommand: currentCommand ? { code: Number(currentCommand.code), parameters: currentCommand.parameters || [] } : null,
            immediateComment: list ? Events.commentsImmediatelyBefore(list, interpreter._index) : ''
        });
        if (!event || event._pageIndex < 0 || ['open', 'join'].indexOf(normalizedAction) === -1 || !/^[a-z][a-z0-9_-]{0,31}$/.test(key) || !metadata || String(metadata.battle || '').toLowerCase() !== key) {
            Mmo.toast('Cette branche doit porter <MMO battle=' + key + '> avant MMO BATTLE_LOBBY.', true);
            return { invalid: true };
        }
        return { action: normalizedAction, battleKey: key, mapId: Number($gameMap.mapId()), eventId: Number(interpreter._eventId), pageIndex: Number(event._pageIndex), commandIndex: Number(interpreter._index) };
    };

    Events.sendBattleLobbyAction = function(interpreter, action, battleKey) {
        if (!Mmo.activeCharacter || !Mmo.connected) return Mmo.toast('Connexion MMO requise pour ce combat.', true);
        if (typeof MMOBattle !== 'undefined' && MMOBattle.active) return Mmo.toast('Un combat est déjà en cours.', true);
        var spec = Events.battleLobbySpecForInterpreter(interpreter, action, battleKey);
        if (!spec || spec.invalid) return;
        // Plugin-command arguments preserve the author's spelling (usually
        // OPEN / JOIN in uppercase). `spec.action` is the already normalized
        // and validated form; use it to select the packet so OPEN never falls
        // through to the JOIN packet because of a case-sensitive comparison.
        var packetType = spec.action === 'open' ? 'battleLobbyOpen' : 'battleLobbyJoin';
        var eventContext = { mapId: spec.mapId, eventId: spec.eventId, pageIndex: spec.pageIndex, commandIndex: spec.commandIndex };
        Events.traceLobby('sending ' + packetType, { battleKey: spec.battleKey, eventContext: eventContext });
        Mmo.send(packetType, { battleKey: spec.battleKey, eventContext: eventContext });
    };

    // Visible map-side lobby panel. It is informational only: OPEN, JOIN and
    // Lancer remain explicit native MV branches, so this UI can never enrol a
    // player or start a battle by itself.
    Events.activeLobby = null;
    Events.LobbyWindow = null;

    Events.lobbyBelongsToCurrentMap = function(lobby) {
        if (!lobby || typeof $gameMap === 'undefined' || !$gameMap) return false;
        if (Number(lobby.mapId) !== Number($gameMap.mapId())) return false;
        var currentInstance = typeof Mmo.instanceId === 'undefined' ? null : (Mmo.instanceId || null);
        return (lobby.instanceId || null) === currentInstance;
    };

    if (typeof Window_Base !== 'undefined') {
        function Window_MMOBattleLobby() {
            this.initialize.apply(this, arguments);
        }
        Window_MMOBattleLobby.prototype = Object.create(Window_Base.prototype);
        Window_MMOBattleLobby.prototype.constructor = Window_MMOBattleLobby;
        Window_MMOBattleLobby.prototype.initialize = function() {
            var width = Math.min(390, Math.max(300, Graphics.boxWidth - 16));
            Window_Base.prototype.initialize.call(this, Graphics.boxWidth - width - 8, 8, width, 190);
            this.opacity = 222;
            this.backOpacity = 190;
            this._lobby = null;
            this._signature = '';
            this._lastSecond = -1;
            this.hide();
        };
        Window_MMOBattleLobby.prototype.setLobby = function(lobby) {
            var next = Events.lobbyBelongsToCurrentMap(lobby) ? lobby : null;
            var signature = next ? JSON.stringify({
                battleKey: next.battleKey, coop: next.coop, ownerCharacterId: next.ownerCharacterId,
                members: (next.members || []).map(function(member) { return [member.characterId, member.name, member.isOwner]; }),
                expiresAt: next.expiresAt
            }) : '';
            this._lobby = next;
            if (!next) {
                this._signature = '';
                this.hide();
                return;
            }
            this.show();
            if (signature !== this._signature) {
                this._signature = signature;
                this.refresh();
            }
        };
        Window_MMOBattleLobby.prototype.secondsLeft = function() {
            var expiresAt = this._lobby && Date.parse(this._lobby.expiresAt || '');
            if (!Number.isFinite(expiresAt)) return 0;
            return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
        };
        Window_MMOBattleLobby.prototype.durationLabel = function() {
            var seconds = this.secondsLeft();
            var remainder = seconds % 60;
            return Math.floor(seconds / 60) + ':' + (remainder < 10 ? '0' : '') + remainder;
        };
        Window_MMOBattleLobby.prototype.layout = function(memberCount) {
            var shown = Math.min(7, Math.max(1, memberCount));
            var extra = memberCount > shown ? 1 : 0;
            var height = 190 + (shown + extra) * 20;
            var width = Math.min(390, Math.max(300, Graphics.boxWidth - 16));
            if (this.width !== width || this.height !== height || this.x !== Graphics.boxWidth - width - 8) {
                this.move(Graphics.boxWidth - width - 8, 8, width, height);
                this.createContents();
            }
            return { shown: shown, extra: extra };
        };
        Window_MMOBattleLobby.prototype.refresh = function() {
            var lobby = this._lobby;
            if (!lobby) return;
            var members = lobby.members || (lobby.memberIds || []).map(function(characterId) {
                return { characterId: characterId, name: 'Aventurier', isOwner: String(characterId) === String(lobby.ownerCharacterId) };
            });
            var layout = this.layout(members.length);
            this.contents.clear();
            this.contents.fontSize = 18;
            this.changeTextColor(this.systemColor());
            this.drawText('Lobby de combat', 0, 0, this.contentsWidth());
            this.contents.fontSize = 12;
            this.resetTextColor();
            this.drawText('Monstre : ' + String(lobby.battleKey || 'combat'), 0, 23, this.contentsWidth());
            this.changeTextColor(this.powerUpColor());
            this.drawText('État : en attente de lancement', 0, 43, this.contentsWidth());
            this.resetTextColor();
            this.drawText('Expiration : ' + this.durationLabel(), 0, 63, this.contentsWidth());
            var owner = members.filter(function(member) { return member && member.isOwner; })[0];
            this.drawText('Créateur : ' + String(owner ? owner.name : lobby.ownerCharacterId || 'inconnu'), 0, 83, this.contentsWidth());
            this.changeTextColor(this.systemColor());
            this.drawText('Inscrits (' + members.length + ')', 0, 105, this.contentsWidth());
            this.resetTextColor();
            var localId = Mmo.activeCharacter && Mmo.activeCharacter.characterId;
            members.slice(0, layout.shown).forEach(function(member, index) {
                var isLocal = String(member.characterId) === String(localId);
                var prefix = member.isOwner ? '★ ' : '✓ ';
                var suffix = isLocal ? ' (vous)' : '';
                this.changeTextColor(isLocal ? this.powerUpColor() : this.normalColor());
                this.drawText(prefix + String(member.name || 'Aventurier') + suffix, 4, 126 + index * 20, this.contentsWidth() - 4);
                this.resetTextColor();
            }, this);
            var y = 126 + layout.shown * 20;
            if (layout.extra) {
                this.drawText('… et ' + (members.length - layout.shown) + ' autre(s)', 4, y, this.contentsWidth() - 4);
                y += 20;
            }
            var iAmOwner = String(lobby.ownerCharacterId) === String(localId);
            this.contents.fontSize = 11;
            this.changeTextColor(iAmOwner ? this.powerUpColor() : this.normalColor());
            this.drawText(iAmOwner ? 'Vous êtes créateur : cliquez le monstre puis choisissez « Lancer ».' : 'Vous êtes inscrit : attendez que le créateur choisisse « Lancer ».', 0, y + 3, this.contentsWidth());
            this.resetTextColor();
            this.contents.fontSize = this.standardFontSize();
        };
        Window_MMOBattleLobby.prototype.update = function() {
            Window_Base.prototype.update.call(this);
            if (!this.visible || !this._lobby) return;
            var second = Math.floor(Date.now() / 1000);
            if (second !== this._lastSecond) {
                this._lastSecond = second;
                this.refresh();
            }
        };
        Events.LobbyWindow = Window_MMOBattleLobby;
    }

    Events.attachLobbyWindow = function(scene) {
        if (!scene || !Events.LobbyWindow || scene._mmoBattleLobbyWindow || !scene.addWindow) return;
        scene._mmoBattleLobbyWindow = new Events.LobbyWindow();
        scene.addWindow(scene._mmoBattleLobbyWindow);
        scene._mmoBattleLobbyWindow.setLobby(Events.activeLobby);
    };
    Events.refreshLobbyWindow = function() {
        var scene = typeof SceneManager !== 'undefined' && SceneManager ? SceneManager._scene : null;
        if (scene && scene._mmoBattleLobbyWindow) scene._mmoBattleLobbyWindow.setLobby(Events.activeLobby);
    };
    Events.setActiveLobby = function(lobby) {
        Events.activeLobby = lobby && lobby.status === 'lobby' ? lobby : null;
        Events.refreshLobbyWindow();
    };
    Events.clearActiveLobby = function(battleKey) {
        if (!Events.activeLobby || !battleKey || String(Events.activeLobby.battleKey) === String(battleKey)) Events.activeLobby = null;
        Events.refreshLobbyWindow();
    };

    var _Scene_Map_createAllWindowsLobby = Scene_Map.prototype.createAllWindows;
    if (typeof _Scene_Map_createAllWindowsLobby === 'function') {
        Scene_Map.prototype.createAllWindows = function() {
            _Scene_Map_createAllWindowsLobby.call(this);
            Events.attachLobbyWindow(this);
        };
    }

    // Quest-giver markers are cosmetic projections of the authoritative quest
    // snapshot. They never start, complete or claim a quest; the NPC branch is
    // still verified again by the server.
    Events.questMarkerStates = [];
    Events.questMarkersDirty = true;
    Events.markQuestMarkersDirty = function() { Events.questMarkersDirty = true; };

    Events.questIdsForGiverEvent = function(eventId) {
        if (typeof $dataMap === 'undefined' || !$dataMap || typeof $gameMap === 'undefined' || !$gameMap) return [];
        var runtimeEvent = $gameMap.event(eventId);
        var dataEvent = $dataMap.events && $dataMap.events[eventId];
        if (!runtimeEvent || runtimeEvent._erased || !dataEvent || !dataEvent.pages || runtimeEvent._pageIndex < 0) return [];
        var page = dataEvent.pages[runtimeEvent._pageIndex];
        var list = page && page.list ? page.list : [];
        var isQuestGiver = false;
        var questIds = [];
        list.forEach(function(command) {
            if (!command || (command.code !== 108 && command.code !== 408)) return;
            var metadata = Events.parseMetadata(String((command.parameters || [])[0] || ''));
            if (!metadata) return;
            if (String(metadata.npc || '').toLowerCase() === 'quest_giver') isQuestGiver = true;
            var action = String(metadata['npc-action'] || '').toLowerCase();
            var questId = String(metadata.quest || '').toLowerCase();
            if ((action === 'quest_start' || action === 'quest_turn_in') && /^[a-z][a-z0-9_-]{0,63}$/.test(questId) && questIds.indexOf(questId) === -1) questIds.push(questId);
        });
        return isQuestGiver ? questIds : [];
    };

    Events.questMarkerForIds = function(questIds) {
        if (!questIds || !questIds.length) return '';
        var states = Events.questMarkerStates || Mmo.quests || [];
        var hasAvailable = false;
        for (var index = 0; index < questIds.length; index += 1) {
            var questId = String(questIds[index]);
            var matching = states.filter(function(quest) { return String(quest.questId || '').toLowerCase() === questId; });
            if (matching.some(function(quest) { return quest && quest.status === 'ready'; })) return '?';
            if (!matching.length) hasAvailable = true;
        }
        return hasAvailable ? '!' : '';
    };

    Events.questMarkerEntries = function() {
        if (typeof $dataMap === 'undefined' || !$dataMap || !Array.isArray($dataMap.events)) return [];
        var entries = [];
        $dataMap.events.forEach(function(dataEvent, eventId) {
            if (!dataEvent || eventId < 1) return;
            var symbol = Events.questMarkerForIds(Events.questIdsForGiverEvent(eventId));
            if (symbol) entries.push({ eventId: Number(eventId), symbol: symbol });
        });
        return entries;
    };

    Events.clearQuestMarkers = function(scene) {
        if (!scene || !scene._mmoQuestMarkers) return;
        Object.keys(scene._mmoQuestMarkers).forEach(function(key) {
            var sprite = scene._mmoQuestMarkers[key];
            if (sprite && sprite.parent && sprite.parent.removeChild) sprite.parent.removeChild(sprite);
        });
        scene._mmoQuestMarkers = {};
        scene._mmoQuestMarkerSignature = '';
    };

    Events.makeQuestMarkerSprite = function(symbol) {
        if (typeof Bitmap === 'undefined' || typeof Sprite === 'undefined') return null;
        var bitmap = new Bitmap(34, 34);
        bitmap.fontFace = 'Arial';
        bitmap.fontSize = 28;
        bitmap.outlineWidth = 4;
        bitmap.outlineColor = '#172136';
        bitmap.textColor = symbol === '?' ? '#f5d45b' : '#f3f7ff';
        bitmap.drawText(symbol, 0, -2, 34, 34, 'center');
        var sprite = new Sprite(bitmap);
        sprite.anchor.x = 0.5;
        sprite.anchor.y = 1;
        return sprite;
    };

    Events.rebuildQuestMarkers = function(scene, entries) {
        var parent = scene && scene._spriteset && (scene._spriteset._tilemap || scene._spriteset);
        if (!parent || !parent.addChild) return;
        Events.clearQuestMarkers(scene);
        scene._mmoQuestMarkers = {};
        entries.forEach(function(entry) {
            var sprite = Events.makeQuestMarkerSprite(entry.symbol);
            if (!sprite) return;
            scene._mmoQuestMarkers[String(entry.eventId)] = sprite;
            parent.addChild(sprite);
        });
        scene._mmoQuestMarkerSignature = entries.map(function(entry) { return entry.eventId + ':' + entry.symbol; }).join('|');
    };

    Events.positionQuestMarkers = function(scene) {
        if (!scene || !scene._mmoQuestMarkers || typeof $gameMap === 'undefined' || !$gameMap) return;
        Object.keys(scene._mmoQuestMarkers).forEach(function(key) {
            var sprite = scene._mmoQuestMarkers[key];
            var event = $gameMap.event(Number(key));
            sprite.visible = !!(event && !event._erased);
            if (!sprite.visible) return;
            sprite.x = event.screenX();
            sprite.y = event.screenY() - 48;
        });
    };

    Events.updateQuestMarkers = function(scene) {
        if (!scene || typeof $gameMap === 'undefined' || !$gameMap || typeof $dataMap === 'undefined' || !$dataMap) return;
        scene._mmoQuestMarkerTick = Number(scene._mmoQuestMarkerTick || 0) + 1;
        if (Events.questMarkersDirty || scene._mmoQuestMarkerTick % 12 === 0) {
            var entries = Events.questMarkerEntries();
            var signature = entries.map(function(entry) { return entry.eventId + ':' + entry.symbol; }).join('|');
            if (signature !== scene._mmoQuestMarkerSignature) Events.rebuildQuestMarkers(scene, entries);
            Events.questMarkersDirty = false;
        }
        Events.positionQuestMarkers(scene);
    };

    Mmo.registerPacketHandler('questSnapshot', function(packet) {
        Events.questMarkerStates = packet && packet.quests ? packet.quests : [];
        Events.markQuestMarkersDirty();
    });

    var _Scene_Map_updateQuestMarkers = Scene_Map.prototype.update;
    if (typeof _Scene_Map_updateQuestMarkers === 'function') {
        Scene_Map.prototype.update = function() {
            _Scene_Map_updateQuestMarkers.call(this);
            Events.updateQuestMarkers(this);
        };
    }
    var _Scene_Map_terminateQuestMarkers = Scene_Map.prototype.terminate;
    if (typeof _Scene_Map_terminateQuestMarkers === 'function') {
        Scene_Map.prototype.terminate = function() {
            Events.clearQuestMarkers(this);
            _Scene_Map_terminateQuestMarkers.call(this);
        };
    }

    Events.monsterStates = {};
    Events.monsterStateKey = function(packet) {
        return [Number(packet.mapId), packet.instanceId || 'public', Number(packet.eventId), Number(packet.pageIndex), String(packet.battleKey || '')].join(':');
    };
    Events.applyMonsterState = function(packet) {
        if (!packet || typeof $gameMap === 'undefined' || !$gameMap || Number($gameMap.mapId()) !== Number(packet.mapId)) return;
        if (typeof Mmo.instanceId !== 'undefined' && (Mmo.instanceId || null) !== (packet.instanceId || null)) return;
        var event = $gameMap.event(Number(packet.eventId));
        if (!event) return;
        if (packet.status === 'respawning') {
            event.erase();
        } else if (packet.status === 'available' && event._erased) {
            var anotherRespawn = Object.keys(Events.monsterStates).some(function(key) {
                var state = Events.monsterStates[key];
                return state && state.status === 'respawning' && Number(state.mapId) === Number(packet.mapId) && Number(state.eventId) === Number(packet.eventId) && (state.instanceId || null) === (packet.instanceId || null);
            });
            if (!anotherRespawn) {
                event._erased = false;
                event.refresh();
            }
        }
    };
    Events.applyMonsterStates = function() {
        Object.keys(Events.monsterStates).forEach(function(key) { Events.applyMonsterState(Events.monsterStates[key]); });
    };
    Mmo.registerPacketHandler('worldSnapshot', function(packet) {
        Events.monsterStates = {};
        (packet.monsterStates || []).forEach(function(state) { Events.monsterStates[Events.monsterStateKey(state)] = state; });
        Events.applyMonsterStates();
    });
    Mmo.registerPacketHandler('worldMonsterState', function(packet) {
        var key = Events.monsterStateKey(packet);
        if (packet.status === 'available') delete Events.monsterStates[key]; else Events.monsterStates[key] = packet;
        Events.applyMonsterState(packet);
    });
    Mmo.registerPacketHandler('battleLobbyState', function(packet) {
        if (packet && packet.lobby) Events.setActiveLobby(packet.lobby);
        if (packet && packet.message) Mmo.toast(packet.message, false);
    });
    Mmo.registerPacketHandler('battleLobbyClosed', function(packet) {
        Events.clearActiveLobby(packet && packet.battleKey);
        if (packet && packet.reason) Mmo.toast(packet.reason, false);
    });
    Mmo.registerErrorHandler(function(packet) {
        var code = String(packet && packet.code || '');
        if (code.indexOf('battle_lobby') !== 0) return;
        Events.traceLobby('server refused lobby request', { code: code, message: String(packet.message || '') });
    });
    var _Scene_Map_onMapLoadedMonster = Scene_Map.prototype.onMapLoaded;
    Scene_Map.prototype.onMapLoaded = function() {
        _Scene_Map_onMapLoadedMonster.call(this);
        Events.applyMonsterStates();
        Events.refreshLobbyWindow();
        Events.markQuestMarkersDirty();
    };

    // Service NPCs deliberately keep Show Choices and every dialogue command
    // native. Only a marked branch calls MMO NPC_ACTION, which pauses that
    // event until the server has reread and authorized the real MapXXX page.
    Events.npcPending = {};
    Events.npcSequence = 0;
    Events.npcTurnInRewardIndexes = function(list, commandIndex) {
        var actionCommand = list && list[commandIndex];
        var indent = Number(actionCommand && actionCommand.indent || 0);
        var indexes = [];
        for (var index = Number(commandIndex) + 1; list && index < list.length; index += 1) {
            var command = list[index];
            if (!command || Number(command.indent || 0) !== indent) break;
            if ([125, 126, 127, 128, 315].indexOf(Number(command.code)) === -1) break;
            indexes.push(index);
        }
        return indexes;
    };
    Events.npcSpecForInterpreter = function(interpreter, action) {
        if (!interpreter || !interpreter._eventId || typeof $gameMap === 'undefined' || !$gameMap || typeof $dataMap === 'undefined' || !$dataMap) return null;
        var event = $gameMap.event(interpreter._eventId);
        var dataEvent = $dataMap.events[interpreter._eventId];
        var page = dataEvent && dataEvent.pages ? dataEvent.pages[event && event._pageIndex] : null;
        var list = page && page.list;
        var metadata = list ? Events.parseMetadata(Events.commentsImmediatelyBefore(list, interpreter._index)) : null;
        var normalizedAction = String(action || '').toLowerCase();
        if (!event || event._pageIndex < 0 || !metadata || String(metadata['npc-action'] || '').toLowerCase() !== normalizedAction || !/^[a-z][a-z0-9_-]{0,31}$/.test(normalizedAction)) {
            Mmo.toast('Cette action PNJ doit être précédée de <MMO npc-action=' + normalizedAction + '>.', true);
            return { invalid: true };
        }
        return {
            action: normalizedAction,
            mapId: Number($gameMap.mapId()),
            eventId: Number(interpreter._eventId),
            pageIndex: Number(event._pageIndex),
            commandIndex: Number(interpreter._index),
            rewardCommandIndexes: normalizedAction === 'quest_turn_in' ? Events.npcTurnInRewardIndexes(list, interpreter._index) : []
        };
    };

    Events.completeNpc = function(entry, applyRewards) {
        if (!entry) return;
        entry.applyRewards = applyRewards === true;
        entry.ready = true;
    };
    Events.beginNpcAction = function(interpreter, spec) {
        if (!Mmo.activeCharacter || !Mmo.connected) {
            Mmo.toast('Connexion MMO requise pour ce PNJ.', true);
            return false;
        }
        Events.npcSequence += 1;
        var requestId = 'npc-' + Date.now() + '-' + Events.npcSequence;
        var entry = {
            requestId: requestId, interpreter: interpreter, ready: false, applyRewards: false,
            action: spec.action, rewardCommandIndexes: spec.rewardCommandIndexes || []
        };
        Events.npcPending[requestId] = entry;
        interpreter._mmoNpcRequestId = requestId;
        interpreter.setWaitMode('mmoNpcAction');
        if (!Mmo.send('npcAction', { requestId: requestId, action: spec.action, eventContext: {
            mapId: spec.mapId, eventId: spec.eventId, pageIndex: spec.pageIndex, commandIndex: spec.commandIndex
        } })) {
            Events.completeNpc(entry);
        }
        return true;
    };

    Mmo.registerPacketHandler('npcServiceOpen', function(packet) {
        var entry = Events.npcPending[packet.requestId];
        if (entry) Events.completeNpc(entry, entry.action === 'quest_turn_in');
        if (packet.service === 'auction_house' && typeof MMOAuction !== 'undefined' && MMOAuction.openFromNpcService) {
            MMOAuction.openFromNpcService(packet);
        } else if ((packet.service === 'merchant' || packet.service === 'banker') && typeof MMOServices !== 'undefined' && MMOServices.openFromNpcService) {
            MMOServices.openFromNpcService(packet);
        } else if (packet.service === 'guild_registrar' && typeof MMOGuild !== 'undefined' && MMOGuild.openCreateFromNpcService) {
            MMOGuild.openCreateFromNpcService(packet);
        } else if (packet.service === 'quest_giver' || packet.service === 'innkeeper') {
            if (packet.message) Mmo.toast(packet.message, false);
        } else {
            Mmo.toast('Service PNJ inconnu : ' + String(packet.service || ''), true);
        }
    });
    Mmo.registerErrorHandler(function(packet) {
        var code = String(packet.code || '');
        // The service request has no dedicated response on refusal. Resume its
        // native event branch for every error that can occur before opening;
        // auction_* errors happen only after the service UI is already open.
        // Quest mode/group validation is also a refusal of the marked NPC
        // action. Always release its native interpreter instead of freezing a
        // Show Choices branch when, for example, a player chose group mode
        // without belonging to a group.
        var resumable = code.indexOf('npc_') === 0 || code.indexOf('quest_') === 0 ||
            ['in_battle', 'no_character', 'server_error', 'invalid_packet', 'group_required', 'already_in_guild', 'merchant_config_invalid'].indexOf(code) !== -1;
        if (!resumable) return;
        Object.keys(Events.npcPending).forEach(function(key) { Events.completeNpc(Events.npcPending[key]); });
    });

    var _Game_Interpreter_updateWaitModeNpc = Game_Interpreter.prototype.updateWaitMode;
    Game_Interpreter.prototype.updateWaitMode = function() {
        if (this._waitMode === 'mmoNpcAction') {
            var requestId = this._mmoNpcRequestId;
            var entry = Events.npcPending[requestId];
            if (entry && !entry.ready) return true;
            if (entry && entry.applyRewards && entry.rewardCommandIndexes.length) {
                this._mmoSkipRewardCommands = this._mmoSkipRewardCommands || {};
                entry.rewardCommandIndexes.forEach(function(index) { this._mmoSkipRewardCommands[index] = true; }, this);
            }
            delete Events.npcPending[requestId];
            delete this._mmoNpcRequestId;
            this._waitMode = '';
            return false;
        }
        return _Game_Interpreter_updateWaitModeNpc.call(this);
    };

    var _Game_Interpreter_pluginCommandNpc = Game_Interpreter.prototype.pluginCommand;
    Game_Interpreter.prototype.pluginCommand = function(command, args) {
        if (String(command).toUpperCase() === 'MMO') {
            var lobbyHead = String(args[0] || '').toUpperCase();
            if (lobbyHead === 'BATTLE_LOBBY' || lobbyHead === 'BATTLELOBBY') {
                Events.sendBattleLobbyAction(this, args[1], args[2]);
                return true;
            }
            if (lobbyHead === 'BATTLE' && String(args[1] || '').toUpperCase() === 'LOBBY') {
                Events.sendBattleLobbyAction(this, args[2], args[3]);
                return true;
            }
        }
        if (String(command).toUpperCase() === 'MMO' && String(args[0] || '').toUpperCase() === 'NPC_ACTION') {
            var spec = Events.npcSpecForInterpreter(this, args[1]);
            if (!spec || spec.invalid || !Events.beginNpcAction(this, spec)) return true;
            return true;
        }
        return _Game_Interpreter_pluginCommandNpc.call(this, command, args);
    };

})(MMOEvents, MMOFoundation);
