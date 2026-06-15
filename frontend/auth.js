/**
 * Spring ISD Transportation Portal — Shared Auth & API client
 * Include this script on every protected page.
 */

// Set this to your Worker URL after deployment
window.API_BASE = 'https://YOUR_WORKER_URL.workers.dev';

window.Auth = {
  token() { return sessionStorage.getItem('sisd_token'); },
  user()  { return JSON.parse(sessionStorage.getItem('sisd_user') || 'null'); },
  isAdmin() { return this.user()?.role === 'admin'; },

  // Verify session is still valid — call on every page load
  async verify() {
    const token = this.token();
    if (!token) { this.redirect(); return null; }
    try {
      const res = await fetch(window.API_BASE + '/api/auth/me', {
        headers: { Authorization: 'Bearer ' + token }
      });
      if (!res.ok) { this.redirect(); return null; }
      const data = await res.json();
      sessionStorage.setItem('sisd_user', JSON.stringify(data.user));
      return data.user;
    } catch {
      this.redirect();
      return null;
    }
  },

  async logout() {
    const token = this.token();
    if (token) {
      try {
        await fetch(window.API_BASE + '/api/auth/logout', {
          method: 'POST', headers: { Authorization: 'Bearer ' + token }
        });
      } catch {}
    }
    sessionStorage.clear();
    window.location.href = '/index.html';
  },

  redirect() {
    sessionStorage.clear();
    window.location.href = '/index.html';
  }
};

// API helper — all requests go through here
window.API = {
  async req(method, path, body, isFile = false) {
    const token = window.Auth.token();
    const headers = { Authorization: 'Bearer ' + token };
    let bodyData;
    if (body && !isFile) {
      headers['Content-Type'] = 'application/json';
      bodyData = JSON.stringify(body);
    } else if (isFile) {
      bodyData = body; // FormData
    }
    const res = await fetch(window.API_BASE + path, { method, headers, body: bodyData });
    if (res.status === 401) { window.Auth.redirect(); return null; }
    return res;
  },
  get(path)         { return this.req('GET', path); },
  post(path, body)  { return this.req('POST', path, body); },
  put(path, body)   { return this.req('PUT', path, body); },
  del(path)         { return this.req('DELETE', path); },
  upload(path, formData) { return this.req('POST', path, formData, true); },
};
