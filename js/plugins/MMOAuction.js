/*:
 * @plugindesc v0.21.0 Hôtel des ventes autoritaire ouvert par PNJ MMO.
 * @author Arena MMO starter
 *
 * @help
 * Requires MMOFoundation and MMOInventory above it. MMOEvents, loaded after
 * this plugin, opens the auction only after a native event branch has passed
 * server validation:
 *
 *   <MMO npc=auction_house>
 *   Show Choices: Ouvrir l'hôtel des ventes, En savoir plus, Partir
 *     When [Ouvrir l'hôtel des ventes]
 *       <MMO npc-action=open>
 *       MMO NPC_ACTION open
 *
 * The server owns listings, gold, quantities, expiry and every transfer.
 * There is intentionally no keyboard shortcut or direct open command.
 */

var Imported = Imported || {};
Imported.MMOAuction = true;
var MMOAuction = MMOAuction || {};

(function(Auction, Mmo) {
    'use strict';

    if (!Mmo || typeof Mmo.registerPacketHandler !== 'function') {
        console.error('MMOAuction requires MMOFoundation, loaded above it.');
        return;
    }

    function escapeHtml(value) {
        return String(value === undefined || value === null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }
    function number(value) { return Math.max(0, Math.floor(Number(value) || 0)); }
    function gold(value) { return number(value).toLocaleString('fr-FR') + ' or'; }
    function dateLabel(value) {
        var date = value ? new Date(value) : null;
        return date && !isNaN(date.getTime()) ? date.toLocaleString('fr-FR') : '—';
    }
    function ownTradableItems() {
        return typeof MMOInventory !== 'undefined' && MMOInventory.data ? (MMOInventory.data.items || []).filter(function(item) {
            return item && item.tradable && number(item.quantity) > 0;
        }) : [];
    }
    function state() {
        return Auction.state || { listings: [], mine: [], filters: { query: '', type: 'all', page: 0 }, page: 0, total: 0, pageSize: 30 };
    }

    Auction.opened = false;
    Auction.sessionId = null;
    Auction.state = null;
    Auction.tab = 'browse';
    Auction.sellEntries = [];

    Auction.ensureDom = function() {
        if (typeof document === 'undefined') return null;
        if (!document.getElementById('mmo-auction-style')) {
            var style = document.createElement('style');
            style.id = 'mmo-auction-style';
            style.textContent = [
                '#mmo-auction-root{position:fixed;z-index:100007;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(3,7,15,.72);font-family:Arial,sans-serif;color:#edf4ff;pointer-events:auto}',
                '#mmo-auction-root:empty{display:none}.ma-window{width:min(1040px,calc(100vw - 28px));max-height:calc(100vh - 28px);overflow:auto;background:#101b2e;border:1px solid #cfad5e;border-radius:11px;box-shadow:0 16px 58px #000}.ma-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:13px 16px;background:linear-gradient(90deg,#6a4812,#2f2447)}.ma-head strong{font-size:19px}.ma-head button,.ma-button,.ma-card button{border:0;border-radius:4px;padding:7px 10px;background:#b77921;color:#fff;font-weight:bold;cursor:pointer}.ma-head button,.ma-button.secondary{background:#4b5870}.ma-button.cancel{background:#9b4055}.ma-content{padding:14px}.ma-tabs{display:flex;gap:7px;flex-wrap:wrap;border-bottom:1px solid #4e4960;padding-bottom:10px;margin-bottom:12px}.ma-tabs button{padding:7px 10px;border:1px solid #6e6680;border-radius:4px;background:#17243a;color:#e8efff;cursor:pointer}.ma-tabs button.active{background:#b77921;border-color:#e1bf70;color:#fff}.ma-note{padding:10px;background:#17283e;border-left:3px solid #e1b85c;line-height:1.45;font-size:13px}.ma-toolbar{display:flex;gap:7px;align-items:end;flex-wrap:wrap;margin:12px 0}.ma-toolbar label{display:grid;gap:4px;color:#b9c9e4;font-size:11px}.ma-toolbar input,.ma-toolbar select,.ma-card input{box-sizing:border-box;padding:8px;background:#07111f;border:1px solid #4e668d;border-radius:4px;color:#fff}.ma-toolbar input{width:145px}.ma-toolbar input.ma-price{width:100px}.ma-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.ma-card{min-width:0;border:1px solid #3c5379;border-radius:6px;background:#132137;padding:10px}.ma-card-top{display:flex;justify-content:space-between;gap:10px}.ma-card strong{display:block;color:#f8e7b8}.ma-card small,.ma-muted{display:block;color:#b9c9e3;font-size:11px;margin-top:3px}.ma-qty{white-space:nowrap;color:#d9e6ff}.ma-price-label{margin-top:8px;color:#f2cf76;font-weight:bold}.ma-actions{display:flex;gap:7px;align-items:center;flex-wrap:wrap;margin-top:9px}.ma-actions input{width:64px}.ma-status{display:inline-block;border-radius:999px;padding:3px 7px;font-size:10px;font-weight:bold;text-transform:uppercase}.ma-status.active{background:#1c634b;color:#d8ffec}.ma-status.sold{background:#345a8c;color:#e1eeff}.ma-status.cancelled,.ma-status.expired{background:#595466;color:#e6e3ed}.ma-pagination{display:flex;align-items:center;gap:8px;margin:12px 0}.ma-summary{color:#bccae0;font-size:12px;margin:10px 0}@media(max-width:720px){.ma-grid{grid-template-columns:1fr}.ma-window{max-height:calc(100vh - 8px)}.ma-toolbar input{width:120px}}'
            ].join('');
            document.head.appendChild(style);
        }
        var root = document.getElementById('mmo-auction-root');
        if (!root) {
            root = document.createElement('div');
            root.id = 'mmo-auction-root';
            document.body.appendChild(root);
        }
        if (typeof Mmo.protectHudInteraction === 'function') Mmo.protectHudInteraction(root);
        if (typeof Mmo.enableWheelScrolling === 'function') Mmo.enableWheelScrolling(root);
        return root;
    };

    Auction.close = function(notify) {
        var sessionId = Auction.sessionId;
        Auction.opened = false;
        Auction.sessionId = null;
        Auction.state = null;
        Auction.sellEntries = [];
        var root = Auction.ensureDom();
        if (root) root.innerHTML = '';
        if (notify && sessionId) Mmo.send('auctionClose', { sessionId: sessionId });
    };

    Auction.openFromNpcService = function(packet) {
        if (!packet || packet.service !== 'auction_house' || !packet.sessionId) return;
        Auction.opened = true;
        Auction.sessionId = packet.sessionId;
        Auction.state = packet.state || null;
        Auction.tab = 'browse';
        Mmo.send('inventoryRequest');
        Auction.render();
    };

    Auction.requestBrowse = function(filters) {
        if (!Auction.sessionId) return;
        Mmo.send('auctionBrowse', { sessionId: Auction.sessionId, filters: filters || state().filters || {} });
    };

    Auction.itemLabel = function(item) {
        return escapeHtml(item && item.label || item && item.itemId || 'Objet inconnu');
    };
    Auction.listingHtml = function(listing) {
        var item = listing.item || {};
        var max = Math.max(1, number(listing.quantityRemaining));
        return '<article class="ma-card"><div class="ma-card-top"><div><strong>' + Auction.itemLabel(item) + '</strong><small>' + escapeHtml(item.type || 'objet') + ' · vendeur : ' + escapeHtml(listing.sellerName || '—') + '</small></div><div class="ma-qty">× ' + max + '</div></div>' +
            '<small>' + escapeHtml(item.description || '') + '</small><div class="ma-price-label">' + gold(listing.unitPrice) + ' / unité</div><small>Expire le ' + escapeHtml(dateLabel(listing.expiresAt)) + '</small>' +
            '<div class="ma-actions"><label>Qté <input id="ma-buy-' + escapeHtml(listing.listingId) + '" type="number" min="1" max="' + max + '" value="1"></label><button class="ma-buy" data-id="' + escapeHtml(listing.listingId) + '">Acheter</button></div></article>';
    };

    Auction.renderBrowse = function() {
        var current = state();
        var filters = current.filters || {};
        var listings = current.listings || [];
        var page = number(current.page);
        var pageSize = Math.max(1, number(current.pageSize) || 30);
        var hasPrevious = page > 0;
        var hasNext = (page + 1) * pageSize < number(current.total);
        return '<div class="ma-note">Les prix sont unitaires. Tu peux acheter une partie du stock d’une annonce. Toute opération est vérifiée par le serveur tant que tu restes près du PNJ.</div>' +
            '<div class="ma-toolbar"><label>Recherche<input id="ma-query" maxlength="48" value="' + escapeHtml(filters.query || '') + '" placeholder="Objet ou vendeur"></label><label>Type<select id="ma-type"><option value="all">Tous</option><option value="consumable">Consommables</option><option value="material">Matériaux</option><option value="equipment">Équipements</option><option value="furniture">Mobilier</option></select></label><label>Prix min.<input id="ma-min" class="ma-price" type="number" min="1" value="' + escapeHtml(filters.minUnitPrice || '') + '"></label><label>Prix max.<input id="ma-max" class="ma-price" type="number" min="1" value="' + escapeHtml(filters.maxUnitPrice || '') + '"></label><button class="ma-button" id="ma-search">Rechercher</button><button class="ma-button secondary" id="ma-refresh">Actualiser</button></div>' +
            '<div class="ma-summary">' + number(current.total) + ' annonce(s) trouvée(s) · page ' + (page + 1) + '</div>' +
            (listings.length ? '<div class="ma-grid">' + listings.map(Auction.listingHtml).join('') + '</div>' : '<div class="ma-muted">Aucune annonce ne correspond à ces critères.</div>') +
            '<div class="ma-pagination"><button class="ma-button secondary" id="ma-prev"' + (hasPrevious ? '' : ' disabled') + '>← Précédent</button><button class="ma-button secondary" id="ma-next"' + (hasNext ? '' : ' disabled') + '>Suivant →</button></div>';
    };

    Auction.renderSell = function() {
        var items = ownTradableItems();
        Auction.sellEntries = items;
        return '<div class="ma-note">Créer une annonce retire immédiatement la quantité choisie de ton inventaire serveur. Les armes et armures mises en vente sont déséquipées automatiquement.</div>' +
            '<div class="ma-summary">' + number((state().mine || []).filter(function(listing) { return listing.status === 'active'; }).length) + ' / ' + number(state().activeListingLimit || 20) + ' annonces actives</div>' +
            (items.length ? '<div class="ma-grid">' + items.map(function(item, index) {
                return '<article class="ma-card"><div class="ma-card-top"><div><strong>' + Auction.itemLabel(item) + '</strong><small>' + escapeHtml(item.type || 'objet') + '</small></div><div class="ma-qty">× ' + number(item.quantity) + '</div></div><small>' + escapeHtml(item.description || '') + '</small><div class="ma-actions"><label>Quantité <input id="ma-sell-q-' + index + '" type="number" min="1" max="' + number(item.quantity) + '" value="1"></label><label>Prix / unité <input id="ma-sell-p-' + index + '" type="number" min="1" max="100000000" value="1"></label><button class="ma-create" data-index="' + index + '">Mettre en vente</button></div></article>';
            }).join('') + '</div>' : '<div class="ma-muted">Aucun actif échangeable dans ton inventaire.</div>');
    };

    Auction.myListingHtml = function(listing) {
        var item = listing.item || {};
        var active = listing.status === 'active';
        return '<article class="ma-card"><div class="ma-card-top"><div><strong>' + Auction.itemLabel(item) + '</strong><small>Annonce #' + escapeHtml(listing.listingId) + ' · créée le ' + escapeHtml(dateLabel(listing.createdAt)) + '</small></div><span class="ma-status ' + escapeHtml(listing.status || '') + '">' + escapeHtml(listing.status || '') + '</span></div>' +
            '<div class="ma-price-label">' + gold(listing.unitPrice) + ' / unité · reste × ' + number(listing.quantityRemaining) + '</div>' +
            (active ? '<small>Expire le ' + escapeHtml(dateLabel(listing.expiresAt)) + '</small><div class="ma-actions"><button class="ma-button cancel ma-cancel-listing" data-id="' + escapeHtml(listing.listingId) + '">Annuler et récupérer</button></div>' : '<small>Quantité initiale : × ' + number(listing.quantityInitial) + (listing.closedAt ? ' · clôturée le ' + escapeHtml(dateLabel(listing.closedAt)) : '') + '</small>') +
            '</article>';
    };

    Auction.renderMine = function() {
        var listings = state().mine || [];
        return '<div class="ma-note">Les ventes partielles diminuent le stock restant. Une annulation retourne uniquement ce stock restant dans ton inventaire.</div>' +
            (listings.length ? '<div class="ma-grid">' + listings.map(Auction.myListingHtml).join('') + '</div>' : '<div class="ma-muted">Tu n’as encore créé aucune annonce.</div>');
    };

    Auction.render = function() {
        var root = Auction.ensureDom();
        if (!root || !Auction.opened || !Auction.sessionId) return;
        var current = state();
        var body = Auction.tab === 'sell' ? Auction.renderSell() : (Auction.tab === 'mine' ? Auction.renderMine() : Auction.renderBrowse());
        root.innerHTML = '<section class="ma-window"><div class="ma-head"><strong>Hôtel des ventes</strong><button id="ma-close">Fermer</button></div><div class="ma-content"><div class="ma-tabs"><button class="ma-tab ' + (Auction.tab === 'browse' ? 'active' : '') + '" data-tab="browse">Parcourir</button><button class="ma-tab ' + (Auction.tab === 'sell' ? 'active' : '') + '" data-tab="sell">Vendre</button><button class="ma-tab ' + (Auction.tab === 'mine' ? 'active' : '') + '" data-tab="mine">Mes annonces (' + number((current.mine || []).filter(function(listing) { return listing.status === 'active'; }).length) + ')</button></div>' + body + '</div></section>';
        document.getElementById('ma-close').onclick = function() { Auction.close(true); };
        var type = document.getElementById('ma-type');
        if (type) type.value = (current.filters && current.filters.type) || 'all';
        var search = document.getElementById('ma-search');
        if (search) search.onclick = function() {
            Auction.requestBrowse({ query: document.getElementById('ma-query').value, type: document.getElementById('ma-type').value, minUnitPrice: document.getElementById('ma-min').value, maxUnitPrice: document.getElementById('ma-max').value, page: 0 });
        };
        var refresh = document.getElementById('ma-refresh');
        if (refresh) refresh.onclick = function() { Auction.requestBrowse(current.filters || {}); };
        var previous = document.getElementById('ma-prev');
        if (previous) previous.onclick = function() { var filters = Object.assign({}, current.filters || {}, { page: Math.max(0, number(current.page) - 1) }); Auction.requestBrowse(filters); };
        var next = document.getElementById('ma-next');
        if (next) next.onclick = function() { var filters = Object.assign({}, current.filters || {}, { page: number(current.page) + 1 }); Auction.requestBrowse(filters); };
        var tabs = root.querySelectorAll('.ma-tab');
        for (var tabIndex = 0; tabIndex < tabs.length; tabIndex++) tabs[tabIndex].onclick = function() { Auction.tab = this.getAttribute('data-tab'); Auction.render(); };
        var buys = root.querySelectorAll('.ma-buy');
        for (var buyIndex = 0; buyIndex < buys.length; buyIndex++) buys[buyIndex].onclick = function() {
            var listingId = this.getAttribute('data-id');
            var input = document.getElementById('ma-buy-' + listingId);
            Mmo.send('auctionBuy', { sessionId: Auction.sessionId, listingId: listingId, quantity: Math.max(1, Math.floor(Number(input && input.value || 1))) });
        };
        var creates = root.querySelectorAll('.ma-create');
        for (var createIndex = 0; createIndex < creates.length; createIndex++) creates[createIndex].onclick = function() {
            var index = number(this.getAttribute('data-index'));
            var item = Auction.sellEntries[index];
            if (!item) return;
            var quantity = document.getElementById('ma-sell-q-' + index);
            var unitPrice = document.getElementById('ma-sell-p-' + index);
            Mmo.send('auctionCreate', { sessionId: Auction.sessionId, itemId: item.itemId, quantity: Math.max(1, Math.floor(Number(quantity && quantity.value || 1))), unitPrice: Math.max(1, Math.floor(Number(unitPrice && unitPrice.value || 1))) });
        };
        var cancellations = root.querySelectorAll('.ma-cancel-listing');
        for (var cancellationIndex = 0; cancellationIndex < cancellations.length; cancellationIndex++) cancellations[cancellationIndex].onclick = function() {
            var listingId = this.getAttribute('data-id');
            if (window.confirm('Annuler cette annonce et récupérer le stock restant ?')) Mmo.send('auctionCancel', { sessionId: Auction.sessionId, listingId: listingId });
        };
    };

    Mmo.registerPacketHandler('auctionHouseState', function(packet) {
        if (!Auction.opened || !Auction.sessionId || String(packet.sessionId) !== String(Auction.sessionId)) return;
        Auction.state = packet.state || Auction.state;
        Auction.render();
    });
    Mmo.registerPacketHandler('auctionHouseClosed', function(packet) {
        if (!Auction.opened) return;
        Auction.close(false);
        if (packet.reason) Mmo.toast(packet.reason, true);
    });
    Mmo.registerPacketHandler('inventorySnapshot', function() {
        if (Auction.opened && Auction.tab === 'sell') Auction.render();
    });
    if (typeof Mmo.registerErrorHandler === 'function') {
        Mmo.registerErrorHandler(function(packet) {
            var code = String(packet.code || '');
            if (['auction_session_missing', 'auction_session_expired', 'auction_too_far'].indexOf(code) !== -1) Auction.close(false);
        });
    }

})(MMOAuction, MMOFoundation);
