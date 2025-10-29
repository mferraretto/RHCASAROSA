// Gestão completa de recrutamento com Firestore e Storage
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  updateDoc,
  getDocs,
  query,
  where,
  arrayUnion
} from "https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js";
import {
  getStorage,
  ref,
  uploadBytes,
  getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.12.3/firebase-storage.js";
import { logActivity } from "./activity.js";

const db = getFirestore();
const storage = getStorage();

const STAGES = [
  { id: "RECEBIDOS", label: "📥 Recebidos" },
  { id: "TRIAGEM_RH", label: "📞 Triagem RH" },
  { id: "ENTREVISTA_GESTOR", label: "🧠 Entrevista Gestor" },
  { id: "APROVADO", label: "✅ Aprovado" },
  { id: "REJEITADO", label: "🚫 Rejeitado" }
];

const STORAGE_PREFIX = "rh/recrutamento";
const CSV_HEADERS = [
  "vaga",
  "candidato",
  "email",
  "telefone",
  "etapaAtual",
  "nota",
  "status",
  "gestor",
  "dataCriacao",
  "dataContratacao"
];
const DEFAULT_FILTERS = { status: "", area: "", costCenter: "", managerUid: "", type: "" };
const PERMISSIONS = {
  createJob: ["ADM", "RH"],
  editJob: ["ADM", "RH"],
  closeJob: ["ADM", "RH", "Gestor"],
  addCandidate: ["ADM", "RH", "Gestor"],
  moveCandidate: ["ADM", "RH", "Gestor"],
  assignInterviewer: ["ADM", "RH", "Gestor"],
  evaluateCandidate: ["ADM", "RH", "Gestor"],
  export: ["ADM", "RH", "Gestor"],
  viewStatus: ["ADM", "RH", "Gestor", "Colaborador"]
};

let state = {
  jobs: [],
  candidates: [],
  managerDirectory: new Map(),
  selectedJobId: null,
  filters: { ...DEFAULT_FILTERS },
  search: ""
};

function profile() {
  return window.__APP__?.profile || { role: "Colaborador" };
}

function currentUser() {
  return window.__APP__?.user || null;
}

function isManagerRole() {
  return ["ADM", "RH", "Gestor"].includes(profile().role || "");
}

function belongsToManager(job) {
  const data = profile();
  const user = currentUser();
  if (!job) return false;
  if (["ADM", "RH"].includes(data.role)) return true;
  if (data.role !== "Gestor") return false;
  const sameUid = job.managerUid && user?.uid === job.managerUid;
  const sameArea = data.area && job.area && data.area.toLowerCase() === job.area.toLowerCase();
  return Boolean(sameUid || sameArea);
}

function can(action, job = null) {
  const role = profile().role || "Colaborador";
  if (action === "viewJob") {
    if (["ADM", "RH"].includes(role)) return true;
    if (role === "Gestor") return belongsToManager(job);
    if (role === "Colaborador") return job?.status === "Aberta";
    return false;
  }
  if (action === "closeJob" && role === "Gestor") return belongsToManager(job);
  return (PERMISSIONS[action] || []).includes(role);
}

function fmtDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString("pt-BR");
}

function fmtNumber(value, fallback = "—") {
  return Number.isFinite(value) ? value.toLocaleString("pt-BR", { maximumFractionDigits: 1 }) : fallback;
}

function fmtPercent(value) {
  return Number.isFinite(value) ? `${value.toFixed(0)}%` : "—";
}

function normalize(value) {
  return (value || "").toString().trim();
}

function normalizeStage(value) {
  const key = normalize(value).toUpperCase();
  if (STAGES.some((stage) => stage.id === key)) return key;
  switch (key) {
    case "TRIAGEM":
      return "TRIAGEM_RH";
    case "ENTREVISTA":
    case "GESTOR":
      return "ENTREVISTA_GESTOR";
    case "APROVADO":
    case "APROVADA":
      return "APROVADO";
    case "REPROVADO":
    case "REJEITADA":
    case "DESCARTADO":
      return "REJEITADO";
    default:
      return "RECEBIDOS";
  }
}

function ensureArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  return [value];
}

function avgScore(list = []) {
  const values = list
    .map((item) => Number(item.score))
    .filter((value) => Number.isFinite(value));
  if (!values.length) return null;
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

function candidateActive(candidate) {
  if (candidate.status === "CONTRATADO") return false;
  return candidate.stage !== "REJEITADO";
}

function candidateStatus(candidate) {
  if (candidate.status === "CONTRATADO") return "Contratado";
  if (candidate.stage === "REJEITADO") return "Rejeitado";
  if (candidate.stage === "APROVADO") return "Aprovado";
  return "Em andamento";
}

function normalizeCandidate(jobId, id, data) {
  const evaluations = ensureArray(data.evaluations);
  const attachments = ensureArray(data.attachments);
  const history = ensureArray(data.history);
  return {
    id,
    jobId,
    name: data.name || data.nome || "Candidato",
    email: normalize(data.email || data.mail),
    phone: data.phone || data.telefone || "",
    stage: normalizeStage(data.stage || data.etapa),
    status: data.status || (data.hired ? "CONTRATADO" : ""),
    resumeUrl: data.resumeUrl || data.curriculoUrl || "",
    resumeName: data.resumeName || data.curriculoNome || "Currículo",
    source: data.source || data.origem || "",
    notes: data.notes || data.observacoes || "",
    createdAt: data.createdAt || data.dataCriacao || null,
    hiredAt: data.hiredAt || data.dataContratacao || null,
    interviewerUid: data.interviewerUid || null,
    evaluations,
    attachments,
    history,
    averageScore: avgScore(evaluations),
    updatedAt: data.updatedAt || null
  };
}

function buildSearchIndex(job, candidates) {
  const fields = [
    job.title,
    job.area,
    job.costCenter,
    job.type,
    job.managerName,
    job.location,
    job.description,
    job.publicLink
  ];
  candidates.forEach((candidate) => {
    fields.push(candidate.name, candidate.email, candidate.phone, candidate.source);
  });
  return fields
    .filter(Boolean)
    .map((value) => normalize(value).toLowerCase())
    .join(" ");
}

function applyFilters(job) {
  const filters = state.filters;
  if (filters.status && job.status !== filters.status) return false;
  if (filters.area && job.area !== filters.area) return false;
  if (filters.costCenter && job.costCenter !== filters.costCenter) return false;
  if (filters.managerUid && job.managerUid !== filters.managerUid) return false;
  if (filters.type && job.type !== filters.type) return false;
  if (state.search && !job.__search.includes(state.search.toLowerCase())) return false;
  return true;
}

function computeAverageTime(candidates, fallback) {
  const values = candidates
    .filter((candidate) => candidate.status === "CONTRATADO" && candidate.hiredAt)
    .map((candidate) => {
      const start = new Date(candidate.createdAt || fallback || candidate.hiredAt);
      const end = new Date(candidate.hiredAt);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
      return (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
    })
    .filter((value) => Number.isFinite(value));
  if (!values.length) return null;
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

function computeApprovalRate(candidates) {
  if (!candidates.length) return null;
  const hired = candidates.filter((candidate) => candidate.status === "CONTRATADO").length;
  if (!hired) return 0;
  return (hired / candidates.length) * 100;
}

async function loadManagers() {
  try {
    const snap = await getDocs(collection(db, "employees"));
    const map = new Map();
    snap.forEach((docSnap) => {
      const data = docSnap.data();
      const role = data.role || data.profile;
      if (role && ["ADM", "RH", "Gestor"].includes(role)) {
        map.set(data.uid || docSnap.id, data);
      }
    });
    state.managerDirectory = map;
  } catch (error) {
    console.error("Erro ao carregar gestores", error);
  }
}

async function loadJobs() {
  const snap = await getDocs(collection(db, "recrutamento"));
  const jobs = [];
  const includeCandidates = isManagerRole();
  const promises = [];
  snap.forEach((docSnap) => {
    const data = docSnap.data();
    const job = {
      id: docSnap.id,
      title: data.title || data.titulo || "Sem título",
      area: data.area || "",
      costCenter: data.costCenter || data.centroCusto || "",
      type: data.type || data.tipo || "",
      journey: data.journey || data.jornada || "",
      location: data.location || data.local || "",
      salaryRange: data.salaryRange || data.salario || "",
      benefits: data.benefits || data.beneficios || "",
      requirements: data.requirements || data.requisitos || "",
      desirable: data.desirable || data.desejaveis || "",
      managerUid: data.managerUid || data.gestorUid || "",
      managerName: data.managerName || data.gestorNome || data.gestor || "",
      status: data.status || "Aberta",
      description: data.description || data.descricao || "",
      publicLink: data.publicLink || data.linkPublico || "",
      createdAt: data.createdAt || data.dataCriacao || null,
      updatedAt: data.updatedAt || null,
      attachments: ensureArray(data.attachments || data.documents || []),
      contractTemplate: data.contractTemplate || null,
      technicalTest: data.technicalTest || null,
      pipeline: [],
      candidateCount: 0,
      activeCandidates: 0,
      hiredCount: 0,
      averageTime: null,
      approvalRate: null,
      __search: ""
    };
    jobs.push(job);
    if (includeCandidates) {
      promises.push(
        getDocs(collection(db, "recrutamento", job.id, "candidatos")).then((cSnap) => {
          const list = [];
          cSnap.forEach((candidateDoc) => {
            list.push(normalizeCandidate(job.id, candidateDoc.id, candidateDoc.data()));
          });
          job.pipeline = list;
          job.candidateCount = list.length;
          job.activeCandidates = list.filter(candidateActive).length;
          job.hiredCount = list.filter((candidate) => candidate.status === "CONTRATADO").length;
          job.averageTime = computeAverageTime(list, job.createdAt);
          job.approvalRate = computeApprovalRate(list);
          job.__search = buildSearchIndex(job, list);
        })
      );
    } else {
      job.__search = buildSearchIndex(job, []);
    }
  });
  await Promise.all(promises);
  state.jobs = jobs;
}

function accessibleJobs() {
  return state.jobs.filter((job) => can("viewJob", job));
}

function visibleJobs() {
  return accessibleJobs().filter(applyFilters);
}

function buildOptions(list, field) {
  const set = new Set();
  list.forEach((item) => {
    if (item[field]) set.add(item[field]);
  });
  return Array.from(set);
}

function summaryCards(jobs) {
  const cards = [];
  const open = jobs.filter((job) => job.status === "Aberta").length;
  const running = jobs.filter((job) => job.status !== "Encerrada").length;
  cards.push(`
    <div class="kpi small">
      <div class="label">📌 Vagas abertas</div>
      <div class="value">${open}</div>
    </div>
  `);
  cards.push(`
    <div class="kpi small">
      <div class="label">💼 Vagas em andamento</div>
      <div class="value">${running}</div>
    </div>
  `);
  if (isManagerRole()) {
    const active = jobs.reduce((acc, job) => acc + (job.activeCandidates || 0), 0);
    const avgTimeList = jobs
      .map((job) => job.averageTime)
      .filter((value) => Number.isFinite(value));
    const approvalList = jobs
      .map((job) => job.approvalRate)
      .filter((value) => Number.isFinite(value));
    const avgTime = avgTimeList.length
      ? avgTimeList.reduce((acc, value) => acc + value, 0) / avgTimeList.length
      : null;
    const approval = approvalList.length
      ? approvalList.reduce((acc, value) => acc + value, 0) / approvalList.length
      : null;
    cards.push(`
      <div class="kpi small">
        <div class="label">👥 Candidatos ativos</div>
        <div class="value">${active}</div>
      </div>
    `);
    cards.push(`
      <div class="kpi small">
        <div class="label">🕓 Tempo médio de contratação</div>
        <div class="value">${avgTime ? `${fmtNumber(avgTime)} dias` : "—"}</div>
      </div>
    `);
    cards.push(`
      <div class="kpi small">
        <div class="label">🧩 Taxa de aprovação</div>
        <div class="value">${fmtPercent(approval)}</div>
      </div>
    `);
  }
  return `<div class="summary-grid">${cards.join("")}</div>`;
}

function renderFilters(allJobs, filteredJobs) {
  const statusOptions = ["Aberta", "Pausada", "Encerrada"];
  const areas = buildOptions(allJobs, "area");
  const costCenters = buildOptions(allJobs, "costCenter");
  const managers = buildOptions(allJobs, "managerUid");
  const types = buildOptions(allJobs, "type");
  return `
    <div class="card toolbar-card">
      <div class="toolbar">
        <div class="toolbar-left">
          <div>
            <h2>🧲 Recrutamento</h2>
            <small class="helper">Gerencie vagas, candidatos e relatórios.</small>
          </div>
        </div>
        <div class="toolbar-actions">
          <input class="input search" id="recruitment-search" placeholder="Buscar vaga, candidato ou palavra-chave" value="${state.search || ""}">
          ${can("createJob") ? '<button class="btn" id="recruitment-create">➕ Criar vaga</button>' : ""}
        </div>
      </div>
      <div class="grid cols-5 recruitment-filters">
        <label class="field">
          <span>Status</span>
          <select class="input" id="filter-status">
            <option value="">Todas</option>
            ${statusOptions
              .map((option) => `<option value="${option}" ${state.filters.status === option ? "selected" : ""}>${option}</option>`)
              .join("")}
          </select>
        </label>
        <label class="field">
          <span>Área</span>
          <select class="input" id="filter-area">
            <option value="">Todas</option>
            ${areas.map((option) => `<option value="${option}" ${state.filters.area === option ? "selected" : ""}>${option}</option>`).join("")}
          </select>
        </label>
        <label class="field">
          <span>Centro de custo</span>
          <select class="input" id="filter-costCenter">
            <option value="">Todos</option>
            ${costCenters
              .map((option) => `<option value="${option}" ${state.filters.costCenter === option ? "selected" : ""}>${option}</option>`)
              .join("")}
          </select>
        </label>
        <label class="field">
          <span>Gestor responsável</span>
          <select class="input" id="filter-manager">
            <option value="">Todos</option>
            ${managers
              .map((option) => {
                const manager = state.managerDirectory.get(option);
                const name = manager?.name || manager?.email || option;
                return `<option value="${option}" ${state.filters.managerUid === option ? "selected" : ""}>${name}</option>`;
              })
              .join("")}
          </select>
        </label>
        <label class="field">
          <span>Tipo</span>
          <select class="input" id="filter-type">
            <option value="">Todos</option>
            ${types
              .map((option) => `<option value="${option}" ${state.filters.type === option ? "selected" : ""}>${option}</option>`)
              .join("")}
          </select>
        </label>
      </div>
      ${summaryCards(filteredJobs)}
    </div>
  `;
}

function jobRow(job) {
  const statusBadge =
    job.status === "Aberta"
      ? '<span class="badge ok">🟢 Aberta</span>'
      : job.status === "Pausada"
      ? '<span class="badge warn">🟡 Pausada</span>'
      : '<span class="badge danger">🔴 Encerrada</span>';
  const actions = [];
  if (can("viewJob", job)) actions.push(`<button class="btn ghost" data-action="open" data-id="${job.id}">👁️ Abrir</button>`);
  if (can("editJob", job)) actions.push(`<button class="btn ghost" data-action="edit" data-id="${job.id}">✏️ Editar</button>`);
  if (can("closeJob", job) && job.status !== "Encerrada")
    actions.push(`<button class="btn ghost" data-action="close" data-id="${job.id}">🔒 Encerrar</button>`);
  if (can("addCandidate", job)) actions.push(`<button class="btn ghost" data-action="addCandidate" data-id="${job.id}">➕ Candidato</button>`);
  if (can("export", job)) {
    actions.push(`<button class="btn ghost" data-action="export" data-id="${job.id}">📤 Exportar</button>`);
    actions.push(`<button class="btn ghost" data-action="report" data-id="${job.id}">🧾 Relatório</button>`);
  }
  return `
    <tr>
      <td>
        <div class="cell-main">${job.title}</div>
        <div class="cell-sub">${job.publicLink ? `<a href="${job.publicLink}" target="_blank">Link público</a>` : ""}</div>
      </td>
      <td>${job.area || "—"}</td>
      <td>${job.type || "—"}</td>
      <td>${job.costCenter || "—"}</td>
      <td>${job.managerName || job.managerUid || "—"}</td>
      <td>${statusBadge}</td>
      <td class="num">${job.candidateCount || 0}</td>
      <td><div class="actions">${actions.join("")}</div></td>
    </tr>
  `;
}

function jobsTable(jobs) {
  if (!jobs.length) {
    return `
      <div class="card">
        <h3>📋 Lista de vagas</h3>
        <p class="helper">Nenhuma vaga encontrada com os filtros atuais.</p>
      </div>
    `;
  }
  return `
    <div class="card">
      <div class="card-header">
        <h3>📋 Lista de vagas</h3>
        <small class="helper">Visão consolidada das oportunidades.</small>
      </div>
      <div class="table-scroll">
        <table class="table">
          <thead>
            <tr>
              <th>Título da vaga</th>
              <th>Área</th>
              <th>Tipo</th>
              <th>Centro de custo</th>
              <th>Gestor</th>
              <th>Status</th>
              <th>Candidatos</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            ${jobs.map(jobRow).join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function candidateCard(candidate, job) {
  const actions = [];
  if (candidate.resumeUrl) {
    actions.push(`<a class="btn ghost" href="${candidate.resumeUrl}" target="_blank">📄 Currículo</a>`);
  }
  if (can("evaluateCandidate", job)) {
    actions.push(`<button class="btn ghost" data-evaluate="${candidate.id}">📝 Avaliar</button>`);
  }
  if (can("moveCandidate", job) && candidate.stage !== "REJEITADO") {
    actions.push(`<button class="btn ghost" data-move="${candidate.id}">🔁 Mover</button>`);
  }
  if (can("assignInterviewer", job)) {
    actions.push(`<button class="btn ghost" data-assign="${candidate.id}">👥 Atribuir</button>`);
  }
  if (can("moveCandidate", job) && candidate.status !== "CONTRATADO") {
    actions.push(`<button class="btn ghost" data-hire="${candidate.id}">✅ Contratar</button>`);
  }
  return `
    <div class="candidate-card" data-candidate="${candidate.id}">
      <div>
        <strong>${candidate.name}</strong>
        <div class="candidate-meta">${candidate.email || "—"}${candidate.phone ? ` • ${candidate.phone}` : ""}</div>
      </div>
      <div class="candidate-meta">${candidate.source || "Origem não informada"}</div>
      <div class="candidate-meta">${candidate.averageScore ? `Nota média: ${fmtNumber(candidate.averageScore)}` : "Sem avaliações"}</div>
      <div class="candidate-meta">Status: ${candidateStatus(candidate)}</div>
      <div class="candidate-actions">${actions.join("")}</div>
    </div>
  `;
}

function pipeline(job, candidates) {
  return `
    <div class="pipeline">
      <div class="pipeline-header">
        <div>
          <h3>${job.title}</h3>
          <div class="helper">${job.area || ""} • ${job.type || ""} • ${job.location || ""}</div>
        </div>
        <div class="pipeline-actions">
          ${can("addCandidate", job) ? '<button class="btn" id="btn-add-candidate">➕ Adicionar candidato</button>' : ""}
          ${can("export", job) ? '<button class="btn ghost" id="btn-export-job">📤 Exportar CSV</button>' : ""}
          ${can("export", job) ? '<button class="btn ghost" id="btn-report-job">🧾 Relatório</button>' : ""}
        </div>
      </div>
      <div class="job-info">
        <div>
          <strong>Status</strong>
          <select class="input" id="job-status-select" ${can("editJob", job) || can("closeJob", job) ? "" : "disabled"}>
            <option value="Aberta" ${job.status === "Aberta" ? "selected" : ""}>Aberta</option>
            <option value="Pausada" ${job.status === "Pausada" ? "selected" : ""}>Pausada</option>
            <option value="Encerrada" ${job.status === "Encerrada" ? "selected" : ""}>Encerrada</option>
          </select>
        </div>
        <div>
          <strong>Gestor</strong>
          <div>${job.managerName || job.managerUid || "—"}</div>
        </div>
        <div>
          <strong>Faixa salarial</strong>
          <div>${job.salaryRange || "—"}</div>
        </div>
        <div>
          <strong>Benefícios</strong>
          <div>${job.benefits || "—"}</div>
        </div>
      </div>
      <hr class="split">
      <div class="kanban">
        ${STAGES.map((stage) => {
          const list = candidates.filter((candidate) => candidate.stage === stage.id);
          return `
            <div class="kanban-column" data-stage="${stage.id}">
              <h4>${stage.label}</h4>
              <div class="kanban-cards">
                ${list.length ? list.map((candidate) => candidateCard(candidate, job)).join("") : '<small class="helper">Sem candidatos</small>'}
              </div>
            </div>
          `;
        }).join("")}
      </div>
    </div>
  `;
}

function publicJob(job) {
  return `
    <div class="pipeline">
      <div class="pipeline-header">
        <div>
          <h3>${job.title}</h3>
          <div class="helper">${job.area || ""} • ${job.type || ""} • ${job.location || ""}</div>
        </div>
        ${job.publicLink ? `<a class="btn ghost" href="${job.publicLink}" target="_blank">🔗 Link público</a>` : ""}
      </div>
      <div class="public-job-grid">
        <div>
          <strong>Descrição</strong>
          <p>${job.description || "—"}</p>
        </div>
        <div>
          <strong>Requisitos</strong>
          <p>${job.requirements || "—"}</p>
        </div>
        <div>
          <strong>Desejáveis</strong>
          <p>${job.desirable || "—"}</p>
        </div>
        <div>
          <strong>Benefícios</strong>
          <p>${job.benefits || "—"}</p>
        </div>
        <div>
          <strong>Faixa salarial</strong>
          <p>${job.salaryRange || "—"}</p>
        </div>
        <div>
          <strong>Documentos</strong>
          ${renderAttachments(job.attachments)}
        </div>
      </div>
    </div>
  `;
}

function renderAttachments(list = []) {
  if (!list.length) return '<small class="helper">Nenhum documento anexado.</small>';
  return `
    <ul class="list-unstyled">
      ${list
        .map((item) => `<li><a href="${item.url}" target="_blank">📎 ${item.label || item.name || "Documento"}</a></li>`)
        .join("")}
    </ul>
  `;
}

function renderDetail(job, candidates) {
  const container = document.getElementById("recruitment-detail");
  if (!container) return;
  const role = profile().role || "Colaborador";
  if (!job) {
    container.innerHTML = `
      <div class="empty-state">
        <h3>Selecione uma vaga</h3>
        <p class="helper">Escolha uma oportunidade para visualizar os detalhes.</p>
      </div>
    `;
    return;
  }
  if (role === "Colaborador") {
    container.innerHTML = publicJob(job);
    return;
  }
  container.innerHTML = pipeline(job, candidates);
  attachDetailEvents(job);
}

function attachFilterEvents() {
  const filters = [
    { id: "filter-status", key: "status" },
    { id: "filter-area", key: "area" },
    { id: "filter-costCenter", key: "costCenter" },
    { id: "filter-manager", key: "managerUid" },
    { id: "filter-type", key: "type" }
  ];
  filters.forEach(({ id, key }) => {
    const element = document.getElementById(id);
    if (element) {
      element.onchange = () => {
        state.filters[key] = element.value;
        renderJobs();
      };
    }
  });
  const search = document.getElementById("recruitment-search");
  if (search) {
    search.oninput = (event) => {
      state.search = event.target.value;
      renderJobs();
    };
  }
  const createButton = document.getElementById("recruitment-create");
  if (createButton) {
    createButton.onclick = () => openJobForm();
  }
}

function attachTableEvents() {
  document.querySelectorAll("#recruitment-jobs [data-action]").forEach((button) => {
    const action = button.getAttribute("data-action");
    const id = button.getAttribute("data-id");
    button.onclick = async () => {
      if (action === "open") await openJobDetail(id);
      if (action === "edit") openJobForm(state.jobs.find((job) => job.id === id));
      if (action === "close") await closeJob(id);
      if (action === "addCandidate") await openCandidateForm(id);
      if (action === "export") await exportJob(id);
      if (action === "report") await openReport(id);
    };
  });
}

function attachDetailEvents(job) {
  const statusSelect = document.getElementById("job-status-select");
  if (statusSelect) {
    statusSelect.onchange = async (event) => {
      try {
        await updateDoc(doc(db, "recrutamento", job.id), {
          status: event.target.value,
          updatedAt: new Date().toISOString()
        });
        await logActivity("recruitment.job.status", { job: job.title, status: event.target.value });
        await refresh(job.id);
      } catch (error) {
        console.error(error);
        alert("Não foi possível atualizar o status da vaga.");
      }
    };
  }
  const addButton = document.getElementById("btn-add-candidate");
  if (addButton) addButton.onclick = () => openCandidateForm(job.id);
  const exportButton = document.getElementById("btn-export-job");
  if (exportButton) exportButton.onclick = () => exportJob(job.id);
  const reportButton = document.getElementById("btn-report-job");
  if (reportButton) reportButton.onclick = () => openReport(job.id);
  document.querySelectorAll("[data-evaluate]").forEach((button) => {
    const id = button.getAttribute("data-evaluate");
    button.onclick = () => {
      const candidate = state.candidates.find((item) => item.id === id);
      if (candidate) openEvaluationModal(job, candidate);
    };
  });
  document.querySelectorAll("[data-move]").forEach((button) => {
    const id = button.getAttribute("data-move");
    button.onclick = () => {
      const candidate = state.candidates.find((item) => item.id === id);
      if (candidate) openMoveCandidateModal(job, candidate);
    };
  });
  document.querySelectorAll("[data-assign]").forEach((button) => {
    const id = button.getAttribute("data-assign");
    button.onclick = () => {
      const candidate = state.candidates.find((item) => item.id === id);
      if (candidate) openAssignModal(job, candidate);
    };
  });
  document.querySelectorAll("[data-hire]").forEach((button) => {
    const id = button.getAttribute("data-hire");
    button.onclick = () => {
      const candidate = state.candidates.find((item) => item.id === id);
      if (candidate) confirmHire(job, candidate);
    };
  });
}

function renderJobs() {
  const root = document.getElementById("recruitment-root");
  if (!root) return;
  const allJobs = accessibleJobs();
  const jobs = visibleJobs();
  root.innerHTML = `
    ${renderFilters(allJobs, jobs)}
    <div id="recruitment-jobs">${jobsTable(jobs)}</div>
    <div id="recruitment-form-container" class="hidden"></div>
    <div class="card" id="recruitment-detail"></div>
  `;
  attachFilterEvents();
  attachTableEvents();
  const selected = state.jobs.find((job) => job.id === state.selectedJobId);
  if (!selected || !can("viewJob", selected)) {
    state.selectedJobId = null;
    state.candidates = [];
    renderDetail(null, []);
  } else {
    renderDetail(selected, state.candidates);
  }
}

async function refresh(preserveJobId = null) {
  await loadJobs();
  if (preserveJobId) state.selectedJobId = preserveJobId;
  renderJobs();
  if (state.selectedJobId) await openJobDetail(state.selectedJobId);
}

async function openJobDetail(id) {
  const job = state.jobs.find((item) => item.id === id);
  if (!job || !can("viewJob", job)) {
    state.selectedJobId = null;
    state.candidates = [];
    renderDetail(null, []);
    return;
  }
  state.selectedJobId = id;
  if (profile().role === "Colaborador") {
    state.candidates = [];
    renderDetail(job, []);
    return;
  }
  const snap = await getDocs(collection(db, "recrutamento", id, "candidatos"));
  const candidates = [];
  snap.forEach((docSnap) => {
    candidates.push(normalizeCandidate(id, docSnap.id, docSnap.data()));
  });
  state.candidates = candidates;
  renderDetail(job, candidates);
}

async function closeJob(id) {
  const job = state.jobs.find((item) => item.id === id);
  if (!job) return;
  if (!confirm(`Encerrar a vaga ${job.title}?`)) return;
  await updateDoc(doc(db, "recrutamento", id), {
    status: "Encerrada",
    updatedAt: new Date().toISOString()
  });
  await logActivity("recruitment.job.close", { job: job.title });
  await refresh();
}

function managerSelectOptions(selected = "") {
  const entries = Array.from(state.managerDirectory.entries());
  return entries
    .map(([uid, data]) => {
      const name = data.name || data.email || uid;
      return `<option value="${uid}" ${selected === uid ? "selected" : ""}>${name}</option>`;
    })
    .join("");
}

function jobForm(existing) {
  return `
    <div class="card">
      <div class="card-header">
        <h3>${existing ? "Editar vaga" : "Criar nova vaga"}</h3>
        <button class="btn ghost" type="button" id="job-form-cancel">Fechar</button>
      </div>
      <form id="job-form" class="grid cols-3">
        <label class="field">
          <span>Título da vaga</span>
          <input class="input" name="title" value="${existing?.title || ""}" required>
        </label>
        <label class="field">
          <span>Área</span>
          <input class="input" name="area" value="${existing?.area || ""}" required>
        </label>
        <label class="field">
          <span>Centro de custo</span>
          <input class="input" name="costCenter" value="${existing?.costCenter || ""}" required>
        </label>
        <label class="field">
          <span>Tipo de contratação</span>
          <select class="input" name="type" required>
            ${["CLT", "PJ", "Estágio", "Temporário"]
              .map((option) => `<option value="${option}" ${existing?.type === option ? "selected" : ""}>${option}</option>`)
              .join("")}
          </select>
        </label>
        <label class="field">
          <span>Jornada / Escala</span>
          <input class="input" name="journey" value="${existing?.journey || ""}" required>
        </label>
        <label class="field">
          <span>Local</span>
          <select class="input" name="location" required>
            ${["Presencial", "Híbrido", "Remoto"]
              .map((option) => `<option value="${option}" ${existing?.location === option ? "selected" : ""}>${option}</option>`)
              .join("")}
          </select>
        </label>
        <label class="field">
          <span>Salário / Faixa salarial</span>
          <input class="input" name="salaryRange" value="${existing?.salaryRange || ""}" required>
        </label>
        <label class="field">
          <span>Benefícios</span>
          <textarea class="input" name="benefits" rows="3" required>${existing?.benefits || ""}</textarea>
        </label>
        <label class="field">
          <span>Requisitos obrigatórios</span>
          <textarea class="input" name="requirements" rows="3" required>${existing?.requirements || ""}</textarea>
        </label>
        <label class="field">
          <span>Desejáveis</span>
          <textarea class="input" name="desirable" rows="3" required>${existing?.desirable || ""}</textarea>
        </label>
        <label class="field">
          <span>Responsável (gestor)</span>
          <select class="input" name="managerUid" required>
            <option value="">Selecione</option>
            ${managerSelectOptions(existing?.managerUid || "")}
          </select>
        </label>
        <label class="field">
          <span>Status</span>
          <select class="input" name="status" required>
            ${["Aberta", "Pausada", "Encerrada"]
              .map((option) => `<option value="${option}" ${existing?.status === option ? "selected" : ""}>${option}</option>`)
              .join("")}
          </select>
        </label>
        <label class="field">
          <span>Descrição da função</span>
          <textarea class="input" name="description" rows="4" required>${existing?.description || ""}</textarea>
        </label>
        <label class="field">
          <span>Link público (opcional)</span>
          <input class="input" name="publicLink" value="${existing?.publicLink || ""}">
        </label>
        <label class="field">
          <span>Modelo de contrato (PDF)</span>
          <input class="input" type="file" name="contractTemplate" accept="application/pdf">
          ${existing?.contractTemplate ? `<small class="helper"><a href="${existing.contractTemplate.url}" target="_blank">Arquivo atual</a></small>` : ""}
        </label>
        <label class="field">
          <span>Teste técnico</span>
          <input class="input" type="file" name="technicalTest" accept="application/pdf,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">
          ${existing?.technicalTest ? `<small class="helper"><a href="${existing.technicalTest.url}" target="_blank">Arquivo atual</a></small>` : ""}
        </label>
        <label class="field">
          <span>Documentos da vaga</span>
          <input class="input" type="file" name="documents" multiple>
        </label>
        <div style="grid-column:1/-1;display:flex;justify-content:flex-end;gap:.5rem">
          <button class="btn ghost" type="button" id="job-form-cancel-bottom">Cancelar</button>
          <button class="btn" type="submit">${existing ? "Salvar alterações" : "Criar vaga"}</button>
        </div>
      </form>
    </div>
  `;
}

function openJobForm(existing = null) {
  const container = document.getElementById("recruitment-form-container");
  if (!container) return;
  container.innerHTML = jobForm(existing);
  container.classList.remove("hidden");
  const close = () => {
    container.innerHTML = "";
    container.classList.add("hidden");
  };
  const cancelTop = document.getElementById("job-form-cancel");
  const cancelBottom = document.getElementById("job-form-cancel-bottom");
  if (cancelTop) cancelTop.onclick = close;
  if (cancelBottom) cancelBottom.onclick = close;
  const form = document.getElementById("job-form");
  if (!form) return;
  form.onsubmit = async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const payload = Object.fromEntries(data.entries());
    try {
      await saveJob(existing, payload, data);
      close();
      await refresh(existing?.id || null);
    } catch (error) {
      console.error(error);
      alert("Não foi possível salvar a vaga.");
    }
  };
}

async function saveJob(existing, payload, data) {
  const now = new Date().toISOString();
  const manager = state.managerDirectory.get(payload.managerUid);
  const base = {
    title: payload.title,
    area: payload.area,
    costCenter: payload.costCenter,
    type: payload.type,
    journey: payload.journey,
    location: payload.location,
    salaryRange: payload.salaryRange,
    benefits: payload.benefits,
    requirements: payload.requirements,
    desirable: payload.desirable,
    managerUid: payload.managerUid,
    managerName: manager?.name || manager?.email || payload.managerUid,
    status: payload.status,
    description: payload.description,
    publicLink: payload.publicLink || "",
    updatedAt: now
  };
  let jobId = existing?.id;
  if (existing) {
    await updateDoc(doc(db, "recrutamento", jobId), base);
  } else {
    const docRef = await addDoc(collection(db, "recrutamento"), {
      ...base,
      createdAt: now,
      published: true
    });
    jobId = docRef.id;
    await logActivity("recruitment.job.create", { job: payload.title, area: payload.area });
  }
  await handleJobUploads(jobId, data);
  if (existing) {
    await logActivity("recruitment.job.update", { job: payload.title, area: payload.area });
  }
}

async function handleJobUploads(jobId, data) {
  const uploads = [];
  const contract = data.get("contractTemplate");
  if (contract && contract.size) {
    uploads.push(
      uploadFile(`${STORAGE_PREFIX}/vagas/${jobId}/modelo-contrato-${Date.now()}.pdf`, contract).then((url) =>
        updateDoc(doc(db, "recrutamento", jobId), {
          contractTemplate: { url, name: contract.name }
        })
      )
    );
  }
  const testFile = data.get("technicalTest");
  if (testFile && testFile.size) {
    uploads.push(
      uploadFile(`${STORAGE_PREFIX}/vagas/${jobId}/teste-tecnico-${Date.now()}-${testFile.name}`, testFile).then((url) =>
        updateDoc(doc(db, "recrutamento", jobId), {
          technicalTest: { url, name: testFile.name }
        })
      )
    );
  }
  const docs = data.getAll("documents").filter((file) => file && file.size);
  if (docs.length) {
    const tasks = docs.map((file) =>
      uploadFile(`${STORAGE_PREFIX}/vagas/${jobId}/docs/${Date.now()}-${file.name}`, file).then((url) => ({
        url,
        name: file.name,
        label: file.name
      }))
    );
    uploads.push(
      Promise.all(tasks).then((files) =>
        updateDoc(doc(db, "recrutamento", jobId), {
          attachments: arrayUnion(...files)
        })
      )
    );
  }
  await Promise.all(uploads);
}

function candidateForm(job) {
  return `
    <h3>Adicionar candidato</h3>
    <p><small class="helper">${job.title} • ${job.area}</small></p>
    <form id="candidate-form" class="grid cols-2">
      <label class="field">
        <span>Nome completo</span>
        <input class="input" name="name" required>
      </label>
      <label class="field">
        <span>E-mail</span>
        <input class="input" type="email" name="email" required>
      </label>
      <label class="field">
        <span>Telefone / WhatsApp</span>
        <input class="input" name="phone">
      </label>
      <label class="field">
        <span>Origem</span>
        <input class="input" name="source" placeholder="LinkedIn / Indicação / Site / Interno">
      </label>
      <label class="field">
        <span>Currículo (PDF)</span>
        <input class="input" type="file" name="resume" accept="application/pdf">
      </label>
      <label class="field">
        <span>Documentos adicionais</span>
        <input class="input" type="file" name="docs" multiple>
      </label>
      <label class="field" style="grid-column:1/-1">
        <span>Observações iniciais</span>
        <textarea class="input" name="notes"></textarea>
      </label>
      <div style="grid-column:1/-1;display:flex;justify-content:flex-end;gap:.5rem">
        <button class="btn ghost" type="button" id="candidate-cancel">Cancelar</button>
        <button class="btn" type="submit">Salvar</button>
      </div>
    </form>
  `;
}

function showModal(content) {
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `
    <div class="modal-card">
      <button class="modal-close" type="button">×</button>
      <div class="modal-content">${content}</div>
    </div>
  `;
  document.body.appendChild(modal);
  const close = () => {
    modal.classList.add("closing");
    setTimeout(() => modal.remove(), 180);
  };
  modal.querySelector(".modal-close").onclick = close;
  modal.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });
  return { modal, close };
}

async function openCandidateForm(jobId) {
  const job = state.jobs.find((item) => item.id === jobId);
  if (!job) return;
  const { modal, close } = showModal(candidateForm(job));
  const form = modal.querySelector("#candidate-form");
  const cancel = modal.querySelector("#candidate-cancel");
  if (cancel) cancel.onclick = close;
  form.onsubmit = async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const payload = Object.fromEntries(data.entries());
    try {
      await saveCandidate(jobId, payload, data);
      close();
      await openJobDetail(jobId);
    } catch (error) {
      console.error(error);
      alert("Não foi possível adicionar o candidato.");
    }
  };
}

async function saveCandidate(jobId, payload, formData) {
  const collectionRef = collection(db, "recrutamento", jobId, "candidatos");
  const now = new Date().toISOString();
  const candidate = {
    name: payload.name,
    email: payload.email,
    phone: payload.phone || "",
    source: payload.source || "",
    notes: payload.notes || "",
    stage: "RECEBIDOS",
    status: "",
    createdAt: now,
    history: [
      {
        etapa: "Recebidos",
        by: currentUser()?.uid || "",
        data: now
      }
    ],
    evaluations: []
  };
  const docRef = await addDoc(collectionRef, candidate);
  const candidateId = docRef.id;
  const uploads = [];
  const resume = formData.get("resume");
  if (resume && resume.size) {
    uploads.push(
      uploadFile(`${STORAGE_PREFIX}/vagas/${jobId}/candidatos/${candidateId}/curriculo-${resume.name}`, resume).then((url) =>
        updateDoc(docRef, {
          resumeUrl: url,
          resumeName: resume.name
        })
      )
    );
  }
  const docs = formData.getAll("docs").filter((file) => file && file.size);
  if (docs.length) {
    const tasks = docs.map((file) =>
      uploadFile(`${STORAGE_PREFIX}/vagas/${jobId}/candidatos/${candidateId}/docs/${Date.now()}-${file.name}`, file).then((url) => ({
        url,
        name: file.name
      }))
    );
    uploads.push(
      Promise.all(tasks).then((files) =>
        updateDoc(docRef, {
          attachments: arrayUnion(...files)
        })
      )
    );
  }
  await Promise.all(uploads);
  await logActivity("recruitment.candidate.create", {
    job: state.jobs.find((job) => job.id === jobId)?.title || jobId,
    candidate: payload.name
  });
}

function evaluationForm(candidate) {
  return `
    <h3>Avaliar candidato</h3>
    <p><small class="helper">${candidate.name}</small></p>
    <form id="evaluation-form" class="grid cols-2">
      <label class="field">
        <span>Nota (1 a 5)</span>
        <input class="input" name="score" type="number" min="1" max="5" step="0.1" required>
      </label>
      <label class="field">
        <span>Etapa avaliada</span>
        <select class="input" name="stage">
          ${STAGES.map((stage) => `<option value="${stage.id}">${stage.label}</option>`).join("")}
        </select>
      </label>
      <label class="field" style="grid-column:1/-1">
        <span>Feedback</span>
        <textarea class="input" name="feedback" rows="4" required></textarea>
      </label>
      <label class="field">
        <span>Anexo (opcional)</span>
        <input class="input" type="file" name="attachment">
      </label>
      <div style="grid-column:1/-1;display:flex;justify-content:flex-end;gap:.5rem">
        <button class="btn ghost" type="button" id="evaluation-cancel">Cancelar</button>
        <button class="btn" type="submit">Salvar avaliação</button>
      </div>
    </form>
  `;
}

function openEvaluationModal(job, candidate) {
  const { modal, close } = showModal(evaluationForm(candidate));
  const form = modal.querySelector("#evaluation-form");
  const cancel = modal.querySelector("#evaluation-cancel");
  if (cancel) cancel.onclick = close;
  form.onsubmit = async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const payload = Object.fromEntries(data.entries());
    const score = Number(payload.score);
    if (Number.isNaN(score) || score < 1 || score > 5) {
      alert("Informe uma nota entre 1 e 5.");
      return;
    }
    try {
      await saveEvaluation(job.id, candidate.id, score, payload.feedback, payload.stage, data.get("attachment"));
      close();
      await openJobDetail(job.id);
    } catch (error) {
      console.error(error);
      alert("Não foi possível salvar a avaliação.");
    }
  };
}

async function saveEvaluation(jobId, candidateId, score, feedback, stage, attachment) {
  const now = new Date().toISOString();
  const entry = {
    score,
    feedback,
    stage,
    by: currentUser()?.uid || "",
    name: profile().name || currentUser()?.email || "",
    createdAt: now
  };
  if (attachment && attachment.size) {
    const url = await uploadFile(
      `${STORAGE_PREFIX}/vagas/${jobId}/candidatos/${candidateId}/avaliacoes/${Date.now()}-${attachment.name}`,
      attachment
    );
    entry.attachment = { url, name: attachment.name };
  }
  await updateDoc(doc(db, "recrutamento", jobId, "candidatos", candidateId), {
    evaluations: arrayUnion(entry),
    updatedAt: now
  });
  await logActivity("recruitment.candidate.evaluate", {
    job: state.jobs.find((job) => job.id === jobId)?.title || jobId,
    candidate: candidateId,
    stage
  });
}

function moveForm(candidate) {
  return `
    <h3>Mover candidato</h3>
    <p><small class="helper">${candidate.name}</small></p>
    <form id="move-form" class="grid">
      <label class="field">
        <span>Nova etapa</span>
        <select class="input" name="stage" required>
          ${STAGES.map((stage) => `<option value="${stage.id}" ${candidate.stage === stage.id ? "selected" : ""}>${stage.label}</option>`).join("")}
        </select>
      </label>
      <label class="field">
        <span>Observações</span>
        <textarea class="input" name="notes"></textarea>
      </label>
      <div style="display:flex;justify-content:flex-end;gap:.5rem">
        <button class="btn ghost" type="button" id="move-cancel">Cancelar</button>
        <button class="btn" type="submit">Mover</button>
      </div>
    </form>
  `;
}

function openMoveCandidateModal(job, candidate) {
  const { modal, close } = showModal(moveForm(candidate));
  const form = modal.querySelector("#move-form");
  const cancel = modal.querySelector("#move-cancel");
  if (cancel) cancel.onclick = close;
  form.onsubmit = async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    try {
      await moveCandidate(job.id, candidate.id, data.stage, data.notes);
      close();
      await openJobDetail(job.id);
    } catch (error) {
      console.error(error);
      alert("Não foi possível mover o candidato.");
    }
  };
}

async function moveCandidate(jobId, candidateId, stage, notes) {
  const entry = {
    etapa: STAGES.find((item) => item.id === stage)?.label || stage,
    by: currentUser()?.uid || "",
    data: new Date().toISOString(),
    notes: notes || ""
  };
  await updateDoc(doc(db, "recrutamento", jobId, "candidatos", candidateId), {
    stage,
    updatedAt: entry.data,
    history: arrayUnion(entry)
  });
  await logActivity("recruitment.candidate.move", {
    job: state.jobs.find((job) => job.id === jobId)?.title || jobId,
    candidate: candidateId,
    stage
  });
}

function assignForm(candidate) {
  return `
    <h3>Atribuir entrevistador</h3>
    <p><small class="helper">${candidate.name}</small></p>
    <form id="assign-form" class="grid">
      <label class="field">
        <span>Entrevistador</span>
        <select class="input" name="interviewer" required>
          ${Array.from(state.managerDirectory.entries())
            .map(([uid, data]) => `<option value="${uid}" ${candidate.interviewerUid === uid ? "selected" : ""}>${data.name || data.email || uid}</option>`)
            .join("")}
        </select>
      </label>
      <div style="display:flex;justify-content:flex-end;gap:.5rem">
        <button class="btn ghost" type="button" id="assign-cancel">Cancelar</button>
        <button class="btn" type="submit">Salvar</button>
      </div>
    </form>
  `;
}

function openAssignModal(job, candidate) {
  const { modal, close } = showModal(assignForm(candidate));
  const form = modal.querySelector("#assign-form");
  const cancel = modal.querySelector("#assign-cancel");
  if (cancel) cancel.onclick = close;
  form.onsubmit = async (event) => {
    event.preventDefault();
    const interviewerUid = form.interviewer.value;
    try {
      await updateDoc(doc(db, "recrutamento", job.id, "candidatos", candidate.id), {
        interviewerUid,
        updatedAt: new Date().toISOString()
      });
      await logActivity("recruitment.candidate.assign", {
        job: job.title,
        candidate: candidate.name,
        interviewerUid
      });
      close();
      await openJobDetail(job.id);
    } catch (error) {
      console.error(error);
      alert("Não foi possível atribuir entrevistador.");
    }
  };
}

function confirmHire(job, candidate) {
  if (!confirm(`Confirmar contratação de ${candidate.name}?`)) return;
  hireCandidate(job, candidate).catch((error) => {
    console.error(error);
    alert("Não foi possível concluir a contratação.");
  });
}

async function hireCandidate(job, candidate) {
  const now = new Date().toISOString();
  await updateDoc(doc(db, "recrutamento", job.id, "candidatos", candidate.id), {
    status: "CONTRATADO",
    hiredAt: now,
    updatedAt: now,
    history: arrayUnion({ etapa: "Contratado", by: currentUser()?.uid || "", data: now })
  });
  await ensureEmployeeRecord(candidate, job);
  await logActivity("recruitment.candidate.hire", { job: job.title, candidate: candidate.name });
  await openJobDetail(job.id);
}

async function ensureEmployeeRecord(candidate, job) {
  if (!candidate.email) return;
  const existing = await getDocs(query(collection(db, "employees"), where("email", "==", candidate.email)));
  if (!existing.empty) return;
  await addDoc(collection(db, "employees"), {
    name: candidate.name,
    email: candidate.email,
    phone: candidate.phone || "",
    role: job.title,
    area: job.area || "",
    costCenter: job.costCenter || "",
    origin: "Recrutamento",
    status: "Pré-cadastro",
    createdAt: new Date().toISOString()
  });
}

async function exportJob(jobId) {
  const job = state.jobs.find((item) => item.id === jobId);
  if (!job) return;
  const snap = await getDocs(collection(db, "recrutamento", jobId, "candidatos"));
  const rows = [];
  snap.forEach((docSnap) => {
    const data = normalizeCandidate(jobId, docSnap.id, docSnap.data());
    rows.push({
      vaga: job.title,
      candidato: data.name,
      email: data.email,
      telefone: data.phone,
      etapaAtual: STAGES.find((stage) => stage.id === data.stage)?.label || data.stage,
      nota: data.averageScore ? fmtNumber(data.averageScore) : "",
      status: candidateStatus(data),
      gestor: job.managerName || job.managerUid || "",
      dataCriacao: fmtDate(data.createdAt),
      dataContratacao: fmtDate(data.hiredAt)
    });
  });
  downloadCsv(`candidatos-${jobId}.csv`, rows);
}

function reportContent(job, candidates) {
  const stageStats = STAGES.map((stage) => {
    const list = candidates.filter((candidate) => candidate.stage === stage.id);
    return `<li>${stage.label}: <strong>${list.length}</strong></li>`;
  }).join("");
  const sources = candidates.reduce((acc, candidate) => {
    const key = candidate.source || "Não informado";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const sourceList = Object.entries(sources)
    .map(([name, value]) => `<li>${name}: <strong>${value}</strong></li>`)
    .join("");
  const hired = candidates.filter((candidate) => candidate.status === "CONTRATADO");
  const avgTime = computeAverageTime(candidates, job.createdAt);
  const approval = computeApprovalRate(candidates);
  return `
    <h3>Relatório da vaga</h3>
    <p><small class="helper">${job.title} • ${job.area || ""}</small></p>
    <div class="metrics-grid">
      <div class="card mini">
        <strong>Total de candidatos</strong>
        <span class="helper">${candidates.length}</span>
      </div>
      <div class="card mini">
        <strong>Contratados</strong>
        <span class="helper">${hired.length}</span>
      </div>
      <div class="card mini">
        <strong>Tempo médio</strong>
        <span class="helper">${avgTime ? `${fmtNumber(avgTime)} dias` : "—"}</span>
      </div>
      <div class="card mini">
        <strong>Taxa de aprovação</strong>
        <span class="helper">${fmtPercent(approval)}</span>
      </div>
    </div>
    <div class="grid cols-2">
      <div>
        <h4>Pipeline</h4>
        <ul class="list-unstyled">${stageStats}</ul>
      </div>
      <div>
        <h4>Fontes de candidatos</h4>
        <ul class="list-unstyled">${sourceList || '<li>Sem dados</li>'}</ul>
      </div>
    </div>
  `;
}

async function openReport(jobId) {
  const job = state.jobs.find((item) => item.id === jobId);
  if (!job) return;
  const snap = await getDocs(collection(db, "recrutamento", jobId, "candidatos"));
  const candidates = [];
  snap.forEach((docSnap) => candidates.push(normalizeCandidate(jobId, docSnap.id, docSnap.data())));
  showModal(reportContent(job, candidates));
}

function downloadCsv(filename, rows) {
  const csv = [CSV_HEADERS.join(",")];
  rows.forEach((row) => {
    const line = CSV_HEADERS.map((key) => {
      const value = row[key] ?? "";
      const safe = String(value).replace(/"/g, '""');
      return safe.search(/[",\n]/) >= 0 ? `"${safe}"` : safe;
    }).join(",");
    csv.push(line);
  });
  const blob = new Blob([csv.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

window.RecruitmentView = async function RecruitmentView() {
  const view = document.getElementById("view");
  if (!view) return;
  view.innerHTML = '<div class="card"><p>Carregando recrutamento...</p></div>';
  await loadManagers();
  await loadJobs();
  view.innerHTML = '<div class="grid" id="recruitment-root"></div>';
  renderJobs();
};

window.ATSView = window.RecruitmentView;

