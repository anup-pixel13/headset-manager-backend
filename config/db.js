import mysql from 'mysql2';
import dotenv from 'dotenv';

dotenv.config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'headset_inventory',
  port: Number(process.env.DB_PORT || 3306),
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
});

const db = pool.promise();

export const testDbConnection = async () => {
  const conn = await db.getConnection();
  try {
    await conn.query('SELECT 1');
    console.log('✅ Database connected successfully');
    console.log(`   Database: ${process.env.DB_NAME}`);
    console.log(`   Host: ${process.env.DB_HOST}:${process.env.DB_PORT || 3306}`);
  } finally {
    conn.release();
  }
};

export const getDbConnection = async () => {
  return await db.getConnection();
};

export default db;