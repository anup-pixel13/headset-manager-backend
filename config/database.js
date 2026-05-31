import mysql from 'mysql2';
import dotenv from 'dotenv';

dotenv.config();

// Create connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'headset_inventory',
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
});

// Test connection
pool.getConnection((err, connection) => {
  if (err) {
    console.error('❌ Database connection failed:', err.message);
    console.error('   Check your .env configuration');
  } else {
    console.log('✅ Database connected successfully');
    console.log(`   Database: ${process.env.DB_NAME}`);
    console.log(`   Host: ${process.env.DB_HOST}:${process.env.DB_PORT || 3306}`);
    connection.release();
  }
});

// Handle connection errors
pool.on('error', (err) => {
  console.error('❌ Database pool error:', err.message);
  if (err.code === 'PROTOCOL_CONNECTION_LOST') {
    console.error('   Database connection was closed.');
  }
  if (err.code === 'ER_CON_COUNT_ERROR') {
    console.error('   Database has too many connections.');
  }
  if (err.code === 'ECONNREFUSED') {
    console.error('   Database connection was refused.');
  }
});

// Export promise-based pool (for normal queries)
const db = pool.promise();

// ✅ Also export a helper to get a promise-based connection (for transactions)
export const getDbConnection = async () => {
  const conn = await pool.promise().getConnection();
  return conn;
};

export default db;