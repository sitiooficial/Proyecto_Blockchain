const express = require('express');
const router = express.Router();
const { logger } = require('../logger');
const { appendRowToSheet, readSheetRows, getDoc } = require('../utils/googleSheets');
const { ethers } = require('ethers'); // used for signature/tx verification if needed

// Helper: read structured sheets (indexes configurable)
const SHEET_INDEX = {
  voters: 0,
  elections: 1,
  candidates: 2,
  votes: 3
};

// POST /api  (single-entry legacy endpoint)
router.post('/', async (req, res) => {
  const body = req.body || {};
  const action = body.action || '';

  try {
    switch (action) {
      case 'registerVoter': {
        const { walletAddress, name, idNumber, email } = body;
        if (!walletAddress || !name || !idNumber) return res.json({ success: false, error: 'Faltan datos' });
        await appendRowToSheet(SHEET_INDEX.voters, { Fecha: new Date().toLocaleString(), Wallet: walletAddress, Name: name, ID: idNumber, Email: email });
        return res.json({ success: true, message: 'Votante registrado' });
      }

      case 'getActiveElections': {
        const rows = await readSheetRows(SHEET_INDEX.elections);
        // map to expected fields
        const elections = (rows || []).map((r, i) => ({
          ElectionID: r[0] || i + 1,
          Title: r[1] || 'Sin título',
          Description: r[2] || '',
          TotalVotes: Number(r[3] || 0)
        }));
        return res.json({ success: true, elections });
      }

      case 'getCandidates': {
        const electionId = body.electionId;
        const rows = await readSheetRows(SHEET_INDEX.candidates);
        const candidates = (rows || []).filter(r => String(r[0]) === String(electionId)).map((r, i) => ({
          CandidateID: r[1] || i+1,
          Name: r[2] || 'Sin nombre',
          Party: r[3] || '',
          Votes: Number(r[4] || 0)
        }));
        return res.json({ success: true, candidates });
      }

      case 'castVote': {
        const { walletAddress, electionId, candidateId } = body;
        if (!walletAddress || !electionId || !candidateId) return res.json({ success: false, error: 'Faltan parámetros' });

        // Append to votes sheet
        await appendRowToSheet(SHEET_INDEX.votes, { Fecha: new Date().toLocaleString(), Wallet: walletAddress, ElectionID: electionId, CandidateID: candidateId });

        // Emit socket event (server.js listens and will broadcast)
        req.app.get('io')?.emit('vote:cast', { electionId, candidateId, walletAddress, timestamp: Date.now() });

        return res.json({ success: true, voteId: Date.now().toString() });
      }

      case 'getStats': {
        const voters = await readSheetRows(SHEET_INDEX.voters);
        const elections = await readSheetRows(SHEET_INDEX.elections);
        const candidates = await readSheetRows(SHEET_INDEX.candidates);
        const votes = await readSheetRows(SHEET_INDEX.votes);
        const stats = {
          totalVoters: (voters || []).length,
          totalElections: (elections || []).length,
          totalCandidates: (candidates || []).length,
          totalVotes: (votes || []).length
        };
        return res.json({ success: true, stats });
      }

      case 'getVotersOverTime': {
        // naive: group votes by date (based on votes sheet)
        const votes = await readSheetRows(SHEET_INDEX.votes);
        const map = {};
        (votes || []).forEach(r => {
          const date = (r[0] && new Date(r[0]).toLocaleDateString()) || new Date().toLocaleDateString();
          map[date] = (map[date] || 0) + 1;
        });
        const series = Object.keys(map).sort().map(d => ({ date: d, count: map[d] }));
        return res.json({ success: true, series });
      }

      case 'getCandidatesCountPerElection': {
        const elections = await readSheetRows(SHEET_INDEX.elections);
        const candidates = await readSheetRows(SHEET_INDEX.candidates);
        const out = (elections || []).map((e, idx) => {
          const electionId = e[0] || idx+1;
          const title = e[1] || `Elección ${electionId}`;
          const count = (candidates || []).filter(c => String(c[0]) === String(electionId)).length;
          return { electionId, title, candidatesCount: count };
        });
        return res.json({ success: true, data: out });
      }

      case 'getParticipation': {
        const voters = await readSheetRows(SHEET_INDEX.voters);
        const votes = await readSheetRows(SHEET_INDEX.votes);
        const votedSet = new Set((votes || []).map(r => r[1])); // Wallet column assumed at index 1
        return res.json({ success: true, voted: votedSet.size, notVoted: Math.max(0, (voters || []).length - votedSet.size) });
      }

      case 'getActivitySeries': {
        // use votes grouped by date (same as voters over time)
        const votes = await readSheetRows(SHEET_INDEX.votes);
        const map = {};
        (votes || []).forEach(r => {
          const date = (r[0] && new Date(r[0]).toLocaleDateString()) || new Date().toLocaleDateString();
          map[date] = (map[date] || 0) + 1;
        });
        const series = Object.keys(map).sort().map(d => ({ date: d, votes: map[d] }));
        return res.json({ success: true, series });
      }

      case 'verifyTx': {
        // Basic stub — if you want real RPC check, implement with provider.getTransactionReceipt
        const txHash = body.txHash;
        if (!txHash) return res.json({ success: false, error: 'txHash requerido' });
        // return not implemented
        return res.json({ success: false, error: 'verifyTx no implementado en este backend. Implementar RPC provider.' });
      }

      default:
        return res.json({ success: false, error: 'Action no soportada' });
    }
  } catch (err) {
    logger.error('API error: ' + err.message);
    return res.json({ success: false, error: err.message || String(err) });
  }
});

// Export CSV / XLSX endpoints (simple redirect to Google Sheets export)
router.get('/db/export/csv', (req, res) => {
  const adminKey = req.query.adminKey;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(403).send('Forbidden');
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) return res.status(500).send('No GOOGLE_SHEET_ID');
  const gid = req.query.gid || '0';
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
  res.redirect(url);
});

router.get('/db/export/xlsx', (req, res) => {
  const adminKey = req.query.adminKey;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(403).send('Forbidden');
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) return res.status(500).send('No GOOGLE_SHEET_ID');
  const gid = req.query.gid || '0';
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=xlsx&gid=${gid}`;
  res.redirect(url);
});

module.exports = router;
