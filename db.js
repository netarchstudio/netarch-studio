// Connexion MySQL partagée par server.js et migrate-sqlite.js
// Réglages lus dans les variables d'environnement (voir .env.example)
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'netarch',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'netarch',
  charset: 'utf8mb4',
  timezone: 'Z',          // dates en UTC, comme avec SQLite
  dateStrings: true,      // dates renvoyées en texte "AAAA-MM-JJ hh:mm:ss"
  connectionLimit: 8
});

const TABLES = [
  `CREATE TABLE IF NOT EXISTS schema_current (
     id TINYINT PRIMARY KEY,
     data LONGTEXT NOT NULL,
     updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
   ) DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS schema_history (
     id INT AUTO_INCREMENT PRIMARY KEY,
     data LONGTEXT NOT NULL,
     saved_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
   ) DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS app_settings (
     setting_key VARCHAR(100) PRIMARY KEY,
     value LONGTEXT NOT NULL
   ) DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS custom_catalog (
     id VARCHAR(191) PRIMARY KEY,
     data LONGTEXT NOT NULL,
     created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
   ) DEFAULT CHARSET=utf8mb4`
];

// Attend que MySQL soit prêt (il met quelques secondes à démarrer au premier lancement), puis crée les tables
async function init(retries = 40) {
  for (let i = 1; ; i++) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch (e) {
      if (i >= retries) throw new Error('MySQL injoignable (' + (process.env.DB_HOST || 'localhost') + ') : ' + e.message);
      console.log(`En attente de MySQL… (${i}/${retries}) ${e.code || e.message}`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  for (const sql of TABLES) await pool.query(sql);
}

module.exports = { pool, init };
