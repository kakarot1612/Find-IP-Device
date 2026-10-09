'use strict';

const loginScreen = document.getElementById('login-screen');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const loginButton = document.getElementById('login-button');
const logoutButton = document.getElementById('logout-button');
const navUser = document.getElementById('nav-user');

function setAuthed(authed) {
  document.body.classList.toggle('authed', authed);
}

async function checkSession() {
  try {
    const response = await fetch('/api/session', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    setAuthed(Boolean(data.authenticated));
    if (navUser) navUser.textContent = data.username || '';
  } catch {
    setAuthed(false);
  }
}

if (loginForm) {
  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    loginError.textContent = '';
    loginButton.disabled = true;
    loginButton.classList.add('loading');
    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: document.getElementById('login-username').value.trim(),
          password: document.getElementById('login-password').value,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.ok) {
        setAuthed(true);
        window.location.reload();
        return;
      }
      loginError.textContent = data.error || 'Đăng nhập thất bại.';
    } catch {
      loginError.textContent = 'Không kết nối được tới ứng dụng.';
    } finally {
      loginButton.disabled = false;
      loginButton.classList.remove('loading');
    }
  });
}

if (logoutButton) {
  logoutButton.addEventListener('click', async () => {
    try { await fetch('/api/logout', { method: 'POST' }); } catch { /* noop */ }
    setAuthed(false);
    window.location.reload();
  });
}

checkSession();