const { NodeSSH } = require('node-ssh');
const fs = require('fs');
const path = require('path');

// Files/dirs to always skip during transfer
const EXCLUDED_NAMES = new Set([
    'node_modules', '.git', '__pycache__', '.cache', '.npm',
    '.local', '.pip', '.config', '.launchpadlib', '.ssh',
    '.gnupg', '.snap', 'snap', '.dbus', '.bash_history',
    '.bashrc', '.profile', '.bash_logout', '.bash_aliases',
    '.viminfo', '.lesshst', '.wget-hsts', '.motd_shown',
    'lost+found', 'tmp', '.tmp', '.env.local', 'logs', 'log'
]);

const EXCLUDED_EXT = new Set([
    '.zip', '.tar', '.gz', '.log', '.tmp', '.bak',
    '.swp', '.lock', '.pid', '.sock'
]);

/**
 * Fast file migration via direct SFTP putDirectory.
 * Skips node_modules, dotfiles, caches, and system dirs.
 */
async function migrateBot(botName, targetIp, targetUser, targetPass, screens) {
    const bot = screens.find(s => s.name === botName);
    if (!bot) throw new Error(`Bot "${botName}" not found in active screen list`);

    const botDir = bot.savedDirectory || bot.cwd;
    if (!botDir || botDir === 'Unknown') {
        throw new Error(`Bot directory unknown. Please set a directory in Bot Configuration first.`);
    }
    if (!fs.existsSync(botDir)) {
        throw new Error(`Bot directory does not exist on this server: ${botDir}`);
    }

    // Guard: warn if trying to upload entire home/root directory
    const dangerousDirs = ['/', '/root', '/home', process.env.HOME].filter(Boolean);
    if (dangerousDirs.includes(botDir.replace(/\/$/, ''))) {
        throw new Error(
            `Refusing to migrate: the bot directory is "${botDir}" (home/root directory). ` +
            `Please set a specific bot folder (e.g. /root/mybot) in Bot Configuration first.`
        );
    }

    // Count files to give a progress hint
    let fileCount = 0;
    try {
        const countFiles = (dir) => {
            const items = fs.readdirSync(dir, { withFileTypes: true });
            for (const item of items) {
                if (EXCLUDED_NAMES.has(item.name)) continue;
                if (item.isDirectory()) countFiles(path.join(dir, item.name));
                else fileCount++;
            }
        };
        countFiles(botDir);
    } catch(e) {}

    console.log(`[Migration] Migrating "${botName}" — ${fileCount} files from ${botDir}`);

    const remoteDir = `/root/${botName}`;

    const ssh = new NodeSSH();
    await ssh.connect({
        host: targetIp,
        username: targetUser,
        password: targetPass,
        readyTimeout: 15000
    });

    try {
        console.log(`[Migration] SSH connected. Target: ${remoteDir}`);
        await ssh.execCommand(`mkdir -p "${remoteDir}"`);

        console.log(`[Migration] Uploading ${fileCount} files via SFTP (concurrency: 20)...`);

        const failed = [];
        const result = await ssh.putDirectory(botDir, remoteDir, {
            recursive: true,
            concurrency: 20, // max parallel SFTP channels
            validate: (itemPath) => {
                const basename = path.basename(itemPath);
                const ext = path.extname(basename);
                if (EXCLUDED_NAMES.has(basename)) return false;
                if (EXCLUDED_EXT.has(ext)) return false;
                // Skip hidden dirs (starting with dot) that aren't .env files
                if (basename.startsWith('.') && ext !== '.env' && basename !== '.env') return false;
                return true;
            },
            tick: (localPath, remotePath, error) => {
                if (error) {
                    failed.push(path.basename(localPath));
                    console.warn(`[Migration] Skip: ${path.basename(localPath)}`);
                }
            }
        });

        if (!result && failed.length === fileCount) {
            throw new Error(`All file transfers failed. Check permissions on ${botDir}`);
        }

        console.log(`[Migration] Done! ${fileCount - failed.length}/${fileCount} files transferred to ${remoteDir}`);

        return {
            success: true,
            remoteDir,
            transferred: fileCount - failed.length,
            total: fileCount,
            failedFiles: failed.length,
            message: `${fileCount - failed.length} files transferred to ${remoteDir}`
        };

    } finally {
        ssh.dispose();
    }
}

module.exports = { migrateBot };
