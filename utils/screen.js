const { exec, execFile } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const isWindows = os.platform() === 'win32';

// Security: sanitize screen name and command to prevent shell injection
function sanitizeName(name) {
    return name.replace(/[^a-zA-Z0-9_\-\.]/g, '');
}
function sanitizeCommand(cmd) {
    // Remove characters that could break out of the screen stuff quoting
    return cmd.replace(/["\\\r]/g, '');
}

// Helper to run commands
function runCmd(command) {
    return new Promise((resolve, reject) => {
        if (isWindows) {
            console.log(`[Windows Mock] Executing: ${command}`);
            // Mock output for Windows to prevent crash
            if (command.includes('screen -ls')) {
                resolve("There are screens on:\n\t1234.test_bot\t(Detached)\n1 Socket in /run/screen/S-root.");
                return;
            }
            if (command.includes('hardcopy')) {
                const parts = command.split('-h ');
                const tempPath = parts.length > 1 ? parts[1].replace(/"/g, '').trim() : '';
                if (tempPath) {
                    fs.writeFileSync(tempPath, "[Mock Log Windows]\nSystem booting...\nBot is running...\nWaiting for trades...");
                }
                resolve("");
                return;
            }
            resolve("");
            return;
        }

        exec(command, { shell: '/bin/bash' }, (error, stdout, stderr) => {
            // screen -ls returns exit code 1 if no screens are found — stdout can be null
            const outStr = stdout || '';
            if (error && command.includes('screen -ls') && 
                (outStr.includes('No Sockets found') || outStr.includes('No Sockets') || outStr === '')) {
                return resolve('');
            }
            if (error && !outStr) {
                console.error(`Error executing ${command}:`, stderr || error.message);
                return reject(error);
            }
            resolve(outStr);
        });
    });
}

const ScreenUtils = {
    async listScreens() {
        try {
            const output = await runCmd('screen -ls');
            if (!output || output.includes('No Sockets found')) return [];
            
            let allProcs = [];
            if (!isWindows) {
                try {
                    // Get PPID, PID, CPU, MEM, and command
                    const psOut = await runCmd('ps -e -o ppid=,pid=,pcpu=,pmem=,comm=');
                    allProcs = psOut.split('\n').map(l => {
                        const parts = l.trim().split(/\s+/);
                        if (parts.length >= 5) {
                            return { 
                                ppid: parts[0], 
                                pid: parts[1], 
                                cpu: parseFloat(parts[2]) || 0, 
                                mem: parseFloat(parts[3]) || 0, 
                                comm: parts.slice(4).join(' ') 
                            };
                        }
                        return null;
                    }).filter(Boolean);
                } catch (e) {
                    console.error('Failed to get process tree:', e);
                }
            }

            const lines = output.split('\n');
            const screens = [];
            for (const line of lines) {
                if (line.includes('\t') && (line.includes('(Detached)') || line.includes('(Attached)'))) {
                    const parts = line.trim().split('\t');
                    const fullName = parts[0];
                    const status = parts[1] ? parts[1].replace(/[()]/g, '') : 'Unknown';
                    
                    const nameParts = fullName.split('.');
                    const pid = nameParts.shift();
                    // Screen names can contain dots, so join all remaining parts
                    const name = nameParts.join('.');
                    // Guard: pid must be numeric
                    if (!pid || !/^\d+$/.test(pid)) continue;
                    
                    let cwd = 'Unknown';
                    let isActive = false;
                    let startTime = null;
                    let cpuUsage = 0;
                    let memUsage = 0;

                    try {
                        if (!isWindows) {
                            cwd = fs.readlinkSync(`/proc/${pid}/cwd`);

                            // --- isActive & Resources check ---
                            if (allProcs.length > 0) {
                                const screenChildren = allProcs.filter(p => String(p.ppid) === String(pid));
                                for (const child of screenChildren) {
                                    cpuUsage += child.cpu;
                                    memUsage += child.mem;
                                    
                                    if (child.comm !== 'bash' && child.comm !== 'sh' && child.comm !== 'SCREEN') {
                                        isActive = true;
                                    } else {
                                        const shellChildren = allProcs.filter(p => String(p.ppid) === String(child.pid));
                                        if (shellChildren.length > 0) { 
                                            isActive = true; 
                                            shellChildren.forEach(sc => {
                                                cpuUsage += sc.cpu;
                                                memUsage += sc.mem;
                                            });
                                        }
                                    }
                                }
                            }

                            // --- startTime from /proc/pid/stat ---
                            try {
                                const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
                                const fields = stat.split(' ');
                                const jiffies = parseInt(fields[21]);
                                const bootStatRaw = fs.readFileSync('/proc/stat', 'utf8');
                                const btimeLine = bootStatRaw.split('\n').find(l => l.startsWith('btime'));
                                const bootTime = btimeLine ? parseInt(btimeLine.split(' ')[1]) : 0;
                                startTime = (Math.floor(jiffies / 100) + bootTime) * 1000;
                            } catch(e) {}

                        } else {
                            cwd = 'C:\\mock\\bot_dir';
                            isActive = true;
                            startTime = Date.now() - 3600000;
                        }
                    } catch(e) {}

                    screens.push({ 
                        pid, 
                        name, 
                        fullName, 
                        status, 
                        cwd, 
                        isActive, 
                        startTime, 
                        cpu: cpuUsage.toFixed(1), 
                        mem: memUsage.toFixed(1) 
                    });
                }
            }
            return screens;
        } catch (err) {
            console.error('List screen error:', err);
            return [];
        }
    },

    async stopScreen(name) {
        const safeName = sanitizeName(name);
        // BUG FIX: $'\003' requires bash shell. Pass via execFile with bash -c explicitly.
        // Using printf to generate the Ctrl+C byte reliably.
        return new Promise((resolve, reject) => {
            if (isWindows) { console.log(`[Mock] Stop: ${safeName}`); return resolve(''); }
            execFile('bash', ['-c', `screen -S ${safeName} -X stuff $'\x03'`], (err, stdout) => {
                if (err) return reject(err);
                resolve(stdout || '');
            });
        });
    },

    async restartScreen(name, command) {
        const safeName = sanitizeName(name);
        const safeCmd = sanitizeCommand(command);
        await this.stopScreen(safeName);
        await new Promise(r => setTimeout(r, 1500));
        return new Promise((resolve, reject) => {
            if (isWindows) { console.log(`[Mock] Restart: ${safeName} with ${safeCmd}`); return resolve(''); }
            // Use direct execFile to avoid bash substitution issues
            execFile('screen', ['-S', safeName, '-X', 'stuff', safeCmd + '\r'], (err, stdout) => {
                if (err) return reject(err);
                resolve(stdout || '');
            });
        });
    },

    async killScreen(name) {
        const safeName = sanitizeName(name);
        return runCmd(`screen -S ${safeName} -X quit`);
    },

    async getLog(name) {
        const safeName = sanitizeName(name);
        // Use os tmpdir for temporary hardcopy dump file
        const tempFile = path.join(os.tmpdir(), `vpsmon_log_${safeName}_${Date.now()}.txt`);
        try {
            await runCmd(`screen -S ${safeName} -X hardcopy -h "${tempFile}"`);
            if (fs.existsSync(tempFile)) {
                const content = fs.readFileSync(tempFile, 'utf-8');
                fs.unlinkSync(tempFile); // clean up immediately
                return content;
            }
            return 'No logs found or screen is not accessible.';
        } catch (err) {
            if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
            throw err;
        }
    },

    async sendCommandToScreen(name, command) {
        const safeName = sanitizeName(name);
        return new Promise((resolve, reject) => {
            if (isWindows) { console.log(`[Mock] Send to ${safeName}: ${command}`); return resolve(''); }
            // Using execFile directly to screen prevents bash command substitution vulnerability
            execFile('screen', ['-S', safeName, '-X', 'stuff', command + '\r'], (err, stdout) => {
                if (err) return reject(err);
                resolve(stdout || '');
            });
        });
    },

    async startNewScreen(name, command, directoryPath) {
        const safeName = sanitizeName(name);
        const safeCmd = sanitizeCommand(command);
        // BUG FIX: Use { cwd } option so the screen inherits the correct working directory.
        // `cd && screen` doesn't work reliably in exec() because cd is not persistent.
        return new Promise((resolve, reject) => {
            if (isWindows) { console.log(`[Mock] Start: ${safeName} -> ${safeCmd} in ${directoryPath}`); return resolve(''); }
            // Start detached screen first, with cwd set to bot directory
            execFile('bash', ['-c', `screen -dmS ${safeName} bash -c '${safeCmd}'`], { cwd: directoryPath }, (err, stdout) => {
                if (err) return reject(err);
                resolve(stdout || '');
            });
        });
    }
};

module.exports = ScreenUtils;
