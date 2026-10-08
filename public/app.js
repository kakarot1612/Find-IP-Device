'use strict';

const form = document.querySelector('#trace-form');
const traceButton = document.querySelector('#trace-button');
const emptyState = document.querySelector('#empty-state');
const runState = document.querySelector('#run-state');
const statusBanner = document.querySelector('#status-banner');
const statusTitle = document.querySelector('#status-title');
const statusDetail = document.querySelector('#status-detail');
const timeline = document.querySelector('#timeline');
const summary = document.querySelector('#summary');
const commandList = document.querySelector('#command-list');
const commandCount = document.querySelector('#command-count');
const clearButton = document.querySelector('#clear-button');
const credentialVault = document.querySelector('#credential-vault');
const credentialTitle = document.querySelector('#credential-title');
const credentialDetail = document.querySelector('#credential-detail');
const cameraIpsInput = document.querySelector('#camera-ips');
const cameraFileInput = document.querySelector('#camera-file');
const ipCount = document.querySelector('#ip-count');
const batchToolbar = document.querySelector('#batch-toolbar');
const batchProgress = document.querySelector('#batch-progress');
const batchTableWrap = document.querySelector('#batch-table-wrap');
const batchTableBody = document.querySelector('#batch-table-body');
const exportCsvButton = document.querySelector('#export-csv');

let commands = 0;
let credentialsReady = false;
let batchResults = [];
let batchSize = 0;

async function checkCredentials() {
  try {
    const response = await fetch('/api/config');
    const config = await response.json();
    credentialsReady = config.credentialsLoaded;
    credentialVault.className = `credential-vault ${credentialsReady ? 'ready' : 'missing'}`;
    credentialTitle.textContent = credentialsReady ? 'Credential SSH đã được nạp' : 'Chưa nạp credential SSH';
    credentialDetail.textContent = credentialsReady
      ? `Windows DPAPI • ${config.authentication} • Áp dụng cho mọi hop`
      : 'Chạy setup-credentials.ps1, sau đó mở lại app';
    traceButton.disabled = !credentialsReady;
  } catch {
    credentialsReady = false;
    credentialVault.className = 'credential-vault missing';
    credentialTitle.textContent = 'Không đọc được trạng thái credential';
    credentialDetail.textContent = 'Kiểm tra server ứng dụng và chạy lại start-app.cmd';
    traceButton.disabled = true;
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function isValidIpv4(value) {
  const parts = String(value).split('.');
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function parseCameraList(text) {
  const valid = [];
  const invalid = [];
  const duplicates = [];
  const seen = new Set();
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const candidates = line.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) || [];
    const lineValid = candidates.filter(isValidIpv4);
    if (!lineValid.length) {
      if (!/^(?:ip|camera|camera ip|ip camera)(?:\s*[,;\t].*)?$/i.test(line)) invalid.push(line);
      continue;
    }
    for (const ip of lineValid) {
      if (seen.has(ip)) duplicates.push(ip);
      else {
        seen.add(ip);
        valid.push(ip);
      }
    }
  }
  return { valid, invalid, duplicates };
}

function updateIpCount() {
  const parsed = parseCameraList(cameraIpsInput.value);
  const notes = [`${parsed.valid.length} IP hợp lệ`];
  if (parsed.duplicates.length) notes.push(`${parsed.duplicates.length} trùng`);
  if (parsed.invalid.length) notes.push(`${parsed.invalid.length} dòng lỗi`);
  ipCount.textContent = notes.join(' • ');
}

function setStatus(kind, title, detail) {
  statusBanner.className = `status-banner ${kind}`;
  statusTitle.textContent = title;
  statusDetail.textContent = detail;
}

function resetResults() {
  commands = 0;
  batchResults = [];
  batchSize = 0;
  commandCount.textContent = '0';
  timeline.innerHTML = '';
  commandList.innerHTML = '';
  summary.innerHTML = '';
  summary.classList.add('hidden');
  batchToolbar.classList.add('hidden');
  batchTableWrap.classList.add('hidden');
  exportCsvButton.classList.add('hidden');
  batchTableBody.innerHTML = '';
  batchProgress.textContent = '0 / 0';
  statusBanner.className = 'status-banner running';
}

function startRun() {
  resetResults();
  emptyState.classList.add('hidden');
  runState.classList.remove('hidden');
  traceButton.disabled = true;
  traceButton.classList.add('loading');
  document.querySelector('.button-text').textContent = 'Đang dò tuần tự...';
}

function stopRun() {
  traceButton.disabled = !credentialsReady;
  traceButton.classList.remove('loading');
  document.querySelector('.button-text').textContent = 'Bắt đầu dò port';
}

function addCommand(event) {
  commands += 1;
  commandCount.textContent = String(commands);
  const entry = document.createElement('div');
  entry.className = 'command-entry';
  entry.innerHTML = `<div class="command-title"><span>${escapeHtml(event.command)}</span><span>${escapeHtml(event.cameraIp || '')} @ ${escapeHtml(event.host)}</span></div><pre>${escapeHtml(event.output || '(không có output)')}</pre>`;
  commandList.append(entry);
}

function addHop(hop) {
  const card = document.createElement('article');
  card.className = 'hop-card';
  const target = hop.neighbor?.likelySwitch ? (hop.neighbor.deviceId || hop.neighbor.ip || 'Switch kế tiếp') : 'Camera / endpoint';
  const note = hop.neighbor?.likelySwitch
    ? `${hop.neighbor.protocol} • IP quản trị ${hop.neighbor.ip || 'không có'}`
    : 'Port access / endpoint cuối';
  const discoveryNote = hop.neighborPort && hop.neighborPort !== hop.port ? ` • qua member ${hop.neighborPort}` : '';
  const memberNote = hop.etherchannel?.members?.length
    ? ` • ${hop.etherchannel.portChannel}: ${hop.etherchannel.members.map((member) => `${member.port}(${member.state})`).join(', ')}`
    : '';
  card.innerHTML = `
    <div class="hop-header"><div><small>HOP ${String(hop.number).padStart(2, '0')}</small><strong>${escapeHtml(hop.device)}</strong></div><span class="hop-host">${escapeHtml(hop.host)}</span></div>
    <div class="hop-route"><div class="route-box"><span>MAC table</span><strong>${escapeHtml(hop.macEntry.mac)}</strong></div><span class="route-arrow">→</span><div class="route-box"><span>${escapeHtml(hop.port)}</span><strong>${escapeHtml(target)}</strong></div></div>
    <p class="neighbor-note">${escapeHtml(note)}${escapeHtml(discoveryNote)}${hop.switchport?.operationalMode ? ` • ${escapeHtml(hop.switchport.operationalMode)}` : ''}${escapeHtml(memberNote)}</p>`;
  timeline.append(card);
}

function showSummary(result) {
  summary.classList.remove('hidden');
  summary.innerHTML = `
    <div class="summary-main"><span>Port camera cuối cùng</span><strong>${escapeHtml(result.finalPort)}</strong></div>
    <div class="summary-item"><span>Thiết bị</span><strong>${escapeHtml(result.finalDevice)}</strong></div>
    <div class="summary-item"><span>IP quản trị</span><strong>${escapeHtml(result.finalHost)}</strong></div>
    <div class="summary-item"><span>Camera</span><strong>${escapeHtml(result.cameraIp)}</strong></div>
    <div class="summary-item"><span>MAC / VLAN</span><strong>${escapeHtml(result.cameraMac)} / ${escapeHtml(result.vlan ?? 'N/A')}</strong></div>`;
}

function resultPath(result) {
  return (result.hops || []).map((hop) => {
    const member = hop.neighborPort && hop.neighborPort !== hop.port ? ` via ${hop.neighborPort}` : '';
    return `${hop.device} [${hop.host}] ${hop.port}${member}`;
  }).join(' -> ');
}

function addBatchResult(record) {
  batchResults.push(record);
  batchToolbar.classList.remove('hidden');
  batchTableWrap.classList.remove('hidden');
  const row = document.createElement('tr');
  row.className = record.status === 'success' ? 'row-success' : 'row-error';
  const result = record.result || {};
  const switchCell = record.status === 'success'
    ? `<strong>${escapeHtml(result.finalDevice)}</strong><small>${escapeHtml(result.finalHost)}</small>`
    : `<span class="error-text">${escapeHtml(record.error || 'Không xác định')}</span>`;
  row.innerHTML = `
    <td><strong>${escapeHtml(record.cameraIp)}</strong></td>
    <td>${record.status === 'success' ? `<strong>${escapeHtml(result.cameraMac)}</strong><small>VLAN ${escapeHtml(result.vlan ?? 'N/A')}</small>` : '—'}</td>
    <td title="${escapeHtml(record.path || '')}">${switchCell}</td>
    <td><strong class="port-value">${escapeHtml(result.finalPort || '—')}</strong></td>
    <td>${escapeHtml(result.hops?.length ?? '—')}</td>
    <td><span class="result-badge ${record.status}">${record.status === 'success' ? 'Thành công' : 'Lỗi'}</span></td>`;
  batchTableBody.append(row);
}

function addPreflightRows(parsed) {
  for (const value of parsed.invalid) addBatchResult({ cameraIp: value, status: 'error', error: 'Dòng không chứa IP hợp lệ', path: '' });
  for (const ip of parsed.duplicates) addBatchResult({ cameraIp: ip, status: 'error', error: 'IP trùng — đã bỏ qua', path: '' });
}

function handleEvent(event) {
  switch (event.type) {
    case 'batch-start':
      batchSize = event.total;
      batchToolbar.classList.remove('hidden');
      batchProgress.textContent = `0 / ${event.total}`;
      break;
    case 'item-start':
      timeline.innerHTML = '';
      summary.classList.add('hidden');
      setStatus('running', `Đang dò ${event.cameraIp}`, `Camera ${event.index}/${event.total}`);
      break;
    case 'start':
      break;
    case 'connecting':
      setStatus('running', `Đang dò ${event.cameraIp}`, `Hop ${event.hop} • ${event.host}`);
      break;
    case 'connected':
      setStatus('running', `Đã kết nối ${event.prompt}`, `${event.cameraIp}${event.legacySsh ? ' • SSH legacy fallback' : ''}`);
      break;
    case 'arp':
      setStatus('running', `${event.cameraIp} → ${event.arp.mac}`, `VLAN ${event.arp.vlan ?? 'chưa xác định'}`);
      break;
    case 'command':
      addCommand(event);
      break;
    case 'hop':
      if (batchSize === 1) addHop(event.hop);
      break;
    case 'complete': {
      const record = { cameraIp: event.result.cameraIp, status: 'success', result: event.result, path: resultPath(event.result) };
      addBatchResult(record);
      if (batchSize === 1) showSummary(event.result);
      break;
    }
    case 'item-error':
      addBatchResult({ cameraIp: event.cameraIp, status: 'error', error: event.error.message, path: '' });
      break;
    case 'item-finish':
      batchProgress.textContent = `${event.index} / ${event.total}`;
      break;
    case 'batch-complete':
      {
        const totalErrors = batchResults.filter((record) => record.status === 'error').length;
        setStatus(totalErrors ? 'error' : 'success', 'Đã hoàn tất danh sách', `${event.succeeded} thành công • ${totalErrors} lỗi`);
      }
      exportCsvButton.classList.remove('hidden');
      break;
    case 'error':
      setStatus('error', 'Không thể hoàn tất dò tìm', event.error.message);
      break;
    default:
      break;
  }
}

async function readEventStream(response) {
  if (!response.body) throw new Error('Trình duyệt không hỗ trợ đọc stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) if (line.trim()) handleEvent(JSON.parse(line));
    if (done) break;
  }
  if (buffer.trim()) handleEvent(JSON.parse(buffer));
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function exportCsv() {
  const header = ['Camera IP', 'MAC', 'VLAN', 'Switch', 'Management IP', 'Port', 'Hop count', 'Path', 'Status', 'Error'];
  const rows = batchResults.map((record) => {
    const result = record.result || {};
    return [
      record.cameraIp, result.cameraMac, result.vlan, result.finalDevice, result.finalHost,
      result.finalPort, result.hops?.length, record.path, record.status, record.error,
    ];
  });
  const csv = `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `camera-trace-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

cameraIpsInput.addEventListener('input', updateIpCount);
cameraFileInput.addEventListener('change', async () => {
  const file = cameraFileInput.files?.[0];
  if (!file) return;
  cameraIpsInput.value = await file.text();
  updateIpCount();
});
exportCsvButton.addEventListener('click', exportCsv);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const parsed = parseCameraList(cameraIpsInput.value);
  if (!parsed.valid.length) {
    emptyState.classList.add('hidden');
    runState.classList.remove('hidden');
    setStatus('error', 'Danh sách không có IP hợp lệ', 'Nhập mỗi IP một dòng hoặc import file TXT/CSV.');
    return;
  }
  const payload = {
    cameraIps: parsed.valid,
    coreHost: document.querySelector('#core-host').value.trim(),
    maxHops: Number(document.querySelector('#max-hops').value),
    timeoutMs: Number(document.querySelector('#timeout').value) * 1000,
  };
  localStorage.setItem('camera-tracer-settings', JSON.stringify({
    coreHost: payload.coreHost, maxHops: payload.maxHops, timeoutMs: payload.timeoutMs,
  }));
  startRun();
  addPreflightRows(parsed);
  try {
    const response = await fetch('/api/trace-batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await readEventStream(response);
  } catch (error) {
    setStatus('error', 'Mất kết nối với ứng dụng', error.message);
  } finally {
    if (batchResults.length) exportCsvButton.classList.remove('hidden');
    stopRun();
  }
});

clearButton.addEventListener('click', () => {
  resetResults();
  runState.classList.add('hidden');
  emptyState.classList.remove('hidden');
});

try {
  const saved = JSON.parse(localStorage.getItem('camera-tracer-settings') || '{}');
  if (saved.coreHost) document.querySelector('#core-host').value = saved.coreHost;
  if (saved.maxHops) document.querySelector('#max-hops').value = saved.maxHops;
  if (saved.timeoutMs) document.querySelector('#timeout').value = saved.timeoutMs / 1000;
} catch {
  localStorage.removeItem('camera-tracer-settings');
}

updateIpCount();
checkCredentials();
