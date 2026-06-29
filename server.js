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

// ================= PATHS =================
const VIDEOS_DIR = path.join(__dirname, "videos");
if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true });

// ================= LIVE CONNECTIONS (memory) =================
const liveSockets = new Map(); // device_id -> socket.id

// ================= MIDDLEWARE =================
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/videos", express.static(VIDEOS_DIR));

// ================= UPLOAD (multer) =================
const IMAGES_DIR = path.join(__dirname, "images");
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

app.use("/images", express.static(IMAGES_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const isImage = file.mimetype.startsWith("image/");
      cb(null, isImage ? IMAGES_DIR : VIDEOS_DIR);
    },
    filename: (req, file, cb) => {
      const safe = file.originalname.replace(/\s+/g, "_");
      cb(null, Date.now() + "_" + safe);
    }
  }),
  fileFilter: (req, file, cb) => {
    const allowed = ["video/", "image/"];
    if (allowed.some(t => file.mimetype.startsWith(t))) cb(null, true);
    else cb(new Error("Only video and image files are allowed"));
  }
});

// =====================================================================
// PAGES
// =====================================================================

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/content", (req, res) => res.sendFile(path.join(__dirname, "public", "content.html")));
app.get("/devices", (req, res) => res.sendFile(path.join(__dirname, "public", "devices.html")));

// =====================================================================
// TV / DEVICE API
// =====================================================================

app.get("/api/tvs", (req, res) => {
  const tvs = db.prepare("SELECT * FROM tvs ORDER BY created_at DESC").all().map(tv => ({
    ...tv,
    is_online: liveSockets.has(tv.device_id) ? 1 : 0,
  }));
  res.json(tvs);
});

// Manually add a device from the admin panel ("+ Add Device")
// Auto-generates a UUID + device_id
app.post("/api/tvs", (req, res) => {
  const { name, location, ip_address } = req.body;
  if (!name) return res.status(400).json({ message: "Device name required" });

  const uid = generateUUID();
  const device_id = name.trim().replace(/\s+/g, "-") + "-" + uid.slice(0, 8);

  db.prepare(`
    INSERT INTO tvs (uid, device_id, name, location, ip_address)
    VALUES (?, ?, ?, ?, ?)
  `).run(uid, device_id, name.trim(), location || "", ip_address || "");

  const tv = db.prepare("SELECT * FROM tvs WHERE uid = ?").get(uid);
  broadcastTvList();
  res.json(tv);
});

app.delete("/api/tvs/:id", (req, res) => {
  const tv = db.prepare("SELECT * FROM tvs WHERE id = ?").get(req.params.id);
  if (!tv) return res.status(404).json({ message: "Device not found" });

  db.prepare("DELETE FROM tvs WHERE id = ?").run(req.params.id);
  liveSockets.delete(tv.device_id);

  broadcastTvList();
  res.json({ message: `"${tv.name}" removed` });
});

// =====================================================================
// VIDEO / CONTENT API
// =====================================================================

app.get("/api/videos", (req, res) => {
  const videos = db.prepare("SELECT * FROM videos ORDER BY uploaded_at DESC").all();
  res.json(videos);
});

app.get("/videos-list", (req, res) => {
  const videos = db.prepare("SELECT filename FROM videos ORDER BY uploaded_at DESC").all();
  res.json(videos.map(v => v.filename));
});

app.post("/upload-video", upload.single("video"), (req, res) => {
  if (!req.file) return res.status(400).json({ message: "No file uploaded" });

  const isImage = req.file.mimetype.startsWith("image/");
  const mediaType = isImage ? "image" : "video";

  db.prepare(
    "INSERT INTO videos (filename, original_name, size_bytes, media_type) VALUES (?, ?, ?, ?)"
  ).run(req.file.filename, req.file.originalname, req.file.size, mediaType);

  res.json({ message: "Uploaded: " + req.file.originalname, filename: req.file.filename, media_type: mediaType });
});

app.delete("/api/videos/:id", (req, res) => {
  const video = db.prepare("SELECT * FROM videos WHERE id = ?").get(req.params.id);
  if (!video) return res.status(404).json({ message: "Video not found" });

  const filePath = path.join(video.media_type === 'image' ? IMAGES_DIR : VIDEOS_DIR, video.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  db.prepare("UPDATE tvs SET current_video = NULL, playback_status = 'stopped' WHERE current_video = ?")
    .run(video.filename);

  db.prepare("DELETE FROM videos WHERE id = ?").run(req.params.id);
  res.json({ message: `"${video.original_name}" deleted` });
});

// =====================================================================
// GROUP API
// =====================================================================

app.get("/groups", (req, res) => {
  res.json(db.prepare("SELECT * FROM tv_groups ORDER BY group_name").all());
});

app.get("/api/groups", (req, res) => {
  const groups = db.prepare("SELECT * FROM tv_groups ORDER BY group_name").all().map(g => {
    const members = db.prepare(`
      SELECT tvs.* FROM group_members
      JOIN tvs ON tvs.id = group_members.tv_id
      WHERE group_members.group_id = ?
    `).all(g.id).map(tv => ({ ...tv, is_online: liveSockets.has(tv.device_id) ? 1 : 0 }));
    return { ...g, members };
  });
  res.json(groups);
});

app.post("/create-group", (req, res) => {
  const { groupName } = req.body;
  if (!groupName) return res.status(400).json({ message: "Group name required" });

  try {
    db.prepare("INSERT INTO tv_groups (group_name) VALUES (?)").run(groupName);
    res.json({ message: `Group "${groupName}" created` });
  } catch (err) {
    if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return res.status(400).json({ message: "Group already exists" });
    }
    res.status(500).json({ message: "Error creating group" });
  }
});

app.delete("/api/groups/:id", (req, res) => {
  const group = db.prepare("SELECT * FROM tv_groups WHERE id = ?").get(req.params.id);
  if (!group) return res.status(404).json({ message: "Group not found" });
  db.prepare("DELETE FROM tv_groups WHERE id = ?").run(req.params.id);
  res.json({ message: `Group "${group.group_name}" deleted` });
});

app.post("/save-group-tvs", (req, res) => {
  const { groupName, tvs } = req.body;
  if (!groupName || !Array.isArray(tvs)) {
    return res.status(400).json({ message: "Group name and TVs required" });
  }

  const group = db.prepare("SELECT * FROM tv_groups WHERE group_name = ?").get(groupName);
  if (!group) return res.status(404).json({ message: "Group not found" });

  const clear = db.prepare("DELETE FROM group_members WHERE group_id = ?");
  const insert = db.prepare("INSERT OR IGNORE INTO group_members (group_id, tv_id) VALUES (?, ?)");

  const tx = db.transaction(() => {
    clear.run(group.id);
    for (const deviceId of tvs) {
      const tv = db.prepare("SELECT * FROM tvs WHERE device_id = ?").get(deviceId);
      if (tv) insert.run(group.id, tv.id);
    }
  });
  tx();

  res.json({ message: `Saved ${tvs.length} device(s) to "${groupName}"` });
});

function getGroupMemberDeviceIds(groupId) {
  return db.prepare(`
    SELECT tvs.device_id FROM group_members
    JOIN tvs ON tvs.id = group_members.tv_id
    WHERE group_members.group_id = ?
  `).all(groupId).map(r => r.device_id);
}

// =====================================================================
// PLAY CONTENT (instant + scheduled, with loop)
// =====================================================================

// Unified endpoint matching the "Play Content" modal: target + video + loop + optional schedule time
// Pause / Stop endpoints
app.post("/api/pause-content", (req, res) => {
  const { targetId, targetType } = req.body;
  dispatchPlay(targetType === "all" ? "all" : targetId, null, "pause", false);
  res.json({ message: "Paused" });
});

app.post("/api/stop-content", (req, res) => {
  const { targetId, targetType } = req.body;
  dispatchPlay(targetType === "all" ? "all" : targetId, null, "stop", false);
  res.json({ message: "Stopped" });
});

app.post("/api/play-content", (req, res) => {
  const { targetId, targetType, video, loop, loopDuration, scheduleTime } = req.body;
  // targetType: 'tv' | 'group' | 'all'   targetId: device_id or group_name (omit/null for 'all')

  const videoRow = db.prepare("SELECT * FROM videos WHERE filename = ?").get(video);
  if (!videoRow) return res.status(404).json({ message: "Video not found" });

  if (scheduleTime) {
    // Save as a schedule, fire later
    let target_type = targetType || "all";
    let target_id = null;

    if (target_type === "tv") {
      const tv = db.prepare("SELECT * FROM tvs WHERE device_id = ?").get(targetId);
      if (!tv) return res.status(404).json({ message: "Device not found" });
      target_id = tv.id;
    } else if (target_type === "group") {
      const group = db.prepare("SELECT * FROM tv_groups WHERE group_name = ?").get(targetId);
      if (!group) return res.status(404).json({ message: "Group not found" });
      target_id = group.id;
    }

    db.prepare(`
      INSERT INTO schedules (target_type, target_id, video_id, scheduled_time, loop_enabled, loop_duration)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(target_type, target_id, videoRow.id, scheduleTime, loop ? 1 : 0, loopDuration || 0);

    return res.json({ message: `Scheduled "${videoRow.original_name}" for ${scheduleTime}` });
  }

  // Instant play
  dispatchPlay(targetType === "all" ? "all" : targetId, video, "play", !!loop, loopDuration || 0);
  res.json({ message: `Pushed "${videoRow.original_name}" to screens` });
});

// Legacy simple schedule route (kept for compatibility)
app.post("/schedule-video", (req, res) => {
  const { tvId, video, time } = req.body;
  if (!video || !time) return res.status(400).json({ message: "Video and time required" });

  const videoRow = db.prepare("SELECT * FROM videos WHERE filename = ?").get(video);
  if (!videoRow) return res.status(404).json({ message: "Video not found" });

  let target_type = "tv";
  let target_id = null;

  if (tvId === "all") {
    target_type = "all";
  } else {
    const group = db.prepare("SELECT * FROM tv_groups WHERE group_name = ?").get(tvId);
    if (group) {
      target_type = "group";
      target_id = group.id;
    } else {
      const tv = db.prepare("SELECT * FROM tvs WHERE device_id = ?").get(tvId);
      if (tv) target_id = tv.id;
    }
  }

  db.prepare(`
    INSERT INTO schedules (target_type, target_id, video_id, scheduled_time, loop_enabled)
    VALUES (?, ?, ?, ?, 1)
  `).run(target_type, target_id, videoRow.id, time);

  res.json({ message: `Scheduled "${video}" for ${tvId} at ${time}` });
});

// Scheduler loop — checks every second
setInterval(() => {
  const due = db.prepare("SELECT * FROM schedules WHERE fired = 0 AND scheduled_time <= replace(datetime('now', '+5 hours', '+30 minutes'), ' ', 'T')").all();

  due.forEach(job => {
    const video = db.prepare("SELECT * FROM videos WHERE id = ?").get(job.video_id);
    if (!video) return;

    const ld = job.loop_duration || 0;
    if (job.target_type === "all") {
      dispatchToAll("play", video.filename, !!job.loop_enabled, ld);
    } else if (job.target_type === "group") {
      dispatchToGroup(job.target_id, "play", video.filename, !!job.loop_enabled, ld);
    } else if (job.target_type === "tv") {
      const tv = db.prepare("SELECT * FROM tvs WHERE id = ?").get(job.target_id);
      if (tv) dispatchToTv(tv.device_id, "play", video.filename, !!job.loop_enabled, ld);
    }

    db.prepare("UPDATE schedules SET fired = 1 WHERE id = ?").run(job.id);
    console.log(`Fired schedule #${job.id}: ${video.filename} -> ${job.target_type}`);
  });
}, 1000);

app.get("/api/schedules", (req, res) => {
  const rows = db.prepare(`
    SELECT schedules.*, videos.original_name as video_name, videos.filename as video_filename
    FROM schedules JOIN videos ON videos.id = schedules.video_id
    ORDER BY scheduled_time DESC
  `).all();
  res.json(rows);
});

// =====================================================================
// PLAYBACK DISPATCH HELPERS
// =====================================================================

function dispatchToTv(deviceId, action, videoFilename = null, loop = true, loopDuration = 0) {
  const tv = db.prepare("SELECT * FROM tvs WHERE device_id = ?").get(deviceId);
  if (!tv) return;

  if (action === "play") {
    db.prepare("UPDATE tvs SET current_video = ?, playback_status = 'playing', loop_enabled = ?, loop_duration = ? WHERE id = ?")
      .run(videoFilename, loop ? 1 : 0, loopDuration, tv.id);
  } else if (action === "pause") {
    db.prepare("UPDATE tvs SET playback_status = 'paused' WHERE id = ?").run(tv.id);
  } else if (action === "stop") {
    db.prepare("UPDATE tvs SET playback_status = 'stopped', current_video = NULL WHERE id = ?").run(tv.id);
  }

  const video = videoFilename ? db.prepare("SELECT * FROM videos WHERE filename = ?").get(videoFilename) : null;
  db.prepare("INSERT INTO play_history (tv_id, video_id, action) VALUES (?, ?, ?)"
    ).run(tv.id, video ? video.id : null, action);

  const sockId = liveSockets.get(deviceId);
  if (sockId) {
    io.to(sockId).emit("action", { type: action, video: videoFilename, loop, loopDuration, mediaType: video ? video.media_type : null });
  }

  broadcastTvList();
}

function dispatchToGroup(groupId, action, videoFilename = null, loop = true, loopDuration = 0) {
  const deviceIds = getGroupMemberDeviceIds(groupId);
  deviceIds.forEach(id => dispatchToTv(id, action, videoFilename, loop, loopDuration));

  const video = videoFilename ? db.prepare("SELECT * FROM videos WHERE filename = ?").get(videoFilename) : null;
  db.prepare("INSERT INTO play_history (group_id, video_id, action) VALUES (?, ?, ?)"
    ).run(groupId, video ? video.id : null, action);
}

function dispatchToAll(action, videoFilename = null, loop = true, loopDuration = 0) {
  const allTvs = db.prepare("SELECT device_id FROM tvs").all();
  allTvs.forEach(tv => dispatchToTv(tv.device_id, action, videoFilename, loop, loopDuration));
}

function dispatchPlay(tvId, video, action = "play", loop = true, loopDuration = 0) {
  if (tvId === "all" || !tvId) return dispatchToAll(action, video, loop, loopDuration);

  const group = db.prepare("SELECT * FROM tv_groups WHERE group_name = ?").get(tvId);
  if (group) return dispatchToGroup(group.id, action, video, loop, loopDuration);

  return dispatchToTv(tvId, action, video, loop, loopDuration);
}

// =====================================================================
// TV CLIENT PAGE
// =====================================================================

app.get("/client/:deviceId", (req, res) => {
  const deviceId = req.params.deviceId;

  const existing = db.prepare("SELECT * FROM tvs WHERE device_id = ?").get(deviceId);
  if (!existing) {
    db.prepare("INSERT INTO tvs (uid, device_id, name) VALUES (?, ?, ?)")
      .run(generateUUID(), deviceId, deviceId);
  }

  res.sendFile(path.join(__dirname, "public", "client.html"));
});

app.get("/api/tv-info/:deviceId", (req, res) => {
  const tv = db.prepare("SELECT * FROM tvs WHERE device_id = ?").get(req.params.deviceId);
  if (!tv) return res.status(404).json({ message: "Device not found" });
  res.json({ ...tv, is_online: liveSockets.has(tv.device_id) ? 1 : 0 });
});

// =====================================================================
// SOCKET.IO
// =====================================================================

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  socket.on("register-device", (deviceId) => {
    liveSockets.set(deviceId, socket.id);

    const existing = db.prepare("SELECT * FROM tvs WHERE device_id = ?").get(deviceId);
    if (existing) {
      db.prepare("UPDATE tvs SET is_online = 1, last_seen = CURRENT_TIMESTAMP WHERE device_id = ?").run(deviceId);
    } else {
      db.prepare("INSERT INTO tvs (uid, device_id, name, is_online, last_seen) VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)")
        .run(generateUUID(), deviceId, deviceId);
    }

    console.log("Device registered:", deviceId);
    broadcastTvList();
  });

  socket.on("play-video", ({ tvId, video, loop, loopDuration }) => dispatchPlay(tvId, video, "play", loop !== false, loopDuration || 0));
  socket.on("pause-video", ({ tvId }) => dispatchPlay(tvId, null, "pause"));
  socket.on("stop-video", ({ tvId }) => dispatchPlay(tvId, null, "stop"));

  socket.on("disconnect", () => {
    for (const [id, sockId] of liveSockets.entries()) {
      if (sockId === socket.id) {
        liveSockets.delete(id);
        db.prepare("UPDATE tvs SET is_online = 0 WHERE device_id = ?").run(id);
        console.log("Device disconnected:", id);
        break;
      }
    }
    broadcastTvList();
  });
});

function broadcastTvList() {
  const tvs = db.prepare("SELECT * FROM tvs ORDER BY created_at DESC").all().map(tv => ({
    ...tv,
    is_online: liveSockets.has(tv.device_id) ? 1 : 0,
  }));
  io.emit("tv-list-full", tvs);
}

// =====================================================================
// START
// =====================================================================

server.listen(3000, "0.0.0.0", () => {
  console.log("InnoSpace Smart TV server running on http:// 192.168.1.129:3000");
});
