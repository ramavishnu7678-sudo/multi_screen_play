const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "tv_system.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  -- Registered TV screens
  CREATE TABLE IF NOT EXISTS tvs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT UNIQUE NOT NULL,
    device_id TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    location TEXT DEFAULT '',
    ip_address TEXT DEFAULT '',
    is_online INTEGER DEFAULT 0,
    playback_status TEXT DEFAULT 'stopped',
    current_playlist_id INTEGER,
    current_item_index INTEGER DEFAULT 0,
    loop_enabled INTEGER DEFAULT 0,
    loop_until DATETIME DEFAULT NULL,
    last_seen DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Content library (videos + images)
  CREATE TABLE IF NOT EXISTS content (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT UNIQUE NOT NULL,
    original_name TEXT NOT NULL,
    media_type TEXT DEFAULT 'video',
    size_bytes INTEGER DEFAULT 0,
    duration_seconds INTEGER DEFAULT 0,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Playlists
  CREATE TABLE IF NOT EXISTS playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    tv_id INTEGER REFERENCES tvs(id) ON DELETE CASCADE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Items inside a playlist (ordered)
  CREATE TABLE IF NOT EXISTS playlist_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    content_id INTEGER NOT NULL REFERENCES content(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    display_duration INTEGER DEFAULT 10
  );

  -- TV Groups
  CREATE TABLE IF NOT EXISTS tv_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_name TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS group_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL REFERENCES tv_groups(id) ON DELETE CASCADE,
    tv_id INTEGER NOT NULL REFERENCES tvs(id) ON DELETE CASCADE,
    UNIQUE(group_id, tv_id)
  );

  -- Schedules
  CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_type TEXT NOT NULL,
    target_id INTEGER,
    playlist_id INTEGER REFERENCES playlists(id) ON DELETE CASCADE,
    scheduled_time DATETIME NOT NULL,
    loop_enabled INTEGER DEFAULT 0,
    loop_until DATETIME DEFAULT NULL,
    fired INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Play history
  CREATE TABLE IF NOT EXISTS play_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tv_id INTEGER REFERENCES tvs(id) ON DELETE CASCADE,
    playlist_id INTEGER REFERENCES playlists(id) ON DELETE SET NULL,
    content_id INTEGER REFERENCES content(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    played_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

function generateUUID() { return crypto.randomUUID(); }

module.exports = db;
module.exports.generateUUID = generateUUID;
