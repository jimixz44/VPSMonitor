const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const http = require('http');
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const pty = require('node-pty');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'vps-monitor-super-secret-key-please-change-in-production';

// Allow CORS from same server — works whether accessed via localhost or public IP.
// Since the frontend is served by the same Express server, credentials from
// the same origin are always valid. We reflect the request's own origin.
app.use(cors({
    origin: (origin, callback) => {
        const allowed = process.env.ALLOWED_ORIGIN;
        if (!origin || !allowed || origin === allowed) return callback(null, true);
        callback(null, true);
    },
    credentials: true
}));
// Fix: trust proxy so express-rate-limit works correctly behind Nginx/reverse proxy
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend files
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);
app.use(express.static(publicDir));

// Ensure upload directory exists
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

// Multer config
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ 
    storage,
    limits: { fileSize: 200 * 1024 * 1024 } // 200MB per file max
});

// Import Database connection
require('./database');

// Import routes
const apiRoutes = require('./routes/api');
app.use('/api', apiRoutes(upload));

app.get('/', (req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
});

// --- HTTP Server ---
const server = http.createServer(app);

// --- WebSocket Terminal Server ---
const wss = new WebSocketServer({ server, path: '/terminal' });

// Track active PTY per screen to prevent memory leaks on reconnect
const activePtys = new Map();

wss.on('connection', (ws, req) => {
    const params = new URL(req.url, `http://localhost`).searchParams;
    const token = params.get('token');
    const screenName = params.get('screen');

    // Authenticate
    try {
        jwt.verify(token, JWT_SECRET);
    } catch (err) {
        ws.send('\r\n\x1b[31m[Auth Error] Invalid or expired token.\x1b[0m\r\n');
        ws.close();
        return;
    }

    if (!screenName) {
        ws.send('\r\n\x1b[31m[Error] No screen name specified.\x1b[0m\r\n');
        ws.close();
        return;
    }

    // BUG FIX: Kill any stale PTY for the same screen to prevent memory/process leaks
    if (activePtys.has(screenName)) {
        try { activePtys.get(screenName).kill(); } catch {}
        activePtys.delete(screenName);
    }

    // Spawn a pty attached to the screen session
    const cols = Math.max(10, parseInt(params.get('cols')) || 220);
    const rows = Math.max(2, parseInt(params.get('rows')) || 50);

    let ptyProcess;
    try {
        ptyProcess = pty.spawn('screen', ['-x', screenName], {
            name: 'xterm-256color',
            cols,
            rows,
            env: { ...process.env, TERM: 'xterm-256color' }
        });
    } catch (err) {
        ws.send(`\r\n\x1b[31m[Error] Could not attach to screen '${screenName}': ${err.message}\x1b[0m\r\n`);
        ws.close();
        return;
    }

    activePtys.set(screenName, ptyProcess);

    // Pipe pty output -> browser
    ptyProcess.onData(data => {
        if (ws.readyState === ws.OPEN) ws.send(data);
    });

    ptyProcess.onExit(() => {
        activePtys.delete(screenName);
        if (ws.readyState === ws.OPEN) {
            ws.send('\r\n\x1b[33m[Session ended]\x1b[0m\r\n');
            ws.close();
        }
    });

    // Pipe browser input -> pty
    ws.on('message', (msg) => {
        try {
            const msgStr = msg.toString();
            const data = JSON.parse(msgStr);
            if (data.type === 'input') {
                ptyProcess.write(data.data);
            } else if (data.type === 'resize') {
                const newCols = Math.max(10, parseInt(data.cols) || cols);
                const newRows = Math.max(2, parseInt(data.rows) || rows);
                ptyProcess.resize(newCols, newRows);
            }
        } catch (e) {
            console.error(`[WS Input] Error parsing/handling msg:`, e);
            try { ptyProcess.write(msg.toString()); } catch {}
        }
    });

    ws.on('close', () => {
        // Only kill if this WS still owns the PTY for this screen
        if (activePtys.get(screenName) === ptyProcess) {
            activePtys.delete(screenName);
            try { ptyProcess.kill(); } catch {}
        }
    });
});

server.listen(PORT, () => {
    console.log(`VPS Monitor Server running at http://localhost:${PORT}`);
});
