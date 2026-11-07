const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

function getDbPath() {
  const localDb = path.resolve(__dirname, 'Virtual FootBall Data', 'virtual_football_archive.db');
  if (fs.existsSync(localDb)) return localDb;
  const currentDirDb = path.resolve(__dirname, 'virtual_football_archive.db');
  if (fs.existsSync(currentDirDb)) return currentDirDb;
  return localDb;
}

const dbPath = getDbPath();
const db = new Database(dbPath);
const row = db.prepare("SELECT data FROM seasons LIMIT 1").get();
const parsed = JSON.parse(row.data);

if (parsed['Head to Head'] && parsed['Head to Head'].default) {
  console.log("=== ALL HEAD TO HEAD TABLES ===");
  parsed['Head to Head'].default.tables.forEach((t, i) => {
    console.log(`Index ${i}: ${t}`);
  });
}
db.close();
