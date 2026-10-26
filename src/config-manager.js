'use strict';

const { execFile } = require('node:child_process');
const net = require('node:net');

const DEVICE_TYPES = ['cisco_ios', 'cisco_ios_telnet', 'cisco_nxos', 'cisco_xe', 'cisco_aireos'];
const DEFAULT_TIMEOUT_MS = 20000;

function isValidIp(value) {
  const parts = String(value || '').trim().split('.');
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function tcpPortCheck(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: timeoutMs });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
  });
}

function pingHost(ip, timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (!isValidIp(ip)) return resolve({ ok: false, message: `IP không hợp lệ: ${ip}` });
    const isWindows = process.platform === 'win32';
    const args = isWindows
      ? ['-n', '1', '-w', String(timeoutMs), ip]
      : ['-c', '1', '-W', String(Math.max(1, Math.ceil(timeoutMs / 1000))), ip];

    execFile('ping', args, { timeout: timeoutMs + 2000 }, (error) => {
      if (!error) return resolve({ ok: true, message: 'Ping OK' });
      if (error.code === 'ENOENT') {
        return tcpPortCheck(ip, 22, timeoutMs).then((open) => resolve(
          open
            ? { ok: true, message: 'Ping không khả dụng, cổng 22 (SSH) đang mở' }
            : { ok: false, message: 'Ping không khả dụng, cổng 22 (SSH) đóng' },
        ));
      }
      if (error.killed || error.signal) return resolve({ ok: false, message: 'Ping timeout' });
      return resolve({ ok: false, message: 'Ping thất bại (không phản hồi)' });
    });
  });
}

function toSessionOptions(switchInfo) {
  return {
    host: switchInfo.ip,
    username: switchInfo.username,
    password: switchInfo.password || undefined,
    enablePassword: switchInfo.secret || undefined,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    hostUsernamePrompt: isAireos(switchInfo.device_type),
  };
}

function saveCommand(deviceType) {
  if (deviceType === 'cisco_nxos') return 'copy running-config startup-config';
  if (deviceType === 'cisco_aireos') return 'save config';
  return 'write memory';
}

function isAireos(deviceType) {
  return deviceType === 'cisco_aireos';
}

async function sshTest(switchInfo, createSession) {
  if (switchInfo.device_type === 'cisco_ios_telnet') {
    return { ok: false, message: 'Telnet chưa được hỗ trợ ở phiên bản web (chỉ SSH).' };
  }
  const session = createSession(toSessionOptions(switchInfo));
  try {
    await session.connect();
    return { ok: true, message: `SSH OK (prompt: ${session.prompt || ''})` };
  } catch (error) {
    return { ok: false, message: `SSH lỗi: ${error.message}` };
  } finally {
    try { session.close(); } catch { /* noop */ }
  }
}

function detectCliErrors(output) {
  const lines = String(output || '').split(/\r?\n/).map((line) => line.trim());
  return lines.filter((line) => {
    if (!line) return false;
    if (/already\s+exists|already\s+in\s+use|name\s+exists/i.test(line)) return true;
    if (/duplicate\s+mac\s+filter|mac\s+filter\s+already|is\s+already\s+(added|configured|in\s+the\s+list)/i.test(line)) return true;
    if (/invalid\s+input/i.test(line)) return true;
    if (/incomplete\s+command/i.test(line)) return true;
    if (/ambiguous\s+command/i.test(line)) return true;
    if (/^%.*(error|invalid|incomplete|ambiguous|already|failed|denied|not\s+found)/i.test(line)) return true;
    return false;
  });
}

async function applyConfig(switchInfo, commands, createSession, emit, options = {}) {
  if (switchInfo.device_type === 'cisco_ios_telnet') {
    return { ok: false, message: 'Telnet chưa được hỗ trợ ở phiên bản web (chỉ SSH).' };
  }
  const shouldSave = options.save !== false;
  const session = createSession(toSessionOptions(switchInfo));
  const runLog = [];
  const record = (command, output, ok = true, error = null) => {
    runLog.push({ command, output, ok, error });
    if (emit) emit({ type: 'command', command, output, ok, error });
  };
  const failed = [];
  try {
    await session.connect();
    if (!isAireos(switchInfo.device_type)) {
      await session.run('configure terminal');
    }
    for (const command of commands) {
      const output = await session.run(command);
      const errors = detectCliErrors(output);
      const ok = errors.length === 0;
      const error = ok ? null : errors[0];
      record(command, output, ok, error);
      if (!ok) failed.push({ command, error });
    }
    if (!isAireos(switchInfo.device_type)) {
      await session.run('end');
    }
    if (shouldSave) {
      const save = saveCommand(switchInfo.device_type);
      record(save, await session.run(save));
    }
    if (failed.length) {
      const first = failed[0];
      return { ok: false, message: `Lệnh lỗi: ${first.command} — ${first.error}`, output: runLog, failed };
    }
    return { ok: true, message: `Áp dụng OK (${commands.length} lệnh)`, output: runLog };
  } catch (error) {
    return { ok: false, message: `Áp dụng lỗi: ${error.message}`, output: runLog };
  } finally {
    try { session.close(); } catch { /* noop */ }
  }
}

module.exports = {
  DEVICE_TYPES,
  DEFAULT_TIMEOUT_MS,
  isValidIp,
  pingHost,
  sshTest,
  applyConfig,
  detectCliErrors,
  toSessionOptions,
  saveCommand,
  isAireos,
};