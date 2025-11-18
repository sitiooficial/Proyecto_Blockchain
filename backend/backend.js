// backend.js
// Backend híbrido JSON + Google Sheets (compatible con tu frontend)
// Coloca service-account.json en ./google/service-account.json o ajusta env GOOGLE_CREDENTIALS

const express = require('express');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const XLSX = require('xlsx');
const { google } = require('googleapis');
const http = require('http');
const { Server } = require('socket.io');
const { ethers } = require('ethers'); // usado para verifyTx si configuras RPC

// ----------------- CONFIG -----------------
const PORT = process.env.PORT || 3002;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'database.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID || '';
const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS || path.join(__dirname, 'google', 'service-account.json');
const SHEET_SYNC_TOKEN = process.env.SHEET_SYNC_TOKEN || 'SHEET_TOKEN_123';
const ADMIN_KEY = process.env.ADMIN_KEY || 'ADMIN_KEY_123';
const NETWORK = process.env.NETWORK || 'sepolia';
const RPC_URL = process.env.RPC_URL || ''; // optional for verifyTx
const DEBUG = (process.env.DEBUG === '1') || true;

// ----------------- GOOGLE SHEETS INIT -----------------
let sheetsAPI = null;
if (fs.existsSync(GOOGLE_CREDENTIALS) && GOOGLE_SHEET_ID) {
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: GOOGLE_CREDENTIALS,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    sheetsAPI = google.sheets({ version: 'v4', auth });
    console.log('✅ Google Sheets API inicializada');
  } catch (e) {
    console.warn('⚠️ No se pudo inicializar Google Sheets API:', e.message || e);
    sheetsAPI = null;
  }
} else {
  if (!fs.existsSync(GOOGLE_CREDENTIALS)) console.log('ℹ️ Google credentials no encontradas, Sheets deshabilitado');
  if (!GOOGLE_SHEET_ID) console.log('ℹ️ GOOGLE_SHEET_ID no configurado, Sheets deshabilitado');
}

// helper para append a sheets (no bloquear)
async function appendToSheet(sheetName, rowArr) {
  if (!sheetsAPI || !GOOGLE_SHEET_ID) return;
  try {
    await sheetsAPI.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `${sheetName}!A:Z`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [rowArr] }
    });
  } catch (err) {
    console.error('Sheets append error:', err.message || err);
  }
}

// helper: leer hoja completa y convertir a objetos usando primera fila como headers
async function readSheet(sheetName) {
  if (!sheetsAPI || !GOOGLE_SHEET_ID) return [];
  try {
    const resp = await sheetsAPI.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `${sheetName}!A:Z`
    });
    const rows = resp.data.values || [];
    if (rows.length <= 1) return [];
    const headers = rows[0];
    return rows.slice(1).map(r => {
      const obj = {};
      headers.forEach((h, i) => obj[h] = r[i] || '');
      return obj;
    });
  } catch (err) {
    console.error('readSheet error:', err.message || err);
    return [];
  }
}

// ----------------- LOGGER + SOCKET.IO -----------------
let io = null;
function emitLog(type, message, data = null) {
  const payload = { type, message, data, time: new Date().toISOString() };
  console.log(`[${type.toUpperCase()}] ${message}`, data || '');
  if (io) io.emit('system:log', payload);
  // también guarda a Sheets (no await)
  appendToSheet('Logs', [new Date().toISOString(), type, message, data ? JSON.stringify(data) : '']).catch(()=>{});
}
const logger = {
  info: (m,d) => emitLog('info', m, d),
  success: (m,d) => emitLog('success', m, d),
  warn: (m,d) => emitLog('warn', m, d),
  error: (m,d) => emitLog('error', m, d),
  action: (m,d) => emitLog('action', m, d)
};

// ----------------- EXPRESS + SOCKET.IO -----------------
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

if (fs.existsSync(PUBLIC_DIR)) app.use(express.static(PUBLIC_DIR));
else console.warn('⚠️ Public dir no existe:', PUBLIC_DIR);

const server = http.createServer(app);
io = new Server(server, { cors: { origin: '*' } });

io.on('connection', (socket) => {
  logger.info('Nuevo cliente conectado', { id: socket.id });
  socket.on('disconnect', () => logger.warn('Cliente desconectado', { id: socket.id }));
});

// ----------------- JSON DB HELPERS -----------------
const DEFAULT_DB = { voters: [], elections: [], candidates: [], votes: [], sysActivity: [] };

async function ensureDB() {
  await fs.ensureFile(DATA_FILE);
  try {
    const db = await fs.readJson(DATA_FILE);
    if (!db || typeof db !== 'object') throw new Error('DB inválida');
    let modified = false;
    for (const k of Object.keys(DEFAULT_DB)) {
      if (!Array.isArray(db[k])) { db[k] = DEFAULT_DB[k]; modified = true; }
    }
    if (modified) await fs.writeJson(DATA_FILE, db, { spaces: 2 });
  } catch (err) {
    await fs.writeJson(DATA_FILE, DEFAULT_DB, { spaces: 2 });
  }
}

async function readDB() {
  await ensureDB();
  return fs.readJson(DATA_FILE);
}
async function writeDB(db) {
  await fs.ensureFile(DATA_FILE);
  return fs.writeJson(DATA_FILE, db, { spaces: 2 });
}

// ----------------- ID helpers -----------------
function nextId(collection, keyName) {
  if (!Array.isArray(collection) || collection.length === 0) return 1;
  const max = Math.max(...collection.map(x => Number(x[keyName] || 0)));
  return max + 1;
}

// ----------------- anti-spam -----------------
const lastCall = {};
const LIMIT_MS = 800;
function antiSpam(action) {
  if (!action) return true;
  const now = Date.now();
  if (lastCall[action] && now - lastCall[action] < LIMIT_MS) {
    return false;
  }
  lastCall[action] = now;
  return true;
}

// ----------------- SYNC HELPERS (JSON -> Sheets) -----------------
async function syncAllToSheets() {
  if (!sheetsAPI || !GOOGLE_SHEET_ID) return { success: false, error: 'Sheets not configured' };
  try {
    const db = await readDB();

    // Write headers + rows by replacing entire sheet (cheaper to update ranges)
    // For simple use-case we will clear and write values for each sheet
    async function writeSheet(name, rows) {
      const headers = rows.length ? Object.keys(rows[0]) : [];
      const values = [headers, ...rows.map(r => headers.map(h => r[h] || ''))];
      await sheetsAPI.spreadsheets.values.clear({ spreadsheetId: GOOGLE_SHEET_ID, range: `${name}!A:Z` });
      if (values.length > 1) {
        await sheetsAPI.spreadsheets.values.update({
          spreadsheetId: GOOGLE_SHEET_ID,
          range: `${name}!A1`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values }
        });
      } else {
        // still write headers if none
        if (headers.length) {
          await sheetsAPI.spreadsheets.values.update({
            spreadsheetId: GOOGLE_SHEET_ID,
            range: `${name}!A1`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values }
          });
        }
      }
    }

    await writeSheet('Votantes', db.voters);
    await writeSheet('Elecciones', db.elections);
    await writeSheet('Candidatos', db.candidates);
    await writeSheet('Votos', db.votes);
    await writeSheet('SysActivity', db.sysActivity || []);

    logger.success('Sync completo a Google Sheets', { counts: {
      voters: db.voters.length, elections: db.elections.length, candidates: db.candidates.length, votes: db.votes.length }});
    return { success: true };
  } catch (err) {
    logger.error('syncAllToSheets failed', { error: err.message || String(err) });
    return { success: false, error: err.message || String(err) };
  }
}

// ----------------- API CENTRAL (/api) -----------------
app.post('/api', async (req, res) => {
  const action = req.body && req.body.action;
  logger.action(`API → ${action}`);

  // anti-spam
  if (!antiSpam(action)) {
    logger.warn('Spam bloqueado', { action });
    return res.status(429).json({ success: false, error: 'Too many requests' });
  }

  try {
    const db = await readDB();

    // ---------- registerVoter ----------
    if (action === 'registerVoter') {
      const { walletAddress, name, idNumber, email, ipAddress } = req.body || {};
      if (!walletAddress || !name || !idNumber) return res.json({ success: false, error: 'Campos incompletos' });

      const walletLower = String(walletAddress).toLowerCase();
      if (db.voters.find(v => String(v.Wallet || '').toLowerCase() === walletLower))
        return res.json({ success: false, error: 'Wallet ya registrada' });

      const VoterID = nextId(db.voters, 'VoterID');
      const voter = { VoterID, Wallet: walletAddress, Name: name, IDNumber: idNumber, Email: email || '', RegisteredAt: new Date().toISOString(), IP: ipAddress || '' };

      db.voters.push(voter);
      await writeDB(db);

      // append to sheet
      appendToSheet('Votantes', [voter.VoterID, voter.Wallet, voter.Name, voter.IDNumber, voter.Email, voter.RegisteredAt, voter.IP]).catch(()=>{});

      logger.success('Votante registrado', voter);
      if (io) io.emit('voter:registered', voter);
      return res.json({ success: true, voter });
    }

    // ---------- getActiveElections ----------
    if (action === 'getActiveElections') {
      const now = Date.now();
      const active = (db.elections || []).filter(e => {
        const start = e.StartDate ? new Date(e.StartDate).getTime() : -Infinity;
        const end = e.EndDate ? new Date(e.EndDate).getTime() : Infinity;
        return start <= now && now <= end;
      });
      return res.json({ success: true, elections: active });
    }

    // ---------- getCandidates ----------
    if (action === 'getCandidates') {
      const electionId = req.body.electionId;
      const list = (db.candidates || []).filter(c => String(c.ElectionID) === String(electionId));
      return res.json({ success: true, candidates: list });
    }

    // ---------- createElection ----------
    if (action === 'createElection') {
      const id = nextId(db.elections, 'ElectionID');
      const e = {
        ElectionID: id,
        Title: req.body.title || `Elección ${id}`,
        Description: req.body.description || '',
        StartDate: req.body.startDate || null,
        EndDate: req.body.endDate || null,
        CreatedAt: new Date().toISOString(),
        TotalVotes: 0
      };
      db.elections.push(e);
      await writeDB(db);

      appendToSheet('Elecciones', [e.ElectionID, e.Title, e.Description, e.StartDate || '', e.EndDate || '', e.CreatedAt, e.TotalVotes]).catch(()=>{});

      logger.success('Elección creada', e);
      if (io) io.emit('election:created', e);
      return res.json({ success: true, election: e });
    }

    // ---------- addCandidate ----------
    if (action === 'addCandidate') {
      if (!req.body || !req.body.electionId || !req.body.name) return res.json({ success: false, error: 'electionId y name requeridos' });
      const id = nextId(db.candidates, 'CandidateID');
      const c = { CandidateID: id, ElectionID: Number(req.body.electionId), Name: req.body.name, Party: req.body.party || '', Votes: 0, CreatedAt: new Date().toISOString() };
      db.candidates.push(c);
      await writeDB(db);

      appendToSheet('Candidatos', [c.CandidateID, c.ElectionID, c.Name, c.Party, c.Votes, c.CreatedAt]).catch(()=>{});

      logger.success('Candidato agregado', c);
      if (io) io.emit('candidate:added', c);
      return res.json({ success: true, candidate: c });
    }

    // ---------- castVote ----------
    if (action === 'castVote') {
      const { walletAddress, electionId, candidateId } = req.body || {};
      if (!walletAddress || !electionId || !candidateId) return res.json({ success: false, error: 'Faltan datos' });

      const walletLower = String(walletAddress).toLowerCase();
      if ((db.votes || []).find(v => String(v.Wallet || '').toLowerCase() === walletLower && String(v.ElectionID) === String(electionId)))
        return res.json({ success: false, error: 'Ya votó' });

      const VoteID = nextId(db.votes, 'VoteID');
      const vote = { VoteID, Wallet: walletAddress, ElectionID: Number(electionId), CandidateID: Number(candidateId), Timestamp: new Date().toISOString() };
      db.votes.push(vote);

      // increment candidate and election counts
      const cand = db.candidates.find(c => String(c.CandidateID) === String(candidateId));
      if (cand) cand.Votes = (cand.Votes || 0) + 1;
      const elect = db.elections.find(e => String(e.ElectionID) === String(electionId));
      if (elect) elect.TotalVotes = (elect.TotalVotes || 0) + 1;

      // write db
      await writeDB(db);

      // append to sheets
      appendToSheet('Votos', [vote.VoteID, vote.Wallet, vote.ElectionID, vote.CandidateID, vote.Timestamp]).catch(()=>{});

      logger.success('Voto registrado', vote);
      if (io) io.emit('vote:cast', vote);

      // record system activity (for charts)
      const activity = { time: new Date().toISOString(), type: 'vote', data: JSON.stringify({ electionId, candidateId }) };
      db.sysActivity = db.sysActivity || [];
      db.sysActivity.push(activity);
      await writeDB(db);
      appendToSheet('SysActivity', [activity.time, activity.type, activity.data]).catch(()=>{});

      return res.json({ success: true, vote });
    }

    // ---------- getResults ----------
    if (action === 'getResults') {
      const electionId = req.body.electionId;
      if (!electionId) return res.json({ success: false, error: 'electionId required' });
      const election = db.elections.find(e => String(e.ElectionID) === String(electionId));
      if (!election) return res.json({ success: false, error: 'Election not found' });
      const candidates = db.candidates.filter(c => String(c.ElectionID) === String(electionId))
        .map(c => ({ name: c.Name, party: c.Party, votes: Number(c.Votes || 0) }));
      const totalVotes = Number(election.TotalVotes || 0);
      const withPct = candidates.map(c => ({ ...c, percentage: totalVotes ? (c.votes / totalVotes) * 100 : 0 }));
      return res.json({ success: true, election: { title: election.Title, totalVotes }, candidates: withPct });
    }

    // ---------- getStats ----------
    if (action === 'getStats') {
      const totals = { totalVoters: db.voters.length, totalElections: db.elections.length, totalVotes: db.votes.length, totalCandidates: db.candidates.length };
      return res.json({ success: true, stats: totals });
    }

    // ---------- getChartData ----------
    // type: votersByDay | candidatesByElection | participation | votesHistory | activityPerMinute
    if (action === 'getChartData') {
      const type = req.body.type;
      if (type === 'votersByDay') {
        // count registrations grouped by day (YYYY-MM-DD)
        const map = {};
        (db.voters || []).forEach(v => {
          const day = v.RegisteredAt ? (new Date(v.RegisteredAt).toISOString().slice(0,10)) : (new Date().toISOString().slice(0,10));
          map[day] = (map[day] || 0) + 1;
        });
        const labels = Object.keys(map).sort();
        const data = labels.map(l => map[l]);
        return res.json({ success: true, labels, data });
      }

      if (type === 'candidatesByElection') {
        // return { electionId, title, candidates: [{name,votes}] } per election
        const out = (db.elections || []).map(e => {
          const cands = (db.candidates || []).filter(c => String(c.ElectionID) === String(e.ElectionID)).map(c => ({ name: c.Name, votes: Number(c.Votes || 0) }));
          return { electionId: e.ElectionID, title: e.Title, candidates: cands };
        });
        return res.json({ success: true, data: out });
      }

      if (type === 'participation') {
        // participation = totalVotes / totalVoters * 100 per election
        const out = (db.elections || []).map(e => {
          const votersCount = db.voters.length || 0;
          const participation = votersCount ? ((Number(e.TotalVotes||0) / votersCount) * 100) : 0;
          return { electionId: e.ElectionID, title: e.Title, participation };
        });
        return res.json({ success: true, data: out });
      }

      if (type === 'votesHistory') {
        // return counts per day of votes
        const map = {};
        (db.votes || []).forEach(v => {
          const day = v.Timestamp ? (new Date(v.Timestamp).toISOString().slice(0,10)) : (new Date().toISOString().slice(0,10));
          map[day] = (map[day] || 0) + 1;
        });
        const labels = Object.keys(map).sort();
        const data = labels.map(l => map[l]);
        return res.json({ success: true, labels, data });
      }

      if (type === 'activityPerMinute') {
        // last 60 minutes activity counts (from sysActivity)
        const now = Date.now();
        const buckets = {};
        for (let i = 0; i < 60; i++) {
          const t = new Date(now - (59 - i) * 60000);
          const label = `${t.getHours().toString().padStart(2,'0')}:${t.getMinutes().toString().padStart(2,'0')}`;
          buckets[label] = 0;
        }
        (db.sysActivity || []).forEach(a => {
          const m = new Date(a.time);
          const label = `${m.getHours().toString().padStart(2,'0')}:${m.getMinutes().toString().padStart(2,'0')}`;
          if (label in buckets) buckets[label] += 1;
        });
        const labels = Object.keys(buckets);
        const data = labels.map(l => buckets[l]);
        return res.json({ success: true, labels, data });
      }

      return res.json({ success: false, error: 'Tipo no soportado' });
    }

    // unknown action
    return res.json({ success: false, error: 'Acción no soportada' });
  } catch (err) {
    logger.error('Error en API', { error: err.message || String(err) });
    return res.json({ success: false, error: err.message || String(err) });
  }
});

// ----------------- ADMIN / DB ROUTES -----------------
app.get('/db/all', async (_, res) => {
  try {
    const db = await readDB();
    return res.json({ success: true, data: db });
  } catch (err) {
    console.error('/db/all error', err);
    return res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

app.post('/db/reset', async (req, res) => {
  try {
    const body = req.body || {};
    if (String(body.adminKey) !== ADMIN_KEY) return res.json({ success: false, error: 'adminKey inválido' });
    await fs.writeJson(DATA_FILE, DEFAULT_DB, { spaces: 2 });
    logger.warn('DB reseteada por admin');
    return res.json({ success: true, message: 'DB reseteada' });
  } catch (err) {
    return res.json({ success: false, error: err.message || String(err) });
  }
});

// ---------- EXPORT CSV/XLSX (local fallback and sheets fallback) ----------
app.get('/export/csv/:sheet', async (req, res) => {
  try {
    const sheetName = req.params.sheet;
    let rows = [];
    // prefer readSheet (Google Sheets) if available
    rows = await readSheet(sheetName).catch(()=>[]);
    if (!rows || rows.length === 0) {
      const db = await readDB();
      rows = db[sheetName] || [];
    }
    if (!rows || rows.length === 0) return res.send('');
    const headers = Object.keys(rows[0]);
    const csv = [headers.join(','), ...rows.map(r => headers.map(h => `"${String(r[h]||'').replace(/"/g,'""')}"`).join(','))].join('\n');
    res.setHeader('Content-Disposition', `attachment; filename="${sheetName}.csv"`);
    res.setHeader('Content-Type', 'text/csv');
    return res.send(csv);
  } catch (err) {
    console.error('CSV export error', err);
    return res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

app.get('/export/xlsx/:sheet', async (req, res) => {
  try {
    const sheetName = req.params.sheet;
    let rows = await readSheet(sheetName).catch(()=>[]);
    if (!rows || rows.length === 0) {
      const db = await readDB();
      rows = db[sheetName] || [];
    }
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="${sheetName}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return res.send(buffer);
  } catch (err) {
    console.error('XLSX export error', err);
    return res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

// ---------- SYNC endpoint (protected by token) ----------
app.post('/db/sync-to-sheets', async (req, res) => {
  try {
    const token = (req.body && req.body.token) || req.query.token;
    if (token !== SHEET_SYNC_TOKEN) return res.status(403).json({ success: false, error: 'token inválido' });
    const r = await syncAllToSheets();
    return res.json(r);
  } catch (err) {
    console.error('sync endpoint error', err);
    return res.json({ success: false, error: err.message || String(err) });
  }
});

// ----------------- START SERVER -----------------
(async () => {
  await ensureDB();
  server.listen(PORT, () => {
    logger.success(`🚀 Backend listo en http://localhost:${PORT}`);
    logger.info(`Sheets: ${sheetsAPI ? 'enabled' : 'disabled'}`);
  });
})();
