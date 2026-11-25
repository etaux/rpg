/*:
 * @plugindesc v0.22.0 Marchands et banque personnels autoritaires, ouverts par PNJ MMO.
 * @author Arena MMO starter
 *
 * @help
 * Requires MMOFoundation and MMOInventory. MMOEvents opens these windows only
 * after the native RPG Maker event branch has been reread by the server.
 *
 * Merchant page example:
 *   <MMO npc=merchant shop=starter_general mode=both>
 *   Show Choices: Acheter / vendre, Partir
 *     When [Acheter / vendre]
 *       <MMO npc-action=open>
 *       MMO NPC_ACTION open
 *
 * Banker page example:
 *   <MMO npc=banker>
 *   Show Choices: Ouvrir le coffre, Partir
 *     When [Ouvrir le coffre]
 *       <MMO npc-action=open>
 *       MMO NPC_ACTION open
 *
 * The plugin has no shortcut and never assigns a price, item quantity or gold
 * balance locally. Every action includes the opaque session received from the
 * verified NPC and is committed by the server.
 */

var Imported = Imported || {};
Imported.MMOServices = true;
var MMOServices = MMOServices || {};

(function(Services, Mmo) {
    'use strict';

    if (!Mmo || typeof Mmo.registerPacketHandler !== 'function') {
        console.error('MMOServices requires MMOFoundation, loaded above it.');
        return;
    }

    function escapeHtml(value) {
        return String(value === undefined || value === null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }
    function number(value) { return Math.max(0, Math.floor(Number(value) || 0)); }
    function gold(value) { return number(value).toLocaleString('fr-FR') + ' or'; }
    function inventoryItems() {
        return typeof MMOInventory !== 'undefined' && MMOInventory.data ? (MMOInventory.data.items || []) : [];
    }
    function itemLabel(item) { return escapeHtml(item && (item.label || item.itemId) || 'Objet inconnu'); }
    function promptQuantity(label, maximum) {
        var value = Number(window.prompt(label, '1'));
        if (!isFinite(value)) return 0;
        value = Math.floor(value);
        return value >= 1 && value <= maximum ? value : 0;
    }

    Services.opened = false;
    Services.sessionId = null;
    Services.service = null;
    Services.state = null;
    Services.tab = 'buy';

    Services.ensureDom = function() {
        if (typeof document === 'undefined') return null;
        if (!document.getElementById('mmo-services-style')) {
            var style = document.createElement('style');
            style.id = 'mmo-services-style';
            style.textContent = [
                '#mmo-services-root{position:fixed;z-index:100008;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(3,7,15,.70);font-family:Arial,sans-serif;color:#edf4ff;pointer-events:auto}',
                '#mmo-services-root:empty{display:none}.ms-window{width:min(960px,calc(100vw - 28px));max-height:calc(100vh - 28px);overflow:auto;background:#101b2e;border:1px solid #6dbe9b;border-radius:11px;box-shadow:0 16px 58px #000}.ms-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:13px 16px;background:linear-gradient(90deg,#185c4a,#203c5b)}.ms-head strong{font-size:19px}.ms-head button,.ms-button,.ms-card button{border:0;border-radius:4px;padding:7px 10px;background:#287f65;color:#fff;font-weight:bold;cursor:pointer}.ms-head button,.ms-button.secondary{background:#4b5870}.ms-content{padding:14px}.ms-tabs{display:flex;gap:7px;flex-wrap:wrap;border-bottom:1px solid #496b68;padding-bottom:10px;margin-bottom:12px}.ms-tabs button{padding:7px 10px;border:1px solid #4b7b75;border-radius:4px;background:#172d3a;color:#e8efff;cursor:pointer}.ms-tabs button.active{background:#287f65;color:#fff}.ms-note{padding:10px;background:#172d3a;border-left:3px solid #72c6a4;line-height:1.45;font-size:13px}.ms-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:12px}.ms-card{min-width:0;border:1px solid #3c6470;border-radius:6px;background:#13263a;padding:10px}.ms-card-top{display:flex;justify-content:space-between;gap:10px}.ms-card strong{display:block;color:#d8ffed}.ms-card small,.ms-muted{display:block;color:#b9c9e3;font-size:11px;margin-top:3px}.ms-qty{white-space:nowrap;color:#d9e6ff}.ms-price{margin-top:8px;color:#94e0bd;font-weight:bold}.ms-actions{display:flex;gap:7px;align-items:center;flex-wrap:wrap;margin-top:9px}.ms-actions input{width:64px;box-sizing:border-box;padding:7px;background:#07111f;border:1px solid #4e668d;border-radius:4px;color:#fff}.ms-summary{color:#c8d9e8;font-size:13px;margin:10px 0}.ms-gold{font-size:16px;color:#f4d47b;font-weight:bold;padding:11px;background:#14283a;border:1px solid #3c6470;border-radius:6px;margin:10px 0}@media(max-width:700px){.ms-grid{grid-template-columns:1fr}.ms-window{max-height:calc(100vh - 8px)}}'
            ].join('');
            document.head.appendChild(style);
        }
        var root = document.getElementById('mmo-services-root');
        if (!root) {
            root = document.createElement('div');
            root.id = 'mmo-services-root';
            document.body.appendChild(root);
        }
        if (typeof Mmo.protectHudInteraction === 'function') Mmo.protectHudInteraction(root);
        if (typeof Mmo.enableWheelScrolling === 'function') Mmo.enableWheelScrolling(root);
        return root;
    };

    Services.close = function(notify) {
        var sessionId = Services.sessionId;
        Services.opened = false;
        Services.sessionId = null;
        Services.service = null;
        Services.state = null;
        var root = Services.ensureDom();
        if (root) root.innerHTML = '';
        if (notify && sessionId) Mmo.send('npcServiceClose', { sessionId: sessionId });
    };

    Services.openFromNpcService = function(packet) {
        if (!packet || ['merchant', 'banker'].indexOf(packet.service) === -1 || !packet.sessionId) return;
        Services.opened = true;
        Services.sessionId = packet.sessionId;
        Services.service = packet.service;
        Services.state = packet.state || {};
        Services.tab = packet.service === 'merchant' && Services.state.mode === 'sell' ? 'sell' : (packet.service === 'banker' ? 'bank' : 'buy');
        Mmo.send('inventoryRequest');
        Services.render();
    };

    Services.catalogue = function() { return Services.state && Services.state.catalogue || []; };
    Services.can = function(direction) {
        var mode = Services.state && Services.state.mode;
        return mode === 'both' || mode === direction;
    };

    Services.merchantBuyHtml = function() {
        var entries = Services.catalogue();
        return '<div class="ms-note">Le catalogue et ses prix sont définis côté serveur. Le stock est illimité, mais l’or et l’inventaire sont débités/crédités uniquement après validation serveur.</div>' +
            (entries.length ? '<div class="ms-grid">' + entries.map(function(entry, index) {
                var item = entry.item || {};
                return '<article class="ms-card"><div class="ms-card-top"><div><strong>' + itemLabel(item) + '</strong><small>' + escapeHtml(item.type || 'objet') + '</small></div><div class="ms-qty">illimité</div></div><small>' + escapeHtml(item.description || '') + '</small><div class="ms-price">' + gold(entry.sellPrice) + ' / unité</div><div class="ms-actions"><label>Qté <input id="ms-buy-q-' + index + '" type="number" min="1" max="999999" value="1"></label><button class="ms-buy" data-index="' + index + '">Acheter</button></div></article>';
            }).join('') + '</div>' : '<div class="ms-muted">Ce catalogue est vide.</div>');
    };

    Services.merchantSellHtml = function() {
        var prices = {};
        Services.catalogue().forEach(function(entry) { if (entry && entry.item) prices[entry.item.itemId] = entry; });
        var entries = inventoryItems().filter(function(item) { return item && number(item.quantity) > 0 && prices[item.itemId]; });
        return '<div class="ms-note">Seuls les objets présents dans le catalogue serveur sont repris. Un équipement vendu est déséquipé par le serveur.</div>' +
            (entries.length ? '<div class="ms-grid">' + entries.map(function(item, index) {
                var entry = prices[item.itemId];
                return '<article class="ms-card"><div class="ms-card-top"><div><strong>' + itemLabel(item) + '</strong><small>' + escapeHtml(item.type || 'objet') + '</small></div><div class="ms-qty">× ' + number(item.quantity) + '</div></div><small>' + escapeHtml(item.description || '') + '</small><div class="ms-price">' + gold(entry.buyPrice) + ' / unité</div><div class="ms-actions"><label>Qté <input id="ms-sell-q-' + index + '" type="number" min="1" max="' + number(item.quantity) + '" value="1"></label><button class="ms-sell" data-item="' + escapeHtml(item.itemId) + '">Vendre</button></div></article>';
            }).join('') + '</div>' : '<div class="ms-muted">Aucun objet de ton inventaire ne peut être repris ici.</div>');
    };

    Services.bankItemHtml = function(item, type, index) {
        var action = type === 'bank' ? 'Retirer' : 'Déposer';
        var klass = type === 'bank' ? 'ms-bank-withdraw' : 'ms-bank-deposit';
        return '<article class="ms-card"><div class="ms-card-top"><div><strong>' + itemLabel(item) + '</strong><small>' + escapeHtml(item.type || 'objet') + '</small></div><div class="ms-qty">× ' + number(item.quantity) + '</div></div><small>' + escapeHtml(item.description || '') + '</small><div class="ms-actions"><button class="' + klass + '" data-item="' + escapeHtml(item.itemId) + '" data-max="' + number(item.quantity) + '">' + action + '</button></div></article>';
    };

    Services.bankHtml = function() {
        var bank = Services.state && Services.state.bank || { gold: 0, items: [] };
        var own = inventoryItems().filter(function(item) { return item && number(item.quantity) > 0; });
        return '<div class="ms-note">Ce coffre est strictement personnel. Chaque dépôt ou retrait d’objet et d’or est une transaction atomique côté PostgreSQL.</div>' +
            '<div class="ms-gold">Ton or : ' + gold(Mmo.activeCharacter && Mmo.activeCharacter.gold) + ' · Coffre : ' + gold(bank.gold) + '<div class="ms-actions"><button class="ms-gold-deposit" data-max="' + number(Mmo.activeCharacter && Mmo.activeCharacter.gold) + '">Déposer de l’or</button><button class="ms-gold-withdraw" data-max="' + number(bank.gold) + '">Retirer de l’or</button></div></div>' +
            '<div class="ms-summary">Contenu du coffre</div>' + (bank.items && bank.items.length ? '<div class="ms-grid">' + bank.items.map(function(item, index) { return Services.bankItemHtml(item, 'bank', index); }).join('') + '</div>' : '<div class="ms-muted">Coffre vide.</div>') +
            '<div class="ms-summary">Ton inventaire — dépôt</div>' + (own.length ? '<div class="ms-grid">' + own.map(function(item, index) { return Services.bankItemHtml(item, 'inventory', index); }).join('') + '</div>' : '<div class="ms-muted">Inventaire vide.</div>');
    };

    Services.render = function() {
        var root = Services.ensureDom();
        if (!root || !Services.opened || !Services.sessionId) return;
        var title = Services.service === 'banker' ? 'Banque personnelle' : escapeHtml(Services.state && Services.state.title || 'Marchand');
        var body;
        var tabs = '';
        if (Services.service === 'banker') body = Services.bankHtml();
        else {
            if (Services.can('buy')) tabs += '<button class="ms-tab ' + (Services.tab === 'buy' ? 'active' : '') + '" data-tab="buy">Acheter</button>';
            if (Services.can('sell')) tabs += '<button class="ms-tab ' + (Services.tab === 'sell' ? 'active' : '') + '" data-tab="sell">Vendre</button>';
            body = Services.tab === 'sell' ? Services.merchantSellHtml() : Services.merchantBuyHtml();
        }
        root.innerHTML = '<section class="ms-window"><div class="ms-head"><strong>' + title + '</strong><button id="ms-close">Fermer</button></div><div class="ms-content">' + (tabs ? '<div class="ms-tabs">' + tabs + '</div>' : '') + body + '</div></section>';
        document.getElementById('ms-close').onclick = function() { Services.close(true); };
        var tabsNodes = root.querySelectorAll('.ms-tab');
        for (var tabIndex = 0; tabIndex < tabsNodes.length; tabIndex++) tabsNodes[tabIndex].onclick = function() { Services.tab = this.getAttribute('data-tab'); Services.render(); };
        var buys = root.querySelectorAll('.ms-buy');
        for (var buyIndex = 0; buyIndex < buys.length; buyIndex++) buys[buyIndex].onclick = function() {
            var index = number(this.getAttribute('data-index'));
            var entry = Services.catalogue()[index];
            var input = document.getElementById('ms-buy-q-' + index);
            if (entry && entry.item) Mmo.send('merchantBuy', { sessionId: Services.sessionId, itemId: entry.item.itemId, quantity: Math.max(1, Math.floor(Number(input && input.value || 1))) });
        };
        var sells = root.querySelectorAll('.ms-sell');
        for (var sellIndex = 0; sellIndex < sells.length; sellIndex++) sells[sellIndex].onclick = function() {
            var itemId = this.getAttribute('data-item');
            var index = Array.prototype.indexOf.call(root.querySelectorAll('.ms-sell'), this);
            var input = document.getElementById('ms-sell-q-' + index);
            Mmo.send('merchantSell', { sessionId: Services.sessionId, itemId: itemId, quantity: Math.max(1, Math.floor(Number(input && input.value || 1))) });
        };
        var deposits = root.querySelectorAll('.ms-bank-deposit');
        for (var depositIndex = 0; depositIndex < deposits.length; depositIndex++) deposits[depositIndex].onclick = function() {
            var max = number(this.getAttribute('data-max'));
            var quantity = promptQuantity('Quantité à déposer', max);
            if (quantity) Mmo.send('bankDeposit', { sessionId: Services.sessionId, asset: 'item', itemId: this.getAttribute('data-item'), quantity: quantity });
        };
        var withdrawals = root.querySelectorAll('.ms-bank-withdraw');
        for (var withdrawIndex = 0; withdrawIndex < withdrawals.length; withdrawIndex++) withdrawals[withdrawIndex].onclick = function() {
            var max = number(this.getAttribute('data-max'));
            var quantity = promptQuantity('Quantité à retirer', max);
            if (quantity) Mmo.send('bankWithdraw', { sessionId: Services.sessionId, asset: 'item', itemId: this.getAttribute('data-item'), quantity: quantity });
        };
        var goldDeposit = document.querySelector('.ms-gold-deposit');
        if (goldDeposit) goldDeposit.onclick = function() {
            var quantity = promptQuantity('Or à déposer', number(this.getAttribute('data-max')));
            if (quantity) Mmo.send('bankDeposit', { sessionId: Services.sessionId, asset: 'gold', quantity: quantity });
        };
        var goldWithdraw = document.querySelector('.ms-gold-withdraw');
        if (goldWithdraw) goldWithdraw.onclick = function() {
            var quantity = promptQuantity('Or à retirer', number(this.getAttribute('data-max')));
            if (quantity) Mmo.send('bankWithdraw', { sessionId: Services.sessionId, asset: 'gold', quantity: quantity });
        };
    };

    Mmo.registerPacketHandler('bankState', function(packet) {
        if (!Services.opened || Services.service !== 'banker') return;
        Services.state = Services.state || {};
        Services.state.bank = packet.bank || { gold: 0, items: [] };
        Services.render();
    });
    Mmo.registerPacketHandler('inventorySnapshot', function() {
        if (Services.opened) Services.render();
    });
    Mmo.registerPacketHandler('npcServiceClosed', function(packet) {
        if (!Services.opened || !packet || packet.service !== Services.service) return;
        Services.close(false);
        if (packet.reason) Mmo.toast(packet.reason, true);
    });
    if (typeof Mmo.registerErrorHandler === 'function') {
        Mmo.registerErrorHandler(function(packet) {
            if (['npc_session_missing', 'npc_session_expired', 'npc_too_far'].indexOf(String(packet.code || '')) !== -1) Services.close(false);
        });
    }

})(MMOServices, MMOFoundation);
