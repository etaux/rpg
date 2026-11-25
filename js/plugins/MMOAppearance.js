/*:
 * @plugindesc v0.19.0 Menu-safe runtime Generator faces.
 * @author Arena MMO starter
 *
 * @param GeneratorRoot
 * @text Generator asset root
 * @type string
 * @default img/generator/
 * @desc Folder containing Face/Male, Face/Female, TV/Male, TV/Female, SV/Male, SV/Female and mmo-generator-manifest.json.
 *
 * @help
 * MMOAppearance requires MMOFoundation above it.
 *
 * Copy the original RPG Maker MV Generator folder to the configured root, then
 * run: npm run generator:manifest in the MMO server folder. This creates an
 * exact manifest of the layer filenames present in THIS project, avoiding
 * guessed filenames and missing-resource spam.
 *
 * Load order:
 *   MMOFoundation
 *   MMOAppearance
 *   MMOBattle
 *   MMOInventory
 *   MMOGuild
 *   MMOHousing
 *   MMOEvents
 */

var Imported = Imported || {};
Imported.MMOAppearance = true;
var MMOAppearance = MMOAppearance || {};

(function(Appearance, Mmo) {
    'use strict';

    if (!Mmo) {
        console.error('MMOAppearance requires MMOFoundation, loaded above it.');
        return;
    }

    var parameters = PluginManager.parameters('MMOAppearance');
    Appearance.generatorRoot = String(parameters.GeneratorRoot || 'img/generator/').replace(/\\/g, '/');
    if (Appearance.generatorRoot.charAt(Appearance.generatorRoot.length - 1) !== '/') Appearance.generatorRoot += '/';
    Appearance._definitions = {};
    Appearance._bitmaps = { character: {}, face: {}, sv: {} };
    Appearance._pending = {};
    Appearance.resetCreatorCache = function() {
        // The selection scene is recreated after a character is deleted. Drop
        // unfinished/stale creator composites before the new DOM receives its
        // canvases; actor definitions remain intact for normal map rendering.
        Appearance._bitmaps = { character: {}, face: {}, sv: {} };
        Appearance._pending = {};
    };
    Appearance.manifest = null;
    Appearance.manifestState = 'idle';
    Appearance.manifestCallbacks = [];

    Appearance.skinTones = [
        { id: 'porcelaine', label: 'Porcelaine', color: '#f9c19d' },
        { id: 'clair', label: 'Clair', color: '#efb28c' },
        { id: 'miel', label: 'Miel', color: '#d88f63' },
        { id: 'brun', label: 'Brun', color: '#a86043' },
        { id: 'fonce', label: 'Foncé', color: '#70402f' }
    ];
    Appearance.defaultAppearance = function() {
        return { gender: 'male', skin: 1, hair: 1, eyes: 1, clothing: 1, skinTone: 'porcelaine', parts: { Body: 1, Face: 1, RearHair: 1, FrontHair: 1, Eyes: 1, Nose: 1, Mouth: 1, Clothing: 1 } };
    };
    Appearance.normalize = function(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        var gender = String(value.gender || '').toLowerCase();
        function part(name, max) {
            var number = Number(value[name]);
            return Math.floor(number) === number && number >= 1 && number <= max ? number : null;
        }
        var skin = part('skin', 99) || 1;
        var hair = part('hair', 99) || 1;
        var eyes = part('eyes', 99) || 1;
        var clothing = part('clothing', 99) || 1;
        var tone = String(value.skinTone || 'porcelaine').toLowerCase();
        if (!Appearance.skinTones.some(function(item) { return item.id === tone; })) tone = 'porcelaine';
        if (['male', 'female', 'kid'].indexOf(gender) === -1) return null;
        var parts = { Body: skin, Face: 1, RearHair: hair, FrontHair: hair, Eyes: eyes, Nose: 1, Mouth: 1, Clothing: clothing };
        if (value.parts && typeof value.parts === 'object' && !Array.isArray(value.parts)) {
            Object.keys(value.parts).slice(0, 32).forEach(function(name) {
                var number = Number(value.parts[name]);
                if (/^[A-Za-z][A-Za-z0-9]{0,24}$/.test(name) && Math.floor(number) === number && number >= 1 && number <= 99) parts[name] = number;
            });
        }
        return { gender: gender, skin: skin, hair: hair, eyes: eyes, clothing: clothing, skinTone: tone, parts: parts };
    };
    Appearance.pad = function(value) { return ('0' + Number(value)).slice(-2); };
    Appearance.recipeHash = function(appearance) {
        var text = Object.keys(appearance.parts).sort().map(function(name) { return name + ':' + appearance.parts[name]; }).join('|') + '|' + appearance.skinTone;
        var hash = 2166136261;
        for (var index = 0; index < text.length; index += 1) {
            // Math.imul keeps the 32-bit FNV hash deterministic. Ordinary
            // JavaScript multiplication loses integer precision for longer
            // recipes and can make distinct creator previews share a cache key.
            hash = Math.imul ? Math.imul(hash ^ text.charCodeAt(index), 16777619) : ((hash ^ text.charCodeAt(index)) * 16777619) | 0;
        }
        return (hash >>> 0).toString(36);
    };
    Appearance.signature = function(value) {
        var appearance = Appearance.normalize(value);
        return appearance ? [appearance.gender, Appearance.pad(appearance.skin), Appearance.pad(appearance.hair), Appearance.pad(appearance.eyes), Appearance.pad(appearance.clothing), 't' + appearance.skinTone, 'p' + Appearance.recipeHash(appearance)].join('_') : null;
    };
    Appearance.key = function(kind, value) {
        Appearance.installImageHooks && Appearance.installImageHooks();
        var signature = Appearance.signature(value);
        if (!signature) return null;
        var prefix = { character: '$MMOChar_', face: 'MMOFace_', sv: 'MMOSV_' }[kind];
        if (!prefix) return null;
        var key = prefix + signature;
        Appearance._definitions[key] = Appearance.normalize(value);
        return key;
    };
    Appearance.characterKey = function(value) { return Appearance.key('character', value); };
    Appearance.faceKey = function(value) { return Appearance.key('face', value); };
    Appearance.svKey = function(value) { return Appearance.key('sv', value); };
    Appearance.appearanceForKey = function(kind, value) {
        var filename = String(value || '');
        if (Appearance._definitions[filename]) return Appearance._definitions[filename];
        var prefix = { character: '$MMOChar_', face: 'MMOFace_', sv: 'MMOSV_' }[kind];
        if (!prefix || filename.indexOf(prefix) !== 0) return null;
        // Generated names encode the validated recipe, so native MV renderers
        // can recover it even if their first bitmap request occurs before an
        // earlier scene registered the key in _definitions.
        var bits = filename.slice(prefix.length).split('_');
        if (bits.length < 5) return null;
        var tone = bits[5] && bits[5].charAt(0) === 't' ? bits[5].slice(1) : 'porcelaine';
        var appearance = Appearance.normalize({ gender: bits[0], skin: Number(bits[1]), hair: Number(bits[2]), eyes: Number(bits[3]), clothing: Number(bits[4]), skinTone: tone });
        if (appearance) Appearance._definitions[filename] = appearance;
        return appearance;
    };

    function sourceSpec(kind) {
        return {
            character: { width: 144, height: 192 },
            face: { width: 576, height: 288 },
            sv: { width: 576, height: 384 }
        }[kind];
    }
    function targetName(kind) { return { character: 'tv', face: 'face', sv: 'sv' }[kind]; }
    function flushManifestCallbacks() {
        var callbacks = Appearance.manifestCallbacks.slice();
        Appearance.manifestCallbacks = [];
        callbacks.forEach(function(callback) { try { callback(Appearance.manifest); } catch (error) { console.error('[MMOAppearance manifest]', error); } });
    }
    Appearance.loadManifest = function(callback) {
        if (callback) Appearance.manifestCallbacks.push(callback);
        if (Appearance.manifestState === 'ready' || Appearance.manifestState === 'error') return flushManifestCallbacks();
        if (Appearance.manifestState === 'loading') return;
        Appearance.manifestState = 'loading';
        var request = new XMLHttpRequest();
        request.open('GET', Appearance.generatorRoot + 'mmo-generator-manifest.json', true);
        request.overrideMimeType('application/json');
        request.onload = function() {
            try {
                if (request.status >= 400) throw new Error('HTTP ' + request.status);
                var manifest = JSON.parse(request.responseText || '{}');
                if (!manifest || !manifest.targets) throw new Error('manifest invalid');
                Appearance.manifest = manifest;
                Appearance.manifestState = 'ready';
                Appearance.composePending();
            } catch (error) {
                Appearance.manifestState = 'error';
                console.warn('MMOAppearance: manifest absent ou invalide. Lance npm run generator:manifest après avoir copié les assets Generator.', error.message);
                Appearance.markPendingReady();
            }
            flushManifestCallbacks();
        };
        request.onerror = function() {
            Appearance.manifestState = 'error';
            console.warn('MMOAppearance: mmo-generator-manifest.json introuvable. Lance npm run generator:manifest.');
            Appearance.markPendingReady();
            flushManifestCallbacks();
        };
        request.send();
    };
    Appearance.markPendingReady = function() {
        Object.keys(Appearance._pending).forEach(function(key) {
            var entry = Appearance._pending[key];
            if (entry && entry.output) {
                entry.output._mmoAppearanceReady = true;
                if (typeof entry.output._setDirty === 'function') entry.output._setDirty();
            }
        });
        Appearance._pending = {};
    };
    function waitForBitmap(bitmap, callback, attempts) {
        if (bitmap && bitmap._mmoAppearanceReady === false) {
            if (attempts > 240) return callback(bitmap);
            return setTimeout(function() { waitForBitmap(bitmap, callback, attempts + 1); }, 25);
        }
        if (bitmap && bitmap.isReady && bitmap.isReady()) return callback(bitmap);
        if (!bitmap || (bitmap.isError && bitmap.isError()) || attempts > 240) return callback(null);
        setTimeout(function() { waitForBitmap(bitmap, callback, attempts + 1); }, 25);
    }
    function safeLayerPath(relativePath) {
        // A manifest is generated locally, but keep its contents constrained to
        // the Generator folders even if its JSON is hand-edited afterwards.
        return /^(Face|TV|SV)\/(Male|Female|Kid|Child)\/[^/\\]+\.png$/i.test(String(relativePath || ''));
    }
    function loadRelativeBitmap(relativePath) {
        if (!safeLayerPath(relativePath)) return null;
        var normalized = String(relativePath).replace(/^\/+/, '');
        var slash = normalized.lastIndexOf('/');
        var directory = Appearance.generatorRoot + (slash >= 0 ? normalized.slice(0, slash + 1) : '');
        var filename = (slash >= 0 ? normalized.slice(slash + 1) : normalized).replace(/\.png$/i, '');
        return ImageManager.loadBitmap(directory, filename, 0, false);
    }
    function firstAvailableVariant(variants) {
        var keys = Object.keys(variants || {}).filter(function(key) { return Array.isArray(variants[key]) && variants[key].length; });
        keys.sort(function(left, right) { return Number(left) - Number(right) || String(left).localeCompare(String(right)); });
        return keys.length ? variants[keys[0]] : [];
    }
    function layerEntry(value, recipeOrder, fileOrder) {
        // v1 manifests stored strings. v2 also stores the Generator cell so
        // multi-cell parts such as FG_Eyes_p03_c1/c2 retain their real order.
        var isObject = value && typeof value === 'object';
        var file = isObject ? value.path : value;
        var number = isObject ? Number(value.cell) : NaN;
        return {
            path: String(file || ''),
            cell: isFinite(number) && number >= 0 ? number : null,
            recipeOrder: recipeOrder,
            fileOrder: fileOrder
        };
    }
    function layersFor(kind, appearance) {
        var targets = Appearance.manifest && Appearance.manifest.targets;
        var target = targets && targets[targetName(kind)];
        var gender = target && target[appearance.gender];
        if (!gender) return [];
        // This is the fallback stack for Generator files with no _c cell.
        // When cells are present, their documented order controls the stack.
        var catalog = gender.catalog;
        var order = { Body: 1, RearHair: 2, Face: 3, Ears: 4, BeastEars: 5, Tail: 6, Wings: 7, Clothing: 8, Cloak: 9, Beard: 10, Nose: 11, Mouth: 12, Eyes: 13, Eyebrows: 14, FacialMark: 15, AccA: 16, AccB: 17, Glasses: 18, FrontHair: 19 };
        var recipe;
        if (catalog && Object.keys(catalog).length) {
            var selectedParts = Object.assign({}, appearance.parts);
            // A persisted recipe from an older build can lack the new catalog
            // fields. Always retain the installed base body (and face when it
            // exists) so selecting a cosmetic layer can never make the hero
            // collapse into hair/accessories only.
            ['Body', 'Face'].forEach(function(category) {
                if (!selectedParts[category] && catalog[category]) {
                    var defaults = Object.keys(catalog[category]).sort(function(left, right) { return Number(left) - Number(right); });
                    if (defaults.length) selectedParts[category] = Number(defaults[0]);
                }
            });
            recipe = Object.keys(selectedParts).filter(function(category) { return catalog[category]; }).map(function(category) { return [category, selectedParts[category]]; });
            recipe.sort(function(left, right) { return (order[left[0]] || 50) - (order[right[0]] || 50) || String(left[0]).localeCompare(String(right[0])); });
        } else {
            recipe = [ ['hairRear', appearance.hair], ['skin', appearance.skin], ['clothing', appearance.clothing], ['nose', 1], ['mouth', 1], ['eyes', appearance.eyes], ['hairFront', appearance.hair] ];
        }
        var result = [];
        recipe.forEach(function(entry, recipeOrder) {
            var variants = catalog ? (catalog[entry[0]] || {}) : (gender[entry[0]] || {});
            // A project may have fewer official variants than the UI selector.
            // Use a layer that the manifest proves exists, never a synthetic
            // filename such as FG_Clothing_p01.png.
            var files = variants[String(entry[1])] || firstAvailableVariant(variants);
            files.forEach(function(file, fileOrder) {
                var layer = layerEntry(file, recipeOrder, fileOrder);
                if (safeLayerPath(layer.path) && !result.some(function(current) { return current.path === layer.path; })) result.push(layer);
            });
        });
        if (catalog) {
            // v3 catalogs are used by the editor, but retain the explicit
            // legacy Body/Face group as a mandatory render fallback. Several
            // stock packs use body names that differ from their catalog label;
            // without this fallback a character can visibly keep only hair.
            var baseVariants = gender.skin || {};
            var baseFiles = baseVariants[String(appearance.skin)] || firstAvailableVariant(baseVariants);
            baseFiles.forEach(function(file, fileOrder) {
                var layer = layerEntry(file, -1, fileOrder);
                if (safeLayerPath(layer.path) && !result.some(function(current) { return current.path === layer.path; })) result.push(layer);
            });
        }
        // c1 is the top cell in the MV Generator. It therefore needs to be
        // blitted last; files without cells retain the fallback recipe order.
        result.sort(function(left, right) {
            if (left.cell !== null && right.cell !== null) {
                return right.cell - left.cell || left.recipeOrder - right.recipeOrder || left.fileOrder - right.fileOrder;
            }
            if (left.cell !== null) return 1;
            if (right.cell !== null) return -1;
            return left.recipeOrder - right.recipeOrder || left.fileOrder - right.fileOrder;
        });
        return result;
    }
    Appearance.applySkinTone = function(output, toneId) {
        var tone = Appearance.skinTones.filter(function(item) { return item.id === toneId; })[0] || Appearance.skinTones[0];
        if (!tone || tone.id === 'porcelaine' || !output) return;
        var canvas = output._canvas;
        var context = output._context || (canvas && canvas.getContext ? canvas.getContext('2d') : null);
        if (!context || !context.getImageData || !context.putImageData) return;
        var hex = tone.color.replace('#', '');
        var red = parseInt(hex.slice(0, 2), 16), green = parseInt(hex.slice(2, 4), 16), blue = parseInt(hex.slice(4, 6), 16);
        try {
            var image = context.getImageData(0, 0, output.width, output.height);
            for (var pixel = 0; pixel < image.data.length; pixel += 4) {
                // m001 uses the stock Generator skin key colour #F9C19D.
                if (image.data[pixel] === 249 && image.data[pixel + 1] === 193 && image.data[pixel + 2] === 157) {
                    image.data[pixel] = red;
                    image.data[pixel + 1] = green;
                    image.data[pixel + 2] = blue;
                }
            }
            context.putImageData(image, 0, 0);
        } catch (_) { /* a canvas unavailable to pixel reads simply keeps its stock skin colour */ }
    };
    Appearance.compose = function(kind, key, appearance, output) {
        var files = layersFor(kind, appearance);
        if (!files.length) {
            output._mmoAppearanceReady = true;
            if (typeof output._setDirty === 'function') output._setDirty();
            delete Appearance._pending[kind + ':' + key];
            return;
        }
        var pending = files.length;
        var loadedLayers = new Array(files.length);
        files.forEach(function(file, index) {
            var layer = loadRelativeBitmap(file.path);
            waitForBitmap(layer, function(loaded) {
                loadedLayers[index] = loaded;
                pending -= 1;
                if (pending === 0) {
                    // Load completion timing must never affect which cell is
                    // visually on top, so draw only after every layer settled.
                    loadedLayers.forEach(function(readyLayer) {
                        if (readyLayer && readyLayer.width && readyLayer.height) {
                            output.blt(readyLayer, 0, 0, Math.min(readyLayer.width, output.width), Math.min(readyLayer.height, output.height), 0, 0);
                        }
                    });
                    Appearance.applySkinTone(output, appearance.skinTone);
                    output._mmoAppearanceReady = true;
                    if (typeof output._setDirty === 'function') output._setDirty();
                    delete Appearance._pending[kind + ':' + key];
                }
            }, 0);
        });
    };
    Appearance.composePending = function() {
        Object.keys(Appearance._pending).forEach(function(pendingKey) {
            var entry = Appearance._pending[pendingKey];
            if (entry) Appearance.compose(entry.kind, entry.key, entry.appearance, entry.output);
        });
    };

    Appearance.bitmapFor = function(kind, rawAppearance) {
        var appearance = Appearance.normalize(rawAppearance);
        var key = Appearance.key(kind, appearance);
        var spec = sourceSpec(kind);
        if (!key || !spec || typeof Bitmap === 'undefined' || typeof ImageManager === 'undefined') return null;
        if (Appearance._bitmaps[kind][key]) return Appearance._bitmaps[kind][key];
        var output = new Bitmap(spec.width, spec.height);
        output._mmoAppearanceReady = false;
        Appearance._bitmaps[kind][key] = output;
        Appearance._pending[kind + ':' + key] = { kind: kind, key: key, appearance: appearance, output: output };
        // The missing-manifest fallback is deliberately a ready blank bitmap:
        // native MV renderers keep working and no later call retries any PNG.
        if (Appearance.manifestState === 'error') {
            output._mmoAppearanceReady = true;
            if (typeof output._setDirty === 'function') output._setDirty();
            delete Appearance._pending[kind + ':' + key];
            return output;
        }
        Appearance.loadManifest();
        if (Appearance.manifestState === 'ready') Appearance.compose(kind, key, appearance, output);
        return output;
    };

    Appearance.applyToActor = function(actor, rawAppearance) {
        var appearance = Appearance.normalize(rawAppearance);
        if (!actor || !appearance) return false;
        Appearance.installImageHooks && Appearance.installImageHooks();
        var characterKey = Appearance.characterKey(appearance);
        var faceKey = Appearance.faceKey(appearance);
        var svKey = Appearance.svKey(appearance);
        actor._mmoAppearance = appearance;
        actor._mmoGeneratedFaceKey = faceKey;
        actor._mmoGeneratedFaceIndex = 0;
        if (typeof actor.setCharacterImage === 'function') actor.setCharacterImage(characterKey, 0);
        // Keep a real MV faceset name on the actor. Native menus may bypass
        // ImageManager hooks, so storing MMOFace_* here causes a filesystem
        // request on Scene_Menu/Scene_Item. drawActorFace below renders the
        // generated Bitmap from _mmoAppearance instead.
        if (typeof actor.setFaceImage === 'function') {
            var data = typeof actor.actor === 'function' ? actor.actor() : null;
            var nativeFaceName = data && data.faceName ? data.faceName : (typeof actor.faceName === 'function' ? actor.faceName() : '');
            var nativeFaceIndex = data && data.faceIndex !== undefined ? Number(data.faceIndex) : (typeof actor.faceIndex === 'function' ? Number(actor.faceIndex()) : 0);
            if (String(nativeFaceName).indexOf('MMOFace_') === 0) nativeFaceName = '';
            actor.setFaceImage(nativeFaceName, nativeFaceIndex || 0);
        }
        if (typeof actor.setBattlerImage === 'function') actor.setBattlerImage(svKey);
        Appearance.bitmapFor('character', appearance);
        Appearance.bitmapFor('face', appearance);
        Appearance.bitmapFor('sv', appearance);
        return true;
    };

    // The compact map HUD is HTML, not a Window_Base. It cannot use
    // Window_Base.drawFace, so feed it the generated Bitmap via a canvas
    // instead of constructing img/faces/MMOFace_*.png URLs that do not exist.
    Appearance.renderFaceElement = function(element, faceName, faceIndex, width, height) {
        var appearance = Appearance.appearanceForKey('face', faceName);
        if (!element || !appearance || typeof document === 'undefined') return false;
        var index = Math.max(0, Number(faceIndex) || 0);
        var renderKey = String(faceName) + ':' + index + ':' + width + 'x' + height;
        var canvas = element._mmoFaceCanvas;
        if (!canvas) {
            canvas = document.createElement('canvas');
            element._mmoFaceCanvas = canvas;
            element.innerHTML = '';
            element.appendChild(canvas);
        }
        canvas.width = width;
        canvas.height = height;
        element._mmoFaceRenderKey = renderKey;
        element.style.backgroundImage = 'none';
        element.style.backgroundPosition = '0 0';
        var bitmap = Appearance.bitmapFor('face', appearance);
        waitForBitmap(bitmap, function(loaded) {
            if (!loaded || !canvas.parentNode || element._mmoFaceRenderKey !== renderKey) return;
            var source = loaded._canvas || loaded._image;
            if (!source) return;
            var context = canvas.getContext('2d');
            context.clearRect(0, 0, canvas.width, canvas.height);
            context.imageSmoothingEnabled = false;
            context.drawImage(source, 144 * (index % 4), 144 * Math.floor(index / 4), 144, 144, 0, 0, width, height);
        }, 0);
        return true;
    };

    Appearance.drawFaceInWindow = function(window, rawAppearance, faceIndex, x, y, width, height) {
        var appearance = Appearance.normalize(rawAppearance);
        if (!window || !window.contents || !window.contents.blt || !appearance) return false;
        var bitmap = Appearance.bitmapFor('face', appearance);
        var index = Math.max(0, Number(faceIndex) || 0);
        waitForBitmap(bitmap, function(loaded) {
            if (!loaded || !window.contents || !window.contents.blt) return;
            window.contents.blt(loaded, 144 * (index % 4), 144 * Math.floor(index / 4), 144, 144, x, y, width || 144, height || 144);
        }, 0);
        return true;
    };

    // Generated sheets use native ImageManager/Sprite_Character,
    // Window_Base.drawFace and Sprite_Actor paths. Other MV plugins sometimes
    // replace ImageManager.loadFace after this plugin; install these hooks again
    // when a generated key is requested so MMOFace can never fall through to
    // img/faces/MMOFace_*.png.
    Appearance.hookRevision = '0.16.0';
    Appearance.installImageHooks = function() {
        if (typeof ImageManager === 'undefined') return;
        [
            { method: 'loadCharacter', kind: 'character' },
            { method: 'loadFace', kind: 'face' },
            { method: 'loadSvActor', kind: 'sv' }
        ].forEach(function(spec) {
            var current = ImageManager[spec.method];
            if (typeof current !== 'function' || current._mmoAppearanceHookRevision === Appearance.hookRevision) return;
            var fallback = current;
            var hook = function(filename, hue) {
                var appearance = Appearance.appearanceForKey(spec.kind, filename);
                return appearance ? Appearance.bitmapFor(spec.kind, appearance) : fallback.call(this, filename, hue);
            };
            hook._mmoAppearanceHookRevision = Appearance.hookRevision;
            ImageManager[spec.method] = hook;
        });
        if (typeof Window_Base !== 'undefined' && Window_Base.prototype && Window_Base.prototype.drawFace) {
            var drawFace = Window_Base.prototype.drawFace;
            if (drawFace._mmoAppearanceHookRevision !== Appearance.hookRevision) {
                Window_Base.prototype.drawFace = function(faceName, faceIndex, x, y, width, height) {
                    var appearance = Appearance.appearanceForKey('face', faceName);
                    if (!appearance) return drawFace.apply(this, arguments);
                    Appearance.drawFaceInWindow(this, appearance, faceIndex, x, y, width, height);
                };
                Window_Base.prototype.drawFace._mmoAppearanceHookRevision = Appearance.hookRevision;
            }
            var drawActorFace = Window_Base.prototype.drawActorFace;
            if (typeof drawActorFace === 'function' && drawActorFace._mmoAppearanceHookRevision !== Appearance.hookRevision) {
                Window_Base.prototype.drawActorFace = function(actor, x, y, width, height) {
                    if (actor && actor._mmoAppearance && Appearance.drawFaceInWindow(this, actor._mmoAppearance, actor._mmoGeneratedFaceIndex || 0, x, y, width, height)) return;
                    return drawActorFace.apply(this, arguments);
                };
                Window_Base.prototype.drawActorFace._mmoAppearanceHookRevision = Appearance.hookRevision;
            }
        }
    };
    Appearance.installImageHooks();

    Appearance.categoryLabels = { Body: 'Corps', Face: 'Visage', FrontHair: 'Frange', RearHair: 'Cheveux', Beard: 'Barbe', Ears: 'Oreilles', Eyes: 'Yeux', Eyebrows: 'Sourcils', Nose: 'Nez', Mouth: 'Bouche', FacialMark: 'Signes distinctifs', BeastEars: 'Oreilles animales', Tail: 'Queue', Wings: 'Ailes', Clothing: 'Vêtements', Cloak: 'Manteau', AccA: 'Accessoire 1', AccB: 'Accessoire 2', Glasses: 'Lunettes' };
    Appearance.categoryOrder = ['Body', 'Face', 'FrontHair', 'RearHair', 'Beard', 'Ears', 'Eyes', 'Eyebrows', 'Nose', 'Mouth', 'FacialMark', 'BeastEars', 'Tail', 'Wings', 'Clothing', 'Cloak', 'AccA', 'AccB', 'Glasses'];
    Appearance.categoriesFor = function(gender) {
        var found = {};
        var targets = Appearance.manifest && Appearance.manifest.targets;
        ['face', 'tv', 'sv'].forEach(function(targetName) {
            var catalog = targets && targets[targetName] && targets[targetName][gender] && targets[targetName][gender].catalog;
            Object.keys(catalog || {}).forEach(function(category) { if (catalog[category] && Object.keys(catalog[category]).length) found[category] = true; });
        });
        return Object.keys(found).sort(function(left, right) {
            var leftOrder = Appearance.categoryOrder.indexOf(left), rightOrder = Appearance.categoryOrder.indexOf(right);
            return (leftOrder < 0 ? 99 : leftOrder) - (rightOrder < 0 ? 99 : rightOrder) || left.localeCompare(right);
        });
    };
    Appearance.variantsFor = function(gender, category) {
        var found = {};
        var targets = Appearance.manifest && Appearance.manifest.targets;
        ['face', 'tv', 'sv'].forEach(function(targetName) {
            var entries = targets && targets[targetName] && targets[targetName][gender] && targets[targetName][gender].catalog && targets[targetName][gender].catalog[category];
            Object.keys(entries || {}).forEach(function(variant) { found[variant] = true; });
        });
        return Object.keys(found).map(Number).filter(function(number) { return number > 0; }).sort(function(left, right) { return left - right; });
    };
    Appearance.thumbnailLayer = function(gender, category, variant) {
        var targets = Appearance.manifest && Appearance.manifest.targets;
        // Prefer the face layer where it exists; otherwise show the exact map
        // layer. Do not compose every possible full character just to make the
        // picker thumbnails: that can create hundreds of simultaneous canvases.
        var targetOrder = ['face', 'tv', 'sv'];
        for (var index = 0; index < targetOrder.length; index += 1) {
            var target = targetOrder[index];
            var entries = targets && targets[target] && targets[target][gender] && targets[target][gender].catalog && targets[target][gender].catalog[category];
            var files = entries && (entries[String(variant)] || firstAvailableVariant(entries));
            if (files && files.length) return { target: target, entry: layerEntry(files[0], 0, 0) };
        }
        return null;
    };
    Appearance.renderCategoryOptions = function(elementId, rawAppearance, category, onSelect) {
        if (typeof document === 'undefined') return;
        var element = document.getElementById(elementId);
        var appearance = Appearance.normalize(rawAppearance);
        if (!element || !appearance || Appearance.manifestState !== 'ready') return;
        var variants = Appearance.variantsFor(appearance.gender, category);
        element.innerHTML = '';
        if (!variants.length) {
            element.textContent = 'Aucune variante disponible pour cette catégorie.';
            return;
        }
        variants.forEach(function(variant) {
            var button = document.createElement('button');
            button.type = 'button';
            button.className = 'mmo-generator-variant' + (Number(appearance.parts[category]) === variant ? ' selected' : '');
            button.title = (Appearance.categoryLabels[category] || category) + ' ' + variant;
            var thumbnail = Appearance.thumbnailLayer(appearance.gender, category, variant);
            var useFace = thumbnail && thumbnail.target === 'face';
            var canvas = document.createElement('canvas');
            canvas.width = useFace ? 52 : 40;
            canvas.height = useFace ? 52 : 64;
            if (thumbnail && safeLayerPath(thumbnail.entry.path)) {
                var bitmap = loadRelativeBitmap(thumbnail.entry.path);
                // `var` is function-scoped in MV's JavaScript runtime. Capture
                // this button's canvas explicitly so asynchronous image loads
                // cannot all paint into the final thumbnail in the list.
                (function(targetCanvas, targetBitmap) {
                    waitForBitmap(targetBitmap, function(loaded) {
                        if (!loaded || !targetCanvas.parentNode) return;
                        var source = loaded._canvas || loaded._image;
                        if (!source) return;
                        var context = targetCanvas.getContext('2d');
                        context.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
                        context.imageSmoothingEnabled = false;
                        context.drawImage(source, 0, 0, loaded.width, loaded.height, 0, 0, targetCanvas.width, targetCanvas.height);
                    }, 0);
                })(canvas, bitmap);
            }
            var label = document.createElement('small');
            label.textContent = '#' + variant;
            button.appendChild(canvas);
            button.appendChild(label);
            button.onclick = function() { if (typeof onSelect === 'function') onSelect(variant, button); };
            element.appendChild(button);
        });
    };

    Appearance.renderPreview = function(elementId, rawAppearance) {
        if (typeof document === 'undefined') return;
        var element = document.getElementById(elementId);
        var appearance = Appearance.normalize(rawAppearance);
        if (!element || !appearance) return;
        if (Appearance.manifestState === 'error') {
            element.textContent = 'Assets Generator non préparés : copie-les puis lance npm run generator:manifest.';
            return;
        }
        if (Appearance.manifestState !== 'ready') {
            element.textContent = 'Préparation des assets Generator…';
            return Appearance.loadManifest(function() { Appearance.renderPreview(elementId, appearance); });
        }
        element.innerHTML = '';
        var entries = [
            { kind: 'face', label: 'Portrait', width: 72, height: 72, sourceX: 0, sourceY: 0, sourceWidth: 144, sourceHeight: 144 },
            { kind: 'character', label: 'Carte', width: 54, height: 72, sourceX: 0, sourceY: 0, sourceWidth: 144, sourceHeight: 192 },
            { kind: 'sv', label: 'Combat', width: 96, height: 64, sourceX: 0, sourceY: 0, sourceWidth: 576, sourceHeight: 384 }
        ];
        entries.forEach(function(entry) {
            var card = document.createElement('div');
            card.className = 'mmo-appearance-preview-card';
            var label = document.createElement('small');
            label.textContent = entry.label;
            var canvas = document.createElement('canvas');
            canvas.width = entry.width;
            canvas.height = entry.height;
            card.appendChild(label);
            card.appendChild(canvas);
            element.appendChild(card);
            var bitmap = Appearance.bitmapFor(entry.kind, appearance);
            waitForBitmap(bitmap, function(loaded) {
                if (!loaded || !canvas.parentNode) return;
                var source = loaded._canvas || loaded._image;
                if (!source) return;
                var context = canvas.getContext('2d');
                context.clearRect(0, 0, canvas.width, canvas.height);
                context.imageSmoothingEnabled = false;
                context.drawImage(source, entry.sourceX, entry.sourceY, entry.sourceWidth, entry.sourceHeight, 0, 0, entry.width, entry.height);
            }, 0);
        });
    };

    Appearance.loadManifest();
    // Run once more after Plugin Manager has evaluated the remaining plugins.
    // This protects generated faces from a later ImageManager override.
    if (typeof setTimeout === 'function') setTimeout(function() { Appearance.installImageHooks(); }, 0);

})(MMOAppearance, MMOFoundation);
