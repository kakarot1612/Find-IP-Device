'use strict';

const mysql = require('mysql2/promise');

const DB_CONFIG = {
  host: process.env.RADIUS_DB_HOST || '127.0.0.1',
  port: Number(process.env.RADIUS_DB_PORT) || 3306,
  user: process.env.RADIUS_DB_USER || 'radius',
  password: process.env.RADIUS_DB_PASSWORD || '',
  database: process.env.RADIUS_DB_NAME || 'radiusdb',
  connectionLimit: 5,
  waitForConnections: true,
  connectTimeout: 10000,
};

let pool = null;

function getPool() {
  if (!pool) pool = mysql.createPool(DB_CONFIG);
  return pool;
}

/** Chuẩn hóa MAC về 12 ký tự hex không dấu phân cách (aabbccddeeff). */
function normalizeMac(value) {
  const compact = String(value || '').replace(/[^a-fA-F0-9]/g, '').toLowerCase();
  if (!/^[a-f0-9]{12}$/.test(compact)) return null;
  return compact;
}

/**
 * Thêm một MAC vào FreeRADIUS/DaloRADIUS (MAC authentication).
 * - radcheck: username = MAC, Cleartext-Password = MAC.
 * - radusergroup: gán group/VLAN.
 * - userinfo: thông tin hiển thị (tên thiết bị, notes).
 * Giao dịch nguyên tử; nếu MAC đã tồn tại, trả lỗi already_exists.
 */
async function addMacToRadius({ mac, deviceName, group, department, notes, createdBy }) {
  const username = normalizeMac(mac);
  if (!username) {
    return { ok: false, code: 'INVALID_MAC', message: 'MAC không hợp lệ (cần 12 ký tự hex).' };
  }
  const groupName = String(group || 'VLAN16_QR').trim();
  const createdByValue = String(createdBy || 'API_Gateway').trim() || 'API_Gateway';

  const db = getPool();
  let connection;
  try {
    connection = await db.getConnection();
  } catch (error) {
    return { ok: false, code: 'DB_CONNECT_ERROR', message: `Không kết nối được tới RADIUS DB: ${error.message}` };
  }

  try {
    await connection.beginTransaction();

    // Kiểm tra trùng trong radcheck
    const [existing] = await connection.query(
      'SELECT username FROM radcheck WHERE username = ? LIMIT 1',
      [username],
    );
    if (Array.isArray(existing) && existing.length > 0) {
      await connection.rollback();
      return { ok: false, code: 'ALREADY_EXISTS', message: `MAC ${username} đã tồn tại trong RADIUS.` };
    }

    // 1. radcheck
    await connection.query(
      'INSERT INTO radcheck (username, attribute, op, value) VALUES (?, ?, ?, ?)',
      [username, 'Cleartext-Password', ':=', username],
    );

    // 2. radusergroup
    await connection.query(
      'INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, ?)',
      [username, groupName, 1],
    );

    // 3. userinfo
    await connection.query(
      'INSERT INTO userinfo (username, firstname, department, notes, creationdate, creationby, updatedate, updateby) '
      + 'VALUES (?, ?, ?, ?, NOW(), ?, NOW(), ?)',
      [username, String(deviceName || '').trim(), String(department || '').trim(), String(notes || '').trim(), createdByValue, createdByValue],
    );

    await connection.commit();

    return {
      ok: true,
      code: 'CREATED',
      message: `Đã thêm MAC ${username} vào RADIUS.`,
      mac: username,
      group: groupName,
    };
  } catch (error) {
    try { await connection.rollback(); } catch { /* noop */ }
    return { ok: false, code: 'DB_ERROR', message: `Lỗi DB: ${error.message}` };
  } finally {
    connection.release();
  }
}

/** Kiểm tra MAC đã tồn tại trong RADIUS chưa. */
async function macExists(username) {
  const compact = normalizeMac(username);
  if (!compact) return false;
  const db = getPool();
  try {
    const [rows] = await db.query('SELECT username FROM radcheck WHERE username = ? LIMIT 1', [compact]);
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    return false;
  }
}

module.exports = { addMacToRadius, macExists, normalizeMac, getPool };