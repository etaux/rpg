'use strict';

// Executes the real auction handlers against an in-memory adapter shaped like
// PostgreSQL. This covers escrow, partial purchases, cancellation, expiry and
// range-bound NPC service sessions without requiring a live database.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8') + `
module.exports = {
  handleNpcAction, handleAuctionBrowse, handleAuctionCreate, handleAuctionBuy,
  handleAuctionCancel, auctionSessions, onlineByCharacterId, expireAuctionListings
};`;

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function futureDate() { return new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(); }

function makeDatabase(seed) {
  const state = clone(seed);
  let snapshot = null;
  function listing(id) { return state.listings.filter((row) => String(row.id) === String(id))[0] || null; }
  function inventory(characterId, itemId) {
    const bag = state.inventory[String(characterId)] || {};
    return Number(bag[String(itemId)] || 0);
  }
  function itemRows(characterId) {
    const bag = state.inventory[String(characterId)] || {};
    return Object.keys(bag).filter((id) => Number(bag[id]) > 0).sort().map((item_id) => ({ item_id, quantity: Number(bag[item_id]) }));
  }
  function listingRow(row) {
    return Object.assign({}, row, { seller_name: state.characters[String(row.seller_character_id)].name });
  }
  async function query(text, values) {
    const sql = String(text).replace(/\s+/g, ' ').trim().toLowerCase();
    const args = values || [];
    if (sql === 'begin') { snapshot = clone(state); return { rows: [] }; }
    if (sql === 'commit') { snapshot = null; return { rows: [] }; }
    if (sql === 'rollback') {
      if (snapshot) { Object.keys(state).forEach((key) => delete state[key]); Object.assign(state, clone(snapshot)); }
      snapshot = null;
      return { rows: [] };
    }
    if (sql.indexOf('select id, seller_character_id from auction_listings where status') === 0) {
      return { rows: state.listings.filter((row) => row.status === 'active' && row.quantity_remaining > 0 && new Date(row.expires_at).getTime() <= Date.now()).map((row) => ({ id: row.id, seller_character_id: row.seller_character_id })) };
    }
    if (sql.indexOf('select l.id, l.seller_character_id, l.item_id') === 0 && sql.indexOf("where l.status = 'active'") !== -1) {
      return { rows: state.listings.filter((row) => row.status === 'active' && row.quantity_remaining > 0 && new Date(row.expires_at).getTime() > Date.now()).map(listingRow) };
    }
    if (sql.indexOf('select l.id, l.seller_character_id, l.item_id') === 0 && sql.indexOf('where l.seller_character_id = $1') !== -1) {
      return { rows: state.listings.filter((row) => String(row.seller_character_id) === String(args[0])).sort((a, b) => Number(b.id) - Number(a.id)).map(listingRow) };
    }
    if (sql.indexOf('select seller_character_id from auction_listings where id = $1') === 0) {
      const row = listing(args[0]);
      return { rows: row ? [{ seller_character_id: row.seller_character_id }] : [] };
    }
    if (sql.indexOf('select id, gold from characters where id = any') === 0) {
      const ids = (args[0] || []).map(String).sort((a, b) => Number(a) - Number(b));
      return { rows: ids.filter((id) => state.characters[id]).map((id) => ({ id, gold: state.characters[id].gold })) };
    }
    if (sql.indexOf('select id from characters where id = $1') === 0) {
      const row = state.characters[String(args[0])];
      return { rows: row ? [{ id: String(args[0]) }] : [] };
    }
    if (sql.indexOf('select count(*)::int as count from auction_listings') === 0) {
      const count = state.listings.filter((row) => String(row.seller_character_id) === String(args[0]) && row.status === 'active' && new Date(row.expires_at).getTime() > Date.now()).length;
      return { rows: [{ count }] };
    }
    if (sql.indexOf('select quantity from character_inventory where character_id = $1 and item_id = $2') === 0) {
      const quantity = inventory(args[0], args[1]);
      return { rows: quantity ? [{ quantity }] : [] };
    }
    if (sql.indexOf('select item_id, quantity from character_inventory where character_id = $1 order by item_id asc') === 0) {
      return { rows: itemRows(args[0]) };
    }
    if (sql.indexOf('select slot, item_id from character_equipment where character_id = $1') === 0) {
      const equipment = state.equipment[String(args[0])] || {};
      return { rows: Object.keys(equipment).map((slot) => ({ slot, item_id: equipment[slot] })) };
    }
    if (sql.indexOf('select id, seller_character_id, item_id, quantity_remaining, status, expires_at from auction_listings where id = $1 for update') === 0) {
      const row = listing(args[0]);
      return { rows: row ? [clone(row)] : [] };
    }
    if (sql.indexOf('select id, seller_character_id, item_id, quantity_remaining, unit_price, status, expires_at from auction_listings where id = $1 for update') === 0) {
      const row = listing(args[0]);
      return { rows: row ? [clone(row)] : [] };
    }
    if (sql.indexOf('delete from character_inventory where character_id = $1 and item_id = $2') === 0) {
      delete state.inventory[String(args[0])][String(args[1])];
      return { rows: [] };
    }
    if (sql.indexOf('update character_inventory set quantity = quantity - $3') === 0) {
      state.inventory[String(args[0])][String(args[1])] -= Number(args[2]);
      return { rows: [] };
    }
    if (sql.indexOf('insert into character_inventory ') === 0) {
      const characterId = String(args[0]);
      const itemId = String(args[1]);
      if (!state.inventory[characterId]) state.inventory[characterId] = {};
      state.inventory[characterId][itemId] = inventory(characterId, itemId) + Number(args[2]);
      return { rows: [] };
    }
    if (sql.indexOf('delete from character_equipment where character_id = $1 and item_id = $2') === 0) {
      const equipment = state.equipment[String(args[0])] || {};
      Object.keys(equipment).forEach((slot) => { if (equipment[slot] === String(args[1])) delete equipment[slot]; });
      return { rows: [] };
    }
    if (sql.indexOf('insert into auction_listings ') === 0) {
      const id = String(state.nextListingId++);
      state.listings.push({ id, seller_character_id: String(args[0]), item_id: String(args[1]), quantity_initial: Number(args[2]), quantity_remaining: Number(args[2]), unit_price: Number(args[3]), status: 'active', created_at: new Date().toISOString(), expires_at: futureDate(), closed_at: null });
      return { rows: [{ id }] };
    }
    if (sql.indexOf('update characters set gold = $1') === 0) {
      state.characters[String(args[1])].gold = Number(args[0]);
      return { rows: [] };
    }
    if (sql.indexOf('update auction_listings set quantity_remaining = $1') === 0) {
      // PostgreSQL must see one consistent type for the repeated status
      // parameter in SET and CASE; a bare $2 caused 42P08 on real pg.
      if (sql.indexOf('status = $2::varchar(16)') === -1 || sql.indexOf('when $2::varchar(16)') === -1) {
        throw new Error('Auction status parameter must be explicitly varchar-cast.');
      }
      const row = listing(args[2]);
      row.quantity_remaining = Number(args[0]);
      row.status = String(args[1]);
      if (row.status === 'sold') row.closed_at = new Date().toISOString();
      return { rows: [] };
    }
    if (sql.indexOf('insert into auction_sales ') === 0) {
      state.sales.push({ listing_id: String(args[0]), seller_character_id: String(args[1]), buyer_character_id: String(args[2]), item_id: String(args[3]), quantity: Number(args[4]), unit_price: Number(args[5]), total_price: Number(args[6]) });
      return { rows: [] };
    }
    if (sql.indexOf("update auction_listings set status = 'cancelled'") === 0 || sql.indexOf("update auction_listings set status = 'expired'") === 0) {
      const row = listing(args[0]);
      row.status = sql.indexOf("'cancelled'") !== -1 ? 'cancelled' : 'expired';
      row.closed_at = new Date().toISOString();
      return { rows: [] };
    }
    throw new Error('Unhandled SQL in auction fixture: ' + text);
  }
  return { state, query, pool: { async connect() { return { query, release() {} }; } }, async close() {} };
}

function makeHarness() {
  const db = makeDatabase({
    nextListingId: 1,
    characters: { '101': { gold: 10, name: 'Aline' }, '202': { gold: 500, name: 'Bastien' } },
    inventory: { '101': { potion: 10, bronze_sword: 1 }, '202': {} },
    equipment: { '101': { etype_1: 'bronze_sword' }, '202': {} }, listings: [], sales: []
  });
  const content = {
    CLASSES: { warrior: { baseStats: { hp: 100, mp: 20, atk: 10, def: 8, mat: 4, mdf: 5, agi: 6, luk: 4 }, mv: {} } },
    BATTLE_ACTIONS: {}, CLASS_ACTIONS: {},
    ITEMS: {
      potion: { id: 'potion', label: 'Potion', type: 'consumable', description: 'Soin', stats: {}, tradable: true },
      bronze_sword: { id: 'bronze_sword', label: 'Épée de bronze', type: 'equipment', slot: 'weapon', etypeId: 1, description: 'Arme', stats: { atk: 7 }, tradable: true }
    }, STARTER_ITEMS: {}, ENCOUNTERS: {}, QUESTS: {}, GUILD_HOUSE: {}, DUNGEONS: {}, START_POSITION: {}
  };
  class Wss { constructor() { this.clients = []; } on() {} }
  const fakeRequire = function(request) {
    if (request === 'dotenv') return { config() {} };
    if (request === 'http') return { createServer() { return { listen(_p, _h, callback) { if (callback) callback(); }, close(callback) { if (callback) callback(); } }; } };
    if (request === 'crypto') return crypto;
    if (request === 'express') return function() { return { disable() {}, get() {} }; };
    if (request === 'bcryptjs') return {};
    if (request === 'ws') return { WebSocketServer: Wss, WebSocket: { OPEN: 1 } };
    if (request === './db') return db;
    if (request === './mv-database') return { dataDirectory() { return '/fixture/mv-data'; } };
    if (request === './mv-events') return {
      verifyTaggedBattleEvent() { return {}; }, nativeEncounterForTroop() { return {}; },
      verifyTaggedNpcAction(context, action) { return { ok: true, mapId: Number(context.mapId), eventId: Number(context.eventId), pageIndex: Number(context.pageIndex), commandIndex: Number(context.commandIndex), service: 'auction_house', action: action, eventX: 10, eventY: 10 }; }
    };
    if (request === './mv-combat') return { statsForClass() { return null; }, className(_id, fallback) { return fallback; } };
    if (request === './mv-inventory') return { definition() { return null; }, menuUseFor() { return null; }, parameterRatesForStates() { return [1, 1, 1, 1, 1, 1, 1, 1]; }, canClassEquip() { return true; } };
    if (request === './content') return content;
    throw new Error('Unexpected module: ' + request);
  };
  const module = { exports: {} };
  vm.runInNewContext(source, { require: fakeRequire, module, exports: module.exports, console: { log() {}, warn() {}, error() {} }, process: { env: {}, on() {}, exit() {} }, Buffer, setInterval() { return { unref() {} }; }, setTimeout() { return { unref() {} }; } }, { filename: 'server.js' });
  return { db, api: module.exports };
}

function socket() { const messages = []; return { readyState: 1, messages, send(raw) { messages.push(JSON.parse(raw)); } }; }
function player(id, name, x, socketInstance) {
  return { socket: socketInstance, characterId: String(id), name, classId: 'warrior', level: 1, experience: 0, gold: 0, currentHp: 100, currentMp: 20, persistentStates: [], paramBonuses: [], equipment: {}, mapId: 1, instanceId: null, x, y: 10, direction: 2, battleId: null, tradeId: null, auctionSessionId: null };
}
async function openAuction(harness, person, sock) {
  await harness.api.handleNpcAction(sock, { requestId: 'request-' + person.characterId, action: 'open', eventContext: { mapId: 1, eventId: 1, pageIndex: 0, commandIndex: 4 } });
  assert.ok(person.auctionSessionId, 'server must create an NPC-bound auction session');
  return person.auctionSessionId;
}
function totalPotion(state) {
  return Object.keys(state.inventory).reduce((sum, id) => sum + Number(state.inventory[id].potion || 0), 0) + state.listings.reduce((sum, row) => sum + (row.item_id === 'potion' && row.status === 'active' ? Number(row.quantity_remaining) : 0), 0);
}

(async function main() {
  const harness = makeHarness();
  const sellerSocket = socket();
  const buyerSocket = socket();
  const seller = player('101', 'Aline', 10, sellerSocket);
  const buyer = player('202', 'Bastien', 11, buyerSocket);
  sellerSocket.player = seller;
  buyerSocket.player = buyer;
  harness.api.onlineByCharacterId.set(seller.characterId, seller);
  harness.api.onlineByCharacterId.set(buyer.characterId, buyer);
  const sellerSession = await openAuction(harness, seller, sellerSocket);
  const buyerSession = await openAuction(harness, buyer, buyerSocket);

  await harness.api.handleAuctionCreate(sellerSocket, { sessionId: sellerSession, itemId: 'potion', quantity: 8, unitPrice: 10 });
  assert.strictEqual(harness.db.state.inventory['101'].potion, 2);
  assert.strictEqual(harness.db.state.listings[0].quantity_remaining, 8);

  await harness.api.handleAuctionBuy(buyerSocket, { sessionId: buyerSession, listingId: '1', quantity: 3 });
  assert.strictEqual(harness.db.state.inventory['202'].potion, 3);
  assert.strictEqual(harness.db.state.listings[0].quantity_remaining, 5);
  assert.strictEqual(harness.db.state.characters['101'].gold, 40);
  assert.strictEqual(harness.db.state.characters['202'].gold, 470);

  await harness.api.handleAuctionBuy(buyerSocket, { sessionId: buyerSession, listingId: '1', quantity: 5 });
  assert.strictEqual(harness.db.state.listings[0].status, 'sold');
  assert.strictEqual(harness.db.state.inventory['202'].potion, 8);
  assert.strictEqual(harness.db.state.characters['101'].gold, 90);
  assert.strictEqual(harness.db.state.characters['202'].gold, 420);
  assert.strictEqual(totalPotion(harness.db.state), 10, 'partial purchases must not duplicate or lose stock');

  await harness.api.handleAuctionCreate(sellerSocket, { sessionId: sellerSession, itemId: 'bronze_sword', quantity: 1, unitPrice: 50 });
  assert.strictEqual(harness.db.state.equipment['101'].etype_1, undefined, 'listed equipment must be unequipped');
  await harness.api.handleAuctionCancel(sellerSocket, { sessionId: sellerSession, listingId: '2' });
  assert.strictEqual(harness.db.state.inventory['101'].bronze_sword, 1);
  assert.strictEqual(harness.db.state.listings[1].status, 'cancelled');

  await harness.api.handleAuctionCreate(sellerSocket, { sessionId: sellerSession, itemId: 'potion', quantity: 2, unitPrice: 9 });
  harness.db.state.listings[2].expires_at = new Date(Date.now() - 1000).toISOString();
  await harness.api.expireAuctionListings();
  assert.strictEqual(harness.db.state.listings[2].status, 'expired');
  assert.strictEqual(harness.db.state.inventory['101'].potion, 2);
  assert.strictEqual(totalPotion(harness.db.state), 10, 'expiry must return exactly the remaining escrow');

  buyer.x = 13;
  await harness.api.handleAuctionBrowse(buyerSocket, { sessionId: buyerSession, filters: {} });
  assert.strictEqual(buyer.auctionSessionId, null, 'leaving NPC range must invalidate the service session');
  assert.ok(buyerSocket.messages.some((packet) => packet.type === 'auctionHouseClosed'));
  console.log('Auction fixtures passed: NPC session, escrow, partial purchase, gold, cancel, expiry, equipment cleanup and range invalidation.');
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
