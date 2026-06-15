/**
 * Transit On-Time Analytics Portal — Cloudflare Worker API v2
 * Multi-month file support for Inbound/Outbound arrivals
 */

const SESSION_TTL    = 8 * 60 * 60;
const ARRIVAL_TYPES  = ['inbound', 'outbound'];
const SINGLE_TYPES   = ['runtype', 'campustype'];
const ALL_TYPES      = [...ARRIVAL_TYPES, ...SINGLE_TYPES];

// ── CRYPTO ────────────────────────────────────────────────────────────────
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key  = await pbkdf2(password, salt);
  return btoa(String.fromCharCode(...salt)) + ':' + btoa(String.fromCharCode(...new Uint8Array(key)));
}
async function verifyPassword(password, stored) {
  const [saltB64, hashB64] = stored.split(':');
  const salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
  const key  = await pbkdf2(password, salt);
  return btoa(String.fromCharCode(...new Uint8Array(key))) === hashB64;
}
async function pbkdf2(password, salt) {
  const enc = new TextEncoder();
  const km  = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name:'PBKDF2', salt, iterations:100000, hash:'SHA-256' }, km, 256);
}
function randomToken() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/[+/=]/g,'').slice(0,43);
}

// ── USERS ─────────────────────────────────────────────────────────────────
async function getUsers(env)         { const o=await env.BUCKET.get('users/users.json'); return o?JSON.parse(await o.text()):[];}
async function saveUsers(env,users)  { await env.BUCKET.put('users/users.json',JSON.stringify(users),{httpMetadata:{contentType:'application/json'}}); }
async function getUserById(env,id)   { return (await getUsers(env)).find(u=>u.id===id)||null; }
async function getUserByUsername(env,u){ return (await getUsers(env)).find(x=>x.username.toLowerCase()===u.toLowerCase())||null; }

// ── SESSIONS ──────────────────────────────────────────────────────────────
async function createSession(env,userId,role){ const t=randomToken(); await env.SESSIONS.put('session:'+t,JSON.stringify({userId,role,createdAt:Date.now()}),{expirationTtl:SESSION_TTL}); return t; }
async function getSession(env,token)  { if(!token)return null; const r=await env.SESSIONS.get('session:'+token); return r?JSON.parse(r):null; }
async function deleteSession(env,tok) { await env.SESSIONS.delete('session:'+tok); }

// ── GROUPS ────────────────────────────────────────────────────────────────
async function getGroups(env)        { const o=await env.BUCKET.get('groups/groups.json'); return o?JSON.parse(await o.text()):[];}
async function saveGroups(env,groups){ await env.BUCKET.put('groups/groups.json',JSON.stringify(groups),{httpMetadata:{contentType:'application/json'}}); }

// ── MANIFEST (multi-month) ────────────────────────────────────────────────
async function getManifest(env, type) {
  const obj = await env.BUCKET.get(`files/${type}/manifest.json`);
  return obj ? JSON.parse(await obj.text()) : [];
}
async function saveManifest(env, type, manifest) {
  await env.BUCKET.put(
    `files/${type}/manifest.json`,
    JSON.stringify(manifest),
    { httpMetadata: { contentType: 'application/json' } }
  );
}

// Parse CSV text → array of rows (objects)
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  // Strip quotes and ="..." wrapping from headers
  const headers = lines[0].split(',').map(h => h.replace(/^="(.*)"$/, '$1').replace(/^"|"$/g, '').trim());
  return lines.slice(1).map(line => {
    const vals = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"' && !inQ) { inQ = true; }
      else if (c === '"' && inQ && line[i+1] === '"') { cur += '"'; i++; }
      else if (c === '"' && inQ) { inQ = false; }
      else if (c === ',' && !inQ) { vals.push(cur); cur = ''; }
      else cur += c;
    }
    vals.push(cur);
    const row = {};
    headers.forEach((h, i) => {
      row[h] = (vals[i] || '').replace(/^="(.*)"$/, '$1').replace(/^"|"$/g, '').trim();
    });
    return row;
  });
}

// Fast date detection — only reads first column of each line, no full CSV parse
// Handles: "11/5/2025 12:00:00 AM", ="11/5/2025", 11/5/2025, 2025-11-05
function detectDateRangeFast(text) {
  const lines = text.split(/\r?\n/);
  const dates = [];
  // Skip header row (index 0)
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    // Get first field (before first unquoted comma)
    let field = '';
    if (line.startsWith('"')) {
      const end = line.indexOf('"', 1);
      field = end > 0 ? line.slice(1, end) : line.slice(1);
    } else {
      field = line.split(',')[0];
    }
    field = field.replace(/^="(.*)"$/, '$1').replace(/^=/, '').trim().split(' ')[0];
    // Parse M/D/YYYY
    const m = field.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (m) {
      let yr = parseInt(m[3]); if (yr < 100) yr += 2000;
      const mo = String(parseInt(m[1])).padStart(2,'0');
      const dy = String(parseInt(m[2])).padStart(2,'0');
      dates.push(`${yr}-${mo}-${dy}`);
      continue;
    }
    // Parse YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(field)) { dates.push(field); continue; }
  }
  if (!dates.length) return null;
  dates.sort();
  return { from: dates[0], to: dates[dates.length - 1] };
}

// Detect date range from parsed rows (used by GET /all merger)
function detectDateRange(rows) {
  const dates = rows
    .map(r => {
      let val = String(r['Date'] || r['date'] || '').trim();
      if (!val) return null;
      // Format: "4/1/2026 12:00:00 AM" — take just the date part before space
      val = val.split(' ')[0];
      // Try M/D/YYYY
      const m = val.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
      if (m) {
        let yr = parseInt(m[3]);
        if (yr < 100) yr += 2000;
        const mo = String(parseInt(m[1])).padStart(2,'0');
        const dy = String(parseInt(m[2])).padStart(2,'0');
        return `${yr}-${mo}-${dy}`;
      }
      // Try YYYY-MM-DD
      const iso = val.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (iso) return val;
      return null;
    })
    .filter(Boolean)
    .sort();
  if (!dates.length) return null;
  return { from: dates[0], to: dates[dates.length - 1] };
}

// Check if two date ranges overlap
function rangesOverlap(a, b) {
  return a.from <= b.to && b.from <= a.to;
}

// ── AUTH MIDDLEWARE ───────────────────────────────────────────────────────
async function requireAuth(req, env) {
  const token   = req.headers.get('Authorization')?.replace('Bearer ','');
  const session = await getSession(env, token);
  if (!session) return null;
  const user = await getUserById(env, session.userId);
  if (!user || !user.active) return null;
  return { ...user, token };
}
async function requireAdmin(req, env) {
  const user = await requireAuth(req, env);
  return (user?.role === 'admin') ? user : null;
}

// ── RESPONSES ─────────────────────────────────────────────────────────────
const CORS = { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'Content-Type, Authorization' };
function json(data, status=200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type':'application/json', ...CORS } }); }
function err(msg, status=400)   { return json({ error: msg }, status); }
function ok(data={})            { return json({ ok:true, ...data }); }

// ── ROUTER ────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { headers: { ...CORS, 'Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Max-Age':'86400' } });
    }

    try {

      // ── AUTH ──────────────────────────────────────────────────────────
      if (path === '/api/auth/login' && method === 'POST') {
        const { username, password } = await request.json();
        if (!username || !password) return err('Username and password required.');
        const user = await getUserByUsername(env, username);
        if (!user || !user.active) return err('Invalid username or password.', 401);
        if (!await verifyPassword(password, user.passwordHash)) return err('Invalid username or password.', 401);
        const token = await createSession(env, user.id, user.role);
        return ok({ token, user: { id:user.id, username:user.username, name:user.name, role:user.role } });
      }

      if (path === '/api/auth/logout' && method === 'POST') {
        const token = request.headers.get('Authorization')?.replace('Bearer ','');
        if (token) await deleteSession(env, token);
        return ok();
      }

      if (path === '/api/auth/me' && method === 'GET') {
        const user = await requireAuth(request, env);
        if (!user) return err('Unauthorized.', 401);
        return ok({ user: { id:user.id, username:user.username, name:user.name, role:user.role } });
      }

      if (path === '/api/auth/setup' && method === 'POST') {
        const { setupKey, username, password, name } = await request.json();
        if (setupKey !== env.ADMIN_SETUP_KEY) return err('Invalid setup key.', 403);
        if ((await getUsers(env)).length > 0) return err('Setup already complete.', 403);
        const admin = { id:randomToken().slice(0,12), username, name:name||username, passwordHash:await hashPassword(password), role:'admin', active:true, createdAt:new Date().toISOString() };
        await saveUsers(env, [admin]);
        return ok({ message:'Admin account created.' });
      }

      // ── USERS ─────────────────────────────────────────────────────────
      if (path === '/api/users' && method === 'GET') {
        if (!await requireAdmin(request, env)) return err('Unauthorized.', 401);
        const users = await getUsers(env);
        return ok({ users: users.map(u => ({ id:u.id, username:u.username, name:u.name, role:u.role, active:u.active, createdAt:u.createdAt })) });
      }

      if (path === '/api/users' && method === 'POST') {
        const admin = await requireAdmin(request, env);
        if (!admin) return err('Unauthorized.', 401);
        const { username, password, name, role } = await request.json();
        if (!username || !password) return err('Username and password required.');
        if (!['admin','viewer'].includes(role)) return err('Invalid role.');
        const users = await getUsers(env);
        if (users.find(u => u.username.toLowerCase() === username.toLowerCase())) return err('Username already exists.');
        if (users.filter(u=>u.role==='admin').length >= 10 && role==='admin') return err('Maximum 10 admin users.');
        if (users.length >= 110) return err('Maximum user limit reached.');
        const newUser = { id:randomToken().slice(0,12), username, name:name||username, passwordHash:await hashPassword(password), role, active:true, createdAt:new Date().toISOString() };
        users.push(newUser);
        await saveUsers(env, users);
        return ok({ user: { id:newUser.id, username:newUser.username, name:newUser.name, role:newUser.role, active:newUser.active } });
      }

      // Change own password
      if (path === '/api/users/me' && method === 'PUT') {
        const user = await requireAuth(request, env);
        if (!user) return err('Unauthorized.', 401);
        const { currentPassword, newPassword } = await request.json();
        if (!await verifyPassword(currentPassword, user.passwordHash)) return err('Current password is incorrect.');
        const users = await getUsers(env);
        const idx = users.findIndex(u => u.id === user.id);
        users[idx].passwordHash = await hashPassword(newPassword);
        await saveUsers(env, users);
        return ok({ message:'Password updated.' });
      }

      const userMatch = path.match(/^\/api\/users\/([^/]+)$/);
      if (userMatch) {
        const targetId = userMatch[1];
        const admin = await requireAdmin(request, env);
        if (!admin) return err('Unauthorized.', 401);
        if (method === 'PUT') {
          const { name, role, active } = await request.json();
          const users = await getUsers(env);
          const idx = users.findIndex(u => u.id === targetId);
          if (idx < 0) return err('User not found.', 404);
          if (name !== undefined) users[idx].name = name;
          if (role !== undefined) users[idx].role = role;
          if (active !== undefined) users[idx].active = active;
          await saveUsers(env, users);
          return ok();
        }
        if (method === 'DELETE') {
          const users = await getUsers(env);
          if (!users.find(u=>u.id===targetId)) return err('User not found.', 404);
          if (targetId === admin.id) return err('Cannot delete your own account.');
          await saveUsers(env, users.filter(u=>u.id!==targetId));
          return ok();
        }
      }

      const pwMatch = path.match(/^\/api\/users\/([^/]+)\/password$/);
      if (pwMatch && method === 'POST') {
        if (!await requireAdmin(request, env)) return err('Unauthorized.', 401);
        const { password } = await request.json();
        if (!password) return err('New password required.');
        const users = await getUsers(env);
        const idx = users.findIndex(u => u.id === pwMatch[1]);
        if (idx < 0) return err('User not found.', 404);
        users[idx].passwordHash = await hashPassword(password);
        await saveUsers(env, users);
        return ok({ message:'Password reset.' });
      }

      // ── GROUPS ────────────────────────────────────────────────────────
      if (path === '/api/groups' && method === 'GET') {
        if (!await requireAuth(request, env)) return err('Unauthorized.', 401);
        return ok({ groups: await getGroups(env) });
      }
      if (path === '/api/groups' && method === 'PUT') {
        if (!await requireAdmin(request, env)) return err('Unauthorized.', 401);
        const { groups } = await request.json();
        await saveGroups(env, groups);
        return ok();
      }

      // ── SETUP PAGE ────────────────────────────────────────────────────
      if (method === 'GET' && path === '/setup') {
        const setupHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Spring ISD Portal — Setup</title>
<style>
body{font-family:Arial,sans-serif;max-width:600px;margin:60px auto;padding:20px;background:#f2f5fb;}
h1{color:#003366;margin-bottom:8px;}
p{color:#666;margin-bottom:24px;}
.card{background:#fff;border:1px solid #d4dcea;border-radius:12px;padding:28px;}
.fg{margin-bottom:16px;}
label{display:block;font-weight:700;font-size:.8rem;text-transform:uppercase;letter-spacing:.08em;color:#003366;margin-bottom:6px;}
input[type=text],input[type=password]{width:100%;padding:9px 12px;border:1px solid #d4dcea;border-radius:7px;font-size:.9rem;box-sizing:border-box;}
input[type=file]{width:100%;padding:8px 0;}
.btn{background:#003366;color:#fff;border:none;padding:12px 28px;border-radius:7px;font-weight:700;font-size:.85rem;cursor:pointer;width:100%;margin-top:8px;}
.btn:hover{background:#004080;}
.msg{margin-top:16px;padding:12px 16px;border-radius:7px;font-size:.85rem;display:none;}
.ok{background:#edf7f2;color:#1a7f4b;border:1px solid rgba(26,127,75,.3);}
.err{background:#fdf0f0;color:#b83232;border:1px solid rgba(184,50,50,.3);}
.sep{height:1px;background:#d4dcea;margin:20px 0;}
</style>
</head>
<body>
<h1>🚌 Spring ISD Portal Setup</h1>
<p>Upload the three frontend files to activate the portal.</p>
<div class="card">
  <div class="fg"><label>Admin Password</label><input type="password" id="pw" placeholder="Your admin password"></div>
  <div class="sep"></div>
  <div class="fg"><label>index.html</label><input type="file" id="f1" accept=".html"></div>
  <div class="fg"><label>dashboard.html</label><input type="file" id="f2" accept=".html"></div>
  <div class="fg"><label>auth.js</label><input type="file" id="f3" accept=".js"></div>
  <button class="btn" onclick="go()">Upload &amp; Activate Portal</button>
  <div class="msg" id="msg"></div>
</div>
<script>
const API='https://springisd-transportation.jrackler.workers.dev';
async function go(){
  const msg=document.getElementById('msg');
  const pw=document.getElementById('pw').value;
  const f1=document.getElementById('f1').files[0];
  const f2=document.getElementById('f2').files[0];
  const f3=document.getElementById('f3').files[0];
  if(!pw||!f1||!f2||!f3){show('Please fill in all fields and select all three files.','err');return;}
  show('Logging in…','ok');
  const lr=await fetch(API+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:pw})});
  const ld=await lr.json();
  if(!lr.ok){show('Login failed: '+ld.error,'err');return;}
  show('Uploading files…','ok');
  const fd=new FormData();
  fd.append('index.html',f1);
  fd.append('dashboard.html',f2);
  fd.append('auth.js',f3);
  const r=await fetch(API+'/api/static',{method:'POST',headers:{Authorization:'Bearer '+ld.token},body:fd});
  const d=await r.json();
  if(!r.ok){show('Upload failed: '+d.error,'err');return;}
  show('✓ Done! Redirecting to portal…','ok');
  setTimeout(()=>window.location.href=API,2000);
}
function show(t,c){const m=document.getElementById('msg');m.textContent=t;m.className='msg '+c;m.style.display='block';}
</script>
</body>
</html>`;
        return new Response(setupHtml, { headers: { 'Content-Type': 'text/html' } });
      }

      // ── STATIC FILES ─────────────────────────────────────────────────
      // Serve frontend files stored in R2
      if (method === 'GET' && (path === '/' || path === '/index.html' || path === '')) {
        const obj = await env.BUCKET.get('static/index.html');
        if (!obj) return new Response('App not yet deployed. Please upload static files.', { status: 503 });
        return new Response(await obj.text(), { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' } });
      }
      if (method === 'GET' && path === '/dashboard.html') {
        const obj = await env.BUCKET.get('static/dashboard.html');
        if (!obj) return new Response('Not found', { status: 404 });
        return new Response(await obj.text(), { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' } });
      }
      if (method === 'GET' && path === '/auth.js') {
        const obj = await env.BUCKET.get('static/auth.js');
        if (!obj) return new Response('Not found', { status: 404 });
        return new Response(await obj.text(), { headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' } });
      }

      // ── STATIC FILE UPLOAD (admin only) ──────────────────────────────
      if (path === '/api/static' && method === 'POST') {
        const admin = await requireAdmin(request, env);
        if (!admin) return err('Unauthorized.', 401);
        const fd = await request.formData();
        const files = ['index.html', 'dashboard.html', 'auth.js'];
        for (const name of files) {
          const file = fd.get(name);
          if (file) {
            const ct = name.endsWith('.js') ? 'application/javascript' : 'text/html';
            await env.BUCKET.put(`static/${name}`, await file.text(), { httpMetadata: { contentType: ct } });
          }
        }
        return ok({ message: 'Static files uploaded.' });
      }
      // ── CAMPUS TYPES (JSON store) ─────────────────────────────────────
      if (path === '/api/campustypes' && method === 'GET') {
        if (!await requireAuth(request, env)) return err('Unauthorized.', 401);
        const obj = await env.BUCKET.get('data/campustypes.json');
        return ok({ campusTypes: obj ? JSON.parse(await obj.text()) : {} });
      }
      if (path === '/api/campustypes' && method === 'PUT') {
        if (!await requireAdmin(request, env)) return err('Unauthorized.', 401);
        const { campusTypes } = await request.json();
        await env.BUCKET.put('data/campustypes.json', JSON.stringify(campusTypes),
          { httpMetadata: { contentType: 'application/json' } });
        return ok({ message: 'Campus types saved.' });
      }

      const singleMatch = path.match(/^\/api\/files\/(runtype|campustype)$/);
      if (singleMatch) {
        const type = singleMatch[1];
        if (method === 'POST') {
          if (!await requireAdmin(request, env)) return err('Unauthorized.', 401);
          const fd   = await request.formData();
          const file = fd.get('file');
          if (!file) return err('No file provided.');
          const text = await file.text();
          await env.BUCKET.put(`files/${type}-latest`, text, {
            httpMetadata: { contentType: 'text/csv' },
            customMetadata: { originalName:file.name, uploadedAt:new Date().toISOString() }
          });
          return ok({ message:`${type} file uploaded.`, name:file.name });
        }
        if (method === 'GET') {
          if (!await requireAuth(request, env)) return err('Unauthorized.', 401);
          const obj = await env.BUCKET.get(`files/${type}-latest`);
          if (!obj) return err('No file uploaded yet.', 404);
          // Always serve as plain text/CSV so browser can parse it
          return new Response(await obj.text(), {
            headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS }
          });
        }
      }

      // ── ARRIVAL FILES (inbound, outbound) — multi-month ───────────────

      // GET manifest — list of all uploaded chunks
      const manifestMatch = path.match(/^\/api\/files\/(inbound|outbound)\/manifest$/);
      if (manifestMatch && method === 'GET') {
        if (!await requireAuth(request, env)) return err('Unauthorized.', 401);
        const manifest = await getManifest(env, manifestMatch[1]);
        return ok({ manifest });
      }

      // GET all — now handled by frontend fetching individual files
      // Kept for backward compatibility but redirects to manifest approach
      const allMatch = path.match(/^\/api\/files\/(inbound|outbound)\/all$/);
      if (allMatch && method === 'GET') {
        if (!await requireAuth(request, env)) return err('Unauthorized.', 401);
        const manifest = await getManifest(env, allMatch[1]);
        // Return manifest so frontend knows what keys to fetch individually
        return ok({ manifest, deprecated: true });
      }

      // GET individual file by key — uses ?key= query param to avoid routing conflicts
      if (path === '/api/files/chunk' && method === 'GET') {
        if (!await requireAuth(request, env)) return err('Unauthorized.', 401);
        const type = url.searchParams.get('type');
        const key  = url.searchParams.get('key');
        if (!type || !key) return err('type and key required.');
        if (!ARRIVAL_TYPES.includes(type)) return err('Invalid type.', 400);
        const obj = await env.BUCKET.get(`files/${type}/${key}`);
        if (!obj) return err('File not found.', 404);
        const text = await obj.text();
        const lines = text.split(/\r?\n/);
        const headerLine = lines[0].split(',')
          .map(h => h.replace(/^="(.*)"$/, '$1').replace(/^"|"$/g, '').trim())
          .join(',');
        const dataLines = lines.slice(1).filter(l => l.trim()).map(line => {
          return line.split(',').map(v => {
            v = v.trim();
            if (v.startsWith('="') && v.endsWith('"')) return v.slice(2, -1);
            if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
            if (v.startsWith('=')) return v.slice(1);
            return v;
          }).join(',');
        });
        return new Response(headerLine + '\n' + dataLines.join('\n'), {
          headers: { 'Content-Type': 'text/csv', ...CORS }
        });
      }

      // GET individual file by key in path (kept for compatibility)
      const fileKeyMatch = path.match(/^\/api\/files\/(inbound|outbound)\/([^/]+)$/);
      if (fileKeyMatch && method === 'GET') {
        if (!await requireAuth(request, env)) return err('Unauthorized.', 401);
        const [, type, key] = fileKeyMatch;
        const obj = await env.BUCKET.get(`files/${type}/${key}`);
        if (!obj) return err('File not found.', 404);
        const text = await obj.text();
        const lines = text.split(/\r?\n/);

        // Clean header
        const headerLine = lines[0].split(',')
          .map(h => h.replace(/^="(.*)"$/, '$1').replace(/^"|"$/g, '').trim())
          .join(',');

        // Clean data lines
        const dataLines = lines.slice(1).filter(l => l.trim()).map(line => {
          return line.split(',').map(v => {
            v = v.trim();
            if (v.startsWith('="') && v.endsWith('"')) return v.slice(2, -1);
            if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
            if (v.startsWith('=')) return v.slice(1);
            return v;
          }).join(',');
        });

        const cleaned = headerLine + '\n' + dataLines.join('\n');
        return new Response(cleaned, {
          headers: { 'Content-Type': 'text/csv', ...CORS }
        });
      }

      // POST — upload a new arrival file chunk
      const arrivalUploadMatch = path.match(/^\/api\/files\/(inbound|outbound)$/);
      if (arrivalUploadMatch && method === 'POST') {
        const admin = await requireAdmin(request, env);
        if (!admin) return err('Unauthorized.', 401);
        const type = arrivalUploadMatch[1];
        const fd   = await request.formData();
        const file = fd.get('file');
        const label = (fd.get('label') || '').trim();
        if (!file) return err('No file provided.');

        const text = await file.text();
        if (!text.trim()) return err('File appears to be empty.');

        // Fast date detection — scan only the first column without full CSV parse
        const range = detectDateRangeFast(text);
        if (!range) return err('Could not detect dates in this file. Make sure it has a Date column.');

        // Count rows quickly
        const rowCount = text.split('\n').filter(l => l.trim()).length - 1;

        // Check for overlaps in existing manifest
        const manifest = await getManifest(env, type);
        const overlaps = manifest.filter(e => rangesOverlap({ from:e.dateFrom, to:e.dateTo }, range));

        if (overlaps.length) {
          return json({
            ok: false, overlap: true, range,
            overlappingLabels: overlaps.map(e => e.label || e.key),
            message: `This file contains data from ${fmtDate(range.from)} – ${fmtDate(range.to)}. Data for those dates already exists.`
          }, 200);
        }

        // Store the file
        const key = `${range.from}_${range.to}`;
        await env.BUCKET.put(`files/${type}/${key}`, text, {
          httpMetadata: { contentType:'text/csv' },
          customMetadata: { originalName:file.name, uploadedBy:admin.username, uploadedAt:new Date().toISOString() }
        });
        manifest.push({ key, label:label||autoLabel(range), dateFrom:range.from, dateTo:range.to, records:rowCount, fileName:file.name, uploadedBy:admin.username, uploadedAt:new Date().toISOString() });
        await saveManifest(env, type, manifest);
        return ok({ message:'File uploaded.', key, range, records:rowCount, label:label||autoLabel(range) });
      }

      // POST confirm — replace after overlap confirmed by user
      const confirmMatch = path.match(/^\/api\/files\/(inbound|outbound)\/confirm$/);
      if (confirmMatch && method === 'POST') {
        const admin = await requireAdmin(request, env);
        if (!admin) return err('Unauthorized.', 401);
        const type = confirmMatch[1];
        const fd   = await request.formData();
        const file = fd.get('file');
        const label = (fd.get('label') || '').trim();
        if (!file) return err('No file provided.');

        const text = await file.text();
        const range = detectDateRangeFast(text);
        if (!range) return err('Could not detect dates.');
        const rowCount = text.split('\n').filter(l => l.trim()).length - 1;

        const key = `${range.from}_${range.to}`;
        let manifest = await getManifest(env, type);

        // Remove overlapping entries from manifest and R2
        const overlaps = manifest.filter(e => rangesOverlap({ from:e.dateFrom, to:e.dateTo }, range));
        for (const o of overlaps) {
          await env.BUCKET.delete(`files/${type}/${o.key}`);
        }
        manifest = manifest.filter(e => !rangesOverlap({ from:e.dateFrom, to:e.dateTo }, range));

        // Store new file
        await env.BUCKET.put(`files/${type}/${key}`, text, {
          httpMetadata:{ contentType:'text/csv' },
          customMetadata:{ originalName:file.name, uploadedBy:admin.username, uploadedAt:new Date().toISOString() }
        });
        manifest.push({ key, label:label||autoLabel(range), dateFrom:range.from, dateTo:range.to, records:rowCount, fileName:file.name, uploadedBy:admin.username, uploadedAt:new Date().toISOString() });
        await saveManifest(env, type, manifest);
        return ok({ message:'File replaced.', key, range, records:rowCount });
      }

      // DELETE a specific arrival chunk
      const deleteMatch = path.match(/^\/api\/files\/(inbound|outbound)\/([^/]+)$/);
      if (deleteMatch && method === 'DELETE') {
        if (!await requireAdmin(request, env)) return err('Unauthorized.', 401);
        const [, type, key] = deleteMatch;
        let manifest = await getManifest(env, type);
        if (!manifest.find(e => e.key === key)) return err('File not found.', 404);
        await env.BUCKET.delete(`files/${type}/${key}`);
        manifest = manifest.filter(e => e.key !== key);
        await saveManifest(env, type, manifest);
        return ok({ message:'File deleted.' });
      }

      // GET file status summary
      if (path === '/api/files' && method === 'GET') {
        if (!await requireAuth(request, env)) return err('Unauthorized.', 401);
        const inManifest  = await getManifest(env, 'inbound');
        const outManifest = await getManifest(env, 'outbound');
        const rtObj  = await env.BUCKET.head('files/runtype-latest');
        const ctObj  = await env.BUCKET.head('files/campustype-latest');
        return ok({
          files: {
            inbound:    inManifest.length  ? { count:inManifest.length,  totalRecords:inManifest.reduce((s,e)=>s+e.records,0),  dateFrom:inManifest.reduce((m,e)=>e.dateFrom<m?e.dateFrom:m, '9999'), dateTo:inManifest.reduce((m,e)=>e.dateTo>m?e.dateTo:m,'0000'),  uploaded:inManifest[inManifest.length-1].uploadedAt  } : null,
            outbound:   outManifest.length ? { count:outManifest.length, totalRecords:outManifest.reduce((s,e)=>s+e.records,0), dateFrom:outManifest.reduce((m,e)=>e.dateFrom<m?e.dateFrom:m,'9999'), dateTo:outManifest.reduce((m,e)=>e.dateTo>m?e.dateTo:m,'0000'), uploaded:outManifest[outManifest.length-1].uploadedAt } : null,
            runtype:    rtObj ? { uploaded:rtObj.uploaded.toISOString() } : null,
            campustype: ctObj ? { uploaded:ctObj.uploaded.toISOString() } : null,
          }
        });
      }

      return err('Not found.', 404);

    } catch(e) {
      console.error(e);
      return err('Internal server error.', 500);
    }
  }
};

// ── HELPERS ───────────────────────────────────────────────────────────────
function fmtDate(iso) {
  const [y,m,d] = iso.split('-');
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${months[parseInt(m)-1]} ${parseInt(d)}, ${y}`;
}
function autoLabel(range) {
  const [y,m] = range.from.split('-');
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${months[parseInt(m)-1]} ${y}`;
}
