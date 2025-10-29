import {
  getFirestore,
  collection,
  addDoc,
  getDocs,
  updateDoc,
  doc,
  setDoc,
  query,
  orderBy
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

const STATUS_INFO = {
  PENDENTE_GESTAO: { label: "Pendente gestão", badge: "status-badge pending" },
  APROVADO: { label: "Aprovado", badge: "status-badge approved" },
  REJEITADO: { label: "Rejeitado", badge: "status-badge rejected" },
  EM_FOLHA: { label: "Em folha", badge: "status-badge payroll" },
  CANCELADO: { label: "Cancelado", badge: "status-badge cancelled" }
};

const TYPE_LABEL = {
  Bonus: "Bônus",
  Premiacao: "Premiação",
  Abono: "Abono",
  Gratificacao: "Gratificação"
};

const NATURE_LABEL = {
  Remuneratoria: "Remuneratória",
  Indenizatoria: "Indenizatória"
};

const STATUS_FLOW = ["PENDENTE_GESTAO", "APROVADO", "REJEITADO", "EM_FOLHA", "CANCELADO"];

let employeesCache = [];
let bonusesCache = [];
let managersCache = new Map();
let costCentersCache = new Set();
let viewEl = null;
let selection = new Set();

const filters = {
  competence: getCurrentCompetence(),
  status: "ALL",
  type: "ALL",
  costCenter: "",
  manager: "",
  employee: ""
};

function getCurrentCompetence() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function getProfile() {
  return window.__APP__?.profile || { role: "Colaborador" };
}

function getUser() {
  return window.__APP__?.user || null;
}

function isADM() {
  return (getProfile().role || "").toUpperCase() === "ADM";
}

function isRH() {
  return (getProfile().role || "").toUpperCase() === "RH";
}

function isGestor() {
  return (getProfile().role || "").toUpperCase() === "GESTOR";
}

function isCollaborator() {
  return !isADM() && !isRH() && !isGestor();
}

function ensureStatus(raw) {
  if (!raw) return "PENDENTE_GESTAO";
  const key = String(raw).toUpperCase();
  if (STATUS_INFO[key]) return key;
  if (key === "PENDENTE" || key === "PENDENTE_GESTAO") return "PENDENTE_GESTAO";
  if (key === "APROVADA" || key === "APROVADO") return "APROVADO";
  if (key === "REJEITADA" || key === "REJEITADO") return "REJEITADO";
  if (key === "FOLHA" || key === "EM_FOLHA") return "EM_FOLHA";
  if (key === "CANCELADA" || key === "CANCELADO") return "CANCELADO";
  return "PENDENTE_GESTAO";
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatCurrency(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "R$ 0,00";
  return num.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatDate(value) {
  if (!value) return "—";
  if (value.seconds) {
    return new Date(value.seconds * 1000).toLocaleString("pt-BR");
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("pt-BR");
}

function formatDateOnly(value) {
  if (!value) return "—";
  if (value.seconds) {
    const d = new Date(value.seconds * 1000);
    return d.toLocaleDateString("pt-BR");
  }
  const date = new Date(value.includes("T") ? value : `${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("pt-BR");
}

function normalizeCompetence(value) {
  if (!value) return "";
  const match = String(value).match(/^(\d{4})[-/](\d{2})$/);
  if (match) return `${match[1]}-${match[2]}`;
  return value;
}

function getEmployeeByUid(uid) {
  if (!uid) return null;
  return employeesCache.find((emp) => emp.uid === uid || emp.id === uid) || null;
}

function getEmployeeDisplay(bonus) {
  const base = bonus.forName || bonus.forEmail || bonus.forUid || "—";
  if (bonus.forUid) {
    const found = getEmployeeByUid(bonus.forUid);
    if (found) {
      return `${found.name || found.email || base}`;
    }
  }
  return base;
}

function getManagerDisplay(bonus) {
  if (bonus.managerName) return bonus.managerName;
  if (bonus.managerUid && managersCache.has(bonus.managerUid)) {
    return managersCache.get(bonus.managerUid);
  }
  const manager = bonus.managerUid ? getEmployeeByUid(bonus.managerUid) : null;
  if (manager) {
    return manager.name || manager.email || "—";
  }
  return bonus.manager || "—";
}

function getValueForTotals(bonus) {
  const value = Number(bonus.approvedValue ?? bonus.value ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function ensureSelectionAvailability(records) {
  selection.forEach((id) => {
    if (!records.some((item) => item.id === id && ensureStatus(item.status) === "APROVADO")) {
      selection.delete(id);
    }
  });
}

async function ensureEmployees() {
  if (employeesCache.length) return;
  const snap = await getDocs(collection(db, "employees"));
  const rows = [];
  snap.forEach((docSnap) => rows.push({ id: docSnap.id, ...docSnap.data() }));
  employeesCache = rows.map((row) => ({
    id: row.id,
    uid: row.uid || row.id,
    name: row.name || row.email || "—",
    email: row.email || "",
    costCenter: row.costCenter || row.centroCusto || "",
    managerUid: row.managerUid || row.manager || row.gestorUid || "",
    managerName: row.managerName || row.manager || row.gestor || "",
    role: row.role || "Colaborador"
  }));
  costCentersCache = new Set(
    employeesCache
      .map((emp) => emp.costCenter)
      .filter(Boolean)
  );
  managersCache = new Map();
  employeesCache.forEach((emp) => {
    if (emp.role && String(emp.role).toUpperCase() === "GESTOR") {
      managersCache.set(emp.uid, emp.name || emp.email || emp.uid);
    }
  });
}

async function ensureBonuses() {
  let snap;
  try {
    const baseQuery = query(collection(db, "bonuses"), orderBy("createdAt", "desc"));
    snap = await getDocs(baseQuery);
  } catch (err) {
    console.warn("Fallback loading bonuses without order", err);
    snap = await getDocs(collection(db, "bonuses"));
  }
  const rows = [];
  snap.forEach((docSnap) => rows.push({ id: docSnap.id, ...docSnap.data() }));
  bonusesCache = rows.map((item) => ({
    ...item,
    status: ensureStatus(item.status),
    competence: normalizeCompetence(item.competence)
  }));
  bonusesCache.forEach((item) => {
    if (item.costCenter) {
      costCentersCache.add(item.costCenter);
    }
  });
  ensureSelectionAvailability(bonusesCache);
}

function createStatusBadge(statusRaw) {
  const status = ensureStatus(statusRaw);
  const info = STATUS_INFO[status] || { label: status, badge: "status-badge" };
  return `<span class="${info.badge}">${info.label}</span>`;
}

function renderKpi(label, value) {
  return `<div class="kpi"><div class="label">${label}</div><div class="value">${value}</div></div>`;
}

function computeAdminKpis(dataset) {
  const totals = {
    total: dataset.length,
    pending: dataset.filter((item) => ensureStatus(item.status) === "PENDENTE_GESTAO").length,
    approved: dataset.filter((item) => ensureStatus(item.status) === "APROVADO").length,
    payroll: dataset.filter((item) => ensureStatus(item.status) === "EM_FOLHA").length,
    valueByType: {}
  };
  dataset.forEach((item) => {
    const key = item.type || "Bonus";
    totals.valueByType[key] = (totals.valueByType[key] || 0) + getValueForTotals(item);
  });
  return totals;
}

function renderValueByType(valueByType) {
  if (!valueByType || !Object.keys(valueByType).length) {
    return `<small class="helper">Sem lançamentos para o período.</small>`;
  }
  return Object.entries(valueByType)
    .map(
      ([type, total]) =>
        `<div class="pill-block"><div class="pill-label">${TYPE_LABEL[type] || type}</div><div class="pill-value">${formatCurrency(total)}</div></div>`
    )
    .join("\n");
}

function applyAdminFilters(records) {
  return records.filter((item) => {
    if (filters.competence && normalizeCompetence(item.competence) !== filters.competence) {
      return false;
    }
    if (filters.status !== "ALL" && ensureStatus(item.status) !== filters.status) {
      return false;
    }
    if (filters.type !== "ALL" && (item.type || "") !== filters.type) {
      return false;
    }
    if (filters.costCenter) {
      const cc = (item.costCenter || "").toLowerCase();
      if (!cc.includes(filters.costCenter.toLowerCase())) {
        return false;
      }
    }
    if (filters.manager) {
      const manager = (getManagerDisplay(item) || "").toLowerCase();
      if (!manager.includes(filters.manager.toLowerCase())) return false;
    }
    if (filters.employee) {
      const collab = (getEmployeeDisplay(item) || "").toLowerCase();
      const email = (item.forEmail || "").toLowerCase();
      const queryText = filters.employee.toLowerCase();
      if (!collab.includes(queryText) && !email.includes(queryText)) return false;
    }
    return true;
  });
}

function renderAdminFilters() {
  const costCenterOptions = Array.from(costCentersCache)
    .sort((a, b) => a.localeCompare(b))
    .map((cc) => `<option value="${escapeHtml(cc)}"></option>`) 
    .join("");
  const managerOptions = employeesCache
    .filter((emp) => String(emp.role || "").toUpperCase() === "GESTOR")
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
    .map((emp) => `<option value="${escapeHtml(emp.name || emp.email || emp.uid)}"></option>`)
    .join("");
  const employeeOptions = employeesCache
    .slice()
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
    .map((emp) => `<option value="${escapeHtml(emp.name || emp.email || emp.uid)}"></option>`)
    .join("");
  return `
    <div class="card">
      <div class="grid cols-6" data-role="filters">
        <label class="input-group">
          <span class="input-label">Competência</span>
          <input class="input" type="month" value="${filters.competence}" name="competence" />
        </label>
        <label class="input-group">
          <span class="input-label">Status</span>
          <select class="input" name="status">
            <option value="ALL" ${filters.status === "ALL" ? "selected" : ""}>Todos</option>
            ${STATUS_FLOW.map(
              (status) =>
                `<option value="${status}" ${filters.status === status ? "selected" : ""}>${
                  STATUS_INFO[status]?.label || status
                }</option>`
            ).join("")}
          </select>
        </label>
        <label class="input-group">
          <span class="input-label">Tipo</span>
          <select class="input" name="type">
            <option value="ALL" ${filters.type === "ALL" ? "selected" : ""}>Todos</option>
            ${Object.keys(TYPE_LABEL)
              .map(
                (key) =>
                  `<option value="${key}" ${filters.type === key ? "selected" : ""}>${TYPE_LABEL[key]}</option>`
              )
              .join("")}
          </select>
        </label>
        <label class="input-group">
          <span class="input-label">Centro de Custo</span>
          <input class="input" name="costCenter" list="bonus-cost-centers" value="${escapeHtml(filters.costCenter)}" placeholder="Buscar" />
          <datalist id="bonus-cost-centers">${costCenterOptions}</datalist>
        </label>
        <label class="input-group">
          <span class="input-label">Gestor</span>
          <input class="input" name="manager" list="bonus-managers" value="${escapeHtml(filters.manager)}" placeholder="Buscar" />
          <datalist id="bonus-managers">${managerOptions}</datalist>
        </label>
        <label class="input-group">
          <span class="input-label">Colaborador</span>
          <input class="input" name="employee" list="bonus-employees" value="${escapeHtml(filters.employee)}" placeholder="Buscar" />
          <datalist id="bonus-employees">${employeeOptions}</datalist>
        </label>
      </div>
    </div>
  `;
}

function renderAdminTable(records) {
  if (!records.length) {
    return `<div class="card"><p>Nenhum lançamento encontrado com os filtros selecionados.</p></div>`;
  }
  const rows = records
    .map((item) => {
      const status = ensureStatus(item.status);
      const canSelect = status === "APROVADO";
      const canEdit = status === "PENDENTE_GESTAO";
      const canCancel = status === "PENDENTE_GESTAO";
      return `
        <tr data-id="${item.id}">
          <td>${canSelect ? `<input type="checkbox" class="row-select" data-id="${item.id}" ${
            selection.has(item.id) ? "checked" : ""
          } />` : ""}</td>
          <td><strong>${escapeHtml(getEmployeeDisplay(item))}</strong><br><small class="helper">${
            escapeHtml(item.forEmail || "")
          }</small></td>
          <td>${TYPE_LABEL[item.type] || item.type || "—"}<br><small class="badge">${
            NATURE_LABEL[item.nature] || item.nature || "—"
          }</small></td>
          <td>${formatCurrency(item.value)}</td>
          <td>${escapeHtml(item.costCenter || "—")}</td>
          <td><small>${escapeHtml(item.reason || "—")}</small></td>
          <td>${escapeHtml(getManagerDisplay(item))}</td>
          <td>${createStatusBadge(status)}</td>
          <td>${formatDate(item.createdAt)}</td>
          <td class="table-actions">
            <button class="btn tiny ghost" data-action="detail" data-id="${item.id}">🔎 Detalhes</button>
            ${canEdit ? `<button class="btn tiny" data-action="edit" data-id="${item.id}">✏️ Editar</button>` : ""}
            ${canCancel ? `<button class="btn tiny danger" data-action="cancel" data-id="${item.id}">🗑️ Cancelar</button>` : ""}
            ${canSelect ? `<button class="btn tiny" data-action="send-single" data-id="${item.id}">🧾 Enviar p/ Folha</button>` : ""}
            <button class="btn tiny ghost" data-action="pdf" data-id="${item.id}">📄 PDF</button>
            <button class="btn tiny ghost" data-action="export-one" data-id="${item.id}">📤 CSV</button>
          </td>
        </tr>
      `;
    })
    .join("\n");
  return `
    <div class="card table-wrapper">
      <table class="table">
        <thead>
          <tr>
            <th></th>
            <th>Colaborador</th>
            <th>Tipo</th>
            <th>Valor</th>
            <th>Centro de Custo</th>
            <th>Motivo</th>
            <th>Gestor</th>
            <th>Status</th>
            <th>Criado em</th>
            <th>Ações</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderAdminView() {
  const competenceDataset = bonusesCache.filter(
    (item) => !filters.competence || normalizeCompetence(item.competence) === filters.competence
  );
  const kpis = computeAdminKpis(competenceDataset);
  const filtered = applyAdminFilters(bonusesCache);
  const header = `
    <div class="grid cols-3">
      ${renderKpi("Total do mês", kpis.total)}
      ${renderKpi("Aguardando aprovação", kpis.pending)}
      ${renderKpi("Aprovados", kpis.approved)}
    </div>
    <div class="grid cols-3" style="margin-top:1rem">
      ${renderKpi("Em folha", kpis.payroll)}
      <div class="card">
        <h3>Valor total por tipo</h3>
        <div class="pill-stack">${renderValueByType(kpis.valueByType)}</div>
      </div>
      <div class="card">
        <h3>Ações rápidas</h3>
        <div class="grid">
          <button class="btn" data-action="new">➕ Novo Lançamento</button>
          <button class="btn ghost" data-action="import">📥 Importar CSV</button>
          <button class="btn" data-action="send-selection" ${selection.size ? "" : "disabled"}>🧾 Enviar mês para Folha (${selection.size})</button>
          <button class="btn ghost" data-action="export">📤 Exportar CSV</button>
        </div>
      </div>
    </div>
  `;
  viewEl.innerHTML = `
    ${header}
    ${renderAdminFilters()}
    ${renderAdminTable(filtered)}
  `;
}

function renderManagerView() {
  const user = getUser();
  const uid = user?.uid || "";
  const myRecords = bonusesCache.filter((item) => item.managerUid === uid);
  const competenceDataset = myRecords.filter(
    (item) => !filters.competence || normalizeCompetence(item.competence) === filters.competence
  );
  const approvedValue = competenceDataset
    .filter((item) => ensureStatus(item.status) === "APROVADO")
    .reduce((acc, item) => acc + getValueForTotals(item), 0);
  const byType = {};
  competenceDataset
    .filter((item) => ensureStatus(item.status) === "APROVADO")
    .forEach((item) => {
      byType[item.type || "Bonus"] = (byType[item.type || "Bonus"] || 0) + getValueForTotals(item);
    });
  const pending = myRecords.filter((item) => ensureStatus(item.status) === "PENDENTE_GESTAO");
  const pendingRows = pending
    .map(
      (item) => `
      <div class="card" data-id="${item.id}">
        <div class="grid cols-2">
          <div>
            <h3>${escapeHtml(getEmployeeDisplay(item))}</h3>
            <small class="helper">${TYPE_LABEL[item.type] || item.type || "—"} • ${
        NATURE_LABEL[item.nature] || item.nature || "—"
      }</small>
            <p><strong>Valor solicitado:</strong> ${formatCurrency(item.value)}</p>
            <p><strong>Centro de Custo:</strong> ${escapeHtml(item.costCenter || "—")}</p>
            <p><strong>Competência:</strong> ${escapeHtml(item.competence || "—")}</p>
            <p><strong>Motivo:</strong> ${escapeHtml(item.reason || "—")}</p>
          </div>
          <div class="card ghost">
            <label class="input-group">
              <span class="input-label">Valor aprovado (R$)</span>
              <input class="input" type="number" step="0.01" min="0" value="${Number(item.value).toFixed(2)}" data-field="approvedValue" />
            </label>
            <label class="input-group">
              <span class="input-label">Decisão / Motivo</span>
              <textarea class="input" data-field="decision"></textarea>
            </label>
            <div class="grid cols-2">
              <button class="btn" data-action="approve" data-id="${item.id}">✅ Aprovar</button>
              <button class="btn danger" data-action="reject" data-id="${item.id}">❌ Rejeitar</button>
            </div>
          </div>
        </div>
      </div>
    `
    )
    .join("\n") || `<div class="card"><p>Sem itens pendentes do seu time.</p></div>`;
  const approvedInfo = Object.entries(byType)
    .map(
      ([type, value]) => `<div class="pill-block"><div class="pill-label">${TYPE_LABEL[type] || type}</div><div class="pill-value">${formatCurrency(value)}</div></div>`
    )
    .join("\n") || `<small class="helper">Sem aprovações na competência.</small>`;
  viewEl.innerHTML = `
    <div class="grid cols-2">
      ${renderKpi("Total aprovado no mês", formatCurrency(approvedValue))}
      <div class="card">
        <h3>Por tipo</h3>
        <div class="pill-stack">${approvedInfo}</div>
      </div>
    </div>
    <div class="card" style="margin-top:1rem">
      <div class="grid cols-2">
        <label class="input-group">
          <span class="input-label">Competência</span>
          <input class="input" type="month" value="${filters.competence}" name="competence" />
        </label>
        <button class="btn ghost" data-action="export-team">📤 Exportar CSV (time)</button>
      </div>
    </div>
    <h2>Fila de Aprovação</h2>
    ${pendingRows}
  `;
}

function renderCollaboratorView() {
  const user = getUser();
  const email = user?.email || "";
  const uid = user?.uid || "";
  const myRecords = bonusesCache
    .filter((item) => item.forUid === uid || String(item.forEmail || "").toLowerCase() === String(email).toLowerCase())
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  const rows = myRecords
    .map(
      (item) => `
        <div class="card" data-id="${item.id}">
          <h3>${TYPE_LABEL[item.type] || item.type || "—"} • ${formatCurrency(item.value)}</h3>
          <p><strong>Status:</strong> ${createStatusBadge(item.status)}</p>
          <p><strong>Competência:</strong> ${escapeHtml(item.competence || "—")}</p>
          <p><strong>Motivo:</strong> ${escapeHtml(item.reason || "—")}</p>
          <p><strong>Gestor responsável:</strong> ${escapeHtml(getManagerDisplay(item))}</p>
          ${item.approvedValue && Number(item.approvedValue) !== Number(item.value)
            ? `<p><strong>Valor aprovado:</strong> ${formatCurrency(item.approvedValue)}</p>`
            : ""}
          ${item.decisionNotes ? `<p><strong>Decisão:</strong> ${escapeHtml(item.decisionNotes)}</p>` : ""}
        </div>
      `
    )
    .join("\n") || `<div class="card"><p>Sem lançamentos registrados.</p></div>`;
  viewEl.innerHTML = `
    <div class="card">
      <h2>Meus Lançamentos</h2>
      <p class="helper">Atualizado em ${new Date().toLocaleString("pt-BR")}. Avisaremos sempre que um lançamento for aprovado ou rejeitado.</p>
    </div>
    ${rows}
  `;
}

function render() {
  if (!viewEl) return;
  if (isADM() || isRH()) {
    renderAdminView();
  } else if (isGestor()) {
    renderManagerView();
  } else {
    renderCollaboratorView();
  }
}

function bindEvents() {
  if (!viewEl || viewEl.dataset.bound) return;
  viewEl.dataset.bound = "true";
  viewEl.addEventListener("change", onViewChange, true);
  viewEl.addEventListener("click", onViewClick, true);
}

function onViewChange(event) {
  const target = event.target;
  if (target.matches("select[name='status']")) {
    filters.status = target.value;
    render();
  }
  if (target.matches("select[name='type']")) {
    filters.type = target.value;
    render();
  }
  if (target.matches("input[name='competence']")) {
    filters.competence = normalizeCompetence(target.value);
    render();
  }
  if (target.matches("input[name='costCenter']")) {
    filters.costCenter = target.value || "";
    render();
  }
  if (target.matches("input[name='manager']")) {
    filters.manager = target.value || "";
    render();
  }
  if (target.matches("input[name='employee']")) {
    filters.employee = target.value || "";
    render();
  }
  if (target.matches("input.row-select")) {
    const id = target.dataset.id;
    if (target.checked) {
      selection.add(id);
    } else {
      selection.delete(id);
    }
    render();
  }
  if (target.matches("input[data-field='approvedValue']")) {
    const card = target.closest(".card[data-id]");
    if (card) {
      card.dataset.approvedValue = target.value;
    }
  }
  if (target.matches("textarea[data-field='decision']")) {
    const card = target.closest(".card[data-id]");
    if (card) {
      card.dataset.decision = target.value;
    }
  }
}

function onViewClick(event) {
  const actionBtn = event.target.closest("[data-action]");
  if (!actionBtn) return;
  const action = actionBtn.dataset.action;
  const id = actionBtn.dataset.id;
  switch (action) {
    case "new":
      openBonusModal();
      break;
    case "edit":
      openBonusModal(findBonus(id));
      break;
    case "cancel":
      confirmCancel(id);
      break;
    case "send-single":
      sendBonusesToPayroll([id]);
      break;
    case "send-selection":
      sendBonusesToPayroll(Array.from(selection));
      break;
    case "detail":
      openDetailModal(findBonus(id));
      break;
    case "pdf":
      openPdf(findBonus(id));
      break;
    case "export":
      exportBonuses(applyAdminFilters(bonusesCache));
      break;
    case "export-one":
      exportBonuses([findBonus(id)]);
      break;
    case "import":
      openImportDialog();
      break;
    case "approve":
      handleDecision(id, true, actionBtn.closest(".card"));
      break;
    case "reject":
      handleDecision(id, false, actionBtn.closest(".card"));
      break;
    case "export-team":
      exportBonuses(
        bonusesCache.filter((item) => item.managerUid === getUser()?.uid),
        "bonuses-time"
      );
      break;
    default:
      break;
  }
}

function findBonus(id) {
  return bonusesCache.find((item) => item.id === id);
}

function openModal(renderFn) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  const card = document.createElement("div");
  card.className = "modal-card";
  const closeBtn = document.createElement("button");
  closeBtn.className = "modal-close";
  closeBtn.innerHTML = "&times;";
  closeBtn.addEventListener("click", () => closeModal(backdrop));
  card.appendChild(closeBtn);
  const content = document.createElement("div");
  content.className = "modal-content";
  card.appendChild(content);
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);
  renderFn({ backdrop, card, content, close: () => closeModal(backdrop) });
}

function closeModal(modal) {
  if (!modal) return;
  modal.classList.add("closing");
  setTimeout(() => modal.remove(), 180);
}

function getEmployeeOptions(selected) {
  return employeesCache
    .slice()
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
    .map(
      (emp) =>
        `<option value="${emp.uid}" ${selected === emp.uid ? "selected" : ""}>${escapeHtml(
          `${emp.name || emp.email} (${emp.email})`
        )}</option>`
    )
    .join("\n");
}

function getNatureOptions(selected) {
  return Object.entries(NATURE_LABEL)
    .map(
      ([key, label]) => `<option value="${key}" ${selected === key ? "selected" : ""}>${label}</option>`
    )
    .join("\n");
}

function getTypeOptions(selected) {
  return Object.entries(TYPE_LABEL)
    .map(
      ([key, label]) => `<option value="${key}" ${selected === key ? "selected" : ""}>${label}</option>`
    )
    .join("\n");
}

function getDefaults(record) {
  if (!record) {
    return {
      forUid: "",
      type: "Bonus",
      nature: "Remuneratoria",
      value: "",
      costCenter: "",
      competence: filters.competence || getCurrentCompetence(),
      reason: "",
      attachments: []
    };
  }
  return {
    forUid: record.forUid || "",
    type: record.type || "Bonus",
    nature: record.nature || "Remuneratoria",
    value: Number(record.value || 0).toFixed(2),
    costCenter: record.costCenter || "",
    competence: normalizeCompetence(record.competence) || getCurrentCompetence(),
    reason: record.reason || "",
    attachments: Array.isArray(record.attachments) ? record.attachments : []
  };
}

function openBonusModal(record) {
  if (!isADM() && !isRH()) return;
  if (record && ensureStatus(record.status) !== "PENDENTE_GESTAO") {
    alert("Somente lançamentos pendentes podem ser editados.");
    return;
  }
  const defaults = getDefaults(record);
  openModal(({ content, close }) => {
    content.innerHTML = `
      <h2>${record ? "Editar Lançamento" : "Novo Lançamento"}</h2>
      <form class="grid" data-form="bonus" data-id="${record?.id || ""}">
        <label class="input-group">
          <span class="input-label">Colaborador</span>
          <select class="input" name="forUid" required>${getEmployeeOptions(defaults.forUid)}</select>
        </label>
        <label class="input-group">
          <span class="input-label">Tipo</span>
          <select class="input" name="type" required>${getTypeOptions(defaults.type)}</select>
        </label>
        <label class="input-group">
          <span class="input-label">Natureza</span>
          <select class="input" name="nature" required>${getNatureOptions(defaults.nature)}</select>
        </label>
        <label class="input-group">
          <span class="input-label">Valor (R$)</span>
          <input class="input" name="value" type="number" step="0.01" min="0" required value="${defaults.value}" />
        </label>
        <label class="input-group">
          <span class="input-label">Centro de Custo</span>
          <input class="input" name="costCenter" required value="${escapeHtml(defaults.costCenter)}" list="bonus-cost-centers-modal" />
          <datalist id="bonus-cost-centers-modal">${Array.from(costCentersCache)
            .map((cc) => `<option value="${escapeHtml(cc)}"></option>`)
            .join("")}</datalist>
        </label>
        <label class="input-group">
          <span class="input-label">Competência</span>
          <input class="input" name="competence" type="month" required value="${defaults.competence}" />
        </label>
        <label class="input-group" style="grid-column:1 / span 2">
          <span class="input-label">Motivo / Justificativa</span>
          <textarea class="input" name="reason" minlength="10" required>${escapeHtml(defaults.reason)}</textarea>
        </label>
        <label class="input-group" style="grid-column:1 / span 2">
          <span class="input-label">Anexos (opcional)</span>
          <input class="input" type="file" name="attachments" multiple />
        </label>
        ${defaults.attachments.length
          ? `<div class="card ghost" style="grid-column:1 / span 2">
              <h4>Anexos atuais</h4>
              <ul>${defaults.attachments
                .map((att) => `<li><a href="${att.url}" target="_blank" rel="noopener">${escapeHtml(att.name || att.url)}</a></li>`)
                .join("")}</ul>
            </div>`
          : ""}
        <div class="grid cols-2" style="grid-column:1 / span 2">
          <button class="btn" type="submit">${record ? "Salvar alterações" : "Criar lançamento"}</button>
          <button class="btn ghost" type="button" data-action="close-modal">Cancelar</button>
        </div>
      </form>
    `;
    const formEl = content.querySelector("form[data-form='bonus']");
    formEl.addEventListener("submit", (ev) => {
      ev.preventDefault();
      submitBonusForm(formEl);
    });
    content.querySelector("[data-action='close-modal']").addEventListener("click", () => close());
  });
}

async function submitBonusForm(form) {
  if (!isADM() && !isRH()) return;
  const submitBtn = form.querySelector("button[type='submit']");
  submitBtn.disabled = true;
  submitBtn.textContent = "Salvando...";
  const formData = new FormData(form);
  const recordId = form.dataset.id || null;
  const forUid = formData.get("forUid");
  const employee = getEmployeeByUid(forUid);
  const managerUid = employee?.managerUid || "";
  const managerName = employee?.managerName || "";
  const payload = {
    forUid,
    forName: employee?.name || "",
    forEmail: employee?.email || "",
    managerUid,
    managerName,
    type: formData.get("type"),
    nature: formData.get("nature"),
    value: Number(formData.get("value") || 0),
    costCenter: formData.get("costCenter") || "",
    competence: normalizeCompetence(formData.get("competence")),
    reason: formData.get("reason")?.trim() || "",
    status: "PENDENTE_GESTAO",
    createdBy: getUser()?.uid || "",
    createdRole: getProfile().role || "",
    updatedAt: new Date().toISOString()
  };
  if (!payload.reason || payload.reason.length < 10) {
    alert("Motivo deve conter ao menos 10 caracteres.");
    submitBtn.disabled = false;
    submitBtn.textContent = recordId ? "Salvar alterações" : "Criar lançamento";
    return;
  }
  if (!payload.value || payload.value <= 0) {
    alert("Valor deve ser maior que zero.");
    submitBtn.disabled = false;
    submitBtn.textContent = recordId ? "Salvar alterações" : "Criar lançamento";
    return;
  }
  if (!payload.costCenter) {
    alert("Centro de custo é obrigatório.");
    submitBtn.disabled = false;
    submitBtn.textContent = recordId ? "Salvar alterações" : "Criar lançamento";
    return;
  }
  if (!payload.competence || !/\d{4}-\d{2}/.test(payload.competence)) {
    alert("Competência inválida. Use o formato AAAA-MM.");
    submitBtn.disabled = false;
    submitBtn.textContent = recordId ? "Salvar alterações" : "Criar lançamento";
    return;
  }
  const files = formData.getAll("attachments").filter((value) => value instanceof File && value.size);
  try {
    let attachments = recordId ? findBonus(recordId)?.attachments || [] : [];
    if (files.length) {
      const uploads = await Promise.all(files.map((file) => uploadAttachment(file, payload.forUid, payload.competence)));
      attachments = [...attachments, ...uploads];
    }
    payload.attachments = attachments;
    if (recordId) {
      const docRef = doc(db, "bonuses", recordId);
      await updateDoc(docRef, payload);
      await logActivity("bonus.update", { id: recordId, forUid: payload.forUid });
    } else {
      payload.createdAt = new Date().toISOString();
      payload.approvedValue = null;
      payload.decidedBy = null;
      payload.decidedAt = null;
      payload.decisionNotes = "";
      const docRef = await addDoc(collection(db, "bonuses"), payload);
      await logActivity("bonus.create", { id: docRef.id, forUid: payload.forUid });
    }
    await ensureBonuses();
    render();
    const modal = form.closest(".modal-backdrop");
    closeModal(modal);
  } catch (err) {
    console.error("Erro ao salvar lançamento", err);
    alert("Não foi possível salvar o lançamento. Tente novamente.");
    submitBtn.disabled = false;
    submitBtn.textContent = recordId ? "Salvar alterações" : "Criar lançamento";
  }
}

async function uploadAttachment(file, forUid, competence) {
  const timestamp = Date.now();
  const slug = file.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const path = `rh/bonuses/${forUid || "sem-uid"}/${competence}/${timestamp}-${slug}`;
  const storageRef = ref(storage, path);
  await uploadBytes(storageRef, file);
  const url = await getDownloadURL(storageRef);
  return { name: file.name, url };
}

async function confirmCancel(id) {
  if (!isADM() && !isRH()) return;
  const record = findBonus(id);
  if (!record || ensureStatus(record.status) !== "PENDENTE_GESTAO") {
    alert("Somente lançamentos pendentes podem ser cancelados.");
    return;
  }
  if (!confirm("Tem certeza que deseja cancelar este lançamento?")) return;
  try {
    await updateDoc(doc(db, "bonuses", id), {
      status: "CANCELADO",
      decidedBy: getUser()?.uid || null,
      decidedAt: new Date().toISOString(),
      decisionNotes: "Cancelado pelo RH/ADM"
    });
    await logActivity("bonus.cancel", { id, forUid: record.forUid });
    await ensureBonuses();
    render();
  } catch (err) {
    console.error("Erro ao cancelar", err);
    alert("Não foi possível cancelar. Tente novamente.");
  }
}

async function handleDecision(id, approve, cardEl) {
  if (!isGestor() && !isADM()) return;
  const record = findBonus(id);
  if (!record) return;
  const approvedValueInput = cardEl?.querySelector("[data-field='approvedValue']");
  const decisionInput = cardEl?.querySelector("[data-field='decision']");
  const approvedValue = Number(approvedValueInput?.value || record.value || 0);
  const decisionNotes = decisionInput?.value?.trim() || "";
  if (!decisionNotes) {
    alert("Motivo/decisão é obrigatório.");
    return;
  }
  if (approve && approvedValue > Number(record.value || 0)) {
    alert("Valor aprovado não pode ser maior que o solicitado.");
    return;
  }
  try {
    await updateDoc(doc(db, "bonuses", id), {
      status: approve ? "APROVADO" : "REJEITADO",
      approvedValue: approve ? approvedValue : null,
      decidedBy: getUser()?.uid || null,
      decidedAt: new Date().toISOString(),
      decisionNotes,
      decisionRole: getProfile().role || ""
    });
    await logActivity(approve ? "bonus.approve" : "bonus.reject", { id, forUid: record.forUid });
    await ensureBonuses();
    render();
  } catch (err) {
    console.error("Erro ao registrar decisão", err);
    alert("Não foi possível registrar decisão.");
  }
}

async function sendBonusesToPayroll(ids) {
  if (!ids || !ids.length) {
    alert("Selecione ao menos um lançamento aprovado.");
    return;
  }
  if (!isADM() && !isRH()) return;
  const records = ids
    .map((id) => findBonus(id))
    .filter((record) => record && ensureStatus(record.status) === "APROVADO");
  if (!records.length) {
    alert("Nenhum lançamento elegível (status aprovado).");
    return;
  }
  if (!confirm(`Enviar ${records.length} lançamento(s) para a folha?`)) return;
  try {
    for (const record of records) {
      const docRef = doc(db, "bonuses", record.id);
      const value = getValueForTotals(record);
      await updateDoc(docRef, {
        status: "EM_FOLHA",
        sentToPayrollAt: new Date().toISOString()
      });
      if (record.forUid && record.competence) {
        const payrollRef = doc(db, "holeriteItems", record.forUid, record.competence, record.id);
        await setDoc(payrollRef, {
          type: record.type,
          nature: record.nature,
          value,
          costCenter: record.costCenter || "",
          refBonusId: record.id,
          createdAt: new Date().toISOString()
        });
      }
    }
    selection.clear();
    await logActivity("bonus.payroll", { ids: records.map((r) => r.id), competence: filters.competence });
    await ensureBonuses();
    render();
  } catch (err) {
    console.error("Erro ao enviar para folha", err);
    alert("Não foi possível enviar para folha.");
  }
}

function exportBonuses(records, filename = "bonuses") {
  if (!records || !records.length) {
    alert("Nenhum registro para exportar.");
    return;
  }
  const headers = [
    "ID",
    "Colaborador",
    "Email",
    "Tipo",
    "Natureza",
    "Valor Solicitado",
    "Valor Aprovado",
    "Centro de Custo",
    "Competência",
    "Motivo",
    "Gestor",
    "Status",
    "Criado em",
    "Decisão",
    "Atualizado em"
  ];
  const rows = records.map((item) => [
    item.id,
    getEmployeeDisplay(item),
    item.forEmail || "",
    TYPE_LABEL[item.type] || item.type,
    NATURE_LABEL[item.nature] || item.nature,
    Number(item.value || 0),
    item.approvedValue != null ? Number(item.approvedValue) : "",
    item.costCenter || "",
    item.competence || "",
    item.reason || "",
    getManagerDisplay(item),
    ensureStatus(item.status),
    item.createdAt || "",
    item.decisionNotes || "",
    item.updatedAt || ""
  ]);
  const csv = [headers, ...rows]
    .map((row) => row.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(";"))
    .join("\n");
  downloadFile(`${filename}.csv`, `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`);
}

function downloadFile(filename, dataUrl) {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function openDetailModal(record) {
  if (!record) return;
  openModal(({ content }) => {
    content.innerHTML = `
      <h2>Detalhes do Lançamento</h2>
      <div class="grid cols-2">
        <div>
          <p><strong>Colaborador:</strong> ${escapeHtml(getEmployeeDisplay(record))}</p>
          <p><strong>E-mail:</strong> ${escapeHtml(record.forEmail || "—")}</p>
          <p><strong>Gestor:</strong> ${escapeHtml(getManagerDisplay(record))}</p>
          <p><strong>Centro de Custo:</strong> ${escapeHtml(record.costCenter || "—")}</p>
          <p><strong>Competência:</strong> ${escapeHtml(record.competence || "—")}</p>
          <p><strong>Status:</strong> ${createStatusBadge(record.status)}</p>
        </div>
        <div>
          <p><strong>Tipo:</strong> ${TYPE_LABEL[record.type] || record.type}</p>
          <p><strong>Natureza:</strong> ${NATURE_LABEL[record.nature] || record.nature}</p>
          <p><strong>Valor solicitado:</strong> ${formatCurrency(record.value)}</p>
          ${record.approvedValue != null ? `<p><strong>Valor aprovado:</strong> ${formatCurrency(record.approvedValue)}</p>` : ""}
          <p><strong>Criado em:</strong> ${formatDate(record.createdAt)}</p>
          ${record.decidedAt ? `<p><strong>Decidido em:</strong> ${formatDate(record.decidedAt)}</p>` : ""}
        </div>
      </div>
      <div class="card ghost">
        <h4>Motivo</h4>
        <p>${escapeHtml(record.reason || "—")}</p>
      </div>
      ${record.decisionNotes ? `<div class="card ghost"><h4>Decisão / Observações</h4><p>${escapeHtml(record.decisionNotes)}</p></div>` : ""}
      ${Array.isArray(record.attachments) && record.attachments.length
        ? `<div class="card ghost"><h4>Anexos</h4><ul>${record.attachments
            .map((att) => `<li><a href="${att.url}" target="_blank" rel="noopener">${escapeHtml(att.name || att.url)}</a></li>`)
            .join("")}</ul></div>`
        : ""}
    `;
  });
}

function openPdf(record) {
  if (!record) return;
  const w = window.open("", "_blank");
  if (!w) return;
  const html = `
    <html><head><title>Lançamento ${record.id}</title><style>
      body{font-family:Arial,sans-serif;padding:2rem;}
      h1{margin-bottom:1rem;}
      table{width:100%;border-collapse:collapse;}
      td,th{border:1px solid #ccc;padding:.5rem;text-align:left;}
    </style></head><body>
      <h1>Bônus / Premiação / Abono</h1>
      <p><strong>ID:</strong> ${record.id}</p>
      <table>
        <tr><th>Colaborador</th><td>${escapeHtml(getEmployeeDisplay(record))}</td></tr>
        <tr><th>E-mail</th><td>${escapeHtml(record.forEmail || "—")}</td></tr>
        <tr><th>Gestor</th><td>${escapeHtml(getManagerDisplay(record))}</td></tr>
        <tr><th>Tipo</th><td>${TYPE_LABEL[record.type] || record.type}</td></tr>
        <tr><th>Natureza</th><td>${NATURE_LABEL[record.nature] || record.nature}</td></tr>
        <tr><th>Valor solicitado</th><td>${formatCurrency(record.value)}</td></tr>
        ${record.approvedValue != null ? `<tr><th>Valor aprovado</th><td>${formatCurrency(record.approvedValue)}</td></tr>` : ""}
        <tr><th>Centro de Custo</th><td>${escapeHtml(record.costCenter || "—")}</td></tr>
        <tr><th>Competência</th><td>${escapeHtml(record.competence || "—")}</td></tr>
        <tr><th>Status</th><td>${STATUS_INFO[ensureStatus(record.status)]?.label || record.status}</td></tr>
        <tr><th>Motivo</th><td>${escapeHtml(record.reason || "—")}</td></tr>
        <tr><th>Decisão</th><td>${escapeHtml(record.decisionNotes || "—")}</td></tr>
        <tr><th>Criado em</th><td>${formatDate(record.createdAt)}</td></tr>
        <tr><th>Decidido em</th><td>${record.decidedAt ? formatDate(record.decidedAt) : "—"}</td></tr>
      </table>
    </body></html>`;
  w.document.write(html);
  w.document.close();
  w.focus();
  w.print();
}

function openImportDialog() {
  if (!isADM() && !isRH()) return;
  openModal(({ content }) => {
    content.innerHTML = `
      <h2>Importar CSV</h2>
      <p class="helper">Formato esperado: forEmail;type;nature;value;costCenter;competence;reason</p>
      <form data-form="import" class="grid">
        <input class="input" type="file" name="file" accept=".csv" required />
        <button class="btn" type="submit">Importar</button>
      </form>
    `;
    const formEl = content.querySelector("form[data-form='import']");
    formEl.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      await handleImportForm(formEl);
    });
  });
}

async function handleImportForm(form) {
  const fileInput = form.querySelector("input[type='file']");
  if (!fileInput.files.length) {
    alert("Selecione um arquivo CSV.");
    return;
  }
  const submitBtn = form.querySelector("button[type='submit']");
  submitBtn.disabled = true;
  const originalLabel = submitBtn.textContent;
  submitBtn.textContent = "Importando...";
  const file = fileInput.files[0];
  const text = await file.text();
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const user = getUser();
  const role = getProfile().role || "";
  const createdAt = new Date().toISOString();
  const toCreate = [];
  lines.forEach((line) => {
    const [forEmail, type, nature, value, costCenter, competence, reason] = line.split(";");
    if (!forEmail || !value || !costCenter || !competence || !reason) return;
    const employee = employeesCache.find((emp) => String(emp.email || "").toLowerCase() === String(forEmail).toLowerCase());
    const managerUid = employee?.managerUid || "";
    const managerName = employee?.managerName || "";
    toCreate.push({
      forUid: employee?.uid || null,
      forName: employee?.name || "",
      forEmail,
      managerUid,
      managerName,
      type: type || "Bonus",
      nature: nature || "Remuneratoria",
      value: Number(value || 0),
      costCenter,
      competence: normalizeCompetence(competence),
      reason,
      status: "PENDENTE_GESTAO",
      createdBy: user?.uid || "",
      createdRole: role,
      createdAt,
      updatedAt: createdAt,
      attachments: [],
      approvedValue: null,
      decidedAt: null,
      decidedBy: null,
      decisionNotes: ""
    });
  });
  if (!toCreate.length) {
    alert("Nenhum registro válido encontrado.");
    return;
  }
  try {
    for (const item of toCreate) {
      await addDoc(collection(db, "bonuses"), item);
    }
    await logActivity("bonus.import", { count: toCreate.length });
    await ensureBonuses();
    render();
    closeModal(form.closest(".modal-backdrop"));
  } catch (err) {
    console.error("Erro ao importar", err);
    alert("Não foi possível importar o arquivo.");
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
    return;
  }
  submitBtn.disabled = false;
  submitBtn.textContent = originalLabel;
}

export async function BonusesView() {
  viewEl = document.getElementById("view");
  if (!viewEl) return;
  viewEl.innerHTML = `<div class="card"><p>Carregando bônus e premiações...</p></div>`;
  try {
    await ensureEmployees();
    await ensureBonuses();
    bindEvents();
    render();
  } catch (err) {
    console.error("Erro ao carregar bônus", err);
    viewEl.innerHTML = `<div class="card"><p>Não foi possível carregar os lançamentos. Tente novamente.</p></div>`;
  }
}
