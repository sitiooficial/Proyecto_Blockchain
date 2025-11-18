/*******************************************************
 * FRONTEND — Sistema de Votación Gasless (Full Sync)
 *******************************************************/

console.log("Frontend.js cargado correctamente");

// =============================
//  VARIABLES GLOBALES
// =============================
let provider = null;
let signer = null;
let currentWallet = null;

// Backend base URL definido en index.html
// const BACKEND_URL = "http://localhost:3002/api";


// =============================
//  NOTIFICACIONES
// =============================
function notify(type, message) {
  const box = document.getElementById("notification");
  const text = document.getElementById("notificationMessage");

  box.className = "notification show " + type;
  text.innerText = message;

  setTimeout(() => {
    box.classList.remove("show");
  }, 3500);
}


// =============================
//  WALLET - CONEXIÓN
// =============================
async function connectWallet() {
  try {
    if (!window.ethereum) {
      notify("error", "MetaMask no disponible");
      return;
    }

    provider = new ethers.BrowserProvider(window.ethereum);
    const accounts = await provider.send("eth_requestAccounts", []);
    signer = await provider.getSigner();
    currentWallet = accounts[0];

    document.getElementById("walletDisplay").innerText =
      currentWallet.substring(0, 6) + "..." + currentWallet.slice(-4);

    document.getElementById("statusBadge").classList.remove("status-disconnected");
    document.getElementById("statusBadge").classList.add("status-connected");
    document.getElementById("statusBadge").innerText = "Conectado";

    document.getElementById("regWallet").value = currentWallet;
    document.getElementById("adminAddress").value = currentWallet;

    notify("success", "Wallet conectada");

  } catch (err) {
    console.error(err);
    notify("error", "Error al conectar wallet");
  }
}



// =============================
//  API WRAPPER
// =============================
async function callAPI(action, body = {}) {
  try {
    const res = await fetch(BACKEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...body })
    });

    return await res.json();
  } catch (err) {
    notify("error", "Error de conexión con backend");
    return { success: false, error: err.message };
  }
}



// =============================
//  REGISTRO DE VOTANTES
// =============================
async function registerVoter() {
  const name = document.getElementById("regName").value.trim();
  const dni = document.getElementById("regID").value.trim();
  const email = document.getElementById("regEmail").value.trim();

  if (!currentWallet) {
    notify("error", "Debe conectar MetaMask");
    return;
  }
  if (!name || !dni) {
    notify("error", "Complete los campos obligatorios");
    return;
  }

  const ip = await fetch("https://api.ipify.org?format=json")
    .then(r => r.json()).then(d => d.ip).catch(() => "");

  const resp = await callAPI("registerVoter", {
    walletAddress: currentWallet,
    name,
    idNumber: dni,
    email,
    ipAddress: ip
  });

  if (resp.success) {
    notify("success", "Votante registrado");
    loadStats();
  } else {
    notify("error", resp.error || "Error registrando votante");
  }
}



// =============================
//  ESTADÍSTICAS (Dashboard)
// =============================
async function loadStats() {
  const resp = await callAPI("getStats");

  if (!resp.success) return;

  document.getElementById("statVoters").innerText = resp.stats.totalVoters;
  document.getElementById("statElections").innerText = resp.stats.totalElections;
  document.getElementById("statVotes").innerText = resp.stats.totalVotes;
  document.getElementById("statCandidates").innerText = resp.stats.totalCandidates;

  loadCharts(resp.stats);
}



// =============================
//  ELECCIONES ACTIVAS
// =============================
async function loadActiveElections() {
  const container = document.getElementById("electionsContainer");
  container.innerHTML = "Cargando...";

  const resp = await callAPI("getActiveElections");

  if (!resp.success) {
    container.innerHTML = "Error cargando elecciones";
    return;
  }

  if (resp.elections.length === 0) {
    container.innerHTML = "No hay elecciones activas";
    return;
  }

  container.innerHTML = "";

  for (const election of resp.elections) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
        <h3>${election.Title}</h3>
        <p>${election.Description}</p>
        <button class="btn" onclick="loadCandidates(${election.ElectionID})">Ver Candidatos</button>
        <div id="cand_${election.ElectionID}"></div>
    `;
    container.appendChild(card);
  }
}



// =============================
// Candidatos
// =============================
async function loadCandidates(electionId) {
  const target = document.getElementById(`cand_${electionId}`);
  target.innerHTML = "Cargando...";

  const resp = await callAPI("getCandidates", { electionId });

  if (!resp.success) {
    target.innerHTML = "Error obteniendo candidatos";
    return;
  }

  target.innerHTML = resp.candidates
    .map(c => `
      <div class="card">
        <strong>${c.Name}</strong> – ${c.Party}
        <button class="btn btn-success" onclick="castVote(${electionId}, ${c.CandidateID})">Votar</button>
      </div>
    `)
    .join("");
}



// =============================
// Emitir voto
// =============================
async function castVote(electionId, candidateId) {
  if (!currentWallet) {
    notify("error", "Debe conectar MetaMask");
    return;
  }

  const resp = await callAPI("castVote", {
    walletAddress: currentWallet,
    electionId,
    candidateId
  });

  if (resp.success) {
    notify("success", "Voto emitido");
    loadStats();
  } else {
    notify("error", resp.error || "Error al votar");
  }
}



// =============================
//  RESULTADOS
// =============================
async function loadResults() {
  const select = document.getElementById("resultsElectionSelect");

  const resp = await callAPI("getActiveElections"); // o listAllElections

  if (!resp.success) return;

  select.innerHTML = resp.elections
    .map(e => `<option value="${e.ElectionID}">${e.Title}</option>`)
    .join("");

  if (resp.elections.length > 0) loadResultsFor(resp.elections[0].ElectionID);
}

async function loadResultsFor(id) {
  const container = document.getElementById("resultsContainer");
  const resp = await callAPI("getCandidates", { electionId: id });

  if (!resp.success) return;

  container.innerHTML = resp.candidates
    .map(c => `
        <div class="card">
          <strong>${c.Name}</strong> — ${c.Votes} votos
        </div>
    `)
    .join("");
}



// =============================
//  ADMIN — CREAR ELECCIÓN
// =============================
async function createElection() {
  const title = document.getElementById("electionTitle").value.trim();
  const desc = document.getElementById("electionDesc").value.trim();

  if (!title) {
    notify("error", "Título requerido");
    return;
  }

  const resp = await callAPI("createElection", {
    title,
    description: desc,
    startDate: new Date().toISOString(),
    endDate: null
  });

  if (resp.success) {
    notify("success", "Elección creada");
    loadStats();
    loadActiveElections();
  } else {
    notify("error", resp.error || "Error creando elección");
  }
}



// =============================
//  ADMIN — BD
// =============================
async function queryDB() {
  const res = await fetch("http://localhost:3002/db/all");
  const data = await res.json();
  document.getElementById("dbQueryResult").innerText = JSON.stringify(data, null, 2);
}

async function resetDB() {
  await fetch("http://localhost:3002/db/reset");
}



// =============================
// EXPORTACIONES (CSV / XLSX)
// sincronizado Google Sheets / JSON fallback
// =============================
function exportCSV() {
  window.open("http://localhost:3002/export/csv/votes", "_blank");
}

function exportXLSX() {
  window.open("http://localhost:3002/export/xlsx/votes", "_blank");
}



// =============================
//  VERIFICACIÓN DE TRANSACCIÓN
// =============================
async function verifyTx() {
  const tx = document.getElementById("txHashInput").value.trim();

  if (!tx) {
    notify("error", "Ingrese hash");
    return;
  }

  try {
    const receipt = await provider.getTransactionReceipt(tx);
    document.getElementById("verificationResult").innerText =
      receipt ? JSON.stringify(receipt, null, 2) : "Transacción no encontrada";

  } catch (err) {
    notify("error", "Error verificando");
  }
}



// =============================
// DASHBOARD — GRÁFICOS
// =============================
let chartVoters, chartCandidates, chartParticipation, chartComparison, chartActivity;

function loadCharts(stats) {
  const ctx1 = document.getElementById("chartVoters");
  if (chartVoters) chartVoters.destroy();
  chartVoters = new Chart(ctx1, {
    type: "bar",
    data: {
      labels: ["Votantes"],
      datasets: [{ label: "Total", data: [stats.totalVoters] }]
    }
  });

  const ctx2 = document.getElementById("chartCandidates");
  if (chartCandidates) chartCandidates.destroy();
  chartCandidates = new Chart(ctx2, {
    type: "bar",
    data: {
      labels: ["Candidatos"],
      datasets: [{ label: "Total", data: [stats.totalCandidates] }]
    }
  });

  const ctx3 = document.getElementById("chartParticipation");
  if (chartParticipation) chartParticipation.destroy();
  chartParticipation = new Chart(ctx3, {
    type: "doughnut",
    data: {
      labels: ["Votos", "No Votos"],
      datasets: [{
        data: [stats.totalVotes, Math.max(stats.totalVoters - stats.totalVotes, 0)]
      }]
    }
  });
}



// =============================
// EVENTOS INICIALES
// =============================
window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("createElectionBtn").onclick = createElection;
  document.getElementById("btnQueryDB").onclick = queryDB;
  document.getElementById("btnExportCSV").onclick = exportCSV;
  document.getElementById("btnExportXLSX").onclick = exportXLSX;
  document.getElementById("verifyTxBtn").onclick = verifyTx;

  loadStats();
  loadActiveElections();
  loadResults();
});
