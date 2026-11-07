const Database = require('better-sqlite3');
const fs = require('fs');

function run() {
    const args = process.argv.slice(2);
    if (args.length < 2) {
        console.error(JSON.stringify({ error: "Missing arguments. Usage: node db_reader.js <dbPath> <query> [params...]" }));
        process.exit(1);
    }

    const dbPath = args[0];
    const query = args[1];
    
    // Any remaining arguments are query parameters
    let params = [];
    if (args.length > 2) {
        try {
            params = JSON.parse(args[2]);
        } catch(e) {
            params = args.slice(2);
        }
    }

    if (!fs.existsSync(dbPath)) {
        console.error(JSON.stringify({ error: `Database file not found: ${dbPath}` }));
        process.exit(1);
    }

    try {
        const db = new Database(dbPath);
        
        let result;
        if (query === '__INFO__') {
            const fileSize = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
            let tableSizes = [];
            try {
                const tableSizeQuery = `
                    SELECT 
                        m.name AS tableName,
                        COALESCE(t.sizeBytes, 0) AS sizeBytes
                    FROM (
                        SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
                    ) m
                    LEFT JOIN (
                        SELECT 
                            COALESCE(
                                (SELECT tbl_name FROM sqlite_master WHERE name = dbstat.name),
                                dbstat.name
                            ) AS tbl_name,
                            SUM(pgsize) AS sizeBytes
                        FROM dbstat
                        GROUP BY tbl_name
                    ) t ON m.name = t.tbl_name;
                `;
                tableSizes = db.prepare(tableSizeQuery).all();
            } catch (e) {
                // Fallback if dbstat is not available
                const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
                tableSizes = tables.map(t => ({ tableName: t.name, sizeBytes: 0 }));
            }

            const tablesInfo = tableSizes.map(item => {
                let rowCount = 0;
                try {
                    const row = db.prepare(`SELECT count(*) AS count FROM "${item.tableName}"`).get();
                    rowCount = row ? row.count : 0;
                } catch (e) {}
                return {
                    name: item.tableName,
                    sizeBytes: item.sizeBytes,
                    rowCount: rowCount
                };
            });

            db.close();
            console.log(JSON.stringify({ success: true, fileSize, tables: tablesInfo }));
            process.exit(0);
        }

        const upperQuery = query.trim().toUpperCase();
        if (upperQuery.startsWith('SELECT') || upperQuery.startsWith('PRAGMA') || upperQuery.startsWith('DROP')) {
            const stmt = db.prepare(query);
            if (upperQuery.startsWith('SELECT') || upperQuery.startsWith('PRAGMA')) {
                result = stmt.all(...params);
            } else {
                const runInfo = stmt.run(...params);
                result = [{ success: true, changes: runInfo.changes }];
            }
        } else {
            console.error(JSON.stringify({ error: "Only SELECT, PRAGMA, or DROP queries are allowed for safety." }));
            process.exit(1);
        }

        db.close();
        
        // Output strictly JSON so the dashboard can parse it
        console.log(JSON.stringify({ success: true, data: result }));
        process.exit(0);
        
    } catch (err) {
        console.error(JSON.stringify({ error: err.message }));
        process.exit(1);
    }
}

run();
