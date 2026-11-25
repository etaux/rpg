/*:
 * @plugindesc v2.0 — MMO : limites de paramètres et courbes de classes 1–99 au-delà de 999 (RPG Maker MV).
 * @author Arena
 *
 * @param Activer les courbes MMO
 * @type boolean
 * @on Oui
 * @off Non
 * @default true
 * @desc Utilise les courbes internes des classes 1 à 12 décrites dans le document de game design.
 *
 * @param Maximum PV
 * @type number
 * @min 1
 * @default 999999
 *
 * @param Maximum PM
 * @type number
 * @min 1
 * @default 9999
 *
 * @param Maximum toutes les autres stats
 * @type number
 * @min 999
 * @default 9999
 * @desc ATQ, DEF, MAT, MDF, AGI et CHN/LUK.
 *
 * @help
 * ═══════════════════════════════════════════════════════════════════════
 * MMOParameterCaps v2.0
 * ═══════════════════════════════════════════════════════════════════════
 *
 * INSTALLATION
 * 1. Placer ce fichier dans js/plugins/.
 * 2. Ouvrir le Gestionnaire de plugins de RPG Maker MV.
 * 3. Ajouter et activer MMOParameterCaps.
 * 4. Le placer SOUS les plugins qui modifient les statistiques des acteurs.
 *
 * CE QUE LE PLUGIN CORRIGE
 * - PV  : jusqu'à 999 999
 * - PM  : jusqu'à 9 999
 * - ATQ : jusqu'à 9 999
 * - DEF : jusqu'à 9 999
 * - MAT : jusqu'à 9 999
 * - MDF : jusqu'à 9 999
 * - AGI : jusqu'à 9 999
 * - CHN/LUK : jusqu'à 9 999
 *
 * IMPORTANT
 * L'éditeur RPG Maker MV garde visuellement une limite de 999 dans ses
 * champs de courbe. Aucun plugin de jeu ne peut modifier cette interface,
 * car les plugins ne s'exécutent que pendant le jeu.
 *
 * C'est pourquoi ce fichier applique directement en jeu les courbes 1–99
 * définies ci-dessous. Les valeurs de la base de données peuvent rester à
 * 999 ou moins : cette extension les remplace en combat pour les classes
 * configurées.
 *
 * MAPPING ACTUEL DES IDs DE CLASSE
 * 1 Légionnaire des Cendres       7 Danse-Lame du Voile
 * 2 Bourreau Séraphique           8 Oracle de l'Éclipse
 * 3 Hémomancienne Carmine         9 Dompteur des Chimères
 * 4 Pyromancien du Trône         10 Artificier des Reliques
 * 5 Cantor du Chœur Brisé        11 Moissonneur des Serments
 * 6 Geôlier des Chaînes          12 Gardien des Portes Noires
 * 13 Bastion de l'Aube Noire     14 Bourreau de la Couronne
 *
 * Les IDs 13 et 14 sont les spécialisations recommandées du Légionnaire :
 * elles reprennent sa courbe de stats, avec des compétences différentes.
 * Si un ID diffère dans votre projet, déplacer simplement la ligne de la
 * classe dans CLASS_CURVES vers le bon numéro.
 */

(function() {
    'use strict';

    var pluginName = 'MMOParameterCaps';
    var parameters = PluginManager.parameters(pluginName);

    function positiveNumber(value, fallback) {
        var parsed = Number(value);
        return isFinite(parsed) && parsed > 0 ? parsed : fallback;
    }

    var useMmoCurves = String(parameters['Activer les courbes MMO'] || 'true') === 'true';
    var maxMhp = positiveNumber(parameters['Maximum PV'], 999999);
    var maxMmp = positiveNumber(parameters['Maximum PM'], 9999);
    var maxOther = positiveNumber(parameters['Maximum toutes les autres stats'], 9999);

    // Une entrée = [valeur niveau 1, valeur niveau 99].
    // Index des paramètres MV : 0 PV, 1 PM, 2 ATQ, 3 DEF,
    //                           4 MAT, 5 MDF, 6 AGI, 7 CHN/LUK.
    var CLASS_CURVES = {
        1:  [[620,9000], [70,1250], [66,860], [78,1050], [24,370], [48,680], [38,480], [35,450]],
        2:  [[540,7900], [75,1300], [80,1070], [54,780], [28,420], [38,570], [52,720], [44,570]],
        3:  [[430,6200], [135,2200], [34,470], [35,500], [76,1150], [68,1050], [48,620], [62,900]],
        4:  [[400,5700], [155,2450], [27,380], [30,440], [88,1340], [60,900], [46,600], [45,600]],
        5:  [[460,6600], [145,2300], [30,420], [42,560], [68,1040], [82,1250], [45,590], [60,850]],
        6:  [[570,8200], [95,1450], [65,880], [67,920], [42,600], [54,760], [42,560], [52,710]],
        7:  [[440,6400], [90,1420], [76,1010], [37,510], [34,470], [38,570], [84,1200], [65,900]],
        8:  [[410,5900], [160,2550], [25,350], [32,450], [85,1300], [74,1150], [50,650], [72,1000]],
        9:  [[500,7100], [115,1800], [55,760], [48,680], [63,980], [55,780], [47,640], [58,780]],
        10: [[480,6800], [125,2000], [48,660], [48,690], [58,900], [60,880], [55,760], [55,750]],
        11: [[470,6700], [120,1900], [58,800], [43,620], [69,1050], [57,800], [50,700], [67,940]],
        12: [[590,8500], [85,1380], [63,850], [72,1000], [38,550], [65,950], [39,520], [50,700]],
        // IDs recommandés pour les deux spécialisations du Légionnaire.
        // Elles gardent les courbes de la classe de base ; seuls les sorts
        // et maîtrises de branche changent.
        13: [[620,9000], [70,1250], [66,860], [78,1050], [24,370], [48,680], [38,480], [35,450]],
        14: [[620,9000], [70,1250], [66,860], [78,1050], [24,370], [48,680], [38,480], [35,450]]
    };

    // La première moitié de la progression est légèrement plus rapide,
    // puis la croissance devient régulière jusqu'au niveau 99.
    function curveProgress(level) {
        var t = Math.max(0, Math.min(98, level - 1)) / 98;
        return t <= 0.5 ? t * 1.07 : 0.535 + (t - 0.5) * 0.93;
    }

    function classParamValue(classId, paramId, level) {
        var classData = CLASS_CURVES[classId];
        if (!classData || !classData[paramId]) {
            return null;
        }
        var endpoint = classData[paramId];
        return Math.round(endpoint[0] + (endpoint[1] - endpoint[0]) * curveProgress(level));
    }

    // Déverrouille les huit paramètres du moteur en jeu.
    Game_BattlerBase.prototype.paramMax = function(paramId) {
        if (paramId === 0) {
            return maxMhp;
        }
        if (paramId === 1) {
            return maxMmp;
        }
        return maxOther;
    };

    // Remplace la courbe de la base de données pour les classes MMO définies.
    // Ainsi la MAT, MDF, AGI, etc. dépassent réellement 999 malgré l'éditeur.
    var _Game_Actor_paramBase = Game_Actor.prototype.paramBase;
    Game_Actor.prototype.paramBase = function(paramId) {
        if (useMmoCurves) {
            var value = classParamValue(this._classId, paramId, this._level);
            if (value !== null) {
                return value;
            }
        }
        return _Game_Actor_paramBase.call(this, paramId);
    };

    // API utile pour les futurs plugins du projet.
    window.MMOParameterCaps = window.MMOParameterCaps || {};
    window.MMOParameterCaps.curves = CLASS_CURVES;
    window.MMOParameterCaps.valueAtLevel = classParamValue;
})();
