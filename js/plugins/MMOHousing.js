/*:
 * @plugindesc v0.2 Persistent guild-house furniture and construction permissions for MMOFoundation (RPG Maker MV).
 * @author Arena MMO starter
 *
 * @help
 * MMOHousing requires MMOFoundation and MMOGuild. Load after MMOGuild.
 * Press H inside a guild house to open the housing panel. Choose a furniture
 * item, then click a map tile to place it. Furniture is drawn without external
 * assets, so the module works immediately in a new RPG Maker MV project.
 *
 * Plugin commands:
 *   MMO HOUSE
 *   MMO HOUSE_PLACE item_id x y [rotation]
 *   MMO HOUSE_REMOVE houseItemId
 */

var Imported = Imported || {};
Imported.MMOHousing = true;
var MMOHousing = MMOHousing || {};

(function(Housing, Mmo) {
    'use strict';

    if (!Mmo || typeof Mmo.registerPacketHandler !== 'function') {
        console.error('MMOHousing requires MMOFoundation loaded above it.');
        return;
    }

    function escapeHtml(value) {
        return String(value === undefined || value === null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }
    function furnitureItems() {
        return typeof MMOInventory !== 'undefined' && MMOInventory.data ? (MMOInventory.data.items || []).filter(function(item) { return item.type === 'furniture'; }) : [];
    }

    Housing.data = null;
    Housing.opened = false;
    Housing.sprites = {};
    Housing.placingItem = null;
    Housing.placingRotation = 0;
    Housing.previewSprite = null;

    Housing.ensureDom = function() {
        if (typeof document === 'undefined') return null;
        if (!document.getElementById('mmo-housing-style')) {
            var style = document.createElement('style');
            style.id = 'mmo-housing-style';
            style.textContent = [
                '#mmo-housing-root{position:fixed;z-index:100003;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(4,8,16,.64);font-family:Arial,sans-serif;color:#f3f6ff;pointer-events:auto}',
                '#mmo-housing-root:empty{display:none}.mh-window{width:min(760px,calc(100vw - 28px));max-height:calc(100vh - 28px);overflow:auto;background:#101b2d;border:1px solid #7b9fdf;border-radius:9px;box-shadow:0 12px 45px #000}.mh-head{display:flex;align-items:center;justify-content:space-between;padding:12px 15px;background:linear-gradient(90deg,#1a3b6e,#18284a)}.mh-head strong{font-size:18px}.mh-head button,.mh-button,.mh-item button{border:0;border-radius:4px;padding:7px 9px;background:#356dca;color:#fff;font-weight:bold;cursor:pointer}.mh-head button{background:#485771}',
                '#mmo-housing-placement{position:fixed;z-index:100004;left:50%;bottom:18px;transform:translateX(-50%);padding:10px 14px;border:1px solid #83afea;border-radius:6px;background:rgba(8,17,32,.94);color:#eef5ff;font:13px Arial,sans-serif;box-shadow:0 4px 18px #000;pointer-events:none}#mmo-housing-placement:empty{display:none}',
                '.mh-content{padding:14px}.mh-note{padding:10px;background:#15233b;border-left:3px solid #74a3ee;color:#d0dcf1;font-size:13px;line-height:1.4}.mh-title{margin:12px 0 6px;color:#a6c9ff;font-size:12px;text-transform:uppercase;font-weight:bold}.mh-form{display:flex;gap:7px;flex-wrap:wrap}.mh-form select,.mh-form input{padding:8px;border:1px solid #506f9e;border-radius:4px;background:#08101e;color:#fff}.mh-form select{flex:1;min-width:180px}.mh-form input{width:58px}.mh-item{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px;margin:6px 0;background:#15233b;border:1px solid #304b76;border-radius:5px}.mh-item small{display:block;color:#b8c8e3;font-size:11px;margin-top:3px}.mh-fixture{color:#e8c470}.mh-muted{color:#b2c0da;font-size:13px}'
            ].join('');
            document.head.appendChild(style);
        }
        var root = document.getElementById('mmo-housing-root');
        if (!root) {
            root = document.createElement('div');
            root.id = 'mmo-housing-root';
            document.body.appendChild(root);
        }
        if (!document.getElementById('mmo-housing-placement')) {
            var placement = document.createElement('div');
            placement.id = 'mmo-housing-placement';
            document.body.appendChild(placement);
        }
        return root;
    };

    Housing.close = function() {
        Housing.opened = false;
        var root = Housing.ensureDom();
        if (root) root.innerHTML = '';
    };

    Housing.placementHud = function(text) {
        Housing.ensureDom();
        var hud = document.getElementById('mmo-housing-placement');
        if (hud) hud.textContent = text || '';
    };

    Housing.clearPreview = function() {
        if (Housing.previewSprite && Housing.previewSprite.parent) Housing.previewSprite.parent.removeChild(Housing.previewSprite);
        Housing.previewSprite = null;
    };

    Housing.cancelPlacement = function() {
        Housing.placingItem = null;
        Housing.clearPreview();
        Housing.placementHud('');
    };

    Housing.beginPlacement = function(itemId, rotation) {
        if (!Housing.data || !Housing.data.canBuild || !itemId) return;
        Housing.close();
        Housing.placingItem = itemId;
        Housing.placingRotation = Number(rotation || 0);
        Housing.placementHud('Mode placement : clique une case pour poser le meuble. Échap annule.');
    };

    Housing.open = function() {
        if (!Mmo.activeCharacter) return Mmo.toast('Connecte un personnage avant d’ouvrir la maison.', true);
        if (typeof MMOBattle !== 'undefined' && MMOBattle.active) return Mmo.toast('Construction indisponible pendant le combat.', true);
        Housing.opened = true;
        Housing.data = null;
        Mmo.send('houseRequest');
        Housing.render();
    };

    Housing.toggle = function() {
        if (Housing.placingItem) {
            Housing.cancelPlacement();
            return;
        }
        if (Housing.opened) Housing.close(); else Housing.open();
    };

    Housing.removeSprite = function(id) {
        var sprite = Housing.sprites[id];
        if (sprite && sprite.parent) sprite.parent.removeChild(sprite);
        delete Housing.sprites[id];
    };

    Housing.clearSprites = function() {
        Object.keys(Housing.sprites).forEach(function(id) { Housing.removeSprite(id); });
    };

    Housing.visible = function() {
        return Housing.data && Housing.data.instanceId && Mmo.instanceId === Housing.data.instanceId &&
            typeof Scene_Map !== 'undefined' && SceneManager._scene instanceof Scene_Map;
    };

    Housing.drawFurniture = function(bitmap, item) {
        var width = bitmap.width;
        var height = bitmap.height;
        var dark = '#352b25';
        var wood = '#9b673c';
        if (item.itemId === 'guild_banner') {
            bitmap.fillRect(Math.floor(width * 0.25), 3, 4, height - 6, '#d7ddeb');
            bitmap.fillRect(Math.floor(width * 0.25) + 4, 7, Math.floor(width * 0.48), Math.floor(height * 0.55), item.color || '#8c5bd8');
            bitmap.fillRect(Math.floor(width * 0.25) + 9, 12, Math.floor(width * 0.38), 3, '#f6db78');
        } else if (item.itemId === 'wooden_table') {
            bitmap.fillRect(5, Math.floor(height * 0.35), width - 10, Math.floor(height * 0.28), wood);
            bitmap.fillRect(9, Math.floor(height * 0.62), 5, Math.floor(height * 0.27), dark);
            bitmap.fillRect(width - 14, Math.floor(height * 0.62), 5, Math.floor(height * 0.27), dark);
        } else if (item.itemId === 'wall_torch') {
            bitmap.fillRect(Math.floor(width / 2) - 3, Math.floor(height * 0.38), 6, Math.floor(height * 0.42), '#75482b');
            bitmap.fillRect(Math.floor(width / 2) - 6, 6, 12, Math.floor(height * 0.36), '#e5962d');
            bitmap.fillRect(Math.floor(width / 2) - 3, 9, 6, Math.floor(height * 0.23), '#fff1a0');
        } else if (item.itemId === 'guild_chest') {
            bitmap.fillRect(5, Math.floor(height * 0.40), width - 10, Math.floor(height * 0.43), '#8e6138');
            bitmap.fillRect(5, Math.floor(height * 0.35), width - 10, 5, '#d5a84f');
            bitmap.fillRect(Math.floor(width / 2) - 3, Math.floor(height * 0.57), 6, 8, '#f4d66e');
        } else {
            bitmap.fillRect(4, 4, width - 8, height - 8, item.color || '#7f8ea8');
            bitmap.drawText(item.shortLabel || '?', 0, Math.max(0, height / 2 - 12), width, 24, 'center');
        }
    };

    Housing.makeSprite = function(item, preview) {
        var width = $gameMap.tileWidth();
        var height = $gameMap.tileHeight();
        var bitmap = new Bitmap(width, height);
        Housing.drawFurniture(bitmap, item);
        var sprite = new Sprite(bitmap);
        sprite.z = preview ? 8 : 3;
        sprite.opacity = preview ? 155 : 255;
        sprite._houseItem = item;
        return sprite;
    };

    Housing.updateSpritePosition = function(sprite) {
        var item = sprite._houseItem;
        if (!item || typeof $gameMap === 'undefined' || !$gameMap) return;
        sprite.x = Math.round($gameMap.adjustX(Number(item.x)) * $gameMap.tileWidth());
        sprite.y = Math.round($gameMap.adjustY(Number(item.y)) * $gameMap.tileHeight());
    };

    Housing.refreshFurniture = function() {
        if (!Housing.visible()) {
            Housing.clearSprites();
            return;
        }
        var scene = SceneManager._scene;
        var tilemap = scene && scene._spriteset && scene._spriteset._tilemap;
        if (!tilemap) return;
        var present = {};
        (Housing.data.items || []).forEach(function(item) {
            var id = String(item.houseItemId);
            present[id] = true;
            if (!Housing.sprites[id]) {
                Housing.sprites[id] = Housing.makeSprite(item);
                tilemap.addChild(Housing.sprites[id]);
            } else {
                Housing.sprites[id]._houseItem = item;
            }
            Housing.updateSpritePosition(Housing.sprites[id]);
        });
        Object.keys(Housing.sprites).forEach(function(id) { if (!present[id]) Housing.removeSprite(id); });
    };

    Housing.itemHtml = function(item) {
        var remove = Housing.data.canBuild && !item.fixture ? '<button class="mh-remove" data-id="' + escapeHtml(item.houseItemId) + '">Retirer</button>' : '';
        return '<div class="mh-item"><div><strong class="' + (item.fixture ? 'mh-fixture' : '') + '">' + escapeHtml(item.label) + '</strong><small>Case ' + Number(item.x) + ', ' + Number(item.y) + (item.fixture ? ' · élément fixe' : '') + '</small></div>' + remove + '</div>';
    };

    Housing.render = function() {
        var root = Housing.ensureDom();
        if (!root || !Housing.opened) return;
        if (!Housing.data) {
            root.innerHTML = '<section class="mh-window"><div class="mh-head"><strong>Maison de guilde</strong><button id="mh-close">Fermer · H</button></div><div class="mh-content"><div class="mh-note">Vérification de la maison auprès du serveur…</div></div></section>';
            document.getElementById('mh-close').onclick = Housing.close;
            return;
        }
        var furniture = furnitureItems();
        var build = Housing.data.canBuild ? '<div class="mh-title">Placer du mobilier</div><div class="mh-form"><select id="mh-item">' + (furniture.length ? furniture.map(function(item) { return '<option value="' + escapeHtml(item.itemId) + '">' + escapeHtml(item.label) + ' ×' + Number(item.quantity) + '</option>'; }).join('') : '<option value="">Aucun mobilier dans ton inventaire</option>') + '</select><select id="mh-rotation"><option value="0">0°</option><option value="1">90°</option><option value="2">180°</option><option value="3">270°</option></select><button class="mh-button" id="mh-place">Choisir une tuile</button></div>' : '<div class="mh-note">Ton rang ne permet pas de placer ou retirer le mobilier. Permission actuelle : ' + escapeHtml(Housing.data.buildRole) + ' minimum.</div>';
        var permission = Housing.data.isLeader ? '<div class="mh-title">Permission de construction</div><div class="mh-form"><select id="mh-build-role"><option value="leader">Chef uniquement</option><option value="officer">Chef et officiers</option><option value="member">Tous les membres</option></select><button class="mh-button" id="mh-save-role">Appliquer</button></div>' : '';
        root.innerHTML = '<section class="mh-window"><div class="mh-head"><strong>Maison de guilde</strong><button id="mh-close">Fermer · H</button></div><div class="mh-content"><div class="mh-note">Le mobilier est dessiné directement sur la carte et reste visible uniquement dans l’instance de cette maison. Utilise le mode placement pour cliquer une tuile.</div>' + build + permission + '<div class="mh-title">Mobilier placé</div>' + ((Housing.data.items || []).length ? Housing.data.items.map(Housing.itemHtml).join('') : '<div class="mh-muted">Aucun mobilier.</div>') + '</div></section>';
        document.getElementById('mh-close').onclick = Housing.close;
        var place = document.getElementById('mh-place');
        if (place) place.onclick = function() {
            var itemId = document.getElementById('mh-item').value;
            if (!itemId) return;
            Housing.beginPlacement(itemId, Number(document.getElementById('mh-rotation').value));
        };
        var role = document.getElementById('mh-build-role');
        if (role) {
            role.value = Housing.data.buildRole;
            document.getElementById('mh-save-role').onclick = function() { Mmo.send('houseSetBuildRole', { role: role.value }); };
        }
        var remove = root.querySelectorAll('.mh-remove');
        for (var index = 0; index < remove.length; index++) remove[index].onclick = function() { Mmo.send('houseRemove', { houseItemId: this.getAttribute('data-id') }); };
    };

    Housing.mapTouchTile = function() {
        if (typeof $gameMap === 'undefined' || !$gameMap || !TouchInput.isTriggered()) return null;
        return { x: $gameMap.canvasToMapX(TouchInput.x), y: $gameMap.canvasToMapY(TouchInput.y) };
    };

    Housing.handleMapTouch = function() {
        if (!Housing.visible()) return;
        if (Input.isTriggered('cancel') && Housing.placingItem) {
            Housing.cancelPlacement();
            return;
        }
        var tile = Housing.mapTouchTile();
        if (!tile) return;
        if (Housing.placingItem) {
            Mmo.send('housePlace', { itemId: Housing.placingItem, x: tile.x, y: tile.y, rotation: Housing.placingRotation });
            Housing.cancelPlacement();
            return;
        }
        var clicked = (Housing.data.items || []).filter(function(item) { return Number(item.x) === tile.x && Number(item.y) === tile.y; })[0];
        if (clicked && clicked.itemId === 'guild_chest' && typeof MMOGuild !== 'undefined') {
            MMOGuild.open();
            MMOGuild.requestChest();
        }
    };

    Mmo.registerPacketHandler('houseSnapshot', function(packet) {
        Housing.data = packet;
        Housing.refreshFurniture();
        if (Housing.opened) Housing.render();
    });

    Input.keyMapper[72] = 'mmoHousing'; // H
    var _Scene_Map_update = Scene_Map.prototype.update;
    Scene_Map.prototype.update = function() {
        _Scene_Map_update.call(this);
        var focused = typeof document !== 'undefined' && document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].indexOf(document.activeElement.tagName) !== -1;
        if (Mmo.activeCharacter && !focused && Input.isTriggered('mmoHousing')) Housing.toggle();
        Housing.refreshFurniture();
        if (Housing.placingItem && Housing.visible()) {
            var item = furnitureItems().filter(function(entry) { return entry.itemId === Housing.placingItem; })[0];
            var scene = SceneManager._scene;
            var tilemap = scene && scene._spriteset && scene._spriteset._tilemap;
            if (item && tilemap) {
                if (!Housing.previewSprite) {
                    Housing.previewSprite = Housing.makeSprite(item, true);
                    tilemap.addChild(Housing.previewSprite);
                }
                var hoverX = $gameMap.canvasToMapX(TouchInput.x);
                var hoverY = $gameMap.canvasToMapY(TouchInput.y);
                Housing.previewSprite._houseItem = { x: hoverX, y: hoverY };
                Housing.updateSpritePosition(Housing.previewSprite);
            }
        }
        Housing.handleMapTouch();
    };

    var _Scene_Map_terminate = Scene_Map.prototype.terminate;
    Scene_Map.prototype.terminate = function() {
        Housing.clearSprites();
        Housing.cancelPlacement();
        _Scene_Map_terminate.call(this);
    };

    var _Game_Interpreter_pluginCommand = Game_Interpreter.prototype.pluginCommand;
    Game_Interpreter.prototype.pluginCommand = function(command, args) {
        if (String(command).toUpperCase() === 'MMO') {
            var action = String(args[0] || '').toUpperCase();
            var rest = args.slice(1);
            if (action === 'HOUSE') { Housing.open(); return; }
            if (action === 'HOUSE_PLACE') { Mmo.send('housePlace', { itemId: rest[0], x: Number(rest[1]), y: Number(rest[2]), rotation: Number(rest[3] || 0) }); return; }
            if (action === 'HOUSE_REMOVE') { Mmo.send('houseRemove', { houseItemId: rest[0] }); return; }
        }
        _Game_Interpreter_pluginCommand.call(this, command, args);
    };

})(MMOHousing, MMOFoundation);
