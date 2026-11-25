/*:
 * @plugindesc v0.20.0 Échange joueur à joueur autoritaire avec MMOFoundation.
 * @author Arena MMO starter
 *
 * @help
 * Requires MMOFoundation and MMOInventory above it.
 *
 * Press R on the map while standing next to another player to open the trade
 * picker. Both players must remain within one tile and both must approve the
 * final offer. Items, weapons, armor and gold are transferred atomically by
 * the server only after it locks and rechecks both inventories.
 *
 * Plugin commands:
 *   MMO TRADE Character Name
 *   MMO TRADE_CANCEL
 */

var Imported = Imported || {};
Imported.MMOTrade = true;
var MMOTrade = MMOTrade || {};

(function(Trade, Mmo) {
    'use strict';

    if (!Mmo || typeof Mmo.registerPacketHandler !== 'function') {
        console.error('MMOTrade requires MMOFoundation, loaded above it.');
        return;
    }

    function escapeHtml(value) {
        return String(value === undefined || value === null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }
    function ownItems() {
        return typeof MMOInventory !== 'undefined' && MMOInventory.data ? (MMOInventory.data.items || []) : [];
    }
    function blankOffer() { return { items: [], gold: 0 }; }
    function currentOffer() {
        return Trade.state && Trade.state.myOffer ? Trade.state.myOffer : blankOffer();
    }
    function offerItemQuantity(offer, itemId) {
        var entry = (offer.items || []).filter(function(item) { return String(item.itemId) === String(itemId); })[0];
        return entry ? Number(entry.quantity || 0) : 0;
    }

    Trade.mode = null;
    Trade.state = null;
    Trade.invite = null;
    Trade.outboundTarget = null;
    Trade.pendingTradeId = null;

    Trade.ensureDom = function() {
        if (typeof document === 'undefined') return null;
        if (!document.getElementById('mmo-trade-style')) {
            var style = document.createElement('style');
            style.id = 'mmo-trade-style';
            style.textContent = [
                '#mmo-trade-root{position:fixed;z-index:100006;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(3,7,15,.68);font-family:Arial,sans-serif;color:#edf4ff;pointer-events:auto}',
                '#mmo-trade-root:empty{display:none}.mt-window{width:min(940px,calc(100vw - 28px));max-height:calc(100vh - 28px);overflow:auto;background:#101b2e;border:1px solid #7ea6e7;border-radius:10px;box-shadow:0 14px 55px #000}.mt-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 15px;background:linear-gradient(90deg,#174474,#292367)}.mt-head strong{font-size:18px}.mt-head button,.mt-button,.mt-row button{border:0;border-radius:4px;padding:7px 9px;background:#396fcb;color:#fff;font-weight:bold;cursor:pointer}.mt-button.secondary,.mt-head button{background:#495974}.mt-button.cancel{background:#9b4055}.mt-content{padding:14px}.mt-note{padding:10px;background:#152640;border-left:3px solid #79aaf2;line-height:1.45;font-size:13px}.mt-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}.mt-card{min-width:0;border:1px solid #34517d;border-radius:6px;background:#111f35;padding:10px}.mt-title{margin-bottom:8px;color:#a9cbfb;font-size:12px;font-weight:bold;text-transform:uppercase}.mt-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px;margin:5px 0;border:1px solid #2e496f;border-radius:4px;background:#15253d}.mt-row strong{display:block;font-size:13px}.mt-row small,.mt-muted{display:block;color:#b7c8e3;font-size:11px;margin-top:2px}.mt-gold{display:flex;align-items:center;gap:7px;margin:10px 0}.mt-gold input{width:95px;padding:7px;background:#07111f;border:1px solid #4b6c9e;border-radius:4px;color:#fff}.mt-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.mt-accepted{padding:8px;border-radius:4px;background:#1d634c;color:#d8ffec;font-weight:bold;font-size:12px}.mt-waiting{padding:8px;border-radius:4px;background:#4c5265;color:#e7edf9;font-size:12px}.mt-player{cursor:pointer}.mt-player:hover{border-color:#79aaf2;background:#1b3150}@media(max-width:650px){.mt-grid{grid-template-columns:1fr}.mt-window{max-height:calc(100vh - 10px)}}'
            ].join('');
            document.head.appendChild(style);
        }
        var root = document.getElementById('mmo-trade-root');
        if (!root) {
            root = document.createElement('div');
            root.id = 'mmo-trade-root';
            document.body.appendChild(root);
        }
        if (typeof Mmo.protectHudInteraction === 'function') Mmo.protectHudInteraction(root);
        if (typeof Mmo.enableWheelScrolling === 'function') Mmo.enableWheelScrolling(root);
        return root;
    };

    Trade.close = function(cancel) {
        var active = (Trade.state && Trade.state.tradeId) || Trade.pendingTradeId;
        // Do not hide an active window before the authoritative cancellation
        // arrives. A second confirmation may already be finalizing, in which
        // case the server correctly refuses a late cancellation and the player
        // must still see the completed inventory snapshot.
        if (cancel && active) {
            Mmo.send('tradeCancel', { tradeId: active });
            return;
        }
        Trade.mode = null;
        Trade.state = null;
        Trade.invite = null;
        Trade.outboundTarget = null;
        Trade.pendingTradeId = null;
        var root = Trade.ensureDom();
        if (root) root.innerHTML = '';
    };

    Trade.nearbyPlayers = function() {
        if (typeof $gamePlayer === 'undefined' || !$gamePlayer || !Mmo.activeCharacter) return [];
        var px = Number($gamePlayer.x), py = Number($gamePlayer.y);
        return Object.keys(Mmo.remotePlayers || {}).map(function(id) { return Mmo.remotePlayers[id]; }).filter(function(player) {
            var currentMapId = typeof $gameMap !== 'undefined' && $gameMap ? Number($gameMap.mapId()) : Number(Mmo.activeCharacter.mapId || 0);
            var currentInstanceId = Mmo.instanceId || null;
            return player && Math.max(Math.abs(Number(player.x) - px), Math.abs(Number(player.y) - py)) <= 1 && Number(player.mapId) === currentMapId && (player.instanceId || null) === currentInstanceId;
        });
    };

    Trade.openNearby = function() {
        if (!Mmo.activeCharacter) return Mmo.toast('Connecte un personnage avant de proposer un échange.', true);
        if (typeof MMOBattle !== 'undefined' && MMOBattle.active) return Mmo.toast('Échange indisponible pendant un combat.', true);
        var players = Trade.nearbyPlayers();
        if (!players.length) return Mmo.toast('Aucun joueur à une tuile ou moins.', true);
        if (players.length === 1) return Trade.request(players[0]);
        Trade.mode = 'picker';
        Trade.state = { candidates: players };
        Trade.render();
    };

    Trade.request = function(player) {
        if (!player) return;
        Trade.mode = 'outbound';
        Trade.outboundTarget = player;
        Trade.render();
        Mmo.send('tradeRequest', { targetCharacterId: player.characterId });
    };

    Trade.offerPayload = function() {
        var offer = currentOffer();
        return {
            items: (offer.items || []).map(function(item) { return { itemId: item.itemId, quantity: Number(item.quantity || 0) }; }),
            gold: Number(offer.gold || 0)
        };
    };

    Trade.sendOffer = function(next) {
        if (!Trade.state || !Trade.state.tradeId) return;
        Trade.state.myOffer = next;
        Mmo.send('tradeSetOffer', Object.assign({ tradeId: Trade.state.tradeId }, Trade.offerPayload()));
    };

    Trade.setItemQuantity = function(itemId) {
        var offer = currentOffer();
        var owned = ownItems().filter(function(item) { return String(item.itemId) === String(itemId); })[0];
        if (!owned) return;
        var oldQuantity = offerItemQuantity(offer, itemId);
        var quantity = Number(window.prompt('Quantité à proposer (0 pour retirer)', String(oldQuantity || 1)));
        if (!isFinite(quantity) || quantity < 0) return;
        quantity = Math.min(Math.floor(quantity), Number(owned.quantity || 0));
        var next = { gold: Number(offer.gold || 0), items: (offer.items || []).filter(function(item) { return String(item.itemId) !== String(itemId); }) };
        if (quantity > 0) next.items.push({ itemId: itemId, quantity: quantity });
        Trade.sendOffer(next);
    };

    Trade.setGold = function() {
        if (!Trade.state) return;
        var input = document.getElementById('mt-gold-input');
        var gold = Math.max(0, Math.floor(Number(input && input.value || 0)));
        var offer = currentOffer();
        Trade.sendOffer({ gold: gold, items: (offer.items || []).slice() });
    };

    Trade.offerHtml = function(offer, editable) {
        var items = offer && offer.items || [];
        var rows = items.length ? items.map(function(item) {
            return '<div class="mt-row"><div><strong>' + escapeHtml(item.label || item.itemId) + ' × ' + Number(item.quantity || 0) + '</strong><small>' + escapeHtml(item.description || '') + '</small></div>' +
                (editable ? '<button class="mt-edit-item" data-item="' + escapeHtml(item.itemId) + '">Modifier</button>' : '') + '</div>';
        }).join('') : '<div class="mt-muted">Aucun objet proposé.</div>';
        return '<div class="mt-gold"><strong>Or :</strong><span>' + Number(offer && offer.gold || 0) + '</span></div>' + rows;
    };

    Trade.ownInventoryHtml = function() {
        var offer = currentOffer();
        var items = ownItems();
        if (!items.length) return '<div class="mt-muted">Inventaire vide.</div>';
        return items.map(function(item) {
            var offered = offerItemQuantity(offer, item.itemId);
            return '<div class="mt-row"><div><strong>' + escapeHtml(item.label || item.itemId) + ' × ' + Number(item.quantity || 0) + (offered ? ' · proposé : ' + offered : '') + '</strong><small>' + escapeHtml(item.description || '') + '</small></div><button class="mt-offer-item" data-item="' + escapeHtml(item.itemId) + '">Proposer</button></div>';
        }).join('');
    };

    Trade.renderPicker = function() {
        var candidates = Trade.state && Trade.state.candidates || [];
        return '<div class="mt-note">Choisis un joueur adjacent. Le serveur vérifie la carte, l’instance et la distance réelle avant toute demande.</div><div class="mt-title">Joueurs à proximité</div>' +
            candidates.map(function(player) { return '<div class="mt-row mt-player" data-id="' + escapeHtml(player.characterId) + '"><div><strong>' + escapeHtml(player.name) + '</strong><small>' + escapeHtml(player.classId || '') + ' · niv. ' + Number(player.level || 1) + '</small></div><button>Échanger</button></div>'; }).join('');
    };

    Trade.renderInvite = function() {
        return '<div class="mt-note"><strong>' + escapeHtml(Trade.invite && Trade.invite.from && Trade.invite.from.name || 'Un joueur') + '</strong> te propose un échange. Vous devez rester à une tuile ou moins pendant toute la validation.</div><div class="mt-actions"><button class="mt-button" id="mt-accept-invite">Accepter</button><button class="mt-button cancel" id="mt-decline-invite">Refuser</button></div>';
    };

    Trade.renderOutbound = function() {
        return '<div class="mt-note">Demande envoyée à <strong>' + escapeHtml(Trade.outboundTarget && Trade.outboundTarget.name || 'ce joueur') + '</strong>. En attente de sa confirmation…</div><div class="mt-actions"><button class="mt-button cancel" id="mt-cancel-outbound">Annuler</button></div>';
    };

    Trade.renderActive = function() {
        var state = Trade.state;
        var ownAccepted = state.myAccepted ? '<div class="mt-accepted">Tu as validé cette offre.</div>' : '<div class="mt-waiting">Ta validation reste nécessaire.</div>';
        var otherAccepted = state.otherAccepted ? '<div class="mt-accepted">Le partenaire a validé.</div>' : '<div class="mt-waiting">Le partenaire n’a pas encore validé.</div>';
        return '<div class="mt-note">Chaque modification annule les deux validations. Le transfert ne se produit qu’après les deux validations et une dernière vérification serveur de distance, d’or et d’inventaire.</div>' +
            '<div class="mt-grid"><section class="mt-card"><div class="mt-title">Ton offre</div><div class="mt-gold"><strong>Or :</strong><input id="mt-gold-input" type="number" min="0" step="1" value="' + Number(currentOffer().gold || 0) + '"><button class="mt-button" id="mt-set-gold">Mettre à jour</button></div>' + Trade.offerHtml(currentOffer(), true) + ownAccepted + '</section>' +
            '<section class="mt-card"><div class="mt-title">Offre de ' + escapeHtml(state.partner && state.partner.name || 'joueur') + '</div>' + Trade.offerHtml(state.otherOffer || blankOffer(), false) + otherAccepted + '</section></div>' +
            '<div class="mt-grid"><section class="mt-card"><div class="mt-title">Ton inventaire</div>' + Trade.ownInventoryHtml() + '</section><section class="mt-card"><div class="mt-title">Validation</div><div class="mt-note">Les armes ou armures proposées sont automatiquement retirées de l’équipement du donneur au moment du transfert.</div><div class="mt-actions"><button class="mt-button" id="mt-accept-trade"' + (state.myAccepted ? ' disabled' : '') + '>Valider mon offre</button><button class="mt-button cancel" id="mt-cancel-trade">Annuler l’échange</button></div></section></div>';
    };

    Trade.render = function() {
        var root = Trade.ensureDom();
        if (!root || !Trade.mode) return;
        var body = Trade.mode === 'picker' ? Trade.renderPicker() : Trade.mode === 'invite' ? Trade.renderInvite() : Trade.mode === 'outbound' ? Trade.renderOutbound() : Trade.renderActive();
        root.innerHTML = '<section class="mt-window"><div class="mt-head"><strong>Échange entre joueurs</strong><button id="mt-close">Fermer</button></div><div class="mt-content">' + body + '</div></section>';
        document.getElementById('mt-close').onclick = function() { Trade.close(Trade.mode === 'active' || Trade.mode === 'outbound'); };
        var acceptInvite = document.getElementById('mt-accept-invite');
        if (acceptInvite) acceptInvite.onclick = function() { Mmo.send('tradeResponse', { tradeId: Trade.invite.tradeId, accepted: true }); };
        var declineInvite = document.getElementById('mt-decline-invite');
        if (declineInvite) declineInvite.onclick = function() { Mmo.send('tradeResponse', { tradeId: Trade.invite.tradeId, accepted: false }); Trade.close(false); };
        var cancelOutbound = document.getElementById('mt-cancel-outbound');
        if (cancelOutbound) cancelOutbound.onclick = function() { Trade.close(true); };
        var setGold = document.getElementById('mt-set-gold');
        if (setGold) setGold.onclick = Trade.setGold;
        var acceptTrade = document.getElementById('mt-accept-trade');
        if (acceptTrade) acceptTrade.onclick = function() { Mmo.send('tradeAccept', { tradeId: Trade.state.tradeId }); };
        var cancelTrade = document.getElementById('mt-cancel-trade');
        if (cancelTrade) cancelTrade.onclick = function() { Trade.close(true); };
        var offers = root.querySelectorAll('.mt-offer-item,.mt-edit-item');
        for (var index = 0; index < offers.length; index++) offers[index].onclick = function() { Trade.setItemQuantity(this.getAttribute('data-item')); };
        var candidates = root.querySelectorAll('.mt-player');
        for (var candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) candidates[candidateIndex].onclick = function() {
            var candidate = (Trade.state.candidates || []).filter(function(player) { return String(player.characterId) === String(this.getAttribute('data-id')); }, this)[0];
            Trade.request(candidate);
        };
    };

    Mmo.registerPacketHandler('tradePending', function(packet) {
        Trade.pendingTradeId = packet.tradeId || null;
        Trade.outboundTarget = packet.target || Trade.outboundTarget;
        if (Trade.mode === 'outbound') Trade.render();
    });
    if (typeof Mmo.registerErrorHandler === 'function') {
        Mmo.registerErrorHandler(function(packet) {
            if (Trade.mode === 'outbound' && String(packet.code || '').indexOf('trade_') === 0) Trade.close(false);
        });
    }
    Mmo.registerPacketHandler('tradeInvite', function(packet) {
        Trade.mode = 'invite';
        Trade.invite = packet;
        Trade.render();
    });
    Mmo.registerPacketHandler('tradeState', function(packet) {
        Trade.mode = 'active';
        Trade.state = packet;
        Trade.invite = null;
        Trade.pendingTradeId = null;
        Trade.render();
    });
    Mmo.registerPacketHandler('tradeCompleted', function(packet) {
        Trade.close(false);
        Mmo.toast(packet.message || 'Échange terminé.');
    });
    Mmo.registerPacketHandler('tradeCancelled', function(packet) {
        Trade.close(false);
        if (packet.reason) Mmo.toast(packet.reason, true);
    });

    Input.keyMapper[82] = 'mmoTrade'; // R
    var _Scene_Map_update = Scene_Map.prototype.update;
    Scene_Map.prototype.update = function() {
        _Scene_Map_update.call(this);
        var focused = typeof document !== 'undefined' && document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].indexOf(document.activeElement.tagName) !== -1;
        if (Mmo.activeCharacter && !focused && Input.isTriggered('mmoTrade')) Trade.openNearby();
    };

    var _Game_Interpreter_pluginCommand = Game_Interpreter.prototype.pluginCommand;
    Game_Interpreter.prototype.pluginCommand = function(command, args) {
        if (String(command).toUpperCase() === 'MMO') {
            var action = String(args[0] || '').toUpperCase();
            var rest = args.slice(1);
            if (action === 'TRADE') {
                var name = rest.join(' ').toLocaleLowerCase();
                var player = Object.keys(Mmo.remotePlayers || {}).map(function(id) { return Mmo.remotePlayers[id]; }).filter(function(candidate) { return candidate && String(candidate.name || '').toLocaleLowerCase() === name; })[0];
                if (player) Trade.request(player); else Mmo.toast('Joueur introuvable à proximité.', true);
                return;
            }
            if (action === 'TRADE_CANCEL') { Trade.close(true); return; }
        }
        _Game_Interpreter_pluginCommand.call(this, command, args);
    };

})(MMOTrade, MMOFoundation);
