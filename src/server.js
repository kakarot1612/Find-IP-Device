'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { CiscoSshSession } = require('./ssh');
const { TraceError, traceCamera } = require('./cisco');
const { pingHost, sshTest, applyConfig, isValidIp } = require('./config-manager');

const PORT = Number(process.env.PORT) || 3030;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// Xác thực quản trị (phiên đăng nhập)
// ---------------------------------------------------------------------------
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';
if (!process.env.ADMIN_PASSWORD) {
  console.warn('[auth] ADMIN_PASSWORD chưa được thiết lập — đang dùng mặc định "admin". Hãy đổi qua setup-credentials.ps1 hoặc biến môi trường.');
}

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 giờ
const sessions = new Map();

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function safeEqual(left, right) {
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function parseCookies(request) {
  const header = request.headers.cookie || '';
  const result = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    result[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return result;
}

function getSession(request) {
  const token = parseCookies(request).session;
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function isTrustedOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function hasValidApiKey(request) {
  if (!ADMIN_API_KEY) return false;
  const header = request.headers['x-api-key'];
  if (!header) return false;
  return safeEqual(sha256(header), sha256(ADMIN_API_KEY));
}

function guard(request, response) {
  if (!getSession(request) && !hasValidApiKey(request)) {
    sendJson(response, 401, { error: 'Chưa đăng nhập.' });
    return false;
  }
  if (request.method === 'POST' && !isTrustedOrigin(request)) {
    sendJson(response, 403, { error: 'Origin không hợp lệ.' });
    return false;
  }
  return true;
}

async function handleLogin(request, response) {
  let input = {};
  try {
    input = await readJson(request);
  } catch (error) {
    return sendJson(response, 400, { error: error.message });
  }
  const username = String(input.username || '');
  const password = String(input.password || '');
  const userOk = safeEqual(sha256(username), sha256(ADMIN_USERNAME));
  const passOk = safeEqual(sha256(password), sha256(ADMIN_PASSWORD));
  if (!userOk || !passOk) {
    return sendJson(response, 401, { error: 'Sai tên đăng nhập hoặc mật khẩu.' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username: ADMIN_USERNAME, expiresAt: Date.now() + SESSION_TTL_MS });
  response.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Set-Cookie': `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
  });
  response.end(JSON.stringify({ ok: true, username: ADMIN_USERNAME }));
}

function handleLogout(request, response) {
  const token = parseCookies(request).session;
  if (token) sessions.delete(token);
  response.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Set-Cookie': 'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
  });
  response.end(JSON.stringify({ ok: true }));
}

function handleSession(request, response) {
  const session = getSession(request);
  sendJson(response, 200, { authenticated: Boolean(session), username: session?.username || null });
}

async function readJson(request) {
  let total = 0;
  const chunks = [];
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new TraceError('Dữ liệu gửi lên quá lớn.', 'BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new TraceError('JSON không hợp lệ.', 'INVALID_JSON');
  }
}

function writeEvent(response, event) {
  if (!response.destroyed) response.write(`${JSON.stringify(event)}\n`);
}

async function handleTrace(request, response) {
  response.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-store',
    Connection: 'keep-alive',
    'X-Content-Type-Options': 'nosniff',
  });

  try {
    const input = await readJson(request);
    await traceCamera(input, {
      emit: (event) => writeEvent(response, event),
      createSession: (options) => new CiscoSshSession(options),
    });
  } catch (error) {
    writeEvent(response, {
      type: 'error',
      error: {
        code: error.code || 'UNEXPECTED_ERROR',
        message: error.message || 'Có lỗi không xác định.',
        details: error.details || null,
      },
    });
  } finally {
    response.end();
  }
}

async function handleTraceBatch(request, response) {
  response.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-store',
    Connection: 'keep-alive',
    'X-Content-Type-Options': 'nosniff',
  });

  try {
    const input = await readJson(request);
    if (!Array.isArray(input.cameraIps) || input.cameraIps.length === 0) {
      throw new TraceError('Danh sách IP camera đang trống.', 'EMPTY_CAMERA_LIST');
    }
    if (input.cameraIps.length > 1000) {
      throw new TraceError('Mỗi lần chỉ xử lý tối đa 1000 IP camera.', 'CAMERA_LIST_TOO_LARGE');
    }

    const cameraIps = input.cameraIps.map((value) => String(value).trim());
    writeEvent(response, { type: 'batch-start', total: cameraIps.length });

    let succeeded = 0;
    let failed = 0;
    for (let index = 0; index < cameraIps.length; index += 1) {
      if (response.destroyed) break;
      const cameraIp = cameraIps[index];
      const batch = { index: index + 1, total: cameraIps.length, cameraIp };
      writeEvent(response, { type: 'item-start', ...batch });
      try {
        await traceCamera({ ...input, cameraIp }, {
          emit: (event) => writeEvent(response, { ...event, ...batch }),
          createSession: (options) => new CiscoSshSession(options),
        });
        succeeded += 1;
      } catch (error) {
        failed += 1;
        writeEvent(response, {
          type: 'item-error',
          ...batch,
          error: {
            code: error.code || 'UNEXPECTED_ERROR',
            message: error.message || 'Có lỗi không xác định.',
            details: error.details || null,
          },
        });
      }
      writeEvent(response, { type: 'item-finish', ...batch, succeeded, failed });
    }
    writeEvent(response, { type: 'batch-complete', total: cameraIps.length, succeeded, failed });
  } catch (error) {
    writeEvent(response, {
      type: 'error',
      error: {
        code: error.code || 'UNEXPECTED_ERROR',
        message: error.message || 'Có lỗi không xác định.',
        details: error.details || null,
      },
    });
  } finally {
    response.end();
  }
}

async function handleConfigManager(request, response, action) {
  response.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-store',
    Connection: 'keep-alive',
    'X-Content-Type-Options': 'nosniff',
  });

  try {
    const input = await readJson(request);
    const switches = Array.isArray(input.switches) ? input.switches : [];
    const commands = Array.isArray(input.commands)
      ? input.commands.map((command) => String(command).trim()).filter(Boolean)
      : [];

    if (!switches.length) throw new TraceError('Chưa có switch nào trong danh sách.', 'EMPTY_SWITCH_LIST');
    if (switches.length > 1000) throw new TraceError('Mỗi lần tối đa 1000 switch.', 'SWITCH_LIST_TOO_LARGE');
    if (action === 'apply' && !commands.length) throw new TraceError('Chưa có lệnh cấu hình nào.', 'EMPTY_COMMAND_LIST');

    writeEvent(response, { type: 'batch-start', action, total: switches.length });

    let succeeded = 0;
    let failed = 0;
    for (let index = 0; index < switches.length; index += 1) {
      if (response.destroyed) break;
      const switchInfo = switches[index];
      const ip = String(switchInfo.ip || '').trim();
      const name = String(switchInfo.name || '').trim();
      const batch = { index: index + 1, total: switches.length, ip, name };
      writeEvent(response, { type: 'item-start', ...batch });

      let result;
      if (!isValidIp(ip)) {
        result = { ok: false, message: `IP không hợp lệ: ${ip}` };
      } else {
        const createSession = (options) => new CiscoSshSession(options);
        if (action === 'ping') {
          result = await pingHost(ip);
        } else if (action === 'ssh-test') {
          result = await sshTest(switchInfo, createSession);
        } else {
          result = await applyConfig(switchInfo, commands, createSession, (event) => writeEvent(response, { ...event, ...batch }));
        }
      }

      if (result.ok) succeeded += 1;
      else failed += 1;
      writeEvent(response, {
        type: 'item-result',
        ...batch,
        ok: result.ok,
        message: result.message,
        commands: result.output || null,
      });
      writeEvent(response, { type: 'item-finish', ...batch, succeeded, failed });
    }

    writeEvent(response, { type: 'batch-complete', action, total: switches.length, succeeded, failed });
  } catch (error) {
    writeEvent(response, {
      type: 'error',
      error: {
        code: error.code || 'UNEXPECTED_ERROR',
        message: error.message || 'Có lỗi không xác định.',
        details: error.details || null,
      },
    });
  } finally {
    response.end();
  }
}

async function handleCameraPorts(request, response) {
  let input;
  try {
    input = await readJson(request);
  } catch (error) {
    return sendJson(response, 400, { ok: false, error: error.message });
  }

  const cameraIps = Array.isArray(input.cameraIps)
    ? input.cameraIps.map((value) => String(value).trim()).filter(Boolean)
    : [];

  if (cameraIps.length === 0) {
    return sendJson(response, 400, { ok: false, error: 'Danh sách IP camera đang trống.' });
  }
  if (cameraIps.length > 1000) {
    return sendJson(response, 400, { ok: false, error: 'Mỗi lần chỉ xử lý tối đa 1000 IP camera.' });
  }

  const results = [];
  let succeeded = 0;
  let failed = 0;

  for (const cameraIp of cameraIps) {
    try {
      const result = await traceCamera(
        {
          cameraIp,
          coreHost: input.coreHost,
          maxHops: input.maxHops,
          timeoutMs: input.timeoutMs,
        },
        {
          createSession: (options) => new CiscoSshSession(options),
        },
      );
      results.push({
        cameraIp,
        status: 'success',
        switchName: result.finalDevice,
        switchIp: result.finalHost,
        port: result.finalPort,
        mac: result.cameraMac,
        vlan: result.vlan,
        hops: result.hops?.length ?? 0,
        path: (result.hops || []).map((hop) => `${hop.device} [${hop.host}] ${hop.port}`).join(' -> '),
      });
      succeeded += 1;
    } catch (error) {
      results.push({
        cameraIp,
        status: 'error',
        error: error.message || 'Có lỗi không xác định.',
        errorCode: error.code || 'UNEXPECTED_ERROR',
      });
      failed += 1;
    }
  }

  return sendJson(response, 200, { ok: true, total: cameraIps.length, succeeded, failed, results });
}

function serveStatic(request, response) {
  const requestPath = new URL(request.url, `http://${request.headers.host || 'localhost'}`).pathname;
  const relativePath = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
  const resolved = path.resolve(PUBLIC_DIR, relativePath);
  const publicRoot = path.resolve(PUBLIC_DIR);
  if (!resolved.startsWith(`${publicRoot}${path.sep}`) && resolved !== path.join(PUBLIC_DIR, 'index.html')) {
    return sendJson(response, 403, { error: 'Forbidden' });
  }
  fs.readFile(resolved, (error, data) => {
    if (error) return sendJson(response, error.code === 'ENOENT' ? 404 : 500, { error: 'Không đọc được file.' });
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(resolved)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
    response.end(data);
  });
}

const server = http.createServer(async (request, response) => {
  // Endpoint công khai (cần cho màn hình đăng nhập và healthcheck)
  if (request.method === 'GET' && request.url === '/api/health') {
    return sendJson(response, 200, { ok: true, service: 'Cisco Camera Port Tracer' });
  }
  if (request.method === 'GET' && request.url === '/api/session') return handleSession(request, response);
  if (request.method === 'POST' && request.url === '/api/login') return handleLogin(request, response);
  if (request.method === 'POST' && request.url === '/api/logout') return handleLogout(request, response);

  // Các API còn lại đều yêu cầu đăng nhập
  if (request.url.startsWith('/api/') && !guard(request, response)) return;

  if (request.method === 'GET' && request.url === '/api/config') {
    return sendJson(response, 200, {
      credentialsLoaded: Boolean(
        process.env.CISCO_SSH_USERNAME
        && (process.env.CISCO_SSH_PASSWORD || process.env.CISCO_SSH_PRIVATE_KEY),
      ),
      authentication: process.env.CISCO_SSH_PRIVATE_KEY ? 'private-key' : 'password',
    });
  }
  if (request.method === 'POST' && request.url === '/api/trace') return handleTrace(request, response);
  if (request.method === 'POST' && request.url === '/api/trace-batch') return handleTraceBatch(request, response);
  if (request.method === 'POST' && request.url === '/api/config-manager/ping') return handleConfigManager(request, response, 'ping');
  if (request.method === 'POST' && request.url === '/api/config-manager/ssh-test') return handleConfigManager(request, response, 'ssh-test');
  if (request.method === 'POST' && request.url === '/api/config-manager/apply') return handleConfigManager(request, response, 'apply');
  if (request.method === 'POST' && request.url === '/api/camera-ports') return handleCameraPorts(request, response);
  if (request.method === 'GET' || request.method === 'HEAD') return serveStatic(request, response);
  return sendJson(response, 405, { error: 'Method not allowed' });
});

server.listen(PORT, HOST, () => {
  console.log(`Cisco Camera Port Tracer đang chạy tại http://${HOST}:${PORT}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
