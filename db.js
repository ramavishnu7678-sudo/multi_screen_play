const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

function generateUUID() {
  return crypto.randomUUID();
}

const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "tv_system.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ================= SCHEMA =================
db.exec(`
  CREATE TABLE IF NOT EXISTS tvs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT UNIQUE NOT NULL,             -- generated UUID, primary public identifier
    device_id TEXT UNIQUE NOT NULL,       -- the deviceId used in /client/:deviceId
    name TEXT,
    location TEXT DEFAULT '',
    ip_address TEXT DEFAULT '',
    is_online INTEGER DEFAULT 0,
    current_video TEXT DEFAULT NULL,
    playback_status TEXT DEFAULT 'stopped',  -- playing | paused | stopped
    loop_enabled INTEGER DEFAULT 1,
    loop_duration INTEGER DEFAULT 0,   -- seconds; 0 = infinite
    last_seen DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT UNIQUE NOT NULL,
    original_name TEXT,
    size_bytes INTEGER DEFAULT 0,
    media_type TEXT DEFAULT 'video',   -- 'video' | 'image'
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

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

  CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_type TEXT NOT NULL,            -- 'all' | 'tv' | 'group'
    target_id INTEGER,                    -- tv.id or group.id, NULL if 'all'
    video_id INTEGER REFERENCES videos(id) ON DELETE CASCADE,
    scheduled_time DATETIME NOT NULL,
    loop_enabled INTEGER DEFAULT 1,
    loop_duration INTEGER DEFAULT 0,   -- seconds; 0 = infinite
    fired INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS play_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tv_id INTEGER REFERENCES tvs(id) ON DELETE CASCADE,
    group_id INTEGER REFERENCES tv_groups(id) ON DELETE SET NULL,
    video_id INTEGER REFERENCES videos(id) ON DELETE SET NULL,
    action TEXT NOT NULL,                  -- play | pause | stop
    played_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ================= MIGRATIONS =================
// Safely add columns that may be missing from databases created before the current schema.

const existingScheduleCols = db.pragma("table_info(schedules)").map(c => c.name);

if (!existingScheduleCols.includes("loop_enabled")) {
  db.exec("ALTER TABLE schedules ADD COLUMN loop_enabled INTEGER DEFAULT 1");
  console.log("[migration] Added loop_enabled to schedules");
}

if (!existingScheduleCols.includes("loop_duration")) {
  db.exec("ALTER TABLE schedules ADD COLUMN loop_duration INTEGER DEFAULT 0");
  console.log("[migration] Added loop_duration to schedules");
}

const existingTvCols = db.pragma("table_info(tvs)").map(c => c.name);

const existingVideoCols = db.pragma("table_info(videos)").map(c => c.name);

if (!existingVideoCols.includes("media_type")) {
  db.exec("ALTER TABLE videos ADD COLUMN media_type TEXT DEFAULT 'video'");
  console.log("[migration] Added media_type to videos");
}

if (!existingTvCols.includes("loop_enabled")) {
  db.exec("ALTER TABLE tvs ADD COLUMN loop_enabled INTEGER DEFAULT 1");
  console.log("[migration] Added loop_enabled to tvs");
}

if (!existingTvCols.includes("loop_duration")) {
  db.exec("ALTER TABLE tvs ADD COLUMN loop_duration INTEGER DEFAULT 0");
  console.log("[migration] Added loop_duration to tvs");
}

module.exports = db;
module.exports.generateUUID = generateUUID;
