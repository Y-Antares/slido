# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A real-time Q&A interactive platform (similar to Slido). Lecturers create "sessions" for their events, share a QR code with audiences, and participants submit questions via mobile web. Questions appear in real-time on a presenter display wall via WebSocket. Includes voice input, lottery/draw modes, and data export.

## Commands

```bash
# Start the server
npm start          # runs `node server.js`

# Run tests
npm test           # placeholder - no tests configured yet
```

No build step, linter, or bundler — this is a vanilla HTML/CSS/JS frontend served by Express.

## Architecture

The entire backend is a single file: `server.js`. The frontend is flat HTML files in `public/`. There is no SPA framework, no module system on the frontend, and no directory-based routing.

### Data Models (MongoDB/Mongoose)

- **Session** — name, unique 6-char `nanoid` code, totalConnections counter, createdAt
- **Question** — text, name (default "匿名"), sessionId (ref → Session), ipAddress, createdAt
- **LotteryRecord** — sessionName, sessionCode, date, questionText, userName, createdAt

### WebSocket Rooms

Each session code acts as a WebSocket room. When a client connects to `presenter.html`, it sends `{type: "join", room: code}`. The server maintains a `Map<roomCode, Set<ws>>`. On new questions or deletes, the server broadcasts to all clients in that room. Online client count is tracked and broadcast separately.

### Page Map

| Page | Auth | Purpose |
|------|------|---------|
| `dashboard.html` (`/`) | adminAuth | Create sessions, list all historical sessions |
| `admin.html` (`/admin`) | adminAuth | Filter questions by date range, export CSV |
| `presenter.html` (`/session/:code`) | public | Real-time question wall + QR code + online counter |
| `client.html` (`/session/:code/ask`) | public | Mobile-friendly question submission form with voice input |
| `success.html` (`/session/:code/success`) | public | Post-submission confirmation with "ask another" link |
| `lottery-flip.html` | public | Flip-card lottery (Levenshtein dedup, grouped by author) |
| `lottery-ball.html` | public | Bouncing-ball lottery (Levenshtein dedup, grouped by author) |
| `records.html` | public | Lottery winner history table |

### Voice Input Flow

1. `client.html` records audio via `MediaRecorder` API → WebM blob
2. POST to `/api/voice-to-text` as multipart form data
3. Server uses `fluent-ffmpeg` to convert to 16kHz mono PCM
4. PCM buffer sent to Baidu AipSpeech SDK for recognition
5. Recognized text returned and appended to the textarea

### Auth

Admin routes (`/`, `/admin`, `/api/sessions` POST/GET, `/api/questions` GET) are protected by `express-basic-auth` using `ADMIN_USERNAME` and `ADMIN_PASSWORD` environment variables.

### Environment Variables

- `MONGO_URI` — MongoDB Atlas connection string (required)
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` — basic auth credentials for admin pages
- `BAIDU_APP_ID` / `BAIDU_API_KEY` / `BAIDU_SECRET_KEY` — Baidu speech recognition credentials
- `PORT` — server port (default: 3000)
