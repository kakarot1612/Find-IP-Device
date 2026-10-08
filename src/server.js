'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { CiscoSshSession } = require('./ssh');
const { TraceError, traceCamera } = require('./cisco');

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
    });
    response.end(data);
  });
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/api/health') {
    return sendJson(response, 200, { ok: true, service: 'Cisco Camera Port Tracer' });
  }
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
