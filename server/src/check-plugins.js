'use strict';

// The starter archive stores plugins under rpgmaker/js/plugins. A real RPG
// Maker MV project normally stores them directly under js/plugins. Validate
// whichever layout is present so `npm run check` works in both installations.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..', '..');
const candidates = [
  path.join(projectRoot, 'rpgmaker', 'js', 'plugins'),
  path.join(projectRoot, 'js', 'plugins')
];
const pluginDirectory = candidates.find((directory) => fs.existsSync(directory));

if (!pluginDirectory) {
  console.error('[check] Plugins introuvables. Attendu : js/plugins ou rpgmaker/js/plugins sous ' + projectRoot);
  process.exitCode = 1;
} else {
  ['MMOFoundation.js', 'MMOAppearance.js', 'MMOBattle.js', 'MMOInventory.js', 'MMOTrade.js', 'MMOAuction.js', 'MMOServices.js', 'MMOGuild.js', 'MMOHousing.js', 'MMOEvents.js'].forEach((filename) => {
    const plugin = path.join(pluginDirectory, filename);
    if (!fs.existsSync(plugin)) {
      console.error('[check] Plugin manquant : ' + plugin);
      process.exitCode = 1;
      return;
    }
    execFileSync(process.execPath, ['--check', plugin], { stdio: 'inherit' });
  });
  if (!process.exitCode) console.log('[check] Plugins validés : ' + pluginDirectory);
}
