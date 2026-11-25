'use strict';

// Builds a runtime manifest from the generator parts actually copied into the
// RPG Maker MV project. Generator naming differs between MV editions/DLCs
// (Body/body, Clothing/Clothing1, Hair/Hair1, etc.), so the client must never
// guess paths and trigger a wall of failed file loads.

try { require('dotenv').config(); } catch (_) { /* direct Node use only needs process.env */ }
const fs = require('fs');
const path = require('path');
const { dataDirectory } = require('./mv-database');

const projectRoot = path.dirname(dataDirectory());
const generatorRoot = path.resolve(process.env.RPG_MV_GENERATOR_PATH || path.join(projectRoot, 'img', 'generator'));
const manifestPath = path.join(generatorRoot, 'mmo-generator-manifest.json');

function filesIn(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.png$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch (_) {
    return [];
  }
}

function partNumber(filename, names) {
  const match = String(filename).match(new RegExp('_(?:' + names.join('|') + ')_p(\\d+)(?:_|\\.png$)', 'i'));
  return match ? String(Number(match[1])) : null;
}

function cellNumber(filename) {
  // In the MV Generator, _c1, _c2… means "cell/layer", not an expendable
  // colour-mask image. A file such as FG_Body_p01_c1_m001.png is the actual
  // body layer and must be included. Lower-numbered cells are drawn on top.
  const match = String(filename).match(/_c(\d+)(?:_|\.png$)/i);
  return match ? Number(match[1]) : null;
}

function renderableLayer(filename) {
  // Stock MV also has companion files such as TV_Body_p01_c.png. With no
  // numeric cell, this is a recolour mask, not art to paint over the body.
  // Drawing it after TV_Body_p01.png can hide the entire base sprite.
  return !/_c\.png$/i.test(String(filename));
}

function collectLayers(folder, prefix, names) {
  const groups = {};
  const prefixPattern = new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  filesIn(folder).forEach((filename) => {
    if (!prefixPattern.test(filename) || !renderableLayer(filename)) return;
    const number = partNumber(filename, names);
    if (!number) return;
    if (!groups[number]) groups[number] = [];
    groups[number].push({ filename, cell: cellNumber(filename) });
  });
  Object.keys(groups).forEach((number) => {
    // The Generator's c1 cell is topmost. Drawing high cells first and low
    // cells last reproduces that relationship when the client composites PNGs.
    groups[number].sort((left, right) => {
      const leftCell = left.cell === null ? -1 : left.cell;
      const rightCell = right.cell === null ? -1 : right.cell;
      return rightCell - leftCell || left.filename.localeCompare(right.filename);
    });
  });
  return groups;
}

function canonicalCategory(layerName) {
  const name = String(layerName || '');
  const aliases = { Eye: 'Eyes', Wing: 'Wings', BeastEar: 'BeastEars' };
  const numbered = name.match(/^(Clothing|RearHair|FrontHair|Cloak|Wing|Tail|Beard|Ears|AccA|AccB)(\d+)$/i);
  const base = numbered ? numbered[1] : name;
  return aliases[base] || base;
}

function collectCatalog(folder, prefix, relativeFolder) {
  const result = {};
  const prefixPattern = new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(.+)_p(\\d+)(?:_|\\.png$)', 'i');
  filesIn(folder).forEach((filename) => {
    const match = filename.match(prefixPattern);
    if (!match || !renderableLayer(filename)) return;
    const category = canonicalCategory(match[1]);
    const variant = String(Number(match[2]));
    if (!category || !variant) return;
    if (!result[category]) result[category] = {};
    if (!result[category][variant]) result[category][variant] = [];
    result[category][variant].push({ path: relativeFolder + filename, cell: cellNumber(filename) });
  });
  Object.keys(result).forEach((category) => Object.keys(result[category]).forEach((variant) => {
    result[category][variant].sort((left, right) => {
      const leftCell = left.cell === null ? -1 : left.cell;
      const rightCell = right.cell === null ? -1 : right.cell;
      return rightCell - leftCell || left.path.localeCompare(right.path);
    });
  }));
  return result;
}

function targetManifest(targetFolder, prefix, gender) {
  let genderFolder = gender === 'male' ? 'Male' : gender === 'female' ? 'Female' : 'Kid';
  // Some translated/distributed Generator packs name this folder Child.
  if (gender === 'kid' && !fs.existsSync(path.join(generatorRoot, targetFolder, genderFolder))) genderFolder = 'Child';
  const folder = path.join(generatorRoot, targetFolder, genderFolder);
  const relativeFolder = targetFolder + '/' + genderFolder + '/';
  function files(names) {
    const groups = collectLayers(folder, prefix, names);
    Object.keys(groups).forEach((number) => {
      groups[number] = groups[number].map((entry) => ({ path: relativeFolder + entry.filename, cell: entry.cell }));
    });
    return groups;
  }
  return {
    // Legacy named groups remain for characters made before v0.15. The catalog
    // is the complete, exact list consumed by the full creation interface.
    skin: files(['Body', 'Face']),
    clothing: files(['Clothing', 'Clothing1', 'Clothing2']),
    hairRear: files(['RearHair', 'RearHair1', 'RearHair2']),
    nose: files(['Nose']),
    mouth: files(['Mouth']),
    eyes: files(['Eye', 'Eyes']),
    hairFront: files(['FrontHair', 'FrontHair1', 'FrontHair2']),
    catalog: collectCatalog(folder, prefix, relativeFolder)
  };
}

function variantCount(parts) {
  return Object.keys(parts).filter((part) => part !== 'catalog').reduce((total, part) => total + Object.keys(parts[part]).length, 0);
}

function hasLayer(parts, layer) {
  return Object.keys(parts[layer] || {}).length > 0;
}

function main() {
  const manifest = {
    version: 3,
    generatedAt: new Date().toISOString(),
    targets: {
      face: { male: targetManifest('Face', 'FG_', 'male'), female: targetManifest('Face', 'FG_', 'female'), kid: targetManifest('Face', 'FG_', 'kid') },
      tv: { male: targetManifest('TV', 'TV_', 'male'), female: targetManifest('TV', 'TV_', 'female'), kid: targetManifest('TV', 'TV_', 'kid') },
      sv: { male: targetManifest('SV', 'SV_', 'male'), female: targetManifest('SV', 'SV_', 'female'), kid: targetManifest('SV', 'SV_', 'kid') }
    }
  };
  const requiredGenders = ['male', 'female'];
  const availableGenders = ['male', 'female', 'kid'].filter((gender) => Object.keys(manifest.targets.face[gender].catalog || {}).length > 0);
  const count = Object.keys(manifest.targets).reduce((total, target) => total + availableGenders.reduce((genderTotal, gender) => {
    return genderTotal + variantCount(manifest.targets[target][gender]);
  }, 0), 0);
  const baseMissing = [];
  const cosmeticMissing = [];
  Object.keys(manifest.targets).forEach((target) => requiredGenders.forEach((gender) => {
    const parts = manifest.targets[target][gender];
    const label = target.toUpperCase() + '/' + (gender === 'male' ? 'Male' : 'Female');
    if (!hasLayer(parts, 'skin')) baseMissing.push(label + ' (Body ou Face)');
    ['clothing', 'hairFront'].forEach((layer) => {
      if (!hasLayer(parts, layer)) cosmeticMissing.push(label + ' (' + layer + ')');
    });
    if (target === 'face' && !hasLayer(parts, 'eyes')) cosmeticMissing.push(label + ' (eyes)');
  }));
  if (!count || baseMissing.length) {
    throw new Error('Assets Generator incomplets dans ' + generatorRoot + '. Couches de base absentes : ' + (baseMissing.length ? baseMissing.join(', ') : 'toutes') + '. Attendu : Face/Male, Face/Female, TV/Male, TV/Female, SV/Male et SV/Female.');
  }
  fs.mkdirSync(generatorRoot, { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log('[generator] manifeste v3 créé : ' + manifestPath);
  console.log('[generator] ' + count + ' variantes de couches détectées pour : ' + availableGenders.join(', ') + '.');
  if (cosmeticMissing.length) console.warn('[generator] couches optionnelles absentes : ' + cosmeticMissing.join(', ') + '. Elles ne seront pas chargées par le client.');
}

try { main(); } catch (error) {
  console.error('[generator] ' + error.message);
  process.exitCode = 1;
}
