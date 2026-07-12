const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const db = require("./db");
const { generateUUID } = require("./db");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const MEDIA_DIR = path.join(__dirname, "videos");
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

// device_id -> socket.id (live connections)
const liveSockets = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/media", express.static(MEDIA_DIR));

// ─────────────────────────── UPLOAD ────────────────────────────
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, MEDIA_DIR),
    filename: (req, file, cb) => cb(null, Date.now() + "_" + file.originalname.replace(/\s+/g, "_"))
  }),
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype.startsWith("video/") || file.mimetype.startsWith("image/");
    cb(null, ok);
  }
});

function mediaType(mimetype) { return mimetype.startsWith("image/") ? "image" : "video"; }

// ─────────────────────────── PAGES ─────────────────────────────
app.get("/",          (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/devices",   (req, res) => res.sendFile(path.join(__dirname, "public", "devices.html")));
app.get("/content",   (req, res) => res.sendFile(path.join(__dirname, "public", "content.html")));
app.get("/client/:deviceId", (req, res) => {
  const { deviceId } = req.params;
  const existing = db.prepare("SELECT id FROM tvs WHERE device_id=?").get(deviceId);
  if (!existing) {
    db.prepare("INSERT INTO tvs (uid,device_id,name) VALUES (?,?,?)")
      .run(generateUUID(), deviceId, deviceId);
  }
  res.sendFile(path.join(__dirname, "public", "client.html"));
});

// ─────────────────────────── TV API ────────────────────────────
app.get("/api/tvs", (req, res) => {
  const tvs = db.prepare("SELECT * FROM tvs ORDER BY created_at DESC").all()
    .map(tv => ({ ...tv, is_online: liveSockets.has(tv.device_id) ? 1 : 0 }));
  res.json(tvs);
});

app.post("/api/tvs", (req, res) => {
  const { name, location = "", ip_address = "" } = req.body;
  if (!name) return res.status(400).json({ message: "Name required" });
  const uid = generateUUID();
  const device_id = name.trim().replace(/\s+/g, "-") + "-" + uid.slice(0, 8);
  db.prepare("INSERT INTO tvs (uid,device_id,name,location,ip_address) VALUES (?,?,?,?,?)")
    .run(uid, device_id, name.trim(), location, ip_address);
  res.json(db.prepare("SELECT * FROM tvs WHERE uid=?").get(uid));
  broadcastTvList();
});

app.delete("/api/tvs/:id", (req, res) => {
  const tv = db.prepare("SELECT * FROM tvs WHERE id=?").get(req.params.id);
  if (!tv) return res.status(404).json({ message: "Not found" });
  db.prepare("DELETE FROM tvs WHERE id=?").run(tv.id);
  liveSockets.delete(tv.device_id);
  broadcastTvList();
  res.json({ message: `"${tv.name}" removed` });
});

app.get("/api/tv-info/:deviceId", (req, res) => {
  const tv = db.prepare("SELECT * FROM tvs WHERE device_id=?").get(req.params.deviceId);
  if (!tv) return res.status(404).json({ message: "Not found" });

  // Attach current playlist + items if active
  let playlist = null;
  if (tv.current_playlist_id) {
    playlist = getPlaylistWithItems(tv.current_playlist_id);
  }
  res.json({ ...tv, is_online: liveSockets.has(tv.device_id) ? 1 : 0, playlist });
});

// ─────────────────────────── CONTENT API ───────────────────────
app.get("/api/content", (req, res) => {
  res.json(db.prepare("SELECT * FROM content ORDER BY uploaded_at DESC").all());
});

app.post("/api/upload", upload.array("files", 20), (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ message: "No files uploaded" });
  const inserted = req.files.map(f => {
    db.prepare("INSERT OR IGNORE INTO content (filename,original_name,media_type,size_bytes) VALUES (?,?,?,?)")
      .run(f.filename, f.originalname, mediaType(f.mimetype), f.size);
    return db.prepare("SELECT * FROM content WHERE filename=?").get(f.filename);
  });
  res.json({ message: `${inserted.length} file(s) uploaded`, items: inserted });
});

app.delete("/api/content/:id", (req, res) => {
  const item = db.prepare("SELECT * FROM content WHERE id=?").get(req.params.id);
  if (!item) return res.status(404).json({ message: "Not found" });
  const fp = path.join(MEDIA_DIR, item.filename);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  db.prepare("DELETE FROM content WHERE id=?").run(item.id);
  res.json({ message: `"${item.original_name}" deleted` });
});

// ─────────────────────────── PLAYLIST API ──────────────────────
function getPlaylistWithItems(playlistId) {
  const pl = db.prepare("SELECT * FROM playlists WHERE id=?").get(playlistId);
  if (!pl) return null;
  const items = db.prepare(`
    SELECT pi.*, c.filename, c.original_name, c.media_type, c.size_bytes
    FROM playlist_items pi
    JOIN content c ON c.id = pi.content_id
    WHERE pi.playlist_id=?
    ORDER BY pi.position ASC
  `).all(playlistId);
  return { ...pl, items };
}

// List playlists for a TV (includes items)
app.get("/api/tvs/:tvId/playlists", (req, res) => {
  const playlists = db.prepare("SELECT * FROM playlists WHERE tv_id=? ORDER BY created_at DESC")
    .all(req.params.tvId)
    .map(pl => getPlaylistWithItems(pl.id));
  res.json(playlists);
});

app.get("/api/playlists/:id", (req, res) => {
  const pl = getPlaylistWithItems(req.params.id);
  if (!pl) return res.status(404).json({ message: "Not found" });
  res.json(pl);
});

// List ALL playlists (for admin dashboard)
app.get("/api/playlists", (req, res) => {
  const rows = db.prepare("SELECT * FROM playlists ORDER BY created_at DESC").all();
  res.json(rows.map(pl => getPlaylistWithItems(pl.id)));
});

// Create playlist for a TV
app.post("/api/playlists", (req, res) => {
  const { name, tv_id, items } = req.body;
  // items = [{content_id, display_duration}, ...]
  if (!name) return res.status(400).json({ message: "Playlist name required" });

  const info = db.prepare("INSERT INTO playlists (name,tv_id) VALUES (?,?)").run(name, tv_id || null);
  const playlistId = info.lastInsertRowid;

  if (Array.isArray(items)) {
    items.forEach((item, i) => {
      db.prepare("INSERT INTO playlist_items (playlist_id,content_id,position,display_duration) VALUES (?,?,?,?)")
        .run(playlistId, item.content_id, i, item.display_duration || 10);
    });
  }

  res.json(getPlaylistWithItems(playlistId));
});

// Update playlist items (rebuild)
app.put("/api/playlists/:id", (req, res) => {
  const { name, items } = req.body;
  const pl = db.prepare("SELECT * FROM playlists WHERE id=?").get(req.params.id);
  if (!pl) return res.status(404).json({ message: "Not found" });

  if (name) db.prepare("UPDATE playlists SET name=? WHERE id=?").run(name, pl.id);
  if (Array.isArray(items)) {
    db.prepare("DELETE FROM playlist_items WHERE playlist_id=?").run(pl.id);
    items.forEach((item, i) => {
      db.prepare("INSERT INTO playlist_items (playlist_id,content_id,position,display_duration) VALUES (?,?,?,?)")
        .run(pl.id, item.content_id, i, item.display_duration || 10);
    });
  }

  res.json(getPlaylistWithItems(pl.id));
});

app.delete("/api/playlists/:id", (req, res) => {
  const pl = db.prepare("SELECT * FROM playlists WHERE id=?").get(req.params.id);
  if (!pl) return res.status(404).json({ message: "Not found" });
  db.prepare("DELETE FROM playlists WHERE id=?").run(pl.id);
  res.json({ message: `"${pl.name}" deleted` });
});

// Append items to existing playlist without restarting playback
app.post("/api/playlists/:id/append", (req, res) => {
  const { items } = req.body;
  const pl = db.prepare("SELECT * FROM playlists WHERE id=?").get(req.params.id);
  if (!pl) return res.status(404).json({ message: "Playlist not found" });

  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ message: "No items to append" });
  }

  const currentItems = db.prepare("SELECT COUNT(*) as count FROM playlist_items WHERE playlist_id=?").get(pl.id).count;
  
  items.forEach((item, i) => {
    db.prepare("INSERT INTO playlist_items (playlist_id,content_id,position,display_duration) VALUES (?,?,?,?)")
      .run(pl.id, item.content_id, currentItems + i, item.display_duration || 10);
  });

  res.json(getPlaylistWithItems(pl.id));
});

// ─────────────────────────── GROUPS API ────────────────────────
app.get("/api/groups", (req, res) => {
  const groups = db.prepare("SELECT * FROM tv_groups ORDER BY group_name").all().map(g => {
    const members = db.prepare(`
      SELECT tvs.* FROM group_members
      JOIN tvs ON tvs.id=group_members.tv_id
      WHERE group_members.group_id=?
    `).all(g.id).map(tv => ({ ...tv, is_online: liveSockets.has(tv.device_id) ? 1 : 0 }));
    return { ...g, members };
  });
  res.json(groups);
});

app.post("/api/groups", (req, res) => {
  const { group_name } = req.body;
  if (!group_name) return res.status(400).json({ message: "Name required" });
  try {
    db.prepare("INSERT INTO tv_groups (group_name) VALUES (?)").run(group_name);
    res.json(db.prepare("SELECT * FROM tv_groups WHERE group_name=?").get(group_name));
  } catch (e) {
    res.status(400).json({ message: "Group already exists" });
  }
});

app.post("/api/groups/:id/members", (req, res) => {
  const { tv_ids } = req.body; // array of tv.id
  const group = db.prepare("SELECT * FROM tv_groups WHERE id=?").get(req.params.id);
  if (!group) return res.status(404).json({ message: "Not found" });

  db.prepare("DELETE FROM group_members WHERE group_id=?").run(group.id);
  (tv_ids || []).forEach(tvId => {
    db.prepare("INSERT OR IGNORE INTO group_members (group_id,tv_id) VALUES (?,?)").run(group.id, tvId);
  });
  res.json({ message: "Members saved" });
});

app.delete("/api/groups/:id", (req, res) => {
  const g = db.prepare("SELECT * FROM tv_groups WHERE id=?").get(req.params.id);
  if (!g) return res.status(404).json({ message: "Not found" });
  db.prepare("DELETE FROM tv_groups WHERE id=?").run(g.id);
  res.json({ message: `"${g.group_name}" deleted` });
});

// ─────────────────────────── PLAY CONTENT ──────────────────────
// Push a playlist to a TV / group / all
app.post("/api/push", (req, res) => {
  const { targetType, targetId, playlist_id, loop, loopUntil, scheduleTime } = req.body;
  const pl = db.prepare("SELECT * FROM playlists WHERE id=?").get(playlist_id);
  if (!pl) return res.status(404).json({ message: "Playlist not found" });

  if (scheduleTime) {
    let target_id = null;
    if (targetType === "tv") {
      const tv = db.prepare("SELECT * FROM tvs WHERE device_id=?").get(targetId);
      target_id = tv ? tv.id : null;
    } else if (targetType === "group") {
      const g = db.prepare("SELECT * FROM tv_groups WHERE id=?").get(targetId);
      target_id = g ? g.id : null;
    }
    db.prepare(`
      INSERT INTO schedules (target_type,target_id,playlist_id,scheduled_time,loop_enabled,loop_until)
      VALUES (?,?,?,?,?,?)
    `).run(targetType || "all", target_id, playlist_id, scheduleTime, loop ? 1 : 0, loopUntil || null);
    return res.json({ message: `Scheduled "${pl.name}" for ${scheduleTime}` });
  }

  pushPlaylist(targetType, targetId, playlist_id, !!loop, loopUntil || null);
  res.json({ message: `Pushed "${pl.name}" to screens` });
});

// ─────────────────────────── SCHEDULE LOOP ─────────────────────
setInterval(() => {
  const now = new Date().toISOString().slice(0, 16);
  const due = db.prepare("SELECT * FROM schedules WHERE fired=0 AND scheduled_time<=?").all(now);
  due.forEach(job => {
    pushPlaylist(job.target_type, job.target_id, job.playlist_id, !!job.loop_enabled, job.loop_until);
    db.prepare("UPDATE schedules SET fired=1 WHERE id=?").run(job.id);
  });

  // Auto-stop TVs whose loop window expired
  const nowFull = new Date().toISOString();
  db.prepare("SELECT * FROM tvs WHERE playback_status='playing' AND loop_until IS NOT NULL AND loop_until<=?")
    .all(nowFull)
    .forEach(tv => sendToDevice(tv.device_id, { type: "stop" }, tv));
}, 30000);

// ─────────────────────────── DISPATCH ──────────────────────────
function pushPlaylist(targetType, targetId, playlistId, loop, loopUntil) {
  const pl = getPlaylistWithItems(playlistId);
  if (!pl || !pl.items.length) return;

  if (targetType === "all") {
    db.prepare("SELECT device_id FROM tvs").all()
      .forEach(tv => sendPlaylistToDevice(tv.device_id, pl, loop, loopUntil));
  } else if (targetType === "group") {
    db.prepare(`
      SELECT tvs.device_id FROM group_members
      JOIN tvs ON tvs.id=group_members.tv_id
      WHERE group_members.group_id=?
    `).all(targetId).forEach(tv => sendPlaylistToDevice(tv.device_id, pl, loop, loopUntil));
  } else if (targetType === "tv") {
    // targetId here = device_id string OR numeric tv.id
    const tv = isNaN(targetId)
      ? db.prepare("SELECT * FROM tvs WHERE device_id=?").get(targetId)
      : db.prepare("SELECT * FROM tvs WHERE id=?").get(targetId);
    if (tv) sendPlaylistToDevice(tv.device_id, pl, loop, loopUntil);
  }
}

function sendPlaylistToDevice(deviceId, pl, loop, loopUntil) {
  const tv = db.prepare("SELECT * FROM tvs WHERE device_id=?").get(deviceId);
  if (!tv) return;

  db.prepare(`
    UPDATE tvs SET current_playlist_id=?, current_item_index=0,
           playback_status='playing', loop_enabled=?, loop_until=?
    WHERE id=?
  `).run(pl.id, loop ? 1 : 0, loopUntil || null, tv.id);

  db.prepare("INSERT INTO play_history (tv_id,playlist_id,action) VALUES (?,?,?)")
    .run(tv.id, pl.id, "play");

  sendToDevice(deviceId, {
    type: "load_playlist",
    playlist: pl,
    loop,
    loopUntil: loopUntil || null
  }, tv);

  broadcastTvList();
}

function sendToDevice(deviceId, payload, tvRow) {
  const sockId = liveSockets.get(deviceId);
  if (sockId) io.to(sockId).emit("action", payload);

  if (tvRow) {
    if (payload.type === "resume") {
      db.prepare("UPDATE tvs SET playback_status='playing' WHERE id=?").run(tvRow.id);
    } else if (payload.type === "pause") {
      db.prepare("UPDATE tvs SET playback_status='paused' WHERE id=?").run(tvRow.id);
    } else if (payload.type === "stop") {
      db.prepare("UPDATE tvs SET playback_status='stopped', loop_until=NULL WHERE id=?").run(tvRow.id);
    }
  }

  broadcastTvList();
}

function updatePlaylistOnDevice(targetType, targetId, playlist) {
  if (targetType === "tv") {
    const tv = db.prepare("SELECT * FROM tvs WHERE device_id=?").get(targetId);
    if (!tv) return;
    
    const sockId = liveSockets.get(tv.device_id);
    if (sockId) {
      io.to(sockId).emit("action", {
        type: "update_playlist",
        playlist: playlist
      });
    }
    
    broadcastTvList();
  } else if (targetType === "group") {
    db.prepare(`
      SELECT tvs.device_id FROM group_members
      JOIN tvs ON tvs.id=group_members.tv_id
      WHERE group_members.group_id=?
    `).all(targetId).forEach(tv => {
      const sockId = liveSockets.get(tv.device_id);
      if (sockId) {
        io.to(sockId).emit("action", {
          type: "update_playlist",
          playlist: playlist
        });
      }
    });
    
    broadcastTvList();
  }
}

// ─────────────────────────── SOCKET.IO ─────────────────────────
io.on("connection", (socket) => {
  socket.on("register-device", (deviceId) => {
    liveSockets.set(deviceId, socket.id);

    // Capture real IP from socket handshake
    const ip = socket.handshake.headers["x-forwarded-for"]
      ? socket.handshake.headers["x-forwarded-for"].split(",")[0].trim()
      : socket.handshake.address.replace("::ffff:", "");

    const tv = db.prepare("SELECT * FROM tvs WHERE device_id=?").get(deviceId);
    if (tv) {
      db.prepare("UPDATE tvs SET is_online=1, last_seen=CURRENT_TIMESTAMP, ip_address=COALESCE(NULLIF(?,''),ip_address) WHERE device_id=?")
        .run(ip, deviceId);
    } else {
      db.prepare("INSERT INTO tvs (uid,device_id,name,ip_address,is_online,last_seen) VALUES (?,?,?,?,1,CURRENT_TIMESTAMP)")
        .run(generateUUID(), deviceId, deviceId, ip);
    }
    broadcastTvList();
  });

  socket.on("playback-status", ({ deviceId, status }) => {
    db.prepare(`
      UPDATE tvs
      SET playback_status = ?
      WHERE device_id = ?
    `).run(status, deviceId);

    broadcastTvList();
  });

  socket.on("playback-state", ({ deviceId, status, current_item_index, current_filename, current_original_name, playlist_id, playlist_name, loop_enabled, loop_until }) => {
    const tv = db.prepare("SELECT * FROM tvs WHERE device_id=?").get(deviceId);
    if (!tv) return;

    db.prepare(`
      UPDATE tvs
      SET playback_status = ?, current_item_index = ?, loop_enabled = ?, loop_until = ?
      WHERE device_id = ?
    `).run(status, current_item_index, loop_enabled ? 1 : 0, loop_until || null, deviceId);

    broadcastTvList();
  });

  // Admin sends control commands
  socket.on("control", ({ targetType, targetId, action, playlist_id, loop, loopUntil, playlist }) => {
    if (action === "play" && playlist_id) {
      pushPlaylist(targetType, targetId, playlist_id, !!loop, loopUntil || null);
    } else if (action === "update_playlist" && playlist) {
      // Update playlist without restarting playback
      updatePlaylistOnDevice(targetType, targetId, playlist);
    } else {
      // resume / pause / stop — find devices and send
      const sendAction = (deviceId) => {
        const row = db.prepare("SELECT * FROM tvs WHERE device_id=?").get(deviceId);
        sendToDevice(deviceId, { type: action }, row);
      };

      if (targetType === "all") {
        db.prepare("SELECT device_id FROM tvs").all().forEach(t => sendAction(t.device_id));
      } else if (targetType === "group") {
        db.prepare(`SELECT tvs.device_id FROM group_members JOIN tvs ON tvs.id=group_members.tv_id WHERE group_members.group_id=?`)
          .all(targetId).forEach(t => sendAction(t.device_id));
      } else if (targetType === "tv") {
        const tv = db.prepare("SELECT * FROM tvs WHERE device_id=?").get(targetId);
        if (tv) sendAction(tv.device_id);
      }
    }
  });

  socket.on("disconnect", () => {
    for (const [id, sid] of liveSockets.entries()) {
      if (sid === socket.id) {
        liveSockets.delete(id);
        db.prepare("UPDATE tvs SET is_online=0 WHERE device_id=?").run(id);
        break;
      }
    }
    broadcastTvList();
  });
});

function broadcastTvList() {
  const tvs = db.prepare("SELECT * FROM tvs ORDER BY created_at DESC").all()
    .map(tv => ({ ...tv, is_online: liveSockets.has(tv.device_id) ? 1 : 0 }));
  io.emit("tv-list-full", tvs);
}

// ─────────────────────────── START ─────────────────────────────
server.listen(3000, "0.0.0.0", () => {
  console.log("InnoSpace TV server → http://0.0.0.0:3000");
});