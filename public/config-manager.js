(function () {
  'use strict';

  const STORAGE_KEY = 'cisco-config-manager-v1';
  const el = (id) => document.getElementById(id);

  const traceView = el('view-trace');
  const configView = el('view-config');
  const navTabs = Array.from(document.querySelectorAll('.nav-tab'));

  const cmCount = el('cm-count');
  const switchBody = el('cm-switch-body');
  const selectAll = el('cm-select-all');
  const commandsTextarea = el('cm-commands');
  const logBox = el('cm-log');
  const statusLabel = el('cm-status');
  const csvFile = el('cm-csv-file');
  const projectFile = el('cm-project-file');
  const modal = el('cm-modal');
  const modalTitle = el('cm-modal-title');
  const modalIndex = el('cm-modal-index');

  const actionButtons = [
    'cm-add', 'cm-edit', 'cm-delete', 'cm-import', 'cm-ping', 'cm-ssh', 'cm-apply',
    'cm-new-project', 'cm-open-project', 'cm-save-project', 'cm-save-project-as',
  ].map((id) => el(id));

  let switches = [];
  let busy = false;

  // ---------------------------------------------------------------- helpers
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function isValidIp(value) {
    const parts = String(value || '').trim().split('.');
    return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
  }

  function timestamp() {
    return new Date().toLocaleTimeString('vi-VN', { hour12: false });
  }

  function log(message) {
    const line = document.createElement('div');
    line.textContent = `[${timestamp()}] ${message}`;
    logBox.append(line);
    logBox.scrollTop = logBox.scrollHeight;
  }

  function setStatus(text) {
    statusLabel.textContent = text;
  }

  function setBusy(value) {
    busy = value;
    actionButtons.forEach((btn) => { if (btn) btn.disabled = value; });
    setStatus(value ? 'Đang xử lý...' : 'Sẵn sàng');
  }

  function collectCommands() {
    return commandsTextarea.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  }

  // ----------------------------------------------------------- persistence
  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ switches, config_commands: collectCommands() }));
    } catch { /* ignore */ }
  }

  function loadPersisted() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (Array.isArray(data.switches)) switches = data.switches;
      if (Array.isArray(data.config_commands)) commandsTextarea.value = data.config_commands.join('\n');
    } catch { /* ignore */ }
  }

  // ---------------------------------------------------------------- render
  function renderTable() {
    switchBody.innerHTML = '';
    cmCount.textContent = `${switches.length} thiết bị`;
    switches.forEach((sw, index) => {
      const tr = document.createElement('tr');
      tr.className = 'selectable';
      tr.dataset.ip = sw.ip;
      const statusClass = sw.ok === false ? 'status-err' : (sw.status ? 'status-ok' : '');
      tr.innerHTML = `
        <td class="col-check"><input type="checkbox" data-index="${index}"></td>
        <td>${escapeHtml(sw.name)}</td>
        <td><strong>${escapeHtml(sw.ip)}</strong></td>
        <td>${escapeHtml(sw.username)}</td>
        <td>${escapeHtml(sw.device_type || 'cisco_ios')}</td>
        <td class="${statusClass}">${escapeHtml(sw.status || '')}</td>`;
      tr.addEventListener('dblclick', (event) => {
        if (event.target.tagName === 'INPUT') return;
        openModal(index);
      });
      switchBody.append(tr);
    });
    syncSelectAll();
  }

  function syncSelectAll() {
    const boxes = switchBody.querySelectorAll('input[type="checkbox"]');
    selectAll.checked = boxes.length > 0 && Array.from(boxes).every((b) => b.checked);
  }

  function selectedIndexes() {
    return Array.from(switchBody.querySelectorAll('input[type="checkbox"]:checked'))
      .map((b) => Number(b.dataset.index));
  }

  function setSwitchStatus(ip, statusText, ok) {
    const key = String(ip);
    const sw = switches.find((s) => String(s.ip) === key);
    if (sw) { sw.status = statusText; sw.ok = ok; }
    const tr = Array.from(switchBody.children).find((r) => r.dataset.ip === key);
    if (tr) {
      const td = tr.querySelector('td:last-child');
      td.className = ok ? 'status-ok' : 'status-err';
      td.textContent = statusText.length > 120 ? `${statusText.slice(0, 120)}…` : statusText;
    }
  }

  // ----------------------------------------------------------------- modal
  function openModal(index = -1) {
    modalIndex.value = String(index);
    const sw = index >= 0 ? switches[index] : null;
    modalTitle.textContent = sw ? 'Sửa switch' : 'Thêm switch';
    el('cm-f-name').value = sw ? (sw.name || '') : '';
    el('cm-f-ip').value = sw ? (sw.ip || '') : '';
    el('cm-f-username').value = sw ? (sw.username || '') : '';
    el('cm-f-password').value = '';
    el('cm-f-secret').value = '';
    el('cm-f-device-type').value = sw ? (sw.device_type || 'cisco_ios') : 'cisco_ios';
    el('cm-f-password').placeholder = sw ? 'Để trống để giữ nguyên' : '';
    el('cm-f-secret').placeholder = sw ? 'Để trống để giữ nguyên' : '';
    modal.classList.remove('hidden');
    el('cm-f-name').focus();
  }

  function closeModal() {
    modal.classList.add('hidden');
  }

  function saveModal() {
    const index = Number(modalIndex.value);
    const name = el('cm-f-name').value.trim();
    const ip = el('cm-f-ip').value.trim();
    const username = el('cm-f-username').value.trim();
    const password = el('cm-f-password').value;
    const secret = el('cm-f-secret').value;
    const deviceType = el('cm-f-device-type').value || 'cisco_ios';

    if (!ip) { alert('Địa chỉ IP không được để trống.'); return; }
    if (!isValidIp(ip)) { alert(`Địa chỉ IP không hợp lệ: ${ip}`); return; }
    if (!username) { alert('Username không được để trống.'); return; }

    if (index >= 0 && switches[index]) {
      const existing = switches[index];
      existing.name = name;
      existing.ip = ip;
      existing.username = username;
      if (password) existing.password = password;
      if (secret) existing.secret = secret;
      existing.device_type = deviceType;
      delete existing.status;
      delete existing.ok;
      log(`Đã cập nhật switch ${ip}`);
    } else {
      switches.push({ name, ip, username, password, secret, device_type: deviceType, status: '' });
      log(`Đã thêm switch ${ip}`);
    }
    renderTable();
    persist();
    closeModal();
  }

  function deleteSelected() {
    const indexes = selectedIndexes().sort((a, b) => b - a);
    if (!indexes.length) { alert('Chọn một hoặc nhiều switch để xóa.'); return; }
    if (!confirm(`Xóa ${indexes.length} switch đã chọn?`)) return;
    const removed = indexes.map((i) => switches[i].ip);
    indexes.forEach((i) => switches.splice(i, 1));
    renderTable();
    persist();
    log(`Đã xóa ${indexes.length} switch: ${removed.join(', ')}`);
  }

  // ------------------------------------------------------------------- CSV
  function parseCsv(text) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return [];
    const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
    const idx = (key) => header.indexOf(key);
    const get = (cells, key) => {
      const i = idx(key);
      return i >= 0 ? (cells[i] || '').trim() : '';
    };
    const rows = [];
    for (const line of lines.slice(1)) {
      const cells = line.split(',');
      rows.push({
        name: get(cells, 'name'),
        ip: get(cells, 'ip'),
        username: get(cells, 'username'),
        password: get(cells, 'password'),
        secret: get(cells, 'secret'),
        device_type: get(cells, 'device_type') || 'cisco_ios',
      });
    }
    return rows;
  }

  async function importCsv(file) {
    const text = await file.text();
    const rows = parseCsv(text);
    let added = 0;
    const rejected = [];
    for (const row of rows) {
      if (!row.ip) continue;
      if (!isValidIp(row.ip)) { rejected.push(row.ip); continue; }
      switches.push({ ...row, status: '' });
      added += 1;
    }
    renderTable();
    persist();
    log(`Đã nhập ${added} switch từ file CSV.`);
    if (rejected.length) log(`Đã bỏ qua ${rejected.length} dòng có IP không hợp lệ: ${rejected.join(', ')}`);
  }

  // --------------------------------------------------------------- project
  function newProject() {
    if (switches.length || collectCommands().length) {
      if (!confirm('Tạo dự án mới? Dữ liệu chưa lưu sẽ bị mất.')) return;
    }
    switches = [];
    commandsTextarea.value = '';
    renderTable();
    persist();
    log('Đã tạo dự án mới.');
  }

  async function openProject(file) {
    const text = await file.text();
    const data = JSON.parse(text);
    switches = Array.isArray(data.switches) ? data.switches : [];
    commandsTextarea.value = Array.isArray(data.config_commands) ? data.config_commands.join('\n') : '';
    renderTable();
    persist();
    log(`Đã mở dự án (${switches.length} thiết bị).`);
  }

  function download(filename, content) {
    const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  function projectJson() {
    return JSON.stringify({ switches, config_commands: collectCommands() }, null, 2);
  }

  function saveProject() {
    const filename = `cisco-config-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    download(filename, projectJson());
    log(`Đã lưu dự án: ${filename}`);
  }

  function saveProjectAs() {
    const name = prompt('Nhập tên file dự án (không cần đuôi .json):', 'cisco-config-project');
    if (name === null) return;
    const trimmed = name.trim();
    const filename = trimmed ? (trimmed.endsWith('.json') ? trimmed : `${trimmed}.json`) : `cisco-config-${Date.now()}.json`;
    download(filename, projectJson());
    log(`Đã lưu dự án: ${filename}`);
  }

  // -------------------------------------------------------------- actions
  async function runAction(action) {
    if (busy) return;
    if (!switches.length) { alert('Chưa có switch nào trong danh sách.'); return; }
    if (action === 'apply' && !collectCommands().length) { alert('Chưa có lệnh cấu hình nào.'); return; }
    if (action === 'apply' && !confirm(`Áp dụng ${collectCommands().length} lệnh cấu hình lên ${switches.length} switch?`)) return;

    const label = action === 'ping' ? 'Test Ping' : (action === 'ssh-test' ? 'Test SSH' : 'Áp dụng cấu hình');
    const payload = { switches, commands: collectCommands() };
    setBusy(true);
    log(`=== Bắt đầu: ${label} ===`);

    try {
      const response = await fetch(`/api/config-manager/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await readStream(response);
    } catch (error) {
      log(`Lỗi: ${error.message}`);
      setStatus(`Lỗi: ${error.message}`);
    } finally {
      log(`=== Kết thúc: ${label} ===`);
      persist();
      setBusy(false);
    }
  }

  async function readStream(response) {
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

  function handleEvent(event) {
    switch (event.type) {
      case 'batch-start':
        setStatus(`Đang xử lý ${event.total} thiết bị...`);
        break;
      case 'item-start':
        setStatus(`Đang xử lý ${event.ip} (${event.index}/${event.total})...`);
        break;
      case 'command':
        log(`  $ ${event.command}`);
        break;
      case 'item-result':
        setSwitchStatus(event.ip, event.message, event.ok);
        log(`${event.ip} - ${event.message}`);
        break;
      case 'item-finish':
        break;
      case 'batch-complete':
        setStatus(`Hoàn tất: ${event.succeeded} thành công / ${event.failed} lỗi`);
        break;
      case 'error':
        setStatus(event.error.message);
        log(`Lỗi: ${event.error.message}`);
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------- binds
  navTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      navTabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const view = tab.dataset.view;
      traceView.classList.toggle('hidden', view !== 'trace');
      configView.classList.toggle('hidden', view !== 'config');
    });
  });

  el('cm-add').addEventListener('click', () => openModal(-1));
  el('cm-edit').addEventListener('click', () => {
    const idx = selectedIndexes();
    if (!idx.length) { alert('Chọn một switch để sửa.'); return; }
    openModal(idx[0]);
  });
  el('cm-delete').addEventListener('click', deleteSelected);
  el('cm-import').addEventListener('click', () => csvFile.click());
  csvFile.addEventListener('change', async () => {
    const file = csvFile.files?.[0];
    if (file) await importCsv(file);
    csvFile.value = '';
  });
  el('cm-ping').addEventListener('click', () => runAction('ping'));
  el('cm-ssh').addEventListener('click', () => runAction('ssh-test'));
  el('cm-apply').addEventListener('click', () => runAction('apply'));

  selectAll.addEventListener('change', () => {
    switchBody.querySelectorAll('input[type="checkbox"]').forEach((b) => { b.checked = selectAll.checked; });
  });
  switchBody.addEventListener('change', (event) => {
    if (event.target && event.target.type === 'checkbox') syncSelectAll();
  });

  el('cm-new-project').addEventListener('click', newProject);
  el('cm-open-project').addEventListener('click', () => projectFile.click());
  projectFile.addEventListener('change', async () => {
    const file = projectFile.files?.[0];
    if (!file) return;
    try { await openProject(file); } catch (e) { alert(`Không thể mở dự án: ${e.message}`); }
    projectFile.value = '';
  });
  el('cm-save-project').addEventListener('click', saveProject);
  el('cm-save-project-as').addEventListener('click', saveProjectAs);

  el('cm-modal-save').addEventListener('click', saveModal);
  el('cm-modal-cancel').addEventListener('click', closeModal);
  el('cm-modal-backdrop').addEventListener('click', closeModal);
  modal.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeModal();
  });

  document.addEventListener('keydown', (event) => {
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    const editable = tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT';
    if (event.key === 'Delete' && !editable) deleteSelected();
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && !editable) {
      event.preventDefault();
      switchBody.querySelectorAll('input[type="checkbox"]').forEach((b) => { b.checked = true; });
      syncSelectAll();
    }
  });

  commandsTextarea.addEventListener('input', persist);

  // ------------------------------------------------------------------ init
  loadPersisted();
  renderTable();
  log('Sẵn sàng.');
  setStatus('Sẵn sàng');
})();