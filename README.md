# 📺 InnoSpace — SignageOS-style Dashboard

Redesigned to match the SignageOS reference screenshots: light theme, sidebar nav,
device cards with status pills, a "Play Content" modal with Loop + Schedule, and
a dedicated Content Library page.

## Setup

```bash
npm install
node server.js
```

Open `http://localhost:3000` (replaces your old admin.html automatically).

## Pages

| URL | Matches screenshot | Purpose |
|---|---|---|
| `/` | Network Overview (img 2/3) | Device cards, group cards, system status |
| `/devices` | Registered Devices (img 4) | Full table of all devices, add/delete |
| `/content` | Content Library (img 5) | Upload, preview, delete videos |
| `/client/:deviceId` | — | The actual TV player page |

## New: UUID-based device creation

Click **+ Add Device** (bottom-left on the dashboard, or top-right on the Devices page).
Enter a name (location/IP optional) → the server generates:
- A UUID (`uid` column, shown in the device table and on each device card)
- A `device_id` slug used in the client URL (e.g. `Reception-Display-a3f92b1c`)

After creation, a modal shows the UUID and a **copyable client link**. Open that link
on the TV's browser to connect it — it self-registers and starts reporting online status
via WebSocket.

## New: Play Content modal (Loop + Schedule)

Click **▶ Play Content** on any device card, or **▶ Play on Group** on any group card.

- **Select Playlist or Asset** — dropdown of everything in your Content Library
- **Loop Content** — toggled on by default; when on, the TV's `<video loop>` attribute
  is set so it repeats indefinitely
- **Schedule Playback** — toggle on to reveal a date/time picker. When set, the
  request is stored in the `schedules` table instead of firing immediately; a
  background loop (checks every 30s) fires it at the right time
- **Push to Screens** — sends instantly (or **Schedule** if scheduling is on)

## Database (`db.js`)

```
tvs            id, uid (UUID, unique), device_id (unique), name, location,
                ip_address, is_online, current_video, playback_status,
                loop_enabled, last_seen, created_at

videos         id, filename (unique), original_name, size_bytes, uploaded_at

tv_groups      id, group_name (unique), created_at

group_members  id, group_id -> tv_groups, tv_id -> tvs

schedules      id, target_type (all|tv|group), target_id, video_id,
                scheduled_time, loop_enabled, fired, created_at

play_history   id, tv_id, group_id, video_id, action, played_at
```

All foreign keys cascade on delete — removing a TV, group, or video cleans up
related rows automatically.

## API additions in this version

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/tvs` | **Changed**: now generates `uid` + `device_id` from a `name` (used by the Add Device modal) |
| POST | `/api/play-content` | Unified play/schedule endpoint used by the Play Content modal — handles `targetType`, `targetId`, `video`, `loop`, `scheduleTime` |
| GET | `/api/schedules` | List all scheduled jobs with video names |

Existing routes (`/api/videos`, `/upload-video`, `/api/groups`, `/create-group`,
`/save-group-tvs`, Socket.io events) are unchanged from the previous version.

## Notes

- The visual design intentionally mirrors your reference screenshots (light theme,
  blue accent `#2563eb`, card-based layout, pill status badges) rather than the
  dark theme from earlier versions.
- `better-sqlite3` is a native module — if `npm install` fails on Windows, install
  **Visual Studio Build Tools** (Desktop C++ workload).
