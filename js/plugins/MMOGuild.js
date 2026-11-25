/*:
 * @plugindesc v0.1 Persistent guild, guild chest and guild-house interface for MMOFoundation (RPG Maker MV).
 * @author Arena MMO starter
 *
 * @help
 * MMOGuild requires MMOFoundation v0.1.3 or newer. Load it after
 * MMOFoundation, MMOBattle and MMOInventory.
 *
 * Press G on the map to open the guild interface.
 *
 * Plugin commands:
 *   MMO GUILD
 *   MMO GUILD_INVITE NomDuJoueur
 *
 * Guild creation is intentionally available only from a verified
 * guild_registrar NPC branch (<MMO npc-action=guild_create>).
 *   MMO GUILD_LEAVE
 *   MMO GUILD_HOUSE
 *   MMO GUILD_HOUSE_EXIT
 *   MMO GUILD_CHEST
 */

var Imported = Imported || {};
Imported.MMOGuild = true;
var MMOGuild = MMOGuild || {};

(function(Guild, Mmo) {
    'use strict';

    if (!Mmo || typeof Mmo.registerPacketHandler !== 'function') {
        console.error('MMOGuild requires MMOFoundation v0.1.3 or newer, loaded above it.');
        return;
    }

    function escapeHtml(value) {
        return String(value === undefined || value === null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }
    function roleLabel(role) {
        return ({ leader: 'Chef', officer: 'Officier', member: 'Membre' })[role] || role;
    }
    function ownMember() {
        if (!Guild.data || !Mmo.activeCharacter) return null;
        return (Guild.data.members || []).filter(function(member) {
            return String(member.characterId) === String(Mmo.activeCharacter.characterId);
        })[0] || null;
    }
    function ownItems() {
        return typeof MMOInventory !== 'undefined' && MMOInventory.data ? (MMOInventory.data.items || []) : [];
    }

    Guild.data = null;
    Guild.chest = null;
    Guild.opened = false;
    Guild.tab = 'guild';
    Guild.registrarSessionId = null;

    Guild.ensureDom = function() {
        if (typeof document === 'undefined') return null;
        if (!document.getElementById('mmo-guild-style')) {
            var style = document.createElement('style');
            style.id = 'mmo-guild-style';
            style.textContent = [
                '#mmo-guild-root{position:fixed;z-index:100002;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(4,8,17,.67);font-family:Arial,sans-serif;color:#f4f7ff;pointer-events:auto}',
                '#mmo-guild-root:empty{display:none}.mg-window{width:min(850px,calc(100vw - 28px));max-height:calc(100vh - 28px);overflow:auto;background:#101a2c;border:1px solid #769de2;border-radius:9px;box-shadow:0 11px 46px #000}.mg-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 15px;background:linear-gradient(90deg,#1a3a70,#17274b)}.mg-head strong{font-size:18px}.mg-head button,.mg-button,.mg-member button{border:0;border-radius:4px;padding:7px 9px;color:white;background:#356dcb;font-weight:bold;cursor:pointer}.mg-head button.secondary,.mg-button.secondary{background:#485670}',
                '.mg-content{padding:14px}.mg-tabs{display:flex;gap:7px;border-bottom:1px solid #344e79;padding-bottom:10px;margin-bottom:12px}.mg-tabs button{padding:7px 10px;border:1px solid #476a9d;border-radius:4px;background:#162641;color:#dce8ff;cursor:pointer}.mg-tabs button.active{background:#346bc9;color:#fff}.mg-title{font-size:12px;color:#a6c9ff;text-transform:uppercase;font-weight:bold;margin:12px 0 6px}',
                '.mg-form{display:flex;gap:7px;flex-wrap:wrap}.mg-form input{flex:1;min-width:170px;padding:9px;border:1px solid #4f6e9e;border-radius:4px;background:#08101e;color:#fff}.mg-member,.mg-item{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px;margin:6px 0;background:#15233b;border:1px solid #304a75;border-radius:5px}.mg-member small,.mg-item small,.mg-muted{display:block;color:#b4c5e1;font-size:11px;margin-top:3px}.mg-online{color:#71d39a;font-size:11px}.mg-offline{color:#8d9bb4;font-size:11px}',
                '.mg-actions{display:flex;gap:7px;flex-wrap:wrap;margin:10px 0}.mg-danger{background:#9f3f55!important}.mg-note{padding:10px;background:#15233b;border-left:3px solid #729fea;color:#cbd9f1;font-size:13px;line-height:1.4}.mg-qty{color:#a9c4ee;white-space:nowrap}@media(max-width:600px){.mg-window{max-height:calc(100vh - 10px)}}'
            ].join('');
            document.head.appendChild(style);
        }
        var root = document.getElementById('mmo-guild-root');
        if (!root) {
            root = document.createElement('div');
            root.id = 'mmo-guild-root';
            document.body.appendChild(root);
        }
        return root;
    };

    Guild.close = function(notify) {
        var sessionId = Guild.registrarSessionId;
        Guild.opened = false;
        Guild.registrarSessionId = null;
        var root = Guild.ensureDom();
        if (root) root.innerHTML = '';
        if (notify && sessionId) Mmo.send('npcServiceClose', { sessionId: sessionId });
    };

    Guild.open = function() {
        if (!Mmo.activeCharacter) return Mmo.toast('Connecte un personnage avant d’ouvrir la guilde.', true);
        if (typeof MMOBattle !== 'undefined' && MMOBattle.active) return Mmo.toast('Interface indisponible pendant un combat.', true);
        Guild.opened = true;
        Guild.tab = 'guild';
        Mmo.send('inventoryRequest');
        Guild.render();
    };

    Guild.toggle = function() {
        if (Guild.opened) Guild.close(true); else Guild.open();
    };

    Guild.openCreateFromNpcService = function(packet) {
        if (!packet || packet.service !== 'guild_registrar' || !packet.sessionId) return;
        Guild.registrarSessionId = packet.sessionId;
        Guild.opened = true;
        Guild.tab = 'guild';
        Guild.render();
    };

    Guild.requestChest = function() {
        Guild.tab = 'chest';
        Guild.chest = null;
        Mmo.send('guildChestRequest');
        Guild.render();
    };

    Guild.memberHtml = function(member, own) {
        var me = own && String(member.characterId) === String(own.characterId);
        var controls = '';
        if (own && own.role === 'leader' && member.role !== 'leader') {
            controls = '<button class="mg-set-role" data-id="' + escapeHtml(member.characterId) + '" data-role="' + (member.role === 'officer' ? 'member' : 'officer') + '">' + (member.role === 'officer' ? 'Rétrograder' : 'Officier') + '</button>' +
                '<button class="mg-transfer" data-id="' + escapeHtml(member.characterId) + '">Chef</button>';
        }
        return '<div class="mg-member"><div><strong>' + escapeHtml(member.name) + (me ? ' (toi)' : '') + '</strong><small>' + escapeHtml(roleLabel(member.role)) + ' · ' + escapeHtml(member.classId) + ' · niv. ' + Number(member.level) + '</small></div>' +
            '<div>' + controls + '<div class="' + (member.online ? 'mg-online' : 'mg-offline') + '">' + (member.online ? 'En ligne' : 'Hors ligne') + '</div></div></div>';
    };

    Guild.itemHtml = function(item, type) {
        var action = type === 'chest' ? '<button class="mg-withdraw" data-item="' + escapeHtml(item.itemId) + '">Retirer</button>' : '<button class="mg-deposit" data-item="' + escapeHtml(item.itemId) + '">Déposer</button>';
        return '<div class="mg-item"><div><strong>' + escapeHtml(item.label) + '</strong><small>' + escapeHtml(item.description || '') + '</small></div><div class="mg-qty">× ' + Number(item.quantity) + ' ' + action + '</div></div>';
    };

    Guild.renderCreate = function() {
        if (!Guild.registrarSessionId) {
            return '<div class="mg-note">Tu n’appartiens à aucune guilde. Pour en créer une, parle à un registraire de guilde et choisis sa branche de création native.</div>';
        }
        return '<div class="mg-note">Le registraire a validé ta présence. Choisis le nom de ta nouvelle guilde avant de t’éloigner du PNJ.</div>' +
            '<div class="mg-title">Créer une guilde</div><div class="mg-form"><input id="mg-create-name" maxlength="32" placeholder="Nom de la guilde"><button class="mg-button" id="mg-create">Créer</button></div>';
    };

    Guild.renderGuild = function() {
        var guild = Guild.data;
        var own = ownMember();
        var officer = own && (own.role === 'leader' || own.role === 'officer');
        return '<div class="mg-note"><strong>' + escapeHtml(guild.name) + '</strong> · ton rang : ' + escapeHtml(roleLabel(own ? own.role : 'member')) + '</div>' +
            '<div class="mg-actions"><button class="mg-button" id="mg-house">Entrer dans la maison</button><button class="mg-button" id="mg-chest">Coffre de guilde</button><button class="mg-button secondary" id="mg-house-exit">Sortir de la maison</button><button class="mg-button secondary" id="mg-leave">Quitter</button>' + (own && own.role === 'leader' ? '<button class="mg-button mg-danger" id="mg-disband">Dissoudre</button>' : '') + '</div>' +
            (officer ? '<div class="mg-title">Inviter un joueur en ligne</div><div class="mg-form"><input id="mg-invite-name" maxlength="24" placeholder="Nom du personnage"><button class="mg-button" id="mg-invite">Inviter</button></div>' : '') +
            '<div class="mg-title">Membres (' + guild.members.length + ')</div>' + guild.members.map(function(member) { return Guild.memberHtml(member, own); }).join('');
    };

    Guild.renderChest = function() {
        var chestItems = Guild.chest || [];
        var own = ownItems();
        return '<div class="mg-note">Le coffre ne fonctionne que dans la maison de guilde. Les dépôts et retraits sont confirmés par le serveur.</div>' +
            '<div class="mg-title">Coffre de la guilde</div>' + (Guild.chest === null ? '<div class="mg-muted">Chargement du coffre…</div>' : (chestItems.length ? chestItems.map(function(item) { return Guild.itemHtml(item, 'chest'); }).join('') : '<div class="mg-muted">Coffre vide.</div>')) +
            '<div class="mg-title">Ton inventaire — dépôt</div>' + (own.length ? own.map(function(item) { return Guild.itemHtml(item, 'inventory'); }).join('') : '<div class="mg-muted">Inventaire indisponible ou vide.</div>');
    };

    Guild.render = function() {
        var root = Guild.ensureDom();
        if (!root || !Guild.opened) return;
        var content = !Guild.data ? Guild.renderCreate() : (Guild.tab === 'chest' ? Guild.renderChest() : Guild.renderGuild());
        root.innerHTML = '<section class="mg-window"><div class="mg-head"><strong>Guilde</strong><button id="mg-close">Fermer · G</button></div>' +
            (Guild.data ? '<div class="mg-content"><div class="mg-tabs"><button class="mg-tab ' + (Guild.tab === 'guild' ? 'active' : '') + '" data-tab="guild">Guilde</button><button class="mg-tab ' + (Guild.tab === 'chest' ? 'active' : '') + '" data-tab="chest">Coffre</button></div>' + content + '</div>' : '<div class="mg-content">' + content + '</div>') + '</section>';
        document.getElementById('mg-close').onclick = function() { Guild.close(true); };
        var create = document.getElementById('mg-create');
        if (create) create.onclick = function() { Mmo.send('guildCreate', { sessionId: Guild.registrarSessionId, name: document.getElementById('mg-create-name').value.trim() }); };
        var invite = document.getElementById('mg-invite');
        if (invite) invite.onclick = function() { Mmo.send('guildInvite', { targetName: document.getElementById('mg-invite-name').value.trim() }); };
        var house = document.getElementById('mg-house');
        if (house) house.onclick = function() { Mmo.send('guildHouseEnter'); };
        var exit = document.getElementById('mg-house-exit');
        if (exit) exit.onclick = function() { Mmo.send('guildHouseExit'); };
        var chest = document.getElementById('mg-chest');
        if (chest) chest.onclick = Guild.requestChest;
        var leave = document.getElementById('mg-leave');
        if (leave) leave.onclick = function() { if (window.confirm('Quitter la guilde ?')) Mmo.send('guildLeave'); };
        var disband = document.getElementById('mg-disband');
        if (disband) disband.onclick = function() { if (window.confirm('Dissoudre définitivement la guilde et sa maison ?')) Mmo.send('guildDisband'); };
        var tabs = root.querySelectorAll('.mg-tab');
        for (var tabIndex = 0; tabIndex < tabs.length; tabIndex++) {
            tabs[tabIndex].onclick = function() { if (this.getAttribute('data-tab') === 'chest') Guild.requestChest(); else { Guild.tab = 'guild'; Guild.render(); } };
        }
        var roles = root.querySelectorAll('.mg-set-role');
        for (var roleIndex = 0; roleIndex < roles.length; roleIndex++) roles[roleIndex].onclick = function() { Mmo.send('guildSetRole', { characterId: this.getAttribute('data-id'), role: this.getAttribute('data-role') }); };
        var leaders = root.querySelectorAll('.mg-transfer');
        for (var leaderIndex = 0; leaderIndex < leaders.length; leaderIndex++) leaders[leaderIndex].onclick = function() { if (window.confirm('Transférer le leadership ?')) Mmo.send('guildTransferLeader', { characterId: this.getAttribute('data-id') }); };
        var deposits = root.querySelectorAll('.mg-deposit');
        for (var depositIndex = 0; depositIndex < deposits.length; depositIndex++) deposits[depositIndex].onclick = function() { Guild.moveItem('guildDeposit', this.getAttribute('data-item')); };
        var withdrawals = root.querySelectorAll('.mg-withdraw');
        for (var withdrawIndex = 0; withdrawIndex < withdrawals.length; withdrawIndex++) withdrawals[withdrawIndex].onclick = function() { Guild.moveItem('guildWithdraw', this.getAttribute('data-item')); };
    };

    Guild.moveItem = function(type, itemId) {
        var quantity = Number(window.prompt('Quantité à déplacer', '1'));
        if (!quantity || quantity < 1) return;
        Mmo.send(type, { itemId: itemId, quantity: Math.floor(quantity) });
    };

    Mmo.registerPacketHandler('guildSnapshot', function(packet) {
        Guild.data = packet.guild || null;
        if (!Guild.data) Guild.chest = null;
        if (Guild.data) Guild.registrarSessionId = null;
        if (Guild.opened) Guild.render();
    });
    Mmo.registerPacketHandler('npcServiceClosed', function(packet) {
        if (Guild.registrarSessionId && packet && packet.service === 'guild_registrar') {
            Guild.close(false);
            if (packet.reason) Mmo.toast(packet.reason, true);
        }
    });
    Mmo.registerPacketHandler('guildChestSnapshot', function(packet) {
        Guild.chest = packet.items || [];
        Guild.tab = 'chest';
        if (Guild.opened) Guild.render();
    });
    Mmo.registerPacketHandler('guildInvite', function(packet) {
        var prompt = (packet.from ? packet.from.name : 'Un joueur') + ' t’invite dans la guilde « ' + packet.guildName + ' ». Accepter ?';
        Mmo.send('guildResponse', { guildId: packet.guildId, accepted: window.confirm(prompt) });
    });

    Input.keyMapper[71] = 'mmoGuild'; // G
    var _Scene_Map_update = Scene_Map.prototype.update;
    Scene_Map.prototype.update = function() {
        _Scene_Map_update.call(this);
        var focused = typeof document !== 'undefined' && document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].indexOf(document.activeElement.tagName) !== -1;
        if (Mmo.activeCharacter && !focused && Input.isTriggered('mmoGuild')) Guild.toggle();
    };

    var _Game_Interpreter_pluginCommand = Game_Interpreter.prototype.pluginCommand;
    Game_Interpreter.prototype.pluginCommand = function(command, args) {
        if (String(command).toUpperCase() === 'MMO') {
            var action = String(args[0] || '').toUpperCase();
            var rest = args.slice(1);
            if (action === 'GUILD') { Guild.open(); return; }
            if (action === 'GUILD_CREATE') { Mmo.toast('La création de guilde doit être validée par un registraire.', true); return; }
            if (action === 'GUILD_INVITE') { Mmo.send('guildInvite', { targetName: rest.join(' ') }); return; }
            if (action === 'GUILD_LEAVE') { Mmo.send('guildLeave'); return; }
            if (action === 'GUILD_HOUSE') { Mmo.send('guildHouseEnter'); return; }
            if (action === 'GUILD_HOUSE_EXIT') { Mmo.send('guildHouseExit'); return; }
            if (action === 'GUILD_CHEST') { Guild.requestChest(); return; }
        }
        _Game_Interpreter_pluginCommand.call(this, command, args);
    };

})(MMOGuild, MMOFoundation);
