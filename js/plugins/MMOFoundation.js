/*:
 * @plugindesc v0.19.0 Native advanced item effects integration.
 * @author Arena MMO starter
 *
 * @param ServerUrl
 * @text Server WebSocket URL
 * @type string
 * @default ws://127.0.0.1:3000/ws
 * @desc Use wss:// for a production HTTPS website.
 *
 * @param AutoOpenLogin
 * @text Open MMO launcher on title screen
 * @type boolean
 * @default true
 *
 * @param OfficialServerName
 * @text Official server name
 * @type string
 * @default Serveur officiel — Europe
 * @desc Name shown on the full-screen official-server selection page.
 *
 * @param OfficialServerDescription
 * @text Official server description
 * @type string
 * @default Monde principal · Communauté francophone
 * @desc Description shown below the official server.
 *
 * @param CharacterSheet
 * @text Character sprite sheet
 * @type file
 * @dir img/characters/
 * @default Actor1
 * @desc A normal 8-character RPG Maker MV sheet, without the .png extension.
 *
 * @param WarriorSpriteIndex
 * @type number
 * @min 0
 * @max 7
 * @default 0
 *
 * @param MageSpriteIndex
 * @type number
 * @min 0
 * @max 7
 * @default 1
 *
 * @param ArcherSpriteIndex
 * @type number
 * @min 0
 * @max 7
 * @default 2
 *
 * @param PriestSpriteIndex
 * @type number
 * @min 0
 * @max 7
 * @default 3
 *
 * @param WarriorActorClassId
 * @type number
 * @min 1
 * @default 2
 * @desc Database class assigned to actor 1 when a warrior logs in.
 *
 * @param MageActorClassId
 * @type number
 * @min 1
 * @default 3
 *
 * @param ArcherActorClassId
 * @type number
 * @min 1
 * @default 5
 *
 * @param PriestActorClassId
 * @type number
 * @min 1
 * @default 4
 *
 * @help
 * MMOFoundation – Server companion required
 * ==========================================
 * This plugin connects an RPG Maker MV project to the Node.js MMO server
 * contained in this starter repository. It uses the browser WebSocket API,
 * so it runs in MV's desktop playtest and in web deployments.
 *
 * Plugin commands (RPG Maker MV):
 *   MMO OPEN_LOGIN
 *   MMO CONNECT ws://127.0.0.1:3000/ws
 *   MMO REGISTER username password
 *   MMO LOGIN username password
 *   MMO SELECT characterId
 *   MMO CREATE "Name" warrior|mage|archer|priest
 *   MMO CHAT global|local|group message here
 *   MMO GROUP_INVITE PlayerName
 *   MMO GROUP_ACCEPT groupId
 *   MMO GROUP_DECLINE groupId
 *   MMO GROUP_LEAVE
 *   MMO QUEST_START rat_problem|crypt_sweep
 *   MMO QUEST_PROGRESS rat_problem|crypt_sweep [amount]
 *   MMO ENTER_DUNGEON forgotten_crypt
 *   MMO EXIT_DUNGEON
 *   MMO SHOW_HUD
 *   MMO HIDE_HUD
 *
 * A player can also write chat in the map HUD (press T to focus it).
 *
 * IMPORTANT:
 * - Configure the server's dungeon template map id in server/src/content.js.
 * - The base server validates identities, inventory-like rewards and progress;
 *   it never treats this MV client as authoritative.
 * - QUEST_PROGRESS is a development hook for events. Replace it with validated
 *   server-side battle rewards when adding the BattleManager integration.
 */

var Imported = Imported || {};
Imported.MMOFoundation = true;

var MMOFoundation = MMOFoundation || {};

(function(Mmo) {
    'use strict';

    var parameters = PluginManager.parameters('MMOFoundation');
    function boolParameter(name, fallback) {
        var value = parameters[name];
        if (value === undefined || value === '') return fallback;
        return String(value).toLowerCase() === 'true';
    }
    function numberParameter(name, fallback) {
        var value = Number(parameters[name]);
        return isNaN(value) ? fallback : value;
    }

    Mmo.config = {
        serverUrl: String(parameters.ServerUrl || 'ws://127.0.0.1:3000/ws'),
        autoOpenLogin: boolParameter('AutoOpenLogin', true),
        officialServerName: String(parameters.OfficialServerName || 'Serveur officiel — Europe'),
        officialServerDescription: String(parameters.OfficialServerDescription || 'Monde principal · Communauté francophone'),
        characterSheet: String(parameters.CharacterSheet || 'Actor1'),
        spriteIndexes: {
            warrior: numberParameter('WarriorSpriteIndex', 0),
            mage: numberParameter('MageSpriteIndex', 1),
            archer: numberParameter('ArcherSpriteIndex', 2),
            priest: numberParameter('PriestSpriteIndex', 3)
        },
        actorClassIds: {
            warrior: numberParameter('WarriorActorClassId', 2),
            mage: numberParameter('MageActorClassId', 3),
            archer: numberParameter('ArcherActorClassId', 5),
            priest: numberParameter('PriestActorClassId', 4)
        }
    };

    Mmo.socket = null;
    Mmo.connected = false;
    Mmo.account = null;
    Mmo.classes = [];
    Mmo.characters = [];
    Mmo.activeCharacter = null;
    Mmo.remotePlayers = {};
    Mmo.remoteSprites = {};
    Mmo.instanceId = null;
    Mmo.transferContext = undefined;
    Mmo.deferredTransfer = null;
    Mmo.group = null;
    Mmo.quests = [];
    Mmo.chatHistory = [];
    Mmo.hudChatOpen = false;
    Mmo._onSocketOpen = [];
    Mmo._titleLoginShown = false;
    // The title scene performs the actual Scene_Map switch in its own update loop.
    // This avoids a lost scene transition when a WebSocket packet arrives mid-frame.
    Mmo._worldStartPending = false;
    Mmo.launcherActive = false;
    Mmo.launcherStep = null;
    Mmo._accountDraftUsername = '';
    Mmo.packetHandlers = {};
    Mmo.errorHandlers = [];
    // Several MMO modules can react to the same server packet. This is needed
    // for example when Scene_Battle renders battleState while MMOEvents uses
    // battleEnded to resume the originating RPG Maker event.
    Mmo.registerPacketHandler = function(type, handler) {
        var key = String(type);
        if (!Mmo.packetHandlers[key]) Mmo.packetHandlers[key] = [];
        Mmo.packetHandlers[key].push(handler);
    };
    Mmo.registerErrorHandler = function(handler) {
        if (typeof handler === 'function') Mmo.errorHandlers.push(handler);
    };

    function escapeHtml(value) {
        return String(value === undefined || value === null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function currentSceneIsMap() {
        return typeof Scene_Map !== 'undefined' && SceneManager._scene instanceof Scene_Map;
    }

    function sameInstance(left, right) {
        return (left || null) === (right || null);
    }

    Mmo.ensureDom = function() {
        if (typeof document === 'undefined') return;
        if (!document.getElementById('mmo-foundation-style')) {
            var style = document.createElement('style');
            style.id = 'mmo-foundation-style';
            style.textContent = [
                '#mmo-foundation-modal,#mmo-foundation-hud,#mmo-foundation-toasts{font-family:Arial,sans-serif;position:fixed;z-index:99999;color:#f4f7ff}',
                '#mmo-foundation-modal{inset:0;display:flex;align-items:center;justify-content:center;background:#070b16;pointer-events:auto}',
                '#mmo-foundation-modal:empty{display:none}',
                '.mmo-launcher{position:relative;isolation:isolate;width:100vw;min-height:100vh;overflow:auto;box-sizing:border-box;padding:clamp(22px,6vh,74px) clamp(20px,7vw,112px);background:radial-gradient(circle at 12% 14%,#1f4c80 0,transparent 29%),radial-gradient(circle at 87% 80%,#382361 0,transparent 31%),linear-gradient(135deg,#08101e 0%,#0d1830 48%,#070b16 100%)}',
                '.mmo-launcher:before{content:"";position:absolute;inset:0;z-index:-1;opacity:.24;background-image:linear-gradient(rgba(145,185,255,.14) 1px,transparent 1px),linear-gradient(90deg,rgba(145,185,255,.14) 1px,transparent 1px);background-size:42px 42px;mask-image:linear-gradient(to bottom,black,transparent)}',
                '.mmo-launcher-shell{width:min(1020px,100%);margin:0 auto}.mmo-launcher-brand{display:flex;align-items:center;gap:13px;color:#eaf2ff;letter-spacing:.08em;font-size:12px;font-weight:bold;text-transform:uppercase}.mmo-launcher-mark{display:grid;place-items:center;width:38px;height:38px;border-radius:11px;background:linear-gradient(135deg,#73b7ff,#7c65e9);box-shadow:0 8px 24px rgba(84,134,255,.35);font-size:18px}',
                '.mmo-launcher-content{display:grid;grid-template-columns:minmax(0,1fr) minmax(360px,440px);gap:clamp(28px,7vw,100px);align-items:center;min-height:calc(100vh - 185px)}.mmo-launcher-copy{max-width:510px}.mmo-step{display:inline-block;border:1px solid rgba(144,189,255,.48);border-radius:999px;padding:6px 10px;color:#afd0ff;font-size:11px;font-weight:bold;letter-spacing:.08em;text-transform:uppercase}.mmo-launcher h1{margin:16px 0 13px;color:#f5f8ff;font-size:clamp(34px,5vw,58px);line-height:1.03;letter-spacing:-.04em}.mmo-launcher h2{margin:0 0 8px;font-size:25px;color:#f5f8ff}.mmo-launcher h3{margin:0 0 6px;color:#f5f8ff}.mmo-launcher-copy p,.mmo-launcher-panel p{color:#bdcbe5;line-height:1.55}.mmo-launcher-detail{display:flex;gap:9px;margin-top:22px;color:#98afd4;font-size:13px}.mmo-launcher-detail span{color:#7fb6ff}',
                '.mmo-launcher-panel{box-sizing:border-box;max-height:calc(100vh - 125px);overflow:auto;padding:28px;background:linear-gradient(145deg,rgba(25,42,74,.92),rgba(10,18,34,.95));border:1px solid rgba(119,161,224,.48);border-radius:18px;box-shadow:0 25px 75px rgba(0,0,0,.43);backdrop-filter:blur(12px)}.mmo-launcher-panel label{display:block;margin:15px 0 5px;color:#cbd6ef;font-size:13px}.mmo-launcher input,.mmo-launcher select{box-sizing:border-box;width:100%;padding:12px;border:1px solid #4d6693;border-radius:7px;background:#08101e;color:#fff;font-size:15px}.mmo-launcher input:focus,.mmo-launcher select:focus{outline:2px solid #6ba9ff;border-color:transparent}.mmo-launcher button,.mmo-button{padding:11px 14px;border:0;border-radius:7px;background:linear-gradient(135deg,#4b91ed,#6e66e8);color:white;font-weight:bold;cursor:pointer;margin:15px 8px 0 0}.mmo-launcher button.secondary,.mmo-button.secondary{background:#48536a}.mmo-launcher button.ghost{background:transparent;border:1px solid #536c98;color:#cfe0ff}.mmo-launcher button:hover,.mmo-button:hover{filter:brightness(1.15);transform:translateY(-1px)}',
                '.mmo-error{min-height:18px;margin-top:12px;color:#ff9ba2;font-size:13px}.mmo-success{margin-top:10px;color:#a9e7bb;font-size:13px}.mmo-muted{color:#9faccc;font-size:13px}.mmo-login-switch{margin-top:19px;padding-top:16px;border-top:1px solid rgba(111,144,195,.35)}',
                '.mmo-character{display:flex;align-items:center;justify-content:space-between;gap:8px;border:1px solid #3b4f78;border-radius:8px;padding:13px;margin:9px 0;background:rgba(7,15,31,.7)}.mmo-character strong{display:block}.mmo-character small{color:#b7c4df}.mmo-server-card{border:1px solid rgba(112,166,241,.66);border-radius:12px;padding:17px;background:rgba(7,18,38,.72);box-shadow:inset 0 1px rgba(255,255,255,.05)}.mmo-server-card strong{display:block;font-size:18px;color:#f4f8ff}.mmo-server-card small{display:block;margin-top:5px;color:#b8c9e9}.mmo-server-status{display:inline-block;margin-top:13px;color:#9ce6b1;font-size:12px;font-weight:bold}.mmo-character-list{max-height:280px;overflow:auto;padding-right:3px}.mmo-character-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.mmo-character-actions button{margin:0}.mmo-delete-character{background:transparent!important;border:1px solid rgba(242,126,139,.8)!important;color:#ffc0c7!important}.mmo-launcher-shell.mmo-launcher-shell-full{width:min(1680px,100%)}.mmo-launcher-content.mmo-launcher-content-full{grid-template-columns:1fr;gap:18px;align-items:start;min-height:calc(100vh - 120px)}.mmo-launcher-content-full .mmo-launcher-copy{max-width:none;display:grid;grid-template-columns:auto minmax(0,1fr);column-gap:15px;align-items:center}.mmo-launcher-content-full .mmo-launcher-copy h1{grid-column:1}.mmo-launcher-content-full .mmo-launcher-copy p,.mmo-launcher-content-full .mmo-launcher-detail{grid-column:2;margin:0}.mmo-launcher-panel.mmo-launcher-panel-full{max-height:none;overflow:visible;padding:32px}.mmo-launcher-panel-full .mmo-character-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:10px;max-height:310px;padding:0}.mmo-launcher-panel-full .mmo-character{margin:0}.mmo-launcher-panel-full .mmo-appearance-editor{grid-template-columns:minmax(520px,1fr) minmax(320px,.62fr);gap:24px}.mmo-launcher-panel-full .mmo-generator-variants{max-height:310px}.mmo-launcher-panel-full .mmo-appearance-preview{min-height:260px;gap:14px}.mmo-launcher-panel-full .mmo-appearance-preview-card canvas{transform:scale(1.35);transform-origin:center;margin:12px}.mmo-launcher-panel-full .mmo-appearance-preview-card small{font-size:11px}',
                '.mmo-appearance-editor{display:grid;grid-template-columns:minmax(0,1fr) 175px;gap:14px;margin-top:17px;padding:14px;border:1px solid rgba(112,166,241,.36);border-radius:10px;background:rgba(4,12,27,.42)}.mmo-appearance-editor h3{font-size:16px}.mmo-appearance-fields{display:grid;grid-template-columns:1fr 1fr;gap:0 9px}.mmo-appearance-fields label{margin:7px 0 2px;font-size:11px}.mmo-appearance-fields select{padding:8px;font-size:12px}.mmo-appearance-preview{display:flex;align-items:center;justify-content:center;gap:5px;min-height:112px;border:1px solid rgba(102,145,210,.45);border-radius:8px;background:#08101e;color:#9eb9df;font-size:10px}.mmo-appearance-preview-card{display:flex;flex-direction:column;align-items:center;gap:3px}.mmo-appearance-preview-card small{color:#aacaf4;font-size:9px}.mmo-appearance-preview-card canvas{image-rendering:pixelated;background:linear-gradient(135deg,#182945,#0c1525);border-radius:3px}.mmo-generator-categories{display:flex;flex-wrap:wrap;gap:5px;margin:10px 0}.mmo-generator-category{padding:5px 7px!important;font-size:10px!important}.mmo-generator-category.selected{border-color:#8ec5ff!important;background:#23598d!important}.mmo-generator-variants{display:flex;flex-wrap:wrap;gap:5px;max-height:180px;overflow:auto;padding:6px;border:1px solid rgba(102,145,210,.35);border-radius:6px;background:rgba(0,0,0,.18)}.mmo-generator-variant{display:flex;flex-direction:column;align-items:center;gap:1px;padding:3px!important;min-width:44px;background:#10243e!important;border:1px solid rgba(102,145,210,.42)!important}.mmo-generator-variant.selected{border-color:#f3cc75!important;box-shadow:0 0 0 1px #f3cc75}.mmo-generator-variant canvas{image-rendering:pixelated;background:#101a2b}.mmo-generator-variant small{font-size:9px;color:#c9d9ef}@media(max-width:760px){.mmo-appearance-editor{grid-template-columns:1fr}.mmo-appearance-preview{min-height:94px}}',
                '@media(max-width:760px){.mmo-launcher{padding:28px 20px}.mmo-launcher-content{grid-template-columns:1fr;gap:22px;min-height:auto;padding-top:45px}.mmo-launcher-copy,.mmo-launcher-content-full .mmo-launcher-copy{display:block;max-width:none}.mmo-launcher-panel{max-height:none}.mmo-launcher-panel.mmo-launcher-panel-full{padding:18px}.mmo-launcher-panel-full .mmo-appearance-editor{grid-template-columns:1fr}.mmo-launcher h1{font-size:39px}}',
                '#mmo-foundation-hud{left:14px;top:14px;right:auto;bottom:auto;width:270px;pointer-events:none}#mmo-foundation-hud:empty{display:none}',
                '.mmo-hud-card{pointer-events:auto;box-sizing:border-box;background:linear-gradient(135deg,rgba(6,14,28,.94),rgba(16,34,59,.9));border:1px solid rgba(106,156,226,.7);border-radius:9px;box-shadow:0 6px 20px rgba(0,0,0,.45);overflow:hidden}.mmo-hud-status{display:flex;gap:8px;padding:8px}.mmo-hud-portrait{width:48px;height:48px;flex:0 0 48px;border:1px solid #75a7ed;border-radius:6px;background:#162947 center/192px 96px no-repeat;box-shadow:inset 0 0 0 1px #07101f}.mmo-hud-main{min-width:0;flex:1}.mmo-hud-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#f2f6ff;font-size:13px;font-weight:bold}.mmo-hud-meta{margin:2px 0 5px;color:#a9c8f3;font-size:10px}.mmo-hud-bar{height:8px;position:relative;margin:3px 0;border:1px solid rgba(0,0,0,.65);border-radius:5px;background:#202633;overflow:hidden}.mmo-hud-bar i{display:block;height:100%;border-radius:4px}.mmo-hud-bar b{position:absolute;inset:-2px 4px;color:#fff;font-size:8px;line-height:9px;text-align:right;text-shadow:1px 1px #000;font-weight:normal}.mmo-hud-hp i{background:linear-gradient(90deg,#c43b46,#ee6b5b)}.mmo-hud-mp i{background:linear-gradient(90deg,#356fd0,#58b7ea)}',
                '.mmo-hud-sub{pointer-events:auto;margin-top:5px;padding:7px 9px;color:#d6e3f9;font-size:11px}.mmo-hud-sub:empty{display:none}.mmo-hud-sub .mmo-panel-title{color:#8fc1ff;font-weight:bold}.mmo-hud-sub-row{display:flex;justify-content:space-between;gap:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mmo-hud-quest{position:fixed;left:14px;top:108px;width:270px}.mmo-hud-group{position:fixed;left:14px;top:calc(108px + 72px);width:270px}',
                '#mmo-chat-launcher{position:fixed;left:14px;bottom:14px;pointer-events:auto}.mmo-chat-button{border:1px solid rgba(112,167,240,.82);border-radius:999px;background:linear-gradient(135deg,#152b4a,#214f83);color:#f5f8ff;box-shadow:0 5px 17px rgba(0,0,0,.45);padding:8px 12px;font-size:12px;font-weight:bold;cursor:pointer}.mmo-chat-button:hover{filter:brightness(1.15)}.mmo-chat-button small{margin-left:6px;color:#a7c9f6;font-weight:normal}.mmo-chat-bubble{position:absolute;left:0;bottom:43px;width:250px;box-sizing:border-box;padding:9px 11px;border:1px solid rgba(114,166,240,.75);border-radius:9px;background:rgba(8,18,35,.96);color:#e8f1ff;box-shadow:0 5px 18px rgba(0,0,0,.5);font-size:11px;line-height:1.35}.mmo-chat-bubble:after{content:"";position:absolute;left:17px;bottom:-7px;border-width:7px 7px 0;border-style:solid;border-color:rgba(114,166,240,.75) transparent transparent}.mmo-chat-bubble:empty{display:none}.mmo-chat-bubble strong{color:#99c6ff}.mmo-chat-dock{position:absolute;left:0;bottom:46px;width:310px;background:rgba(7,15,30,.98);border:1px solid rgba(112,167,240,.82);border-radius:10px;box-shadow:0 10px 28px rgba(0,0,0,.55);overflow:hidden}.mmo-chat-dock[hidden]{display:none}',
                '#mmo-chat-dock-head{display:flex;justify-content:space-between;align-items:center;padding:7px 9px;background:#152b4a;color:#dceaff;font-size:11px;font-weight:bold}#mmo-chat-close{border:0;background:transparent;color:#cfe2ff;cursor:pointer;font-size:16px;line-height:12px}#mmo-chat-log{height:130px;overflow-y:auto;padding:8px 10px;font-size:12px;line-height:1.35}.mmo-chat-row{margin:0 0 4px;word-break:break-word}.mmo-chat-scope{font-weight:bold;color:#93b8ff}#mmo-chat-controls{display:flex;gap:5px;padding:7px;border-top:1px solid #2d4168}#mmo-chat-scope{width:74px;padding:7px;font-size:12px;background:#08101e;color:#fff;border:1px solid #4d6693;border-radius:5px}#mmo-chat-input{min-width:0;flex:1;padding:7px;font-size:12px;background:#08101e;color:#fff;border:1px solid #4d6693;border-radius:5px}',
                '#mmo-foundation-toasts{left:50%;top:18px;transform:translateX(-50%);width:min(420px,calc(100vw - 24px));pointer-events:none}.mmo-toast{margin:0 0 8px;padding:10px 13px;background:rgba(18,30,52,.96);border-left:3px solid #68a5ff;border-radius:4px;box-shadow:0 4px 18px #000;font-size:13px}.mmo-toast.error{border-left-color:#ff6673}'
            ].join('');
            document.head.appendChild(style);
        }
        ['mmo-foundation-modal', 'mmo-foundation-hud', 'mmo-foundation-toasts'].forEach(function(id) {
            if (!document.getElementById(id)) {
                var element = document.createElement('div');
                element.id = id;
                document.body.appendChild(element);
            }
        });
    };

    Mmo.toast = function(message, isError) {
        Mmo.ensureDom();
        var container = document.getElementById('mmo-foundation-toasts');
        if (!container) return;
        var toast = document.createElement('div');
        toast.className = 'mmo-toast' + (isError ? ' error' : '');
        toast.textContent = String(message);
        container.appendChild(toast);
        setTimeout(function() {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 5000);
    };

    Mmo.setModal = function(html) {
        Mmo.ensureDom();
        var modal = document.getElementById('mmo-foundation-modal');
        if (modal) modal.innerHTML = html || '';
    };

    // RPG Maker MV registers keyboard listeners on document and prevents the
    // browser Backspace default. Stop those events at MMO text fields so their
    // editing stays native: Backspace, Delete, arrows, selection and paste all
    // work before a chat message is sent.
    Mmo.enableTextEditing = function(input) {
        if (!input || input._mmoTextEditingBound) return;
        input._mmoTextEditingBound = true;
        ['keydown', 'keyup', 'keypress'].forEach(function(type) {
            input.addEventListener(type, function(event) { event.stopPropagation(); });
        });
    };

    // DOM overlays receive wheel input instead of RPG Maker's canvas. Native
    // browser scrolling keeps long character and launcher panels usable.
    Mmo.enableWheelScrolling = function(root) {
        if (!root || root._mmoWheelScrollingBound) return;
        root._mmoWheelScrollingBound = true;
        root.addEventListener('wheel', function(event) {
            var target = event.target;
            while (target && target !== root && !(target.classList && (target.classList.contains('mmo-character-list') || target.classList.contains('mmo-launcher-panel') || target.classList.contains('mmo-launcher') || target.classList.contains('mmo-chat-log')))) target = target.parentNode;
            if (!target || !(target.scrollHeight > target.clientHeight)) return;
            // Let the browser perform its native scrolling. Stopping only the
            // propagation prevents RPG Maker's canvas from receiving the wheel
            // event and allows this listener to stay passive.
            event.stopPropagation();
        }, { passive: true });
    };

    // TouchInput listens on document in RPG Maker MV. Without this firewall a
    // click on a DOM chat field reaches the map as a destination click and can
    // move the player. HUD controls own their pointer/touch interaction.
    Mmo.protectHudInteraction = function(root) {
        if (!root || root._mmoHudInteractionBound) return;
        root._mmoHudInteractionBound = true;
        ['mousedown', 'mouseup', 'mousemove', 'touchstart', 'touchmove', 'touchend', 'pointerdown', 'pointerup', 'click'].forEach(function(type) {
            // Touch handlers only stop propagation; they never call
            // preventDefault, so mark them passive to avoid Chrome warnings.
            var options = type.indexOf('touch') === 0 ? { passive: true } : false;
            root.addEventListener(type, function(event) { event.stopPropagation(); }, options);
        });
    };

    Mmo.closeModal = function() {
        Mmo.launcherActive = false;
        Mmo.launcherStep = null;
        Mmo.setModal('');
    };

    Mmo.connect = function(url, onOpen) {
        var address = String(url || Mmo.config.serverUrl).trim();
        if (!address) {
            Mmo.toast('Adresse serveur manquante.', true);
            return;
        }
        Mmo.config.serverUrl = address;
        if (Mmo.socket && Mmo.socket.readyState === WebSocket.OPEN) {
            if (onOpen) onOpen();
            return;
        }
        if (onOpen) Mmo._onSocketOpen.push(onOpen);
        if (Mmo.socket && Mmo.socket.readyState === WebSocket.CONNECTING) return;

        try {
            var socket = new WebSocket(address);
            Mmo.socket = socket;
            socket.onopen = function() {
                if (Mmo.socket !== socket) return;
                Mmo.connected = true;
                Mmo.toast('Connecté au serveur MMO.');
                var callbacks = Mmo._onSocketOpen.slice();
                Mmo._onSocketOpen = [];
                callbacks.forEach(function(callback) { callback(); });
            };
            socket.onmessage = function(event) {
                if (Mmo.socket !== socket) return;
                Mmo.receive(event.data);
            };
            socket.onerror = function() {
                // onclose displays the actionable message without exposing browser-specific errors.
            };
            socket.onclose = function() {
                if (Mmo.socket !== socket) return;
                Mmo.connected = false;
                Mmo.socket = null;
                Mmo.toast('Connexion au serveur interrompue.', true);
            };
        } catch (error) {
            Mmo.toast('Impossible d’ouvrir la connexion : ' + error.message, true);
        }
    };

    Mmo.send = function(type, data) {
        if (!Mmo.socket || Mmo.socket.readyState !== WebSocket.OPEN) {
            Mmo.toast('Tu n’es pas connecté au serveur.', true);
            return false;
        }
        var packet = data || {};
        packet.type = type;
        Mmo.socket.send(JSON.stringify(packet));
        return true;
    };

    Mmo.lockNativeTitleMenu = function() {
        var scene = typeof SceneManager !== 'undefined' ? SceneManager._scene : null;
        if (typeof Scene_Title === 'undefined' || !(scene instanceof Scene_Title) || !scene._commandWindow) return;
        scene._commandWindow.deactivate();
        scene._commandWindow.close();
        scene._commandWindow.hide();
    };

    Mmo.showLauncher = function(step, headline, body, panel, layout) {
        var fullLayout = layout === 'full';
        Mmo.launcherActive = true;
        Mmo.launcherStep = step;
        Mmo.lockNativeTitleMenu();
        Mmo.setModal(
            '<main class="mmo-launcher" role="main">' +
                '<div class="mmo-launcher-shell' + (fullLayout ? ' mmo-launcher-shell-full' : '') + '">' +
                    '<header class="mmo-launcher-brand"><span class="mmo-launcher-mark">✦</span><span>Chroniques du royaume · MMO</span></header>' +
                    '<div class="mmo-launcher-content' + (fullLayout ? ' mmo-launcher-content-full' : '') + '">' +
                        '<section class="mmo-launcher-copy"><span class="mmo-step">' + escapeHtml(step) + '</span><h1>' + escapeHtml(headline) + '</h1><p>' + escapeHtml(body) + '</p><div class="mmo-launcher-detail"><span>◆</span><span>Compte, personnage et progression sont enregistrés de façon sécurisée sur le serveur.</span></div></section>' +
                        '<section class="mmo-launcher-panel' + (fullLayout ? ' mmo-launcher-panel-full' : '') + '">' + panel + '</section>' +
                    '</div>' +
                '</div>' +
            '</main>'
        );
        Mmo.enableWheelScrolling(document.getElementById('mmo-foundation-modal'));
    };

    Mmo.openLogin = function(notice, presetUsername) {
        var username = presetUsername === undefined ? Mmo._accountDraftUsername : presetUsername;
        Mmo.showLauncher('Étape 1 sur 3 · Compte', 'Entrez dans le royaume.', 'Connecte-toi avec ton compte MMO. Tu choisiras ensuite le serveur officiel et ton aventurier.',
            '<h2>Connexion</h2><p>Heureux de te revoir.</p>' +
            (notice ? '<div class="mmo-success">' + escapeHtml(notice) + '</div>' : '') +
            '<label for="mmo-username">Pseudo de compte</label><input id="mmo-username" maxlength="20" autocomplete="username" value="' + escapeHtml(username || '') + '">' +
            '<label for="mmo-password">Mot de passe</label><input id="mmo-password" type="password" maxlength="72" autocomplete="current-password">' +
            '<button id="mmo-login-button">Se connecter</button>' +
            '<div id="mmo-login-error" class="mmo-error"></div>' +
            '<div class="mmo-login-switch"><span class="mmo-muted">Première visite ?</span><button class="ghost" id="mmo-open-register">Créer un compte</button></div>'
        );
        var login = document.getElementById('mmo-login-button');
        function credentials() {
            return {
                username: document.getElementById('mmo-username').value.trim(),
                password: document.getElementById('mmo-password').value
            };
        }
        function showError(message) {
            var field = document.getElementById('mmo-login-error');
            if (field) field.textContent = message;
        }
        login.onclick = function() {
            var values = credentials();
            if (!values.username || !values.password) return showError('Renseigne le pseudo et le mot de passe.');
            Mmo._accountDraftUsername = values.username;
            Mmo.connect(Mmo.config.serverUrl, function() { Mmo.send('login', values); });
        };
        document.getElementById('mmo-open-register').onclick = function() { Mmo.openRegistration(); };
        document.getElementById('mmo-password').onkeydown = function(event) {
            if (event.keyCode === 13) login.onclick();
        };
        Mmo.enableTextEditing(document.getElementById('mmo-username'));
        Mmo.enableTextEditing(document.getElementById('mmo-password'));
        setTimeout(function() { var input = document.getElementById('mmo-username'); if (input) input.focus(); }, 0);
    };

    Mmo.openRegistration = function() {
        Mmo.showLauncher('Étape 1 sur 3 · Compte', 'Créez votre accès.', 'Un seul compte te permet de conserver tes personnages, tes objets et ta progression sur le serveur officiel.',
            '<h2>Créer un compte</h2><p>Choisis des identifiants que tu garderas pour te reconnecter.</p>' +
            '<label for="mmo-register-username">Pseudo de compte</label><input id="mmo-register-username" maxlength="20" autocomplete="username" value="' + escapeHtml(Mmo._accountDraftUsername || '') + '">' +
            '<label for="mmo-register-password">Mot de passe</label><input id="mmo-register-password" type="password" maxlength="72" autocomplete="new-password">' +
            '<button id="mmo-register-button">Créer mon compte</button><button class="ghost" id="mmo-back-login">Retour à la connexion</button>' +
            '<div id="mmo-register-error" class="mmo-error"></div>'
        );
        function showError(message) {
            var field = document.getElementById('mmo-register-error');
            if (field) field.textContent = message;
        }
        var register = document.getElementById('mmo-register-button');
        register.onclick = function() {
            var username = document.getElementById('mmo-register-username').value.trim();
            var password = document.getElementById('mmo-register-password').value;
            if (!username || !password) return showError('Renseigne le pseudo et le mot de passe.');
            Mmo._accountDraftUsername = username;
            Mmo.connect(Mmo.config.serverUrl, function() { Mmo.send('register', { username: username, password: password }); });
        };
        document.getElementById('mmo-back-login').onclick = function() { Mmo.openLogin(); };
        document.getElementById('mmo-register-password').onkeydown = function(event) {
            if (event.keyCode === 13) register.onclick();
        };
        Mmo.enableTextEditing(document.getElementById('mmo-register-username'));
        Mmo.enableTextEditing(document.getElementById('mmo-register-password'));
    };

    Mmo.showServerSelection = function() {
        Mmo.showLauncher('Étape 2 sur 3 · Serveur', 'Choisissez votre monde.', 'Sélectionne le serveur officiel sur lequel tes personnages joueront. Ton compte est déjà authentifié.',
            '<h2>Serveurs officiels</h2><p>Choisis le monde principal pour accéder à tes personnages.</p>' +
            '<div class="mmo-server-card"><strong>' + escapeHtml(Mmo.config.officialServerName) + '</strong><small>' + escapeHtml(Mmo.config.officialServerDescription) + '</small><span class="mmo-server-status">● Disponible</span><br><button id="mmo-select-official-server">Jouer sur ce serveur</button></div>' +
            '<div id="mmo-server-error" class="mmo-error"></div>'
        );
        document.getElementById('mmo-select-official-server').onclick = function() {
            if (!Mmo.connected) {
                var error = document.getElementById('mmo-server-error');
                if (error) error.textContent = 'La connexion au serveur a été interrompue. Reconnecte-toi.';
                return;
            }
            Mmo.showCharacterSelection();
        };
    };

    Mmo.showCharacterCreation = function() {
        // Entering the dedicated creator must not reuse preview
        // bitmaps whose asynchronous composition belonged to the old DOM.
        if (typeof MMOAppearance !== 'undefined' && typeof MMOAppearance.resetCreatorCache === 'function') MMOAppearance.resetCreatorCache();
        var cards = Mmo.characters.map(function(character) {
            return '<div class="mmo-character"><div><strong>' + escapeHtml(character.name) + '</strong><small>' +
                escapeHtml(Mmo.classLabel(character.classId)) + ' · niveau ' + Number(character.level || 1) +
                '</small></div><div class="mmo-character-actions"><button class="mmo-select-character" data-id="' + escapeHtml(character.characterId) + '">Jouer</button><button class="ghost mmo-delete-character" data-id="' + escapeHtml(character.characterId) + '" data-name="' + escapeHtml(character.name) + '">Supprimer</button></div></div>';
        }).join('');
        if (!cards) cards = '<p class="mmo-muted">Aucun personnage sur ce serveur. Crée ton premier aventurier.</p>';
        var options = Mmo.classes.map(function(item) {
            return '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.label) + ' — ' + escapeHtml(item.description) + '</option>';
        }).join('');
        function appearanceOptions(count, label) {
            var entries = [];
            for (var optionIndex = 1; optionIndex <= count; optionIndex += 1) entries.push('<option value="' + optionIndex + '">' + label + ' ' + optionIndex + '</option>');
            return entries.join('');
        }
        Mmo.showLauncher('Étape 3 sur 3 · Création', 'Créez votre aventurier.', 'Configure son identité, sa classe et son apparence. Les portraits, le sprite de carte et le battler sont générés à partir des couches officielles RPG Maker MV.',
            '<h2>Nouveau personnage</h2><p>Compte : <strong>' + escapeHtml(Mmo.account ? Mmo.account.username : '') + '</strong></p>' +
            '<label for="mmo-character-name">Nom</label><input id="mmo-character-name" maxlength="24">' +
            '<label for="mmo-character-class">Classe</label><select id="mmo-character-class">' + options + '</select>' +
            '<div class="mmo-appearance-editor"><div><h3>Apparence Generator</h3><div class="mmo-appearance-fields">' +
                '<label>Profil<select id="mmo-appearance-gender"><option value="male">Homme</option><option value="female">Femme</option><option value="kid">Enfant</option></select></label>' +
                '<label>Couleur de peau<select id="mmo-appearance-skin-tone"><option value="porcelaine">Porcelaine</option><option value="clair">Clair</option><option value="miel">Miel</option><option value="brun">Brun</option><option value="fonce">Foncé</option></select></label>' +
                '<label>Base corporelle<select id="mmo-appearance-skin">' + appearanceOptions(4, 'Corps') + '</select></label>' +
            '</div><div id="mmo-generator-categories" class="mmo-generator-categories"><span>Chargement des catégories…</span></div><div id="mmo-generator-variants" class="mmo-generator-variants"><span>Préparation des variantes…</span></div></div><div id="mmo-appearance-preview" class="mmo-appearance-preview"><span>Chargement de la tête et du personnage…</span></div></div>' +
            '<button id="mmo-create-character">Créer le personnage</button><button class="ghost" id="mmo-back-characters">Retour aux personnages</button><div id="mmo-character-error" class="mmo-error"></div>',
            'full'
        );
        var errorField = document.getElementById('mmo-character-error');
        function showError(message) { if (errorField) errorField.textContent = message; }
        var buttons = document.querySelectorAll('.mmo-select-character');
        for (var index = 0; index < buttons.length; index++) {
            buttons[index].onclick = function() { Mmo.send('selectCharacter', { characterId: this.getAttribute('data-id') }); };
        }
        var deleteButtons = document.querySelectorAll('.mmo-delete-character');
        for (var deleteIndex = 0; deleteIndex < deleteButtons.length; deleteIndex++) {
            deleteButtons[deleteIndex].onclick = function() {
                var characterId = this.getAttribute('data-id');
                var characterName = this.getAttribute('data-name') || 'ce personnage';
                if (typeof window !== 'undefined' && window.confirm && !window.confirm('Supprimer définitivement « ' + characterName + ' » ? Cette action est irréversible.')) return;
                Mmo.send('deleteCharacter', { characterId: characterId });
            };
        }
        var creatorParts = { Body: 1, Face: 1, RearHair: 1, FrontHair: 1, Eyes: 1, Nose: 1, Mouth: 1, Clothing: 1 };
        var activeGeneratorCategory = 'Face';
        function selectedAppearance() {
            var body = Number(creatorParts.Body || document.getElementById('mmo-appearance-skin').value);
            return {
                gender: document.getElementById('mmo-appearance-gender').value,
                skin: body,
                hair: Number(creatorParts.FrontHair || creatorParts.RearHair || 1),
                eyes: Number(creatorParts.Eyes || 1),
                clothing: Number(creatorParts.Clothing || 1),
                skinTone: document.getElementById('mmo-appearance-skin-tone').value,
                parts: Object.assign({}, creatorParts)
            };
        }
        function refreshGeneratorCategories() {
            var categoryElement = document.getElementById('mmo-generator-categories');
            var variantElement = document.getElementById('mmo-generator-variants');
            if (typeof MMOAppearance === 'undefined' || MMOAppearance.manifestState !== 'ready') {
                if (categoryElement) categoryElement.textContent = 'Préparation des catégories Generator…';
                if (variantElement) variantElement.textContent = 'Préparation des variantes…';
                return;
            }
            var appearance = selectedAppearance();
            var categories = MMOAppearance.categoriesFor(appearance.gender);
            var genderSelect = document.getElementById('mmo-appearance-gender');
            for (var optionIndex = 0; optionIndex < genderSelect.options.length; optionIndex += 1) {
                var option = genderSelect.options[optionIndex];
                option.disabled = MMOAppearance.categoriesFor(option.value).length === 0;
            }
            if (!categories.length) {
                if (categoryElement) categoryElement.textContent = 'Aucun asset Generator installé pour ce profil.';
                if (variantElement) variantElement.textContent = '';
                return;
            }
            if (categories.indexOf(activeGeneratorCategory) === -1) activeGeneratorCategory = categories[0];
            categoryElement.innerHTML = '';
            categories.forEach(function(category) {
                var button = document.createElement('button');
                button.type = 'button';
                button.className = 'mmo-generator-category' + (category === activeGeneratorCategory ? ' selected' : '');
                button.textContent = MMOAppearance.categoryLabels[category] || category;
                button.onclick = function() { activeGeneratorCategory = category; refreshGeneratorCategories(); };
                categoryElement.appendChild(button);
            });
            MMOAppearance.renderCategoryOptions('mmo-generator-variants', appearance, activeGeneratorCategory, function(variant, button) {
                creatorParts[activeGeneratorCategory] = variant;
                var variants = document.querySelectorAll('#mmo-generator-variants .mmo-generator-variant');
                for (var variantIndex = 0; variantIndex < variants.length; variantIndex += 1) variants[variantIndex].classList.remove('selected');
                if (button && button.classList) button.classList.add('selected');
                // Keep the already-rendered thumbnails. Rebuilding every
                // candidate for a one-click change caused expensive animation
                // frames and made slow machines show blank panels temporarily.
                refreshAppearancePreview(true);
            });
        }
        function refreshAppearancePreview(keepVariantGrid) {
            if (typeof MMOAppearance === 'undefined' || typeof MMOAppearance.renderPreview !== 'function') {
                document.getElementById('mmo-appearance-preview').textContent = 'MMOAppearance.js doit être activé après MMOFoundation.';
                return;
            }
            if (MMOAppearance.manifestState === 'error') {
                MMOAppearance.renderPreview('mmo-appearance-preview', selectedAppearance());
                refreshGeneratorCategories();
                return;
            }
            if (MMOAppearance.manifestState !== 'ready') {
                MMOAppearance.renderPreview('mmo-appearance-preview', selectedAppearance());
                MMOAppearance.loadManifest(function() { refreshAppearancePreview(); });
                return;
            }
            MMOAppearance.renderPreview('mmo-appearance-preview', selectedAppearance());
            if (!keepVariantGrid) refreshGeneratorCategories();
        }
        document.getElementById('mmo-appearance-gender').onchange = refreshAppearancePreview;
        document.getElementById('mmo-appearance-skin-tone').onchange = refreshAppearancePreview;
        document.getElementById('mmo-appearance-skin').onchange = function() {
            creatorParts.Body = Number(this.value);
            refreshAppearancePreview();
        };
        document.getElementById('mmo-create-character').onclick = function() {
            var name = document.getElementById('mmo-character-name').value.trim();
            var classId = document.getElementById('mmo-character-class').value;
            if (!name) return showError('Choisis un nom de personnage.');
            if (typeof MMOAppearance === 'undefined') return showError('Le plugin MMOAppearance doit être activé.');
            if (MMOAppearance.manifestState !== 'ready') return showError('Prépare les assets Generator puis lance npm run generator:manifest avant de créer un personnage.');
            Mmo.send('createCharacter', { name: name, classId: classId, appearance: selectedAppearance() });
        };
        document.getElementById('mmo-back-characters').onclick = function() { Mmo.showCharacterSelection(); };
        Mmo.enableTextEditing(document.getElementById('mmo-character-name'));
        refreshAppearancePreview();
    };

    // Keep playable characters and the expensive Generator editor on separate
    // screens. A deletion now returns only to this light character list, so no
    // creator thumbnail/canvas work is running during the delete refresh.
    Mmo.showCharacterSelection = function() {
        var cards = Mmo.characters.map(function(character) {
            return '<div class="mmo-character"><div><strong>' + escapeHtml(character.name) + '</strong><small>' +
                escapeHtml(Mmo.classLabel(character.classId)) + ' · niveau ' + Number(character.level || 1) +
                '</small></div><div class="mmo-character-actions"><button class="mmo-select-character" data-id="' + escapeHtml(character.characterId) + '">Jouer</button><button class="ghost mmo-delete-character" data-id="' + escapeHtml(character.characterId) + '" data-name="' + escapeHtml(character.name) + '">Supprimer</button></div></div>';
        }).join('');
        if (!cards) cards = '<p class="mmo-muted">Aucun personnage sur ce serveur. Crée ton premier aventurier.</p>';
        Mmo.showLauncher('Étape 3 sur 3 · Personnages', 'Choisissez votre aventurier.', 'Sélectionne un personnage existant ou ouvre le créateur complet dans un écran séparé.',
            '<h2>Mes personnages</h2><p>Compte : <strong>' + escapeHtml(Mmo.account ? Mmo.account.username : '') + '</strong></p>' +
            '<div class="mmo-character-list">' + cards + '</div>' +
            '<button id="mmo-open-character-creation">Créer un personnage</button><button class="ghost" id="mmo-back-server">Retour</button><div id="mmo-character-error" class="mmo-error"></div>'
        );
        var selectButtons = document.querySelectorAll('.mmo-select-character');
        for (var index = 0; index < selectButtons.length; index += 1) {
            selectButtons[index].onclick = function() { Mmo.send('selectCharacter', { characterId: this.getAttribute('data-id') }); };
        }
        var deleteButtons = document.querySelectorAll('.mmo-delete-character');
        for (var deleteIndex = 0; deleteIndex < deleteButtons.length; deleteIndex += 1) {
            deleteButtons[deleteIndex].onclick = function() {
                var characterId = this.getAttribute('data-id');
                var characterName = this.getAttribute('data-name') || 'ce personnage';
                if (typeof window !== 'undefined' && window.confirm && !window.confirm('Supprimer définitivement « ' + characterName + ' » ? Cette action est irréversible.')) return;
                Mmo.send('deleteCharacter', { characterId: characterId });
            };
        }
        document.getElementById('mmo-open-character-creation').onclick = function() { Mmo.showCharacterCreation(); };
        document.getElementById('mmo-back-server').onclick = function() { Mmo.showServerSelection(); };
    };

    Mmo.classLabel = function(classId) {
        var found = Mmo.classes.filter(function(item) { return item.id === classId; })[0];
        var fallback = { warrior: 'Guerrier', mage: 'Mage', archer: 'Archer', priest: 'Prêtre' };
        return found ? found.label : (fallback[classId] || classId);
    };

    Mmo.classSprite = function(classId, appearance) {
        if (appearance && typeof MMOAppearance !== 'undefined' && typeof MMOAppearance.characterKey === 'function') {
            var generatedKey = MMOAppearance.characterKey(appearance);
            if (generatedKey) return { name: generatedKey, index: 0 };
        }
        return {
            name: Mmo.config.characterSheet,
            index: Mmo.config.spriteIndexes[classId] || 0
        };
    };

    Mmo.nativeActorForHud = function() {
        if (typeof $gameActors === 'undefined' || !$gameActors) return null;
        return $gameActors.actor(Mmo.nativeActorId());
    };

    Mmo.renderChatHistory = function() {
        var log = document.getElementById('mmo-chat-log');
        if (!log) return;
        log.innerHTML = '';
        Mmo.chatHistory.forEach(function(packet) {
            var row = document.createElement('div');
            row.className = 'mmo-chat-row';
            var scope = document.createElement('span');
            scope.className = 'mmo-chat-scope';
            scope.textContent = '[' + ({ global: 'Global', local: 'Local', group: 'Groupe', guild: 'Guilde' }[packet.scope] || packet.scope) + '] ';
            var body = document.createElement('span');
            body.textContent = (packet.from && packet.from.name ? packet.from.name : 'Système') + ' : ' + String(packet.text || '');
            row.appendChild(scope);
            row.appendChild(body);
            log.appendChild(row);
        });
        log.scrollTop = log.scrollHeight;
    };

    Mmo.updateChatBubble = function() {
        var bubble = document.getElementById('mmo-chat-bubble');
        if (!bubble) return;
        var packet = Mmo.chatHistory[Mmo.chatHistory.length - 1];
        if (!packet || Mmo.hudChatOpen) { bubble.innerHTML = ''; return; }
        var scope = ({ global: 'Global', local: 'Local', group: 'Groupe', guild: 'Guilde' }[packet.scope] || packet.scope);
        var name = packet.from && packet.from.name ? packet.from.name : 'Système';
        bubble.innerHTML = '<strong>[' + escapeHtml(scope) + '] ' + escapeHtml(name) + '</strong> · ' + escapeHtml(String(packet.text || ''));
    };

    Mmo.toggleChat = function(forceOpen) {
        var dock = document.getElementById('mmo-chat-dock');
        if (!dock) return;
        Mmo.hudChatOpen = forceOpen === undefined ? !Mmo.hudChatOpen : !!forceOpen;
        dock.hidden = !Mmo.hudChatOpen;
        Mmo.updateChatBubble();
        if (Mmo.hudChatOpen) {
            Mmo.renderChatHistory();
            var input = document.getElementById('mmo-chat-input');
            if (input) setTimeout(function() { input.focus(); }, 0);
        }
    };

    Mmo.showHud = function() {
        if (!Mmo.activeCharacter) return;
        Mmo.ensureDom();
        var hud = document.getElementById('mmo-foundation-hud');
        if (!hud || hud.innerHTML) {
            Mmo.refreshHud();
            return;
        }
        hud.innerHTML =
            '<section class="mmo-hud-card mmo-hud-status">' +
                '<div id="mmo-hud-portrait" class="mmo-hud-portrait"></div><div class="mmo-hud-main">' +
                '<div id="mmo-hud-player" class="mmo-hud-name"></div><div id="mmo-hud-meta" class="mmo-hud-meta"></div>' +
                '<div class="mmo-hud-bar mmo-hud-hp"><i id="mmo-hud-hp-fill"></i><b id="mmo-hud-hp-text"></b></div>' +
                '<div class="mmo-hud-bar mmo-hud-mp"><i id="mmo-hud-mp-fill"></i><b id="mmo-hud-mp-text"></b></div>' +
                '</div></section>' +
            '<section id="mmo-hud-quest" class="mmo-hud-card mmo-hud-sub mmo-hud-quest"></section>' +
            '<section id="mmo-hud-group" class="mmo-hud-card mmo-hud-sub mmo-hud-group"></section>' +
            '<div id="mmo-chat-launcher"><div id="mmo-chat-bubble" class="mmo-chat-bubble" aria-live="polite"></div>' +
                '<div id="mmo-chat-dock" class="mmo-chat-dock" hidden><div id="mmo-chat-dock-head"><span>Discussion</span><button id="mmo-chat-close" type="button" title="Réduire le chat">×</button></div>' +
                '<div id="mmo-chat-log"></div><div id="mmo-chat-controls"><select id="mmo-chat-scope"><option value="global">Global</option><option value="local">Local</option><option value="group">Groupe</option><option value="guild">Guilde</option></select><input id="mmo-chat-input" maxlength="200" placeholder="Écrire un message…"></div></div>' +
                '<button id="mmo-chat-toggle" class="mmo-chat-button" type="button" title="Ouvrir le chat — raccourci T">💬 Chat <small>T</small></button></div>';
        var input = document.getElementById('mmo-chat-input');
        input.onkeydown = function(event) {
            if (event.keyCode !== 13) return;
            var text = input.value.trim();
            if (!text) return;
            if (text.charAt(0) === '/') Mmo.runHudCommand(text);
            else Mmo.send('chat', { scope: document.getElementById('mmo-chat-scope').value, text: text });
            input.value = '';
            event.preventDefault();
        };
        document.getElementById('mmo-chat-toggle').onclick = function() { Mmo.toggleChat(); };
        document.getElementById('mmo-chat-close').onclick = function() { Mmo.toggleChat(false); };
        Mmo.enableTextEditing(input);
        Mmo.enableWheelScrolling(hud);
        Mmo.protectHudInteraction(hud);
        Mmo.renderChatHistory();
        Mmo.refreshHud();
    };

    Mmo.hideHud = function() {
        Mmo.ensureDom();
        Mmo.hudChatOpen = false;
        var hud = document.getElementById('mmo-foundation-hud');
        if (hud) hud.innerHTML = '';
    };

    Mmo.focusChat = function() {
        Mmo.showHud();
        Mmo.toggleChat(true);
    };

    Mmo.refreshHud = function() {
        if (!Mmo.activeCharacter) return;
        var actor = Mmo.nativeActorForHud();
        var player = document.getElementById('mmo-hud-player');
        var meta = document.getElementById('mmo-hud-meta');
        var portrait = document.getElementById('mmo-hud-portrait');
        var hp = Math.max(0, Number(actor ? actor.hp : 0));
        var mhp = Math.max(1, Number(actor ? actor.mhp : 1));
        var mp = Math.max(0, Number(actor ? actor.mp : 0));
        var mmp = Math.max(1, Number(actor ? actor.mmp : 1));
        var hpFill = document.getElementById('mmo-hud-hp-fill');
        var mpFill = document.getElementById('mmo-hud-mp-fill');
        var hpText = document.getElementById('mmo-hud-hp-text');
        var mpText = document.getElementById('mmo-hud-mp-text');
        if (player) player.textContent = Mmo.activeCharacter.name;
        if (meta) meta.textContent = Mmo.classLabel(Mmo.activeCharacter.classId) + ' · niv. ' + Number(Mmo.activeCharacter.level || (actor && actor.level) || 1) + ' · ' + Object.keys(Mmo.remotePlayers).length + ' proche(s)';
        if (hpFill) hpFill.style.width = Math.max(0, Math.min(100, hp * 100 / mhp)) + '%';
        if (mpFill) mpFill.style.width = Math.max(0, Math.min(100, mp * 100 / mmp)) + '%';
        if (hpText) hpText.textContent = 'PV ' + hp + '/' + mhp;
        if (mpText) mpText.textContent = 'PM ' + mp + '/' + mmp;
        if (portrait && actor) {
            var faceName = actor._mmoGeneratedFaceKey || (typeof actor.faceName === 'function' ? actor.faceName() : '');
            var faceIndex = actor._mmoGeneratedFaceKey ? Number(actor._mmoGeneratedFaceIndex || 0) : (typeof actor.faceIndex === 'function' ? Number(actor.faceIndex()) : 0);
            var generatedFace = faceName && faceName.indexOf('MMOFace_') === 0;
            var renderedGeneratorFace = generatedFace && typeof MMOAppearance !== 'undefined' && typeof MMOAppearance.renderFaceElement === 'function' &&
                MMOAppearance.renderFaceElement(portrait, faceName, faceIndex, 48, 48);
            if (generatedFace && !renderedGeneratorFace) {
                // Never route generated keys through CSS: they are runtime
                // Bitmaps, not files in img/faces/.
                portrait.innerHTML = '';
                portrait._mmoFaceCanvas = null;
                portrait.style.backgroundImage = 'none';
                portrait.style.backgroundPosition = '0 0';
            } else if (!generatedFace && faceName) {
                // A legacy character may be selected after a generated one.
                // Remove its canvas before restoring an ordinary faceset URL.
                if (portrait._mmoFaceCanvas) {
                    portrait.innerHTML = '';
                    portrait._mmoFaceCanvas = null;
                }
                portrait.style.backgroundImage = 'url("img/faces/' + encodeURIComponent(faceName) + '.png")';
                portrait.style.backgroundPosition = (-48 * (faceIndex % 4)) + 'px ' + (-48 * Math.floor(faceIndex / 4)) + 'px';
            }
        }
        var questPanel = document.getElementById('mmo-hud-quest');
        var active = Mmo.quests.filter(function(quest) { return quest.status === 'active' || quest.status === 'ready'; });
        if (questPanel) {
            questPanel.style.display = active.length ? 'block' : 'none';
            questPanel.innerHTML = active.slice(0, 2).map(function(quest) {
                var ready = quest.status === 'ready';
                return '<div class="mmo-hud-sub-row"><span><span class="mmo-panel-title">' + (ready ? 'À rendre' : 'Quête') + '</span> ' + escapeHtml(quest.title || quest.questId) + '</span><strong>' + (ready ? '?' : (Number(quest.progress) + '/' + Number(quest.goal))) + '</strong></div>';
            }).join('');
        }
        var groupPanel = document.getElementById('mmo-hud-group');
        var members = Mmo.group && Mmo.group.members ? Mmo.group.members : [];
        if (groupPanel) {
            groupPanel.style.display = members.length ? 'block' : 'none';
            groupPanel.innerHTML = members.length ? '<div class="mmo-panel-title">Groupe · ' + members.length + '</div><div class="mmo-hud-sub-row">' + members.map(function(member) { return escapeHtml(member.name); }).join(' · ') + '</div>' : '';
        }
        Mmo.updateChatBubble();
    };

    // Convenience commands available from the chat box:
    // /invite Name, /leave, /dungeon dungeon_id, /exit and /help.
    // Quest acceptance and progress are intentionally server-gated through
    // marked native events and authoritative loot, never chat commands.
    Mmo.runHudCommand = function(text) {
        var tokens = text.slice(1).split(/\s+/);
        var command = String(tokens.shift() || '').toLowerCase();
        switch (command) {
        case 'invite':
            Mmo.send('groupInvite', { targetName: tokens.join(' ') });
            break;
        case 'leave':
            Mmo.send('groupLeave');
            break;
        case 'quest':
        case 'progress':
            Mmo.toast('Les quêtes progressent via un donneur de quête et le butin validé par le serveur.', true);
            break;
        case 'dungeon':
            Mmo.send('dungeonEnter', { dungeonId: tokens[0] });
            break;
        case 'exit':
            Mmo.send('dungeonExit');
            break;
        case 'help':
            Mmo.toast('/invite Nom · /leave · /dungeon id · /exit');
            break;
        default:
            Mmo.toast('Commande inconnue. Utilise /help.', true);
            break;
        }
    };

    Mmo.appendChat = function(packet) {
        Mmo.chatHistory.push({
            scope: packet.scope || 'global',
            from: packet.from || { name: 'Système' },
            text: String(packet.text || '')
        });
        while (Mmo.chatHistory.length > 80) Mmo.chatHistory.shift();
        if (typeof MMOBattle !== 'undefined' && MMOBattle.active) return;
        Mmo.showHud();
        Mmo.renderChatHistory();
        Mmo.updateChatBubble();
    };

    Mmo.nativeActorId = function() {
        var mappedId = Mmo.activeCharacter && Mmo.activeCharacter.mv ? Number(Mmo.activeCharacter.mv.actorId) : 0;
        return mappedId > 0 ? mappedId : 1;
    };

    Mmo.syncNativePartyMembers = function() {
        if (!Mmo.activeCharacter || typeof $gameParty === 'undefined' || !$gameParty) return;
        var selectedActorId = Mmo.nativeActorId();
        // DataManager.setupNewGame loads every actor listed in System.json.
        // An MMO character must be represented by its one mapped MV actor only;
        // teammates in a shared battle are transient network actors in MMOBattle.
        var members = ($gameParty._actors || []).slice();
        members.forEach(function(actorId) {
            if (Number(actorId) !== selectedActorId) $gameParty.removeActor(actorId);
        });
        if (($gameParty._actors || []).indexOf(selectedActorId) === -1) $gameParty.addActor(selectedActorId);
        if (typeof $gamePlayer !== 'undefined' && $gamePlayer && typeof $gamePlayer.refresh === 'function') $gamePlayer.refresh();
    };

    Mmo.applyCharacterToGame = function() {
        if (!Mmo.activeCharacter || typeof $gameActors === 'undefined' || !$gameActors) return;
        var actor = $gameActors.actor(Mmo.nativeActorId());
        if (!actor) return;
        actor.setName(Mmo.activeCharacter.name);
        var classId = Mmo.activeCharacter.mv && Mmo.activeCharacter.mv.classId ? Mmo.activeCharacter.mv.classId : Mmo.config.actorClassIds[Mmo.activeCharacter.classId];
        if (classId && typeof $dataClasses !== 'undefined' && $dataClasses && $dataClasses[classId]) {
            actor.changeClass(classId, false);
        }
        if (Mmo.activeCharacter.appearance && typeof MMOAppearance !== 'undefined' && typeof MMOAppearance.applyToActor === 'function') {
            MMOAppearance.applyToActor(actor, Mmo.activeCharacter.appearance);
        }
        Mmo.syncNativePartyMembers();
    };

    Mmo.startWorld = function(data) {
        var target = {
            mapId: Number(data.mapId), x: Number(data.x), y: Number(data.y), direction: Number(data.direction || 2),
            instanceId: data.instanceId || null
        };
        function transfer() {
            Mmo.applyCharacterToGame();
            Mmo.transferTo(target);
            Mmo.showHud();
        }

        // A select packet and the following enterWorld packet can arrive in the same
        // render frame. Keep the latest target, then let Scene_Title.update perform
        // the standard MV new-game transition on the next frame.
        if (Mmo._worldStartPending) {
            Mmo.deferredTransfer = target;
            return;
        }
        if (typeof $gamePlayer === 'undefined' || !$gamePlayer || (typeof Scene_Title !== 'undefined' && SceneManager._scene instanceof Scene_Title)) {
            Mmo.deferredTransfer = target;
            Mmo._worldStartPending = true;
            return;
        }
        transfer();
    };

    Mmo.transferTo = function(data) {
        if (typeof $gamePlayer === 'undefined' || !$gamePlayer) {
            Mmo.deferredTransfer = data;
            return;
        }
        Mmo.transferContext = data.instanceId || null;
        $gamePlayer.reserveTransfer(Number(data.mapId), Number(data.x), Number(data.y), Number(data.direction || 2), 0);
    };

    Mmo.onLocalTransfer = function(mapId, x, y, direction) {
        if (!Mmo.activeCharacter) return;
        if (Mmo.transferContext !== undefined) {
            Mmo.instanceId = Mmo.transferContext;
            Mmo.transferContext = undefined;
        }
        Mmo.clearRemoteSprites();
        Mmo.send('transfer', {
            mapId: Number(mapId), x: Number(x), y: Number(y), direction: Number(direction), instanceId: Mmo.instanceId
        });
        setTimeout(function() { Mmo.syncRemoteSprites(); }, 100);
    };

    Mmo.sendMove = function(x, y, direction, moveSpeed) {
        if (!Mmo.activeCharacter) return;
        Mmo.send('move', {
            x: Number(x), y: Number(y), direction: Number(direction),
            moveSpeed: Math.max(1, Math.min(6, Number(moveSpeed || 4)))
        });
    };

    Mmo.RemoteCharacter = function(data) {
        this.initialize(data);
    };
    Mmo.RemoteCharacter.prototype = Object.create(Game_Character.prototype);
    Mmo.RemoteCharacter.prototype.constructor = Mmo.RemoteCharacter;
    Mmo.RemoteCharacter.prototype.initialize = function(data) {
        Game_Character.prototype.initialize.call(this);
        this._mmoNetworkReady = false;
        this._mmoTargetX = 0;
        this._mmoTargetY = 0;
        this._mmoTargetDirection = 2;
        this._mmoTargetMoveSpeed = 4;
        this.applyNetworkState(data);
    };
    Mmo.RemoteCharacter.prototype.applyNetworkState = function(data) {
        var sprite = Mmo.classSprite(data.classId, data.appearance);
        this.setImage(sprite.name, sprite.index);
        this._mmoTargetX = Number(data.x);
        this._mmoTargetY = Number(data.y);
        this._mmoTargetDirection = Number(data.direction || 2);
        this._mmoTargetMoveSpeed = Math.max(1, Math.min(6, Number(data.moveSpeed || 4)));
        this.setMoveSpeed(this._mmoTargetMoveSpeed);
        if (!this._mmoNetworkReady) {
            this._mmoNetworkReady = true;
            this.setPosition(this._mmoTargetX, this._mmoTargetY);
            this.setDirection(this._mmoTargetDirection);
            return;
        }
        // A teleport, map reload or long packet gap should snap instead of
        // making a remote player walk across half the map to catch up.
        if (Math.abs(this._x - this._mmoTargetX) + Math.abs(this._y - this._mmoTargetY) > 6) {
            this.setPosition(this._mmoTargetX, this._mmoTargetY);
            this.setDirection(this._mmoTargetDirection);
        }
    };
    Mmo.RemoteCharacter.prototype.update = function() {
        Game_Character.prototype.update.call(this);
        if (!this._mmoNetworkReady || this.isMoving()) return;
        var deltaX = this._mmoTargetX - this._x;
        var deltaY = this._mmoTargetY - this._y;
        if (deltaX === 0 && deltaY === 0) {
            this.setDirection(this._mmoTargetDirection);
            return;
        }
        // Server movement is tile based. Reproduce each queued tile with
        // Game_Character's native interpolation, footstep pattern and facing
        // rather than snapping visible sprites to every WebSocket packet.
        var direction;
        if (Math.abs(deltaX) >= Math.abs(deltaY)) direction = deltaX > 0 ? 6 : 4;
        else direction = deltaY > 0 ? 2 : 8;
        this.moveStraight(direction);
        // A remote sprite does not own collision authority. If an unusual map
        // rule rejects the visual step, converge safely on the server position.
        if (!this.isMoving() && (this._x !== this._mmoTargetX || this._y !== this._mmoTargetY)) {
            this.setPosition(this._mmoTargetX, this._mmoTargetY);
            this.setDirection(this._mmoTargetDirection);
        }
    };

    Mmo.isVisibleRemote = function(player) {
        if (!Mmo.activeCharacter || typeof $gameMap === 'undefined' || !$gameMap) return false;
        return Number(player.mapId) === Number($gameMap.mapId()) && sameInstance(player.instanceId, Mmo.instanceId);
    };

    Mmo.addOrUpdateRemoteSprite = function(player) {
        var id = String(player.characterId);
        if (!Mmo.isVisibleRemote(player)) return Mmo.removeRemoteSprite(id);
        var entry = Mmo.remoteSprites[id];
        if (entry) {
            entry.character.applyNetworkState(player);
            return;
        }
        if (!currentSceneIsMap()) return;
        var scene = SceneManager._scene;
        var tilemap = scene && scene._spriteset && scene._spriteset._tilemap;
        if (!tilemap) return;
        var character = new Mmo.RemoteCharacter(player);
        var sprite = new Sprite_Character(character);
        tilemap.addChild(sprite);
        Mmo.remoteSprites[id] = { character: character, sprite: sprite };
    };

    Mmo.removeRemoteSprite = function(characterId) {
        var id = String(characterId);
        var entry = Mmo.remoteSprites[id];
        if (!entry) return;
        if (entry.sprite && entry.sprite.parent) entry.sprite.parent.removeChild(entry.sprite);
        delete Mmo.remoteSprites[id];
    };

    Mmo.clearRemoteSprites = function() {
        Object.keys(Mmo.remoteSprites).forEach(function(id) { Mmo.removeRemoteSprite(id); });
    };

    Mmo.syncRemoteSprites = function() {
        if (!Mmo.activeCharacter || !currentSceneIsMap()) return;
        Object.keys(Mmo.remotePlayers).forEach(function(id) { Mmo.addOrUpdateRemoteSprite(Mmo.remotePlayers[id]); });
        Object.keys(Mmo.remoteSprites).forEach(function(id) {
            if (!Mmo.remotePlayers[id] || !Mmo.isVisibleRemote(Mmo.remotePlayers[id])) Mmo.removeRemoteSprite(id);
        });
        Mmo.refreshHud();
    };
    Mmo.updateRemoteCharacters = function() {
        if (!currentSceneIsMap()) return;
        Object.keys(Mmo.remoteSprites).forEach(function(id) {
            var entry = Mmo.remoteSprites[id];
            if (entry && entry.character && typeof entry.character.update === 'function') entry.character.update();
        });
    };

    Mmo.receive = function(raw) {
        var packet;
        try { packet = JSON.parse(raw); } catch (_) { return; }
        var extensionHandlers = Mmo.packetHandlers[packet.type];
        if (extensionHandlers && extensionHandlers.length) {
            extensionHandlers.slice().forEach(function(handler) {
                try { handler(packet); } catch (error) { console.error('[MMO packet ' + packet.type + ']', error); }
            });
        }
        // Extension handlers augment core packets as well. In particular a
        // worldMonsterState module may observe worldSnapshot without preventing
        // the Foundation from also rebuilding remote-player sprites.
        switch (packet.type) {
        case 'hello':
            return;
        case 'error':
            var battleOwnsError = typeof MMOBattle !== 'undefined' && MMOBattle.active && typeof MMOBattle.showNativeNotice === 'function';
            if (battleOwnsError) MMOBattle.showNativeNotice(SceneManager._scene, packet.message || 'Erreur serveur.');
            else Mmo.toast(packet.message || 'Erreur serveur.', true);
            var errorField = document.getElementById('mmo-login-error') || document.getElementById('mmo-register-error') || document.getElementById('mmo-character-error') || document.getElementById('mmo-server-error');
            if (errorField) errorField.textContent = packet.message || 'Erreur serveur.';
            // Optional modules can recover their native UI immediately after a
            // rejected action instead of waiting for a generic timeout.
            if (typeof MMOBattle !== 'undefined' && typeof MMOBattle.onServerError === 'function') MMOBattle.onServerError(packet);
            Mmo.errorHandlers.slice().forEach(function(handler) {
                try { handler(packet); } catch (error) { console.error('[MMO error handler]', error); }
            });
            return;
        case 'registered':
            Mmo.openLogin(packet.message || 'Compte créé. Connecte-toi pour continuer.', Mmo._accountDraftUsername);
            return;
        case 'notification':
            Mmo.toast(packet.message || 'Notification.');
            return;
        case 'loginSuccess':
            Mmo.account = packet.account;
            Mmo.classes = packet.classes || [];
            Mmo.characters = packet.characters || [];
            Mmo.showServerSelection();
            return;
        case 'characterCreated':
            Mmo.characters.push(packet.character);
            Mmo.toast('Personnage créé.');
            Mmo.showCharacterSelection();
            return;
        case 'characterDeleted':
            Mmo.characters = Mmo.characters.filter(function(character) { return String(character.characterId) !== String(packet.characterId); });
            Mmo.toast('Personnage « ' + (packet.name || '') + ' » supprimé.');
            Mmo.showCharacterSelection();
            return;
        case 'characterSelected':
            Mmo.activeCharacter = packet.character;
            Mmo.closeModal();
            // characterSelected already contains the saved map and coordinates.
            // Starting here makes the title transition resilient even if a later
            // auxiliary packet is delayed.
            Mmo.startWorld(packet.character);
            return;
        case 'enterWorld':
            // This is the authoritative spawn confirmation. It replaces the target
            // recorded by characterSelected if the server changed it.
            Mmo.startWorld(packet);
            return;
        case 'worldSnapshot':
            Mmo.remotePlayers = {};
            (packet.players || []).forEach(function(player) { Mmo.remotePlayers[String(player.characterId)] = player; });
            Mmo.syncRemoteSprites();
            return;
        case 'playerJoined':
            if (packet.player) Mmo.remotePlayers[String(packet.player.characterId)] = packet.player;
            Mmo.syncRemoteSprites();
            return;
        case 'playerLeft':
            delete Mmo.remotePlayers[String(packet.characterId)];
            Mmo.removeRemoteSprite(packet.characterId);
            Mmo.refreshHud();
            return;
        case 'playerMoved':
            var remote = Mmo.remotePlayers[String(packet.characterId)];
            if (remote) {
                remote.x = packet.x;
                remote.y = packet.y;
                remote.direction = packet.direction;
                remote.moveSpeed = packet.moveSpeed || remote.moveSpeed || 4;
                Mmo.addOrUpdateRemoteSprite(remote);
            }
            return;
        case 'chat':
            Mmo.appendChat(packet);
            return;
        case 'groupInvite':
            if (window.confirm((packet.from ? packet.from.name : 'Un joueur') + ' t’invite dans son groupe. Accepter ?')) {
                Mmo.send('groupResponse', { groupId: packet.groupId, accepted: true });
            } else {
                Mmo.send('groupResponse', { groupId: packet.groupId, accepted: false });
            }
            return;
        case 'groupUpdate':
            Mmo.group = packet.group;
            Mmo.refreshHud();
            return;
        case 'questSnapshot':
            Mmo.quests = packet.quests || [];
            Mmo.refreshHud();
            return;
        case 'enterInstance':
            Mmo.toast('Entrée : ' + (packet.title || 'donjon'));
            Mmo.transferTo(packet);
            return;
        case 'exitInstance':
            Mmo.toast('Sortie du donjon.');
            Mmo.transferTo({ mapId: packet.mapId, x: packet.x, y: packet.y, direction: packet.direction, instanceId: null });
            return;
        default:
            return;
        }
    };

    // Title-screen account flow. Set AutoOpenLogin to false if your project opens
    // the account UI from a custom title scene/event with MMO OPEN_LOGIN.
    var _Scene_Title_start = Scene_Title.prototype.start;
    Scene_Title.prototype.start = function() {
        _Scene_Title_start.call(this);
        if (Mmo.config.autoOpenLogin && !Mmo.activeCharacter && !Mmo._titleLoginShown) {
            // Keep MV's title scene only as a safe bootstrap scene. Its native
            // New Game / Continue command window is hidden and deactivated before
            // the full-screen launcher is drawn, so it can never be used behind
            // the account flow.
            Mmo.lockNativeTitleMenu();
            Mmo._titleLoginShown = true;
            setTimeout(function() { Mmo.openLogin(); }, 10);
        }
    };

    var _Scene_Title_update = Scene_Title.prototype.update;
    Scene_Title.prototype.update = function() {
        if (Mmo.launcherActive) Mmo.lockNativeTitleMenu();
        _Scene_Title_update.call(this);
        if (!Mmo._worldStartPending) return;
        Mmo._worldStartPending = false;
        // Same transition used by the native "New Game" command in RPG Maker MV.
        DataManager.setupNewGame();
        SceneManager.goto(Scene_Map);
    };

    var _Scene_Map_start = Scene_Map.prototype.start;
    Scene_Map.prototype.start = function() {
        _Scene_Map_start.call(this);
        if (Mmo.deferredTransfer) {
            var target = Mmo.deferredTransfer;
            Mmo.deferredTransfer = null;
            setTimeout(function() {
                Mmo.applyCharacterToGame();
                Mmo.transferTo(target);
                Mmo.showHud();
            }, 10);
        } else {
            setTimeout(function() { Mmo.syncRemoteSprites(); }, 10);
        }
    };

    var _Scene_Map_terminate = Scene_Map.prototype.terminate;
    Scene_Map.prototype.terminate = function() {
        Mmo.clearRemoteSprites();
        _Scene_Map_terminate.call(this);
    };

    var _Scene_Map_update = Scene_Map.prototype.update;
    Scene_Map.prototype.update = function() {
        _Scene_Map_update.call(this);
        Mmo.updateRemoteCharacters();
        if (Mmo.activeCharacter && Input.isTriggered('mmoChat')) Mmo.focusChat();
    };

    Input.keyMapper[84] = 'mmoChat'; // T

    var _Game_Player_moveStraight = Game_Player.prototype.moveStraight;
    Game_Player.prototype.moveStraight = function(direction) {
        _Game_Player_moveStraight.call(this, direction);
        if (this.isMovementSucceeded()) Mmo.sendMove(this.x, this.y, this.direction(), this.realMoveSpeed());
    };

    var _Game_Player_performTransfer = Game_Player.prototype.performTransfer;
    Game_Player.prototype.performTransfer = function() {
        var wasTransferring = this.isTransferring();
        _Game_Player_performTransfer.call(this);
        if (wasTransferring && typeof $gameMap !== 'undefined' && $gameMap) {
            Mmo.onLocalTransfer($gameMap.mapId(), this.x, this.y, this.direction());
        }
    };

    var _Game_Interpreter_pluginCommand = Game_Interpreter.prototype.pluginCommand;
    Game_Interpreter.prototype.pluginCommand = function(command, args) {
        _Game_Interpreter_pluginCommand.call(this, command, args);
        if (String(command).toUpperCase() !== 'MMO') return;
        var action = String(args[0] || '').toUpperCase();
        var rest = args.slice(1);
        switch (action) {
        case 'OPEN_LOGIN': Mmo.openLogin(); break;
        case 'CONNECT': Mmo.connect(rest[0] || Mmo.config.serverUrl); break;
        case 'REGISTER': Mmo.connect(Mmo.config.serverUrl, function() { Mmo.send('register', { username: rest[0], password: rest[1] }); }); break;
        case 'LOGIN': Mmo.connect(Mmo.config.serverUrl, function() { Mmo.send('login', { username: rest[0], password: rest[1] }); }); break;
        case 'SELECT': Mmo.send('selectCharacter', { characterId: rest[0] }); break;
        case 'CREATE': Mmo.send('createCharacter', { name: rest[0], classId: rest[1] }); break;
        case 'CHAT': Mmo.send('chat', { scope: rest[0] || 'global', text: rest.slice(1).join(' ') }); break;
        case 'GROUP_INVITE': Mmo.send('groupInvite', { targetName: rest.join(' ') }); break;
        case 'GROUP_ACCEPT': Mmo.send('groupResponse', { groupId: rest[0], accepted: true }); break;
        case 'GROUP_DECLINE': Mmo.send('groupResponse', { groupId: rest[0], accepted: false }); break;
        case 'GROUP_LEAVE': Mmo.send('groupLeave'); break;
        case 'QUEST_START':
        case 'QUEST_PROGRESS': Mmo.toast('Utilise une branche de donneur de quêtes marquée MMO NPC_ACTION.', true); break;
        case 'ENTER_DUNGEON': Mmo.send('dungeonEnter', { dungeonId: rest[0] }); break;
        case 'EXIT_DUNGEON': Mmo.send('dungeonExit'); break;
        case 'SHOW_HUD': Mmo.showHud(); break;
        case 'HIDE_HUD': Mmo.hideHud(); break;
        default: Mmo.toast('Commande MMO inconnue : ' + action, true); break;
        }
    };

})(MMOFoundation);
