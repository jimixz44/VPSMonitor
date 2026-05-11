const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error connecting to SQLite database:', err.message);
    } else {
        console.log('Connected to SQLite database.');
    }
});

// Initialize DB schema with proper non-async callback chain
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT NOT NULL
    )`, (err) => {
        if (err) return console.error('Failed to create users table:', err.message);

        // Create bot_configs table to save commands and directories
        db.run(`CREATE TABLE IF NOT EXISTS bot_configs (
            name TEXT PRIMARY KEY,
            command TEXT,
            directory TEXT
        )`, (err) => {
            if (err) console.error('Failed to create bot_configs table:', err.message);
            // Attempt to add directory column if it doesn't exist (migration)
            db.run(`ALTER TABLE bot_configs ADD COLUMN directory TEXT`, () => {});
        });

        // BUG FIX: Moved user creation inside the CREATE TABLE callback to guarantee
        // the table exists before querying it. Using bcrypt.hashSync to avoid
        // async inside SQLite serialize() which can cause race conditions.
        db.get('SELECT count(*) as count FROM users', (err, row) => {
            if (err) return console.error('Failed to query users:', err.message);
            if (row && row.count === 0) {
                // hashSync is acceptable here because it only runs once on first startup
                const hash = require('bcrypt').hashSync('admin123', 10);
                db.run('INSERT INTO users (username, password) VALUES (?, ?)', ['admin', hash], (err) => {
                    if (err) console.error('Error creating default user:', err.message);
                    else {
                        console.log('Default admin user created.');
                        console.log('Username: admin | Password: admin123');
                        console.log('IMPORTANT: Please change this password after first login!');
                    }
                });
            }
        });
    });
});

module.exports = db;
