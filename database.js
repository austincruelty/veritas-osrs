const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const DATA_DIR = (() => {
  const preferred = process.env.DATA_DIR;
  if (preferred) {
    try { fs.accessSync(preferred, fs.constants.W_OK); return preferred; } catch {}
  }
  return __dirname;
})();
const DB_PATH = path.join(DATA_DIR, 'bingo.db');

let _db = null;
let _saveTimer = null;

function persist() {
  if (!_db) return;
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    const data = _db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  }, 200);
}

const db = {
  exec(sql) {
    _db.run(sql);
    persist();
  },

  get(sql, params = []) {
    const stmt = _db.prepare(sql);
    stmt.bind(params);
    let row = null;
    // Call getAsObject() with NO args to avoid re-binding which resets the statement
    if (stmt.step()) row = stmt.getAsObject();
    stmt.free();
    return row;
  },

  all(sql, params = []) {
    const stmt = _db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    // Call getAsObject() with NO args — passing {} would re-bind and cause infinite loops
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  },

  run(sql, params = []) {
    _db.run(sql, params);
    const idRow = _db.exec('SELECT last_insert_rowid() as id');
    const lastInsertRowid = idRow[0]?.values[0]?.[0] ?? null;
    persist();
    return { lastInsertRowid };
  },

  transaction(fn) {
    return function(...args) {
      _db.run('BEGIN');
      try {
        const result = fn(...args);
        _db.run('COMMIT');
        persist();
        return result;
      } catch (err) {
        _db.run('ROLLBACK');
        throw err;
      }
    };
  }
};

async function init() {
  const SQL = await initSqlJs();
  const fileBuffer = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH) : null;
  _db = fileBuffer ? new SQL.Database(fileBuffer) : new SQL.Database();

  _db.run('PRAGMA foreign_keys = ON');

  _db.run(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    code_word TEXT NOT NULL,
    team1_name TEXT NOT NULL DEFAULT 'Team 1',
    team2_name TEXT NOT NULL DEFAULT 'Team 2',
    status TEXT NOT NULL DEFAULT 'active',
    rules TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  // Migration: add rules column to existing databases
  try { _db.run('ALTER TABLE events ADD COLUMN rules TEXT'); } catch {}

  _db.run(`CREATE TABLE IF NOT EXISTS tiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES events(id),
    row INTEGER NOT NULL,
    col INTEGER NOT NULL,
    tile_name TEXT NOT NULL,
    UNIQUE(event_id, row, col)
  )`);

  _db.run(`CREATE TABLE IF NOT EXISTS tile_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tile_id INTEGER NOT NULL REFERENCES tiles(id),
    item_name TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    wiki_image TEXT,
    group_id INTEGER
  )`);
  // Migrations
  try { _db.run('ALTER TABLE tile_items ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1'); } catch {}
  try { _db.run('ALTER TABLE tile_items ADD COLUMN wiki_image TEXT'); } catch {}
  try { _db.run('ALTER TABLE tile_items ADD COLUMN group_id INTEGER'); } catch {}

  _db.run(`CREATE TABLE IF NOT EXISTS tile_item_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tile_id INTEGER NOT NULL REFERENCES tiles(id),
    group_name TEXT NOT NULL,
    target_count INTEGER NOT NULL DEFAULT 1,
    display_order INTEGER NOT NULL DEFAULT 0
  )`);

  _db.run(`CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES events(id),
    tile_id INTEGER NOT NULL REFERENCES tiles(id),
    tile_item_id INTEGER NOT NULL REFERENCES tile_items(id),
    team INTEGER NOT NULL,
    player_name TEXT NOT NULL,
    screenshot_path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    rejection_reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  _db.run(`CREATE TABLE IF NOT EXISTS team_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES events(id),
    team INTEGER NOT NULL,
    player_name TEXT NOT NULL,
    UNIQUE(event_id, player_name)
  )`);

  _db.run(`CREATE TABLE IF NOT EXISTS event_teams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES events(id),
    team_number INTEGER NOT NULL,
    team_name TEXT NOT NULL,
    UNIQUE(event_id, team_number)
  )`);

  // ── Gamemode templates ──────────────────────────────────────
  _db.run(`CREATE TABLE IF NOT EXISTS gamemodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  _db.run(`CREATE TABLE IF NOT EXISTS gamemode_tiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gamemode_id INTEGER NOT NULL REFERENCES gamemodes(id),
    row INTEGER NOT NULL,
    col INTEGER NOT NULL,
    tile_name TEXT NOT NULL
  )`);

  _db.run(`CREATE TABLE IF NOT EXISTS gamemode_tile_item_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tile_id INTEGER NOT NULL REFERENCES gamemode_tiles(id),
    group_name TEXT NOT NULL,
    target_count INTEGER NOT NULL DEFAULT 1,
    display_order INTEGER NOT NULL DEFAULT 0
  )`);

  _db.run(`CREATE TABLE IF NOT EXISTS gamemode_tile_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tile_id INTEGER NOT NULL REFERENCES gamemode_tiles(id),
    item_name TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    wiki_image TEXT,
    group_id INTEGER
  )`);

  // Seed event_teams from existing team1_name/team2_name columns (idempotent — UNIQUE constraint skips duplicates)
  try {
    const rows = db.all('SELECT id, team1_name, team2_name FROM events');
    for (const ev of rows) {
      try { db.run('INSERT INTO event_teams (event_id, team_number, team_name) VALUES (?, 1, ?)', [ev.id, ev.team1_name || 'Team 1']); } catch {}
      try { db.run('INSERT INTO event_teams (event_id, team_number, team_name) VALUES (?, 2, ?)', [ev.id, ev.team2_name || 'Team 2']); } catch {}
    }
  } catch {}

  // ── Game type on events ──────────────────────────────────────
  try { _db.run("ALTER TABLE events ADD COLUMN game_type TEXT NOT NULL DEFAULT 'bingo'"); } catch {}

  // ── Event timer ───────────────────────────────────────────────
  try { _db.run('ALTER TABLE events ADD COLUMN timer_end TEXT'); } catch {}
  try { _db.run('ALTER TABLE events ADD COLUMN timer_remaining_ms INTEGER'); } catch {}
  try { _db.run('ALTER TABLE events ADD COLUMN timer_running INTEGER NOT NULL DEFAULT 0'); } catch {}

  // ── Roulette tables ──────────────────────────────────────────
  _db.run(`CREATE TABLE IF NOT EXISTS roulette_bosses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wheel_tier INTEGER NOT NULL,
    boss_name TEXT NOT NULL UNIQUE
  )`);

  _db.run(`CREATE TABLE IF NOT EXISTS roulette_boss_drops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    boss_id INTEGER NOT NULL REFERENCES roulette_bosses(id),
    item_name TEXT NOT NULL,
    base_points INTEGER NOT NULL DEFAULT 0,
    UNIQUE(boss_id, item_name)
  )`);

  _db.run(`CREATE TABLE IF NOT EXISTS roulette_event_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL UNIQUE REFERENCES events(id),
    starting_bank INTEGER NOT NULL DEFAULT 500,
    respin_cost INTEGER NOT NULL DEFAULT 200,
    bonus_value INTEGER NOT NULL DEFAULT 100
  )`);

  _db.run(`CREATE TABLE IF NOT EXISTS roulette_spins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES events(id),
    team INTEGER NOT NULL,
    wheel_tier INTEGER NOT NULL,
    boss_id INTEGER NOT NULL REFERENCES roulette_bosses(id),
    bonus_drop_id INTEGER REFERENCES roulette_boss_drops(id),
    spin_cost INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  _db.run(`CREATE TABLE IF NOT EXISTS roulette_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    spin_id INTEGER NOT NULL REFERENCES roulette_spins(id),
    event_id INTEGER NOT NULL REFERENCES events(id),
    team INTEGER NOT NULL,
    player_name TEXT NOT NULL,
    drop_id INTEGER REFERENCES roulette_boss_drops(id),
    points_awarded INTEGER NOT NULL DEFAULT 0,
    bonus_points INTEGER NOT NULL DEFAULT 0,
    screenshot_path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    double_down INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  _db.run(`CREATE TABLE IF NOT EXISTS roulette_bank_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES events(id),
    team INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  try { _db.run('ALTER TABLE roulette_submissions ADD COLUMN double_down INTEGER NOT NULL DEFAULT 0'); } catch {}

  _db.run(`CREATE TABLE IF NOT EXISTS roulette_double_down (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES events(id),
    team INTEGER NOT NULL,
    activated_by TEXT NOT NULL,
    end_time TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // Migrations: boss tier corrections
  try { db.run("UPDATE roulette_bosses SET wheel_tier = 1 WHERE boss_name = 'Gauntlet'"); } catch {}
  try { db.run("ALTER TABLE roulette_boss_drops ADD COLUMN image_url TEXT"); } catch {}

  // Populate known image_url overrides — items whose DB name differs from the wiki file name.
  // Runs every startup (idempotent UPDATE). Add entries here instead of editing them in Boss Manager.
  const W = 'https://oldschool.runescape.wiki/w/Special:FilePath/';
  const BOSS_DROP_URL_OVERRIDES = [
    // Chambers of Xeric
    { boss:'Chambers of Xeric',  item:'Twisted Kit',              file:'Twisted_ancestral_colour_kit.png' },
    { boss:'Chambers of Xeric',  item:'Dust',                     file:'Metamorphic_dust.png' },
    { boss:'Chambers of Xeric',  item:'Pet',                      file:'Olmlet.png' },
    // Theatre of Blood
    { boss:'Theatre of Blood',   item:'Dust',                     file:'Sanguine_dust.png' },
    { boss:'Theatre of Blood',   item:'Pet',                      file:"Lil'_zik.png" },
    // Tombs of Amascut
    { boss:'Tombs of Amascut',   item:'Pet',                      file:"Tumeken's_warden.png" },
    // Desert Treasure II
    { boss:'Duke Sucellus',      item:'Pet',                      file:'Duke_(pet).png' },
    { boss:'The Leviathan',      item:'Pet',                      file:"Lil'_leviathan.png" },
    { boss:'Vardorvis',          item:'Pet',                      file:'Butch.png' },
    { boss:'The Whisperer',      item:'Pet',                      file:'Wisp.png' },
    // Nex
    { boss:'Nex',                item:'Pet',                      file:'Nexling.png' },
    // The Nightmare
    { boss:'The Nightmare',      item:'Jar',                      file:'Jar_of_dreams.png' },
    { boss:'The Nightmare',      item:'Pet',                      file:'Little_nightmare.png' },
    // Corporeal Beast
    { boss:'Corporeal Beast',    item:'Jar',                      file:'Jar_of_spirits.png' },
    { boss:'Corporeal Beast',    item:'Pet',                      file:'Corporeal_critter.png' },
    // Gauntlet
    { boss:'Gauntlet',           item:'Pet',                      file:'Youngllef.png' },
    // Amoxliatl (user-confirmed)
    { boss:'Amoxliatl',          item:'Glacial Temotlatl',        file:'Glacial_temotli.png' },
    { boss:'Amoxliatl',          item:'Pet',                      file:'Moxi.png' },
    // Armadyl (user-confirmed)
    { boss:'Armadyl',            item:'Armadyl Helmet',           file:'Armadyl_helmet.png' },
    { boss:'Armadyl',            item:'Armadyl Chestplate',       file:'Armadyl_chestplate.png' },
    { boss:'Armadyl',            item:'Armadyl Chainskirt',       file:'Armadyl_chainskirt.png' },
    { boss:'Armadyl',            item:'Armadyl Godsword',         file:'Armadyl_hilt.png' },
    { boss:'Armadyl',            item:'Pet',                      file:"Pet_Kree'arra.png" },
    // Bandos (user-confirmed)
    { boss:'Bandos',             item:'Bandos Godsword',          file:'Bandos_hilt.png' },
    { boss:'Bandos',             item:'Bandos Chestplate',        file:'Bandos_chestplate.png' },
    { boss:'Bandos',             item:'Bandos Tassets',           file:'Bandos_tassets.png' },
    { boss:'Bandos',             item:'Bandos Boots',             file:'Bandos_boots.png' },
    { boss:'Bandos',             item:'Pet',                      file:'Pet_General_Graardor.png' },
    // Artio/Callisto (user-confirmed)
    { boss:'Artio/Callisto',     item:'Claws of Callisto',        file:'Claws_of_Callisto.png' },
    { boss:'Artio/Callisto',     item:'Tyrannical Ring',          file:'Tyrannical_ring.png' },
    { boss:'Artio/Callisto',     item:'Voidwaker Hilt',           file:'Voidwaker_hilt.png' },
    { boss:'Artio/Callisto',     item:'Pet',                      file:'Callisto_cub.png' },
    // Calvar'ion/Vet'ion (user-confirmed)
    { boss:"Calvar'ion/Vet'ion", item:"Skull of Vet'ion",         file:"Skull_of_Vet'ion.png" },
    { boss:"Calvar'ion/Vet'ion", item:'Ring of the Gods',         file:'Ring_of_the_gods.png' },
    { boss:"Calvar'ion/Vet'ion", item:'Voidwaker Blade',          file:'Voidwaker_blade.png' },
    { boss:"Calvar'ion/Vet'ion", item:'Pet',                      file:"Vet'ion_Jr..png" },
    // Dagannoth Kings (user-confirmed — 3 separate pet drops)
    { boss:'Dagannoth Kings',    item:"Archer's Ring",            file:'Archers_ring.png' },
    { boss:'Dagannoth Kings',    item:"Berserker's Ring",         file:'Berserker_ring.png' },
    { boss:'Dagannoth Kings',    item:"Seer's Ring",              file:'Seers_ring.png' },
    { boss:'Dagannoth Kings',    item:"Warrior's Ring",           file:'Warrior_ring.png' },
    { boss:'Dagannoth Kings',    item:'Pet',                      file:'Pet_Dagannoth_Rex.png' },
    { boss:'Dagannoth Kings',    item:'Pet Dagannoth Prime',      file:'Pet_Dagannoth_Prime.png' },
    { boss:'Dagannoth Kings',    item:'Pet Dagannoth Rex',        file:'Pet_Dagannoth_Rex.png' },
    { boss:'Dagannoth Kings',    item:'Pet Dagannoth Supreme',    file:'Pet_Dagannoth_Supreme.png' },
    // Wilderness — Spindel/Venenatis
    { boss:'Spindel/Venenatis',  item:'Pet',                      file:'Venenatis_spiderling.png' },
    // GWD — remaining
    { boss:'Zamorak',            item:'Pet',                      file:"K'ril_Jr..png" },
    { boss:'Saradomin',          item:'Pet',                      file:'Commander_zilyana_jr..png' },
    // Other
    { boss:'Vorkath',            item:'Pet',                      file:'Vorki.png' },
    { boss:'Zulrah',             item:'Pet',                      file:'Snakeling.png' },
    { boss:'Sarachnis',          item:'Pet',                      file:'Sraracha.png' },
    { boss:'Hueycoatl',          item:'Pet',                      file:'Baby_hueycoatl.png' },
    { boss:'Kalphite Queen',     item:'KQ Head',                  file:"Kalphite_queen's_head.png" },
    { boss:'Kalphite Queen',     item:'Pet',                      file:'Kalphite_princess.png' },
    { boss:'King Black Dragon',  item:'KBD Heads',                file:'King_black_dragon_heads.png' },
    { boss:'King Black Dragon',  item:'Pet',                      file:'Prince_black_dragon.png' },
  ];
  for (const o of BOSS_DROP_URL_OVERRIDES) {
    try {
      db.run(
        `UPDATE roulette_boss_drops SET image_url = ?
         WHERE item_name = ? AND image_url IS NULL
           AND boss_id = (SELECT id FROM roulette_bosses WHERE boss_name = ?)`,
        [W + o.file, o.item, o.boss]
      );
    } catch {}
  }
  // Correct previously-migrated entries where the old filename was wrong (targets the old URL specifically)
  const CORRECTIONS = [
    { boss:'Amoxliatl',          item:'Pet',  old:'Baby_amoxliatl.png',    file:'Moxi.png' },
    { boss:'Armadyl',            item:'Pet',  old:"Kree'arra.png",          file:"Pet_Kree'arra.png" },
    { boss:'Bandos',             item:'Pet',  old:'General_graardor_jr..png', file:'Pet_General_Graardor.png' },
    { boss:"Calvar'ion/Vet'ion", item:'Pet',  old:"Vet'ion_jr..png",        file:"Vet'ion_Jr..png" },
    { boss:'Dagannoth Kings',    item:'Pet',  old:'Dagannoth_rex_jr..png',  file:'Pet_Dagannoth_Rex.png' },
  ];
  for (const c of CORRECTIONS) {
    try {
      db.run(
        `UPDATE roulette_boss_drops SET image_url = ?
         WHERE item_name = ? AND image_url = ?
           AND boss_id = (SELECT id FROM roulette_bosses WHERE boss_name = ?)`,
        [W + c.file, c.item, W + c.old, c.boss]
      );
    } catch {}
  }

  // Seed boss/drop data (runs once)
  const bossCount = db.get('SELECT COUNT(*) as c FROM roulette_bosses');
  if (!bossCount || bossCount.c === 0) {
    const SEED = [
      // ── Tier 1 (High) ──────────────────────────────────────
      { tier:1, name:'Chambers of Xeric', drops:[
        ['Arcane Prayer Scroll',75],['Dexterous Prayer Scroll',75],['Twisted Buckler',100],
        ['Dragon Hunter Crossbow',100],['Ancestral Hat',150],['Ancestral Robe Top',150],
        ['Ancestral Robe Bottom',150],['Dragon Claws',150],['Elder Maul',300],
        ['Kodai Insignia',300],['Twisted Bow',300],['Twisted Kit',75],['Dust',500],['Pet',500],
      ]},
      { tier:1, name:'Theatre of Blood', drops:[
        ['Avernic Defender Hilt',75],['Justiciar Faceguard',125],['Justiciar Chestguard',125],
        ['Justiciar Legguards',125],['Sanguinesti Staff',125],['Ghrazi Rapier',125],
        ['Scythe of Vitur',300],['Dust',500],['Holy Ornament Kit',200],
        ['Sanguine Ornament Kit',200],['Pet',500],
      ]},
      { tier:1, name:'Tombs of Amascut', drops:[
        ['Lightbearer',75],["Osmumten's Fang",75],["Elidinis' Ward",75],
        ['Masori Mask',125],['Masori Body',125],['Masori Chaps',125],
        ["Tumeken's Shadow",300],['Pet',500],
      ]},
      { tier:1, name:'Duke Sucellus', drops:[
        ['Chromium Ingot',50],['Magus Ring Vestige',200],['Eye of Duke',200],
        ['Virtus Mask',150],['Virtus Robe Top',150],['Virtus Robe Bottom',150],['Pet',500],
      ]},
      { tier:1, name:'The Leviathan', drops:[
        ['Chromium Ingot',50],['Venator Ring Vestige',200],["Leviathan's Lure",200],
        ['Virtus Mask',150],['Virtus Robe Top',150],['Virtus Robe Bottom',150],['Pet',500],
      ]},
      { tier:1, name:'Vardorvis', drops:[
        ['Chromium Ingot',50],['Ultor Ring Vestige',200],["Executioner's Axe Head",200],
        ['Virtus Mask',150],['Virtus Robe Top',150],['Virtus Robe Bottom',150],['Pet',500],
      ]},
      { tier:1, name:'The Whisperer', drops:[
        ['Chromium Ingot',50],['Bellator Ring Vestige',200],["Awakener's Orb",200],
        ['Virtus Mask',150],['Virtus Robe Top',150],['Virtus Robe Bottom',150],['Pet',500],
      ]},
      { tier:1, name:'Nex', drops:[
        ['Torva Full Helm',200],['Torva Platebody',200],['Torva Platelegs',200],
        ['Nihil Horn',250],['Ancient Godsword',400],['Pet',500],
      ]},
      { tier:1, name:'Yama', drops:[
        ['Soulflame Horn',125],['Oathplate Helm',175],['Oathplate Body',175],
        ['Oathplate Legs',175],['Pet',500],
      ]},
      { tier:1, name:'Sol Heredit', drops:[
        ['Echo Crystal',50],['Sunfire Fanatic Helm',100],['Sunfire Fanatic Cuirass',100],
        ['Sunfire Fanatic Chausses',100],['Tonalztics of Ralos',150],['Pet',500],
      ]},
      { tier:1, name:'The Nightmare', drops:[
        ["Inquisitor's Great Helm",150],["Inquisitor's Hauberk",150],["Inquisitor's Plateskirt",150],
        ["Inquisitor's Mace",200],['Nightmare Staff',100],['Harmonised Orb',250],
        ['Volatile Orb',250],['Eldritch Orb',250],['Jar',300],['Pet',500],
      ]},
      { tier:1, name:'Doom', drops:[
        ['Eye of Ayak',200],['Avernic Treads',250],['Mokhaiotl Cloth',150],['Pet',200],
      ]},
      { tier:1, name:'Corporeal Beast', drops:[
        ['Arcane Sigil',250],['Spectral Sigil',250],['Elysian Sigil',250],['Jar',300],['Pet',500],
      ]},
      // ── Tier 2 (Mid/Low) ───────────────────────────────────
      { tier:2, name:'Artio/Callisto', drops:[
        ['Claws of Callisto',100],['Tyrannical Ring',75],['Voidwaker Hilt',125],['Pet',500],
      ]},
      { tier:2, name:"Calvar'ion/Vet'ion", drops:[
        ["Skull of Vet'ion",100],['Ring of the Gods',75],['Voidwaker Blade',125],['Pet',500],
      ]},
      { tier:2, name:'Spindel/Venenatis', drops:[
        ['Fangs of Venenatis',100],['Treasonous Ring',75],['Voidwaker Gem',125],['Pet',500],
      ]},
      { tier:2, name:'Armadyl', drops:[
        ['Armadyl Helmet',100],['Armadyl Chestplate',100],['Armadyl Chainskirt',100],
        ['Armadyl Godsword',150],['Pet',500],
      ]},
      { tier:2, name:'Zamorak', drops:[
        ['Zamorakian Spear',50],['Staff of the Dead',100],['Steam Battlestaff',50],
        ['Zamorak Godsword',150],['Pet',500],
      ]},
      { tier:2, name:'Saradomin', drops:[
        ['Saradomin Godsword',150],['Armadyl Crossbow',150],["Saradomin's Light",50],
        ['Saradomin Sword',50],['Pet',500],
      ]},
      { tier:2, name:'Bandos', drops:[
        ['Bandos Godsword',150],['Bandos Chestplate',100],['Bandos Tassets',100],
        ['Bandos Boots',50],['Pet',500],
      ]},
      { tier:2, name:'Dagannoth Kings', drops:[
        ["Archer's Ring",75],["Berserker's Ring",75],["Seer's Ring",75],
        ["Warrior's Ring",75],['Pet',500],
      ]},
      { tier:2, name:'Vorkath', drops:[
        ['Draconic Visage',150],['Skeletal Visage',150],['Dragonbone Necklace',100],
        ["Vorkath's Head",50],['Jar of Decay',150],['Pet',500],
      ]},
      { tier:1, name:'Gauntlet', drops:[
        ['Crystal Weapon Seed',75],['Crystal Armour Seed',100],
        ['Enhanced Crystal Weapon Seed',200],['Pet',500],
      ]},
      { tier:2, name:'Zulrah', drops:[
        ['Serpentine Visage',100],['Magic Fang',100],['Tanzanite Fang',100],
        ['Jar of Swamp',200],['Tanzanite Mutagen',300],['Magma Mutagen',300],['Pet',300],
      ]},
      { tier:2, name:'Sarachnis', drops:[
        ['Sarachnis Cudgel',75],['Giant Egg Sac',300],['Pet',500],
      ]},
      { tier:2, name:'Hueycoatl', drops:[
        ['Tome of Earth',75],['Dragonhunter Wand',100],['Hueycoatl Hide',50],['Pet',300],
      ]},
      { tier:2, name:'Kalphite Queen', drops:[
        ['KQ Head',50],['Dragon Chainbody',50],['Jar of Sand',250],['Pet',500],
      ]},
      { tier:2, name:'Phantom Muspah', drops:[
        ['Venator Shard',75],['Pet',500],
      ]},
      { tier:2, name:'Amoxliatl', drops:[
        ['Glacial Temotlatl',50],['Pet',500],
      ]},
      { tier:2, name:'Lunar Chest', drops:[['Any Piece',50]]},
      { tier:2, name:'Barrows', drops:[['Any Piece',50]]},
      { tier:2, name:'King Black Dragon', drops:[
        ['KBD Heads',50],['Draconic Visage',150],['Pet',500],
      ]},
    ];
    for (const boss of SEED) {
      try {
        const r = db.run('INSERT OR IGNORE INTO roulette_bosses (wheel_tier, boss_name) VALUES (?, ?)', [boss.tier, boss.name]);
        let bossId = r.lastInsertRowid;
        if (!bossId) bossId = db.get('SELECT id FROM roulette_bosses WHERE boss_name = ?', [boss.name])?.id;
        if (bossId) {
          for (const [item, pts] of boss.drops) {
            try { db.run('INSERT OR IGNORE INTO roulette_boss_drops (boss_id, item_name, base_points) VALUES (?, ?, ?)', [bossId, item, pts]); } catch {}
          }
        }
      } catch {}
    }
  }

  return db;
}

module.exports = { db, init };
