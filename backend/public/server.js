// ============================================================
// 🗳️ SISTEMA DE VOTACIÓN BLOCKCHAIN GASLESS - Backend Node.js
// Alternativa a Google Apps Script usando Express + Base de Datos
// ============================================================

const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.BACKEND_PORT || 3002;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- CONFIGURACIÓN ---
const CONFIG = {
  ADMIN_ADDRESSES: (process.env.ADMIN_ADDRESSES || '').split(',').map(a => a.toLowerCase().trim()),
  VOTING_CONTRACT_ADDRESS: process.env.VOTING_CONTRACT_ADDRESS || '',
  FORWARDER_ADDRESS: process.env.FORWARDER_ADDRESS || '',
  RELAYER_URL: process.env.RELAYER_URL || 'http://localhost:3001',
  DATA_DIR: path.join(__dirname, 'data')
};

// --- ESTRUCTURA DE DATOS EN MEMORIA ---
let DATABASE = {
  voters: [],
  elections: [],
  candidates: [],
  votes: [],
  blockchain: [],
  audit: [],
  stats: {},
  relayerLog: []
};

// --- INICIALIZACIÓN ---
async function initializeSystem() {
  try {
    // Crear directorio de datos si no existe
    await fs.mkdir(CONFIG.DATA_DIR, { recursive: true });
    
    // Cargar datos existentes o crear nuevos
    await loadDatabase();
    
    // Crear bloque génesis si no existe
    if (DATABASE.blockchain.length === 0) {
      DATABASE.blockchain.push({
        timestamp: new Date().toISOString(),
        action: 'GENESIS',
        details: { message: 'Sistema inicializado' },
        hash: uuidv4(),
        blockNumber: 0
      });
    }
    
    await updateStats();
    await saveDatabase();
    
    console.log('✅ Sistema inicializado correctamente');
    return { success: true, message: '✅ Sistema inicializado correctamente' };
  } catch (err) {
    console.error('Error inicializando sistema:', err);
    return { success: false, error: err.message };
  }
}

// --- PERSISTENCIA DE DATOS ---
async function saveDatabase() {
  try {
    const dbPath = path.join(CONFIG.DATA_DIR, 'database.json');
    await fs.writeFile(dbPath, JSON.stringify(DATABASE, null, 2));
  } catch (err) {
    console.error('Error guardando base de datos:', err);
  }
}

async function loadDatabase() {
  try {
    const dbPath = path.join(CONFIG.DATA_DIR, 'database.json');
    const data = await fs.readFile(dbPath, 'utf8');
    DATABASE = JSON.parse(data);
    console.log('✅ Base de datos cargada');
  } catch (err) {
    console.log('📝 Creando nueva base de datos');
    // Si no existe, se usará la estructura por defecto
  }
}

// --- REGISTRAR VOTANTE ---
function registerVoter(data) {
  try {
    const wallet = (data.walletAddress || data.wallet || '').toLowerCase().trim();
    const name = (data.name || '').trim();
    const idNumber = (data.idNumber || data.dni || '').trim();
    const email = (data.email || '').trim();

    // Validaciones
    if (!wallet || !name || !idNumber) {
      throw new Error('Datos incompletos: wallet, nombre y DNI son obligatorios');
    }

    if (!wallet.match(/^0x[a-fA-F0-9]{40}$/)) {
      throw new Error('Dirección de wallet inválida');
    }

    // Verificar si ya existe
    const existing = DATABASE.voters.find(v => v.walletAddress.toLowerCase() === wallet);
    if (existing) {
      throw new Error('Votante ya registrado con esta wallet');
    }

    // Crear votante
    const voter = {
      walletAddress: wallet,
      name,
      idNumber,
      email,
      registeredAt: new Date().toISOString(),
      status: 'Activo'
    };

    DATABASE.voters.push(voter);
    logBlockchain('registerVoter', { wallet, name });
    logAudit('registerVoter', wallet, { name, idNumber }, 'success');
    updateStats();
    saveDatabase();

    return { success: true, message: '✅ Votante registrado correctamente', wallet };
  } catch (err) {
    logAudit('registerVoter', data.walletAddress || 'unknown', data, 'error', err.message);
    return { success: false, error: err.message };
  }
}

// --- CREAR ELECCIÓN ---
function createElection(data) {
  try {
    const admin = (data.adminAddress || '').toLowerCase().trim();
    const title = (data.title || '').trim();
    const description = (data.description || '').trim();
    const startDate = data.startDate || '';
    const endDate = data.endDate || '';

    // Validaciones
    if (!admin || !title) {
      throw new Error('Dirección de admin y título son obligatorios');
    }

    if (!CONFIG.ADMIN_ADDRESSES.includes(admin)) {
      throw new Error('No autorizado: dirección no es admin');
    }

    // Crear elección
    const electionId = DATABASE.elections.length + 1;
    const election = {
      electionId,
      title,
      description,
      startDate,
      endDate,
      status: 'Activa',
      totalVotes: 0,
      createdAt: new Date().toISOString(),
      contractAddress: CONFIG.VOTING_CONTRACT_ADDRESS
    };

    DATABASE.elections.push(election);
    logBlockchain('createElection', { admin, title, electionId });
    logAudit('createElection', admin, { title, electionId }, 'success');
    updateStats();
    saveDatabase();

    return {
      success: true,
      message: `✅ Elección "${title}" creada con ID: ${electionId}`,
      electionId
    };
  } catch (err) {
    logAudit('createElection', data.adminAddress || 'unknown', data, 'error', err.message);
    return { success: false, error: err.message };
  }
}

// --- AGREGAR CANDIDATO ---
function addCandidate(data) {
  try {
    const electionId = parseInt(data.electionId || data.election);
    const name = (data.name || '').trim();
    const party = (data.party || data.proposal || '').trim();

    // Validaciones
    if (!electionId || !name) {
      throw new Error('Election ID y nombre son obligatorios');
    }

    const election = DATABASE.elections.find(e => e.electionId === electionId);
    if (!election) {
      throw new Error('Elección no encontrada');
    }

    // Generar candidateId
    const existingCandidates = DATABASE.candidates.filter(c => c.electionId === electionId);
    const candidateId = existingCandidates.length + 1;

    // Crear candidato
    const candidate = {
      electionId,
      candidateId,
      name,
      party,
      votes: 0,
      percentage: '0%',
      addedAt: new Date().toISOString()
    };

    DATABASE.candidates.push(candidate);
    logBlockchain('addCandidate', { electionId, candidateId, name, party });
    logAudit('addCandidate', 'system', { electionId, name }, 'success');
    saveDatabase();

    return {
      success: true,
      message: '✅ Candidato agregado',
      candidateId
    };
  } catch (err) {
    logAudit('addCandidate', 'system', data, 'error', err.message);
    return { success: false, error: err.message };
  }
}

// --- REGISTRAR VOTO ---
function recordVote(data) {
  try {
    const txHash = data.txHash || data.transactionHash || '';
    const wallet = (data.walletAddress || data.voter || data.from || '').toLowerCase().trim();
    const electionId = parseInt(data.electionId);
    const candidateId = parseInt(data.candidateId);
    const blockNumber = data.blockNumber || 0;
    const gasUsed = data.gasUsed || 0;

    // Validaciones
    if (!wallet || !electionId || !candidateId) {
      throw new Error('Datos incompletos para registrar voto');
    }

    // Verificar que no haya votado antes
    const hasVoted = DATABASE.votes.some(v => 
      v.walletAddress.toLowerCase() === wallet && v.electionId === electionId
    );

    if (hasVoted) {
      throw new Error('El votante ya emitió su voto en esta elección');
    }

    // Verificar que el candidato existe
    const candidate = DATABASE.candidates.find(c => 
      c.electionId === electionId && c.candidateId === candidateId
    );

    if (!candidate) {
      throw new Error('Candidato no encontrado');
    }

    // Registrar voto
    const vote = {
      txHash,
      walletAddress: wallet,
      electionId,
      candidateId,
      timestamp: new Date().toISOString(),
      blockNumber,
      gasUsed,
      status: 'Confirmado'
    };

    DATABASE.votes.push(vote);
    
    // Actualizar conteos
    updateCandidateVotes(electionId, candidateId);
    updateElectionTotalVotes(electionId);

    logBlockchain('castVote', { wallet, electionId, candidateId, txHash });
    logAudit('castVote', wallet, { electionId, candidateId }, 'success');
    updateStats();
    saveDatabase();

    return {
      success: true,
      message: '🗳️ Voto registrado correctamente',
      txHash
    };
  } catch (err) {
    logAudit('recordVote', data.walletAddress || 'unknown', data, 'error', err.message);
    return { success: false, error: err.message };
  }
}

// --- ACTUALIZAR CONTEO DE VOTOS DEL CANDIDATO ---
function updateCandidateVotes(electionId) {
  // Contar votos por candidato en esta elección
  const voteCounts = {};
  DATABASE.votes
    .filter(v => v.electionId === electionId)
    .forEach(v => {
      voteCounts[v.candidateId] = (voteCounts[v.candidateId] || 0) + 1;
    });

  const totalVotes = Object.values(voteCounts).reduce((a, b) => a + b, 0);

  // Actualizar cada candidato
  DATABASE.candidates
    .filter(c => c.electionId === electionId)
    .forEach(candidate => {
      const count = voteCounts[candidate.candidateId] || 0;
      const percentage = totalVotes > 0 ? ((count / totalVotes) * 100).toFixed(2) : '0';
      
      candidate.votes = count;
      candidate.percentage = percentage + '%';
    });
}

// --- ACTUALIZAR TOTAL DE VOTOS DE ELECCIÓN ---
function updateElectionTotalVotes(electionId) {
  const totalVotes = DATABASE.votes.filter(v => v.electionId === electionId).length;
  
  const election = DATABASE.elections.find(e => e.electionId === electionId);
  if (election) {
    election.totalVotes = totalVotes;
  }
}

// --- OBTENER ELECCIONES ACTIVAS ---
function getActiveElections() {
  try {
    const activeElections = DATABASE.elections
      .filter(e => e.status === 'Activa')
      .map(e => ({
        ElectionID: e.electionId,
        Title: e.title,
        Description: e.description,
        StartDate: e.startDate,
        EndDate: e.endDate,
        Status: e.status,
        TotalVotes: e.totalVotes,
        ContractAddress: e.contractAddress
      }));

    return { success: true, elections: activeElections };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// --- OBTENER CANDIDATOS DE UNA ELECCIÓN ---
function getCandidates(data) {
  try {
    const electionId = parseInt(data.electionId);
    
    if (!electionId) {
      throw new Error('Election ID es obligatorio');
    }

    const electionCandidates = DATABASE.candidates
      .filter(c => c.electionId === electionId)
      .map(c => ({
        CandidateID: c.candidateId,
        Name: c.name,
        Party: c.party,
        Votes: c.votes,
        Percentage: c.percentage
      }));

    return { success: true, candidates: electionCandidates };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// --- OBTENER RESULTADOS ---
function getResults(data) {
  try {
    const electionId = parseInt(data.electionId);
    
    if (!electionId) {
      throw new Error('Election ID es obligatorio');
    }

    const election = DATABASE.elections.find(e => e.electionId === electionId);
    
    if (!election) {
      throw new Error('Elección no encontrada');
    }

    const results = DATABASE.candidates
      .filter(c => c.electionId === electionId)
      .map(c => ({
        name: c.name,
        party: c.party,
        votes: c.votes,
        percentage: parseFloat(c.percentage) || 0
      }))
      .sort((a, b) => b.votes - a.votes);

    return {
      success: true,
      election: {
        id: election.electionId,
        title: election.title,
        totalVotes: election.totalVotes
      },
      candidates: results
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// --- OBTENER ESTADÍSTICAS ---
function getStats() {
  try {
    const stats = {
      totalVoters: DATABASE.voters.length,
      totalElections: DATABASE.elections.length,
      totalVotes: DATABASE.votes.length,
      totalCandidates: DATABASE.candidates.length,
      lastUpdate: new Date().toISOString()
    };

    return { success: true, stats };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// --- LOGGING DE BLOCKCHAIN ---
function logBlockchain(action, details) {
  try {
    const hash = uuidv4();
    const blockNumber = DATABASE.blockchain.length;
    
    DATABASE.blockchain.push({
      timestamp: new Date().toISOString(),
      action,
      details,
      hash,
      blockNumber
    });
  } catch (err) {
    console.error('Error en logBlockchain:', err);
  }
}

// --- LOGGING DE AUDITORÍA ---
function logAudit(action, user, details, status, error = '') {
  try {
    DATABASE.audit.push({
      timestamp: new Date().toISOString(),
      action,
      user,
      details,
      status,
      error
    });
  } catch (err) {
    console.error('Error en logAudit:', err);
  }
}

// --- REGISTRAR LOG DEL RELAYER ---
function logRelayer(data) {
  try {
    DATABASE.relayerLog.push({
      timestamp: new Date().toISOString(),
      from: data.from || '',
      action: data.action || '',
      status: data.status || '',
      txHash: data.txHash || '',
      gasUsed: data.gasUsed || 0
    });
    saveDatabase();
  } catch (err) {
    console.error('Error en logRelayer:', err);
  }
}

// --- ACTUALIZAR ESTADÍSTICAS ---
function updateStats() {
  try {
    const stats = getStats();
    if (stats.success) {
      DATABASE.stats = stats.stats;
    }
  } catch (err) {
    console.error('Error actualizando stats:', err);
  }
}

// --- DESPACHADOR DE ACCIONES ---
function handleAction(action, data) {
  const actions = {
    'init': initializeSystem,
    'registerVoter': () => registerVoter(data),
    'createElection': () => createElection(data),
    'addCandidate': () => addCandidate(data),
    'recordVote': () => recordVote(data),
    'castVote': () => recordVote(data), // Alias
    'getActiveElections': getActiveElections,
    'getCandidates': () => getCandidates(data),
    'getResults': () => getResults(data),
    'getStats': getStats,
    'logRelayer': () => logRelayer(data)
  };

  if (actions[action]) {
    return actions[action]();
  } else {
    throw new Error('Acción desconocida: ' + action);
  }
}

// ============================================================
// 🌐 RUTAS HTTP
// ============================================================

// GET - Health check
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'API Online',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// GET - Con parámetros de query
app.get('/api', (req, res) => {
  try {
    const action = req.query.action;
    
    if (!action) {
      return res.json({
        success: true,
        message: 'API Online',
        timestamp: new Date().toISOString()
      });
    }

    const result = handleAction(action, req.query);
    res.json(result);
  } catch (err) {
    console.error('Error en GET:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST - Recibir datos
app.post('/api', async (req, res) => {
  try {
    const data = req.body;
    const action = data.action;

    if (!action) {
      return res.status(400).json({
        success: false,
        error: 'Action es requerido'
      });
    }

    const result = await handleAction(action, data);
    res.json(result);
  } catch (err) {
    console.error('Error en POST:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Exportar base de datos (solo para desarrollo)
app.get('/export', (req, res) => {
  res.json({
    success: true,
    data: DATABASE,
    timestamp: new Date().toISOString()
  });
});

// Importar base de datos (solo para desarrollo)
app.post('/import', (req, res) => {
  try {
    DATABASE = req.body;
    saveDatabase();
    res.json({ success: true, message: 'Base de datos importada' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Error handler global
app.use((err, req, res, next) => {
  console.error('Error no manejado:', err);
  res.status(500).json({
    success: false,
    error: 'Error interno del servidor',
    message: err.message
  });
});

// ============================================================
// 🚀 INICIAR SERVIDOR
// ============================================================

async function startServer() {
  try {
    await initializeSystem();
    
    app.listen(PORT, () => {
      console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║  🗳️  Backend Server - Sistema de Votación                ║
║                                                           ║
╠═══════════════════════════════════════════════════════════╣
║  Puerto:          ${PORT}                                    ║
║  Modo:            Node.js Backend                         ║
║  Base de datos:   ${CONFIG.DATA_DIR}                         ║
║  Admins:          ${CONFIG.ADMIN_ADDRESSES.length} configurados            ║
╚═══════════════════════════════════════════════════════════╝

📊 Estadísticas:
   - Votantes:    ${DATABASE.voters.length}
   - Elecciones:  ${DATABASE.elections.length}
   - Votos:       ${DATABASE.votes.length}
   - Candidatos:  ${DATABASE.candidates.length}

🌐 Endpoints disponibles:
   - GET  http://localhost:${PORT}/
   - GET  http://localhost:${PORT}/api?action=getStats
   - POST http://localhost:${PORT}/api

✨ Backend iniciado correctamente!
      `);
    });
  } catch (err) {
    console.error('❌ Error iniciando servidor:', err);
    process.exit(1);
  }
}

// Manejar cierre graceful
process.on('SIGINT', async () => {
  console.log('\n🛑 Cerrando servidor...');
  await saveDatabase();
  console.log('💾 Base de datos guardada');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await saveDatabase();
  process.exit(0);
});

// Iniciar servidor
if (require.main === module) {
  startServer();
}

module.exports = { app, DATABASE, handleAction };