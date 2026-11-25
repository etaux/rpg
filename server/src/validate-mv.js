'use strict';

require('dotenv').config();
const { dataDirectory, loadDatabase, validateMapping } = require('./mv-database');

try {
  const result = validateMapping(loadDatabase());
  console.log('Base MV validée : ' + dataDirectory());
  result.warnings.forEach((warning) => console.warn('[avertissement] ' + warning));
  if (result.errors.length) {
    result.errors.forEach((error) => console.error('[mapping] ' + error));
    console.error('\nCorrige server/src/mv-mapping.js, puis relance npm run validate:mv.');
    process.exitCode = 1;
  } else {
    console.log('Mapping MV valide.');
  }
} catch (error) {
  console.error('[mv validation] ' + error.message);
  process.exitCode = 1;
}
