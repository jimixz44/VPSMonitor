const express = require('express');
const router = express.Router();
const db = require('../database');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const ScreenUtils = require('../utils/screen');
const MigrationUtils = require('../utils/migration');
const rateLimit = require('express-rate-limit');

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // limit each IP to 5 login requests per windowMs
    message: { error: 'Too many login attempts from this IP, please try again after 15 minutes' }
});

const JWT_SECRET = process.env.JWT_SECRET || 'vps-monitor-super-secret-key-please-change-in-production';
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const MAX_EDIT_FILE_SIZE = 5 * 1024 * 1024;

let cachedPublicIp = 'Fetching IP...';
fetch('https://api.ipify.org?format=json')
    .then(r => r.json())
    .then(data => cachedPublicIp = data.ip)
    .catch(() => cachedPublicIp = 'Unknown IP');

// ─── Middleware ────────────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized: No token provided' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Unauthorized: Invalid or expired token' });
        req.user = user;
        next();
    });
}

function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function normalizeRelativePath(input = '') {
    const value = String(input || '').replace(/\\/g, '/').trim();
    if (!value || value === '.' || value === '/') return '';
    if (path.isAbsolute(value)) {
        const err = new Error('Absolute paths are not allowed here');
        err.statusCode = 400;
        throw err;
    }
    const parts = value.split('/').filter(Boolean);
    if (parts.some(part => part === '..')) {
        const err = new Error('Parent directory traversal is not allowed');
        err.statusCode = 400;
        throw err;
    }
    return parts.join('/');
}

function assertInsideRoot(rootReal, targetPath) {
    const targetReal = fs.realpathSync(targetPath);
    const relative = path.relative(rootReal, targetReal);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        const err = new Error('Path is outside the configured bot directory');
        err.statusCode = 403;
        throw err;
    }
    return targetReal;
}

async function getBotFileRoot(botName) {
    if (!botName) {
        const err = new Error('Bot name is required');
        err.statusCode = 400;
        throw err;
    }

    const cfg = await dbGet('SELECT directory FROM bot_configs WHERE name = ?', [botName]);
    const configuredDir = cfg && cfg.directory ? String(cfg.directory).trim() : '';
    if (!configuredDir || configuredDir === 'Unknown') {
        const err = new Error('Bot directory is not configured');
        err.statusCode = 400;
        throw err;
    }
    if (!fs.existsSync(configuredDir) || !fs.statSync(configuredDir).isDirectory()) {
        const err = new Error(`Configured directory does not exist: ${configuredDir}`);
        err.statusCode = 404;
        throw err;
    }

    return fs.realpathSync(configuredDir);
}

function resolveBotPath(rootReal, relativePath = '') {
    const safeRelPath = normalizeRelativePath(relativePath);
    const targetPath = path.resolve(rootReal, safeRelPath);
    const directRelative = path.relative(rootReal, targetPath);
    if (directRelative.startsWith('..') || path.isAbsolute(directRelative)) {
        const err = new Error('Path is outside the configured bot directory');
        err.statusCode = 403;
        throw err;
    }
    return { targetPath, relativePath: safeRelPath };
}

function toClientPath(rootReal, targetPath) {
    const relative = path.relative(rootReal, targetPath);
    if (!relative || relative === '.') return '';
    return relative.split(path.sep).join('/');
}

function parentClientPath(relativePath) {
    if (!relativePath) return '';
    const parts = relativePath.split('/').filter(Boolean);
    parts.pop();
    return parts.join('/');
}

function isProbablyBinary(filePath) {
    const fd = fs.openSync(filePath, 'r');
    try {
        const buffer = Buffer.alloc(4096);
        const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
        for (let i = 0; i < bytesRead; i++) {
            if (buffer[i] === 0) return true;
        }
        return false;
    } finally {
        fs.closeSync(fd);
    }
}

function sendFileManagerError(res, err) {
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message || 'File manager error' });
}

module.exports = function (upload) {
    // ─── AUTH: Refresh Token ───────────────────────────────────────────────────
    router.post('/refresh-token', authMiddleware, (req, res) => {
        const newToken = jwt.sign(
            { id: req.user.id, username: req.user.username },
            JWT_SECRET,
            { expiresIn: '8h' }
        );
        res.json({ token: newToken });
    });

    // ─── AUTH: Login ───────────────────────────────────────────────────────────
    router.post('/login', loginLimiter, (req, res) => {
        const { username, password } = req.body;
        if (!username || !password)
            return res.status(400).json({ error: 'Username and password are required' });

        db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
            if (err) return res.status(500).json({ error: 'Database error' });
            if (!user) return res.status(401).json({ error: 'Invalid credentials' });

            const match = await bcrypt.compare(password, user.password);
            if (!match) return res.status(401).json({ error: 'Invalid credentials' });

            const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '8h' });
            res.json({ token, username: user.username });
        });
    });

    // ─── AUTH: Update Settings (Username/Password) ─────────────────────────────
    router.post('/settings', authMiddleware, async (req, res) => {
        const { username, newPassword, oldPassword } = req.body;
        if (!oldPassword) return res.status(400).json({ error: 'Old password required to save changes' });

        db.get('SELECT * FROM users WHERE id = ?', [req.user.id], async (err, user) => {
            if (err) return res.status(500).json({ error: 'Database error' });
            const match = await bcrypt.compare(oldPassword, user.password);
            if (!match) return res.status(401).json({ error: 'Old password is incorrect' });

            const updates = [];
            const params = [];
            if (username && username.trim() !== '' && username !== user.username) {
                updates.push('username = ?');
                params.push(username.trim());
            }
            if (newPassword && newPassword.trim() !== '') {
                updates.push('password = ?');
                params.push(await bcrypt.hash(newPassword, 10));
            }

            if (updates.length === 0) return res.json({ success: true, message: 'No changes made' });

            params.push(req.user.id);
            db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params, (err) => {
                if (err) return res.status(500).json({ error: 'Failed to update. Username might be taken.' });
                res.json({ success: true, message: 'Settings updated successfully' });
            });
        });
    });

    // ─── SCREENS: List all running screens ────────────────────────────────────
    router.get('/bots', authMiddleware, async (req, res) => {
        try {
            const screens = await ScreenUtils.listScreens();
            db.all('SELECT name, command, directory FROM bot_configs', [], (err, rows) => {
                if (err) return res.status(500).json({ error: 'DB Error fetching configs' });
                
                const configMap = {};
                if (rows) {
                    rows.forEach(r => configMap[r.name] = { cmd: r.command, dir: r.directory });
                }
                
                // Attach saved command and directory to each screen object
                screens.forEach(s => {
                    const cfg = configMap[s.name] || {};
                    s.savedCommand = cfg.cmd || '';
                    s.savedDirectory = cfg.dir || '';
                });
                res.json({ screens });
            });
        } catch (err) {
            res.status(500).json({ error: 'Failed to list screens', details: err.message });
        }
    });

    // ─── SCREENS: Get log (hardcopy mirror) ───────────────────────────────────
    router.get('/logs/:name', authMiddleware, async (req, res) => {
        try {
            const log = await ScreenUtils.getLog(req.params.name);
            res.json({ log });
        } catch (err) {
            res.status(500).json({ error: 'Failed to get log', details: err.message });
        }
    });

    // ─── SCREENS: Send interactive command to terminal ────────────────────────
    router.post('/send-command', authMiddleware, async (req, res) => {
        const { name, command } = req.body;
        if (!name || !command) return res.status(400).json({ error: 'Name and command are required' });
        try {
            await ScreenUtils.sendCommandToScreen(name, command);
            res.json({ success: true, message: 'Command sent successfully' });
        } catch (err) {
            res.status(500).json({ error: 'Failed to send command', details: err.message });
        }
    });

    // ─── SCREENS: Stop (Ctrl+C) ────────────────────────────────────────────────
    router.post('/stop', authMiddleware, async (req, res) => {
        const { name } = req.body;
        if (!name) return res.status(400).json({ error: 'Screen name is required' });
        try {
            await ScreenUtils.stopScreen(name);
            res.json({ success: true, message: `Sent Ctrl+C to ${name}` });
        } catch (err) {
            res.status(500).json({ error: 'Failed to stop screen', details: err.message });
        }
    });

    // ─── SCREENS: Restart (Ctrl+C then run command) ───────────────────────────
    router.post('/restart', authMiddleware, async (req, res) => {
        const { name, command } = req.body;
        if (!name || !command) return res.status(400).json({ error: 'Name and command are required' });
        try {
            await ScreenUtils.restartScreen(name, command);
            res.json({ success: true, message: `Restarted ${name} with: ${command}` });
        } catch (err) {
            res.status(500).json({ error: 'Failed to restart screen', details: err.message });
        }
    });

    // ─── SCREENS: Kill (destroy session entirely) ─────────────────────────────
    router.post('/kill', authMiddleware, async (req, res) => {
        const { name } = req.body;
        if (!name) return res.status(400).json({ error: 'Screen name is required' });
        try {
            await ScreenUtils.killScreen(name);
            res.json({ success: true, message: `Screen ${name} has been killed` });
        } catch (err) {
            res.status(500).json({ error: 'Failed to kill screen', details: err.message });
        }
    });

    // ─── SCREENS: Launch new screen ───────────────────────────────────────────
    router.post('/launch', authMiddleware, async (req, res) => {
        const { name, command, directoryPath } = req.body;
        if (!name || !command || !directoryPath)
            return res.status(400).json({ error: 'name, command, and directoryPath are required' });

        // Validate the directory exists on the VPS
        if (!fs.existsSync(directoryPath) || !fs.statSync(directoryPath).isDirectory())
            return res.status(400).json({ error: `Directory does not exist on server: ${directoryPath}` });

        try {
            await ScreenUtils.startNewScreen(name, command, directoryPath);
            
            // Automatically save the command and directory as the main config for this bot
            db.run(`INSERT INTO bot_configs (name, command, directory) VALUES (?, ?, ?) 
                    ON CONFLICT(name) DO UPDATE SET command = ?, directory = ?`, 
                    [name, command, directoryPath, command, directoryPath]);
                    
            res.json({ success: true, message: `Launched screen '${name}' running '${command}' in ${directoryPath}` });
        } catch (err) {
            res.status(500).json({ error: 'Failed to launch screen', details: err.message });
        }
    });

    // ─── SCREENS: Set Main Command ────────────────────────────────────────────
    router.post('/set-command', authMiddleware, (req, res) => {
        const { name, command, directory } = req.body;
        if (!name || !command) return res.status(400).json({ error: 'name and command required' });

        db.run(`INSERT INTO bot_configs (name, command, directory) VALUES (?, ?, ?) 
                ON CONFLICT(name) DO UPDATE SET command = ?, directory = ?`, 
                [name, command, directory, command, directory], (err) => {
            if (err) return res.status(500).json({ error: 'Failed to save config' });
            res.json({ success: true, message: 'Configuration updated!' });
        });
    });

    // ─── FILES: List directories on VPS ───────────────────────────────────────
    router.get('/dirs', authMiddleware, (req, res) => {
        const targetPath = req.query.path || process.env.HOME || '/root';
        if (!fs.existsSync(targetPath))
            return res.status(404).json({ error: 'Path not found' });

        try {
            const items = fs.readdirSync(targetPath, { withFileTypes: true }).map(item => ({
                name: item.name,
                isDir: item.isDirectory(),
                path: path.join(targetPath, item.name)
            }));
            // Sort directories first
            items.sort((a, b) => b.isDir - a.isDir || a.name.localeCompare(b.name));
            res.json({ currentPath: targetPath, items });
        } catch (err) {
            res.status(500).json({ error: 'Failed to list directory', details: err.message });
        }
    });

    // ─── FILES: Write (edit) file ─────────────────────────────────────────────
    router.get('/files/list', authMiddleware, async (req, res) => {
        try {
            const rootReal = await getBotFileRoot(req.query.name);
            const { targetPath, relativePath } = resolveBotPath(rootReal, req.query.path || '');
            const targetReal = assertInsideRoot(rootReal, targetPath);

            const stats = fs.statSync(targetReal);
            if (!stats.isDirectory()) {
                return res.status(400).json({ error: 'Path is not a directory' });
            }

            const items = fs.readdirSync(targetReal, { withFileTypes: true }).map(item => {
                const itemPath = path.join(targetReal, item.name);
                let itemStats = null;
                let isDir = item.isDirectory();
                const isSymlink = item.isSymbolicLink();

                try {
                    itemStats = fs.statSync(itemPath);
                    isDir = itemStats.isDirectory();
                } catch (_) {
                    itemStats = null;
                }

                return {
                    name: item.name,
                    path: toClientPath(rootReal, itemPath),
                    isDir,
                    isFile: itemStats ? itemStats.isFile() : item.isFile(),
                    isHidden: item.name.startsWith('.'),
                    isSymlink,
                    size: itemStats ? itemStats.size : 0,
                    modifiedAt: itemStats ? itemStats.mtime.toISOString() : null
                };
            });

            items.sort((a, b) => {
                if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
                return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
            });

            res.json({
                root: rootReal,
                currentPath: relativePath,
                parentPath: parentClientPath(relativePath),
                items
            });
        } catch (err) {
            sendFileManagerError(res, err);
        }
    });

    router.get('/files/read', authMiddleware, async (req, res) => {
        try {
            const rootReal = await getBotFileRoot(req.query.name);
            const { targetPath } = resolveBotPath(rootReal, req.query.path || '');
            const targetReal = assertInsideRoot(rootReal, targetPath);
            const stats = fs.statSync(targetReal);

            if (stats.isDirectory()) return res.status(400).json({ error: 'Cannot read a directory as a file' });
            if (!stats.isFile()) return res.status(400).json({ error: 'Only regular files can be opened' });
            if (stats.size > MAX_EDIT_FILE_SIZE) {
                return res.status(400).json({ error: `File too large to edit (max ${Math.round(MAX_EDIT_FILE_SIZE / 1024 / 1024)}MB)` });
            }
            if (isProbablyBinary(targetReal)) {
                return res.status(400).json({ error: 'Binary files cannot be opened in the text editor' });
            }

            res.json({
                content: fs.readFileSync(targetReal, 'utf8'),
                path: toClientPath(rootReal, targetReal),
                name: path.basename(targetReal),
                size: stats.size,
                modifiedAt: stats.mtime.toISOString()
            });
        } catch (err) {
            sendFileManagerError(res, err);
        }
    });

    router.post('/files/write', authMiddleware, async (req, res) => {
        try {
            const { name, filePath, content } = req.body;
            const rootReal = await getBotFileRoot(name);
            const { targetPath } = resolveBotPath(rootReal, filePath || '');
            const targetReal = assertInsideRoot(rootReal, targetPath);
            const stats = fs.statSync(targetReal);

            if (stats.isDirectory()) return res.status(400).json({ error: 'Cannot write to a directory' });
            if (!stats.isFile()) return res.status(400).json({ error: 'Only regular files can be edited' });
            if (stats.size > MAX_EDIT_FILE_SIZE) {
                return res.status(400).json({ error: `File too large to edit (max ${Math.round(MAX_EDIT_FILE_SIZE / 1024 / 1024)}MB)` });
            }
            if (isProbablyBinary(targetReal)) {
                return res.status(400).json({ error: 'Binary files cannot be edited' });
            }

            fs.writeFileSync(targetReal, String(content ?? ''), 'utf8');
            const updatedStats = fs.statSync(targetReal);
            res.json({
                success: true,
                message: 'File saved successfully',
                size: updatedStats.size,
                modifiedAt: updatedStats.mtime.toISOString()
            });
        } catch (err) {
            sendFileManagerError(res, err);
        }
    });

    router.post('/write-file', authMiddleware, (req, res) => {
        const { path: filePath, content } = req.body;
        if (!filePath) return res.status(400).json({ error: 'Path is required' });
        try {
            const stats = fs.statSync(filePath);
            if (stats.isDirectory()) return res.status(400).json({ error: 'Cannot write to a directory' });
        } catch(e) { /* file might not exist yet, allow create */ }
        try {
            fs.writeFileSync(filePath, content || '', 'utf8');
            res.json({ success: true, message: 'File saved successfully' });
        } catch (err) {
            res.status(500).json({ error: 'Failed to write file', details: err.message });
        }
    });

    // ─── FILES: Check if screen name already exists ───────────────────────────
    router.get('/check-name/:name', authMiddleware, async (req, res) => {
        try {
            const screens = await ScreenUtils.listScreens();
            const exists = screens.some(s => s.name === req.params.name);
            res.json({ exists });
        } catch(err) {
            res.status(500).json({ error: 'Failed to check name' });
        }
    });

    // ─── FILES: Read file content for preview ─────────────────────────────────
    router.get('/read-file', authMiddleware, (req, res) => {
        const targetPath = req.query.path;
        if (!targetPath || !fs.existsSync(targetPath)) return res.status(404).json({ error: 'File not found' });
        
        try {
            const stats = fs.statSync(targetPath);
            if (stats.isDirectory()) return res.status(400).json({ error: 'Cannot read a directory as a file' });
            if (stats.size > 2 * 1024 * 1024) return res.status(400).json({ error: 'File too large to preview (>2MB)' });
            
            const content = fs.readFileSync(targetPath, 'utf8');
            res.json({ content });
        } catch (err) {
            res.status(500).json({ error: 'Failed to read file', details: err.message });
        }
    });

    // ─── FILES: Upload folder (drag & drop — files sent individually) ─────────
    router.post('/upload-folder', authMiddleware, upload.array('files'), (req, res) => {
        try {
            const folderName = req.body.folderName || `bot_upload_${Date.now()}`;
            const destFolder = path.join(UPLOADS_DIR, folderName);
            if (!fs.existsSync(destFolder)) fs.mkdirSync(destFolder, { recursive: true });

            // Re-organize files by their relative paths (sent via form field 'paths')
            const filePaths = Array.isArray(req.body.paths) ? req.body.paths : [req.body.paths];
            req.files.forEach((file, idx) => {
                const relPath = filePaths[idx] || file.originalname;
                const targetFile = path.join(destFolder, relPath);
                const targetDir = path.dirname(targetFile);
                if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
                fs.renameSync(file.path, targetFile);
            });

            res.json({ success: true, folderName, destPath: destFolder });
        } catch (err) {
            res.status(500).json({ error: 'Upload failed', details: err.message });
        }
    });

    // ─── SYSTEM: Resource monitoring ──────────────────────────────────────────
    router.get('/system', authMiddleware, (req, res) => {
        const os = require('os');
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        const uptime = os.uptime();

        // Real-time CPU: sample over 100ms delta for accurate reading
        // (one-shot cumulative approach gives stale/wrong values)
        function getCpuSample() {
            const cpus = os.cpus();
            let idle = 0, total = 0;
            cpus.forEach(cpu => {
                for (const type in cpu.times) total += cpu.times[type];
                idle += cpu.times.idle;
            });
            return { idle, total, count: cpus.length, model: cpus[0]?.model || 'N/A' };
        }

        const s1 = getCpuSample();
        setTimeout(() => {
            const s2 = getCpuSample();
            const idleDiff  = s2.idle  - s1.idle;
            const totalDiff = s2.total - s1.total;
            const cpuUsagePercent = totalDiff > 0 ? Math.round(((totalDiff - idleDiff) / totalDiff) * 100) : 0;

            res.json({
                cpu: { usage: cpuUsagePercent, cores: s2.count, model: s2.model },
                memory: {
                    total: totalMem,
                    used: usedMem,
                    free: freeMem,
                    usedPercent: Math.round((usedMem / totalMem) * 100)
                },
                uptime: uptime,
                ip: cachedPublicIp
            });
        }, 100);

    });
    // ─── MIGRATION: Migrate bot to another VPS ───────────────────────────────
    router.post('/migrate', authMiddleware, async (req, res) => {
        const { botName, targetIp, targetUser, targetPass } = req.body;
        if (!botName || !targetIp || !targetUser || !targetPass) {
            return res.status(400).json({ error: 'Missing required migration credentials or bot name' });
        }
        try {
            const screens = await ScreenUtils.listScreens();

            // BUG FIX: Attach savedDirectory + savedCommand from DB (same as /bots endpoint)
            // Without this, bot.savedDirectory is always undefined → falls back to cwd (/root)
            await new Promise((resolve) => {
                db.all('SELECT name, command, directory FROM bot_configs', [], (err, rows) => {
                    if (!err && rows) {
                        const configMap = {};
                        rows.forEach(r => configMap[r.name] = { cmd: r.command, dir: r.directory });
                        screens.forEach(s => {
                            const cfg = configMap[s.name] || {};
                            s.savedCommand = cfg.cmd || '';
                            s.savedDirectory = cfg.dir || '';
                        });
                    }
                    resolve();
                });
            });

            const result = await MigrationUtils.migrateBot(botName, targetIp, targetUser, targetPass, screens);
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // ─── MIGRATION: Test SSH Connection ──────────────────────────────────────
    router.post('/test-connection', authMiddleware, async (req, res) => {
        const { targetIp, targetUser, targetPass } = req.body;
        if (!targetIp || !targetUser || !targetPass) {
            return res.status(400).json({ error: 'Missing credentials' });
        }
        
        const { NodeSSH } = require('node-ssh');
        const ssh = new NodeSSH();
        
        try {
            await ssh.connect({
                host: targetIp,
                username: targetUser,
                password: targetPass,
                readyTimeout: 10000
            });
            ssh.dispose();
            res.json({ success: true, message: 'Connection successful!' });
        } catch (err) {
            try { ssh.dispose(); } catch(e) {}
            res.status(500).json({ error: 'Connection failed: ' + err.message });
        }
    });

    return router;
};
