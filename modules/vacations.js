// Gestão completa da aba de férias seguindo o guia Casa Rosa
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-auth.js";
import {
  getFirestore,
  collection,
  addDoc,
  getDocs,
  query,
  updateDoc,
  doc,
  orderBy
} from "https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js";
import { logActivity } from "./activity.js";

const db = getFirestore();
const auth = getAuth();

const MANAGEMENT_ROLES = ["ADM", "Gestor", "RH"];
const APPROVER_ROLES = ["ADM", "Gestor"];
const CREATOR_ROLES = ["ADM", "RH"];

const STATUS_LABELS = {
  RASCUNHO_RH: "Rascunho RH",
  PENDENTE_GESTAO: "Pendente gestão",
  APROVADA: "Aprovada",
  REJEITADA: "Rejeitada",
  CANCELADA: "Cancelada"
};

const STATUS_BADGES = {
  RASCUNHO_RH: "ghost",
  PENDENTE_GESTAO: "warn",
  APROVADA: "ok",
  REJEITADA: "danger",
  CANCELADA: "ghost"
};

const SPLIT_OPTIONS = [
  { value: "30", label: "30 dias corridos" },
  { value: "20+10", label: "20 + 10 dias" },
  { value: "15+15", label: "15 + 15 dias" }
];

let employeesCache = null;
let vacationsCache = [];
let currentFilters = {
  status: "",
  manager: "",
  costCenter: "",
  search: "",
  periodStart: "",
  periodEnd: ""
};
let currentManagerScope = [];

function getProfile() {
  return window.__APP__?.profile || { role: "Colaborador" };
}

function getUser() {
  return auth.currentUser;
}

function normalizeStatus(value) {
  if (!value) return "PENDENTE_GESTAO";
  const map = {
    PENDENTE: "PENDENTE_GESTAO",
    PENDENTE_GESTAO: "PENDENTE_GESTAO",
    RASCUNHO_RH: "RASCUNHO_RH",
    DRAFT: "RASCUNHO_RH",
    APROVADA: "APROVADA",
    APROVADO: "APROVADA",
    APROVADO_GESTOR: "APROVADA",
    REJEITADA: "REJEITADA",
    REJEITADO: "REJEITADA",
    NEGADA: "REJEITADA",
    CANCELADA: "CANCELADA",
    CANCELADO: "CANCELADA"
  };
  const key = String(value).toUpperCase();
  return map[key] || "PENDENTE_GESTAO";
}

function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}

function statusBadge(status) {
  return STATUS_BADGES[status] || "ghost";
}

function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const normalized = typeof value === "string" ? value.replace(/\//g, "-") : value;
  const date = new Date(`${normalized}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function calculateDays(start, end) {
  const s = parseDate(start);
  const e = parseDate(end);
  if (!s || !e) return 0;
  const diff = Math.round((e - s) / (1000 * 60 * 60 * 24));
  return diff >= 0 ? diff + 1 : 0;
}

function normalizeVacationDoc(snap) {
  const raw = snap.data();
  const start = raw.start || raw.periodStart || raw.inicio || "";
  const end = raw.end || raw.periodEnd || raw.fim || "";
  const status = normalizeStatus(raw.status);
  const days = Number(raw.days) > 0 ? Number(raw.days) : calculateDays(start, end);
  const abono = raw.abono === true || raw.abono === "true" || raw.abono === "1";
  const forUid = raw.forUid || raw.uid || raw.employeeUid || null;
  const forEmail = raw.forEmail || raw.email || raw.employeeEmail || null;
  const forName = raw.forName || raw.employeeName || raw.name || raw.nome || null;
  const managerUid = raw.managerUid || raw.manager || raw.approverUid || null;
  const managerName = raw.managerName || raw.approverName || null;
  const costCenter = raw.costCenter || raw.cost_center || null;
  const createdAt = raw.createdAt || raw.created_at || null;
  const decidedAt = raw.decidedAt || raw.decided_at || null;
  const splitType = raw.splitType || raw.type || "30";
  return {
    id: snap.id,
    ...raw,
    start,
    end,
    status,
    days,
    abono,
    forUid,
    forEmail,
    forName,
    managerUid,
    managerName,
    costCenter,
    createdAt,
    decidedAt,
    splitType
  };
}

async function ensureEmployees() {
  if (employeesCache) return employeesCache;
  try {
    const snap = await getDocs(collection(db, "employees"));
    const rows = [];
    snap.forEach((docSnap) => rows.push({ id: docSnap.id, ...docSnap.data() }));
    employeesCache = rows;
  } catch (err) {
    console.warn("Falha ao carregar colaboradores", err);
    employeesCache = [];
  }
  return employeesCache;
}

function findEmployeeByUid(uid) {
  if (!uid || !employeesCache) return null;
  return employeesCache.find((emp) => emp.uid === uid) || null;
}

function findEmployeeByEmail(email) {
  if (!email || !employeesCache) return null;
  const norm = String(email).toLowerCase();
  return (
    employeesCache.find((emp) => String(emp.email || "").toLowerCase() === norm) || null
  );
}

function getManagerName(uid) {
  if (!uid) return "—";
  const manager = findEmployeeByUid(uid);
  if (manager?.name) return manager.name;
  const profile = getProfile();
  if (profile?.uid === uid) return profile.name || profile.email || "—";
  return "—";
}

function getVacationBalance(profile, employee) {
  const source = employee?.vacation || profile?.vacation || {};
  return {
    balanceDays: source.balanceDays ?? "—",
    takenDays: source.takenDays ?? "—",
    soldDays: source.soldDays ?? "—",
    acquisitiveStart: source.acquisitiveStart || "—",
    acquisitiveEnd: source.acquisitiveEnd || "—"
  };
}

async function fetchVacations() {
  try {
    const snap = await getDocs(query(collection(db, "vacations"), orderBy("createdAt", "desc")));
    const rows = [];
    snap.forEach((docSnap) => rows.push(normalizeVacationDoc(docSnap)));
    return rows;
  } catch (err) {
    console.warn("Falha ao ordenar férias por createdAt, usando carga simples", err);
    const snap = await getDocs(collection(db, "vacations"));
    const rows = [];
    snap.forEach((docSnap) => rows.push(normalizeVacationDoc(docSnap)));
    rows.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    return rows;
  }
}

function getScopedVacations(role, user) {
  if (!user) return [];
  if (role === "ADM" || role === "RH") return vacationsCache;
  if (role === "Gestor") {
    const teamEmails = new Set(
      (employeesCache || [])
        .filter((emp) => String(emp.managerUid || emp.manager).toLowerCase() === String(user.uid).toLowerCase())
        .map((emp) => String(emp.email || "").toLowerCase())
    );
    return vacationsCache.filter((item) => {
      const email = String(user.email || "").toLowerCase();
      if (item.forUid && item.forUid === user.uid) return true;
      if (item.forEmail && String(item.forEmail).toLowerCase() === email) return true;
      if (item.managerUid && item.managerUid === user.uid) return true;
      if (item.forEmail && teamEmails.has(String(item.forEmail).toLowerCase())) return true;
      return false;
    });
  }
  const email = String(user.email || "").toLowerCase();
  return vacationsCache.filter((item) => {
    if (item.forUid && item.forUid === user.uid) return true;
    if (item.forEmail && String(item.forEmail).toLowerCase() === email) return true;
    if (item.email && String(item.email).toLowerCase() === email) return true;
    if (item.uid && item.uid === user.uid) return true;
    return false;
  });
}

function applyFilters(items) {
  return items.filter((item) => {
    if (currentFilters.status && item.status !== currentFilters.status) return false;
    if (currentFilters.manager && String(item.managerUid || "") !== currentFilters.manager) return false;
    if (currentFilters.costCenter && String(item.costCenter || "") !== currentFilters.costCenter) return false;
    if (currentFilters.search) {
      const term = currentFilters.search.toLowerCase();
      const target = `${item.forName || ""} ${item.forEmail || ""}`.toLowerCase();
      if (!target.includes(term)) return false;
    }
    if (currentFilters.periodStart) {
      const start = parseDate(item.start);
      const from = parseDate(currentFilters.periodStart);
      if (start && from && start < from) return false;
    }
    if (currentFilters.periodEnd) {
      const end = parseDate(item.end);
      const to = parseDate(currentFilters.periodEnd);
      if (end && to && end > to) return false;
    }
    return true;
  });
}

function detectShortNotice(item) {
  if (!item.createdAt || !item.start) return false;
  const created = parseDate(item.createdAt);
  const start = parseDate(item.start);
  if (!created || !start) return false;
  const diff = Math.round((start - created) / (1000 * 60 * 60 * 24));
  return diff < 30;
}

function detectConflicts(items) {
  const conflicts = new Set();
  const grouped = new Map();
  items.forEach((item) => {
    const key = `${item.managerUid || ""}|${item.costCenter || ""}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  });
  const overlaps = (a, b) => {
    const aStart = parseDate(a.start);
    const aEnd = parseDate(a.end) || aStart;
    const bStart = parseDate(b.start);
    const bEnd = parseDate(b.end) || bStart;
    if (!aStart || !bStart) return false;
    return aStart <= bEnd && bStart <= aEnd;
  };
  grouped.forEach((list) => {
    const relevant = list.filter((item) => ["PENDENTE_GESTAO", "APROVADA"].includes(item.status));
    relevant.sort((a, b) => new Date(a.start || 0) - new Date(b.start || 0));
    for (let i = 0; i < relevant.length; i += 1) {
      for (let j = i + 1; j < relevant.length; j += 1) {
        const first = relevant[i];
        const second = relevant[j];
        if (overlaps(first, second)) {
          conflicts.add(first.id);
          conflicts.add(second.id);
        }
      }
    }
  });
  return conflicts;
}

function renderBalanceCard(balance) {
  return `
    <div class="card">
      <h2>Saldo de férias</h2>
      <div class="summary-grid">
        <div class="kpi small">
          <div class="label">Saldo disponível</div>
          <div class="value">${balance.balanceDays ?? "—"}</div>
        </div>
        <div class="kpi small">
          <div class="label">Gozados</div>
          <div class="value">${balance.takenDays ?? "—"}</div>
        </div>
        <div class="kpi small">
          <div class="label">Vendidos</div>
          <div class="value">${balance.soldDays ?? "—"}</div>
        </div>
        <div class="kpi small">
          <div class="label">Período aquisitivo</div>
          <div class="value" style="font-size:1rem">${balance.acquisitiveStart || "—"} → ${balance.acquisitiveEnd || "—"}</div>
        </div>
      </div>
      <small class="helper">Consulte o RH para ajustes de saldo.</small>
    </div>
  `;
}

function renderRequestForm(idPrefix, employeesOptions = []) {
  const options = employeesOptions
    .map((emp) => `<option value="${emp.id}">${emp.name || emp.email || emp.id}</option>`)
    .join("");
  const collaboratorSelect = employeesOptions.length
    ? `<div class="field">
        <label>Colaborador</label>
        <select name="employee" class="input" required>
          <option value="" disabled selected>Selecione</option>
          ${options}
        </select>
      </div>`
    : "";
  return `
    <div class="card">
      <h2>${employeesOptions.length ? "Cadastrar férias" : "Solicitar férias"}</h2>
      <form id="${idPrefix}-form" class="grid cols-2">
        ${collaboratorSelect}
        <div class="field">
          <label>Início</label>
          <input class="input" type="date" name="start" required>
        </div>
        <div class="field">
          <label>Término</label>
          <input class="input" type="date" name="end" required>
        </div>
        <div class="field">
          <label>Formato</label>
          <select class="input" name="splitType">
            ${SPLIT_OPTIONS.map((opt) => `<option value="${opt.value}">${opt.label}</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <label>Abono pecuniário</label>
          <select class="input" name="abono">
            <option value="nao">Não</option>
            <option value="sim">Sim (venda de 1/3)</option>
          </select>
        </div>
        <div class="field" style="grid-column:1 / -1">
          <label>Observações</label>
          <textarea class="input" name="notes" rows="3" placeholder="Observações adicionais, acordos de divisão, etc."></textarea>
        </div>
        <div class="field" style="grid-column:1 / -1;display:flex;justify-content:space-between;align-items:center">
          <small class="helper">Total previsto: <strong id="${idPrefix}-days">—</strong></small>
          <button class="btn" type="submit">${employeesOptions.length ? "Criar solicitação" : "Enviar solicitação"}</button>
        </div>
      </form>
    </div>
  `;
}

function renderGuidelinesCard() {
  return `
    <div class="card">
      <h2>Política de férias</h2>
      <ul class="list-unstyled">
        <li><strong>Aviso mínimo:</strong> solicite com 30 dias de antecedência.</li>
        <li><strong>Divisão:</strong> permitidas 3 parcelas (ex.: 20 + 10 ou 15 + 15 dias).</li>
        <li><strong>Abono:</strong> venda de até 1/3, sujeita à aprovação.</li>
        <li><strong>Fluxo:</strong> RH cadastra → Gestor aprova → Colaborador assina aviso.</li>
      </ul>
      <small class="helper">Em caso de conflitos no time, o gestor receberá um alerta.</small>
    </div>
  `;
}

function renderMyRequests(list, role) {
  if (!list.length) {
    return `
      <div class="card">
        <h2>Minhas solicitações</h2>
        <p class="helper">Você ainda não possui solicitações registradas.</p>
      </div>
    `;
  }
  return `
    <div class="card">
      <h2>Minhas solicitações</h2>
      <div class="table-scroll">
        <table class="table">
          <thead><tr><th>Período</th><th>Dias</th><th>Formato</th><th>Abono</th><th>Status</th><th>Avisos</th><th></th></tr></thead>
          <tbody>
            ${list
              .map((item) => {
                const alerts = [];
                if (detectShortNotice(item)) alerts.push("Aviso curto (<30 dias)");
                if (item.decisionNotes) alerts.push(`Obs: ${item.decisionNotes}`);
                const actions = [];
                if (item.pdfUrl) {
                  actions.push(`<a class="btn ghost" href="${item.pdfUrl}" target="_blank">📄 Aviso</a>`);
                }
                if (item.status === "PENDENTE_GESTAO") {
                  actions.push(`<button class="btn ghost" data-cancel-self="${item.id}">Cancelar</button>`);
                }
                return `<tr>
                  <td>${item.start || "—"} → ${item.end || "—"}</td>
                  <td>${item.days || "—"}</td>
                  <td>${item.splitType || "—"}</td>
                  <td>${item.abono ? "Sim" : "Não"}</td>
                  <td><span class="badge ${statusBadge(item.status)}">${statusLabel(item.status)}</span></td>
                  <td>${alerts.length ? `<small class="helper">${alerts.join(" • ")}</small>` : "—"}</td>
                  <td>${actions.join(" ") || ""}</td>
                </tr>`;
              })
              .join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderApprovalsQueue(list, role, user) {
  if (!APPROVER_ROLES.includes(role)) return "";
  const pending = list.filter((item) => item.status === "PENDENTE_GESTAO");
  const scoped = role === "ADM" ? pending : pending.filter((item) => item.managerUid === user.uid);
  return `
    <div class="card">
      <h2>Fila de aprovação</h2>
      ${scoped.length
        ? `<table class="table">
            <thead><tr><th>Colaborador</th><th>Período</th><th>Dias</th><th>Abono</th><th>Observações</th><th></th></tr></thead>
            <tbody>
              ${scoped
                .map((item) => `
                  <tr>
                    <td>${item.forName || item.forEmail || "—"}</td>
                    <td>${item.start || "—"} → ${item.end || "—"}</td>
                    <td>${item.days || "—"}</td>
                    <td>${item.abono ? "Sim" : "Não"}</td>
                    <td>${item.notes ? `<small>${item.notes}</small>` : "—"}</td>
                    <td>
                      <div class="actions">
                        <button class="btn ghost" data-approve="${item.id}">Aprovar</button>
                        <button class="btn warn" data-reject="${item.id}">Rejeitar</button>
                      </div>
                    </td>
                  </tr>`)
                .join("")}
            </tbody>
          </table>`
        : `<p class="helper">Nenhuma solicitação pendente na sua fila.</p>`}
    </div>
  `;
}

function buildFilterOptions(items) {
  const statuses = Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label }));
  const managers = new Map();
  const costCenters = new Set();
  items.forEach((item) => {
    if (item.managerUid) {
      managers.set(item.managerUid, item.managerName || getManagerName(item.managerUid));
    }
    if (item.costCenter) {
      costCenters.add(item.costCenter);
    }
  });
  return {
    statuses,
    managers: Array.from(managers.entries()).map(([value, label]) => ({ value, label })),
    costCenters: Array.from(costCenters)
  };
}

function renderManagerBoard(items, role) {
  currentManagerScope = items;
  const filtered = applyFilters(items);
  const conflicts = detectConflicts(filtered);
  const filterOptions = buildFilterOptions(items);
  const totalPending = filtered.filter((item) => item.status === "PENDENTE_GESTAO").length;
  const totalApproved = filtered.filter((item) => item.status === "APROVADA").length;
  return `
    <div class="card">
      <div class="toolbar">
        <div>
          <h2 style="margin:0">Gestão de férias</h2>
          <small class="helper">Pendentes: ${totalPending} • Aprovadas: ${totalApproved}</small>
        </div>
        <div class="toolbar-actions">
          <input class="input search" id="vac-filter-search" placeholder="Buscar por nome ou e-mail" value="${currentFilters.search}">
          <select class="input" id="vac-filter-status">
            <option value="">Status (todos)</option>
            ${filterOptions.statuses
              .map((opt) => `<option value="${opt.value}" ${currentFilters.status === opt.value ? "selected" : ""}>${opt.label}</option>`)
              .join("")}
          </select>
          <select class="input" id="vac-filter-manager">
            <option value="">Gestor (todos)</option>
            ${filterOptions.managers
              .map((opt) => `<option value="${opt.value}" ${currentFilters.manager === opt.value ? "selected" : ""}>${opt.label}</option>`)
              .join("")}
          </select>
          <select class="input" id="vac-filter-cost">
            <option value="">Centro de custo</option>
            ${Array.from(filterOptions.costCenters)
              .map((value) => `<option value="${value}" ${currentFilters.costCenter === value ? "selected" : ""}>${value}</option>`)
              .join("")}
          </select>
          <button class="btn ghost" id="vac-export">Exportar CSV</button>
        </div>
      </div>
      <div style="display:flex;gap:1rem;flex-wrap:wrap;margin-bottom:1rem">
        <label class="field" style="max-width:180px">
          <span>Início</span>
          <input type="date" class="input" id="vac-filter-start" value="${currentFilters.periodStart}">
        </label>
        <label class="field" style="max-width:180px">
          <span>Término</span>
          <input type="date" class="input" id="vac-filter-end" value="${currentFilters.periodEnd}">
        </label>
        <button class="btn ghost" id="vac-clear">Limpar filtros</button>
      </div>
      <div class="table-scroll">
        <table class="table">
          <thead><tr><th>Colaborador</th><th>Centro</th><th>Período</th><th>Dias</th><th>Formato</th><th>Abono</th><th>Status</th><th>Gestor</th><th>Alertas</th><th></th></tr></thead>
          <tbody>
            ${filtered.length
              ? filtered
                  .map((item) => {
                    const alerts = [];
                    if (conflicts.has(item.id)) alerts.push("Conflito no time");
                    if (detectShortNotice(item)) alerts.push("Aviso curto");
                    const actions = [];
                    if (item.pdfUrl) {
                      actions.push(`<a class="btn ghost" href="${item.pdfUrl}" target="_blank">📄 Aviso</a>`);
                    }
                    if (item.status === "PENDENTE_GESTAO" && APPROVER_ROLES.includes(role)) {
                      if (role === "ADM" || item.managerUid === getUser()?.uid) {
                        actions.push(`<button class="btn ghost" data-approve="${item.id}">Aprovar</button>`);
                        actions.push(`<button class="btn warn" data-reject="${item.id}">Rejeitar</button>`);
                      }
                    }
                    if (item.status === "PENDENTE_GESTAO" && (role === "ADM" || role === "RH")) {
                      actions.push(`<button class="btn ghost" data-cancel="${item.id}">Cancelar</button>`);
                    }
                    return `<tr>
                      <td>${item.forName || item.forEmail || "—"}</td>
                      <td>${item.costCenter || "—"}</td>
                      <td>${item.start || "—"} → ${item.end || "—"}</td>
                      <td>${item.days || "—"}</td>
                      <td>${item.splitType || "—"}</td>
                      <td>${item.abono ? "Sim" : "Não"}</td>
                      <td><span class="badge ${statusBadge(item.status)}">${statusLabel(item.status)}</span></td>
                      <td>${item.managerName || getManagerName(item.managerUid) || "—"}</td>
                      <td>${alerts.length ? `<small class="helper">${alerts.join(" • ")}</small>` : "—"}</td>
                      <td>${actions.join(" ")}</td>
                    </tr>`;
                  })
                  .join("")
              : `<tr><td colspan="10"><p class="helper">Nenhuma solicitação encontrada com os filtros atuais.</p></td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

async function createSelfRequest(formData) {
  const user = getUser();
  if (!user) throw new Error("É necessário estar autenticado");
  const profile = getProfile();
  const employee = findEmployeeByUid(user.uid) || findEmployeeByEmail(user.email);
  const start = formData.get("start");
  const end = formData.get("end");
  if (!start || !end) throw new Error("Informe início e término");
  const days = calculateDays(start, end);
  if (!days) throw new Error("Período inválido");
  const managerUid = employee?.managerUid || employee?.manager || profile?.managerUid || null;
  const managerName = managerUid ? getManagerName(managerUid) : null;
  const payload = {
    forUid: user.uid,
    forEmail: user.email,
    forName: employee?.name || profile?.name || user.email,
    costCenter: employee?.costCenter || profile?.costCenter || null,
    createdBy: user.uid,
    createdRole: profile?.role || "Colaborador",
    managerUid: managerUid || null,
    managerName: managerName || null,
    start,
    end,
    days,
    splitType: formData.get("splitType") || "30",
    abono: formData.get("abono") === "sim",
    notes: formData.get("notes") || "",
    status: "PENDENTE_GESTAO",
    createdAt: new Date().toISOString(),
    decisionNotes: "",
    pdfUrl: null
  };
  await addDoc(collection(db, "vacations"), payload);
  await logActivity("vacation.request", {
    email: user.email,
    start,
    end,
    managerUid: managerUid || null
  });
}

async function createManagedRequest(formData) {
  const creator = getUser();
  if (!creator) throw new Error("É necessário estar autenticado");
  const profile = getProfile();
  const employeeId = formData.get("employee");
  if (!employeeId) throw new Error("Selecione o colaborador");
  const employee = employeesCache.find((emp) => emp.id === employeeId);
  if (!employee) throw new Error("Colaborador não encontrado");
  const start = formData.get("start");
  const end = formData.get("end");
  if (!start || !end) throw new Error("Informe início e término");
  const days = calculateDays(start, end);
  if (!days) throw new Error("Período inválido");
  const managerUid = employee.managerUid || employee.manager || profile?.managerUid || null;
  const payload = {
    forUid: employee.uid || null,
    forEmail: employee.email || null,
    forName: employee.name || employee.email || employeeId,
    costCenter: employee.costCenter || null,
    managerUid: managerUid || null,
    managerName: managerUid ? getManagerName(managerUid) : null,
    createdBy: creator.uid,
    createdRole: profile?.role || "RH",
    createdAt: new Date().toISOString(),
    start,
    end,
    days,
    splitType: formData.get("splitType") || "30",
    abono: formData.get("abono") === "sim",
    notes: formData.get("notes") || "",
    status: "PENDENTE_GESTAO",
    decisionNotes: "",
    pdfUrl: null
  };
  await addDoc(collection(db, "vacations"), payload);
  await logActivity("vacation.request", {
    email: employee.email || employee.name,
    start,
    end,
    createdBy: creator.email,
    managerUid: managerUid || null
  });
}

async function changeStatus(id, status, notes = "") {
  const user = getUser();
  const profile = getProfile();
  const request = vacationsCache.find((item) => item.id === id);
  const payload = {
    status,
    decidedAt: new Date().toISOString(),
    decidedBy: user?.uid || null,
    decidedByEmail: user?.email || null,
    decidedRole: profile?.role || null
  };
  if (notes !== undefined) payload.decisionNotes = notes || "";
  if (status === "CANCELADA") {
    payload.cancelledBy = user?.uid || null;
    payload.cancelledByEmail = user?.email || null;
  }
  await updateDoc(doc(db, "vacations", id), payload);
  const activityPayload = {
    email: request?.forEmail || request?.email || null,
    start: request?.start,
    end: request?.end,
    status,
    notes
  };
  const action =
    status === "APROVADA"
      ? "vacation.approve"
      : status === "REJEITADA"
      ? "vacation.reject"
      : status === "CANCELADA"
      ? "vacation.cancel"
      : "vacation.update";
  await logActivity(action, activityPayload);
}

function exportToCsv(items) {
  if (!items.length) {
    alert("Nada para exportar");
    return;
  }
  const headers = [
    "Nome",
    "E-mail",
    "Centro de custo",
    "Início",
    "Fim",
    "Dias",
    "Formato",
    "Abono",
    "Status",
    "Gestor",
    "Decisão",
    "Decidido em"
  ];
  const rows = items.map((item) => [
    item.forName || "",
    item.forEmail || "",
    item.costCenter || "",
    item.start || "",
    item.end || "",
    item.days || "",
    item.splitType || "",
    item.abono ? "Sim" : "Não",
    statusLabel(item.status),
    item.managerName || getManagerName(item.managerUid) || "",
    item.decisionNotes || "",
    item.decidedAt || ""
  ]);
  const csv = [headers, ...rows]
    .map((line) => line.map((value) => `"${String(value || "").replace(/"/g, '""')}"`).join(";"))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ferias-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function attachFilterEvents() {
  const view = document.getElementById("view");
  const search = view.querySelector("#vac-filter-search");
  const statusSelect = view.querySelector("#vac-filter-status");
  const managerSelect = view.querySelector("#vac-filter-manager");
  const costSelect = view.querySelector("#vac-filter-cost");
  const startInput = view.querySelector("#vac-filter-start");
  const endInput = view.querySelector("#vac-filter-end");
  const clearBtn = view.querySelector("#vac-clear");
  const exportBtn = view.querySelector("#vac-export");

  if (search) {
    search.addEventListener("input", (evt) => {
      currentFilters.search = evt.target.value;
      window.VacationsView();
    });
  }
  if (statusSelect) {
    statusSelect.addEventListener("change", (evt) => {
      currentFilters.status = evt.target.value;
      window.VacationsView();
    });
  }
  if (managerSelect) {
    managerSelect.addEventListener("change", (evt) => {
      currentFilters.manager = evt.target.value;
      window.VacationsView();
    });
  }
  if (costSelect) {
    costSelect.addEventListener("change", (evt) => {
      currentFilters.costCenter = evt.target.value;
      window.VacationsView();
    });
  }
  if (startInput) {
    startInput.addEventListener("change", (evt) => {
      currentFilters.periodStart = evt.target.value;
      window.VacationsView();
    });
  }
  if (endInput) {
    endInput.addEventListener("change", (evt) => {
      currentFilters.periodEnd = evt.target.value;
      window.VacationsView();
    });
  }
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      currentFilters = {
        status: "",
        manager: "",
        costCenter: "",
        search: "",
        periodStart: "",
        periodEnd: ""
      };
      window.VacationsView();
    });
  }
  if (exportBtn) {
    exportBtn.addEventListener("click", () => {
      const base = currentManagerScope && currentManagerScope.length ? currentManagerScope : vacationsCache;
      const scoped = applyFilters(base);
      exportToCsv(scoped);
    });
  }
}

function attachDayCalculator(formId, outputId) {
  const form = document.getElementById(formId);
  const output = document.getElementById(outputId);
  if (!form || !output) return;
  const update = () => {
    const start = form.querySelector("[name=start]")?.value;
    const end = form.querySelector("[name=end]")?.value;
    if (start && end) {
      const days = calculateDays(start, end);
      output.textContent = days ? `${days} dia${days > 1 ? "s" : ""}` : "—";
    } else {
      output.textContent = "—";
    }
  };
  form.querySelectorAll("[name=start],[name=end]").forEach((input) => {
    input.addEventListener("change", update);
    input.addEventListener("input", update);
  });
  update();
}

function attachActionButtons(role, user) {
  const view = document.getElementById("view");
  view.querySelectorAll("[data-approve]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-approve");
      if (!id) return;
      const notes = prompt("Observações para o colaborador (opcional)", "");
      await changeStatus(id, "APROVADA", notes || "");
      await window.VacationsView();
    });
  });
  view.querySelectorAll("[data-reject]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-reject");
      if (!id) return;
      const notes = prompt("Motivo da reprovação", "");
      if (!notes) {
        alert("Informe o motivo para rejeitar");
        return;
      }
      await changeStatus(id, "REJEITADA", notes);
      await window.VacationsView();
    });
  });
  view.querySelectorAll("[data-cancel]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-cancel");
      if (!id) return;
      if (!confirm("Cancelar esta solicitação?")) return;
      await changeStatus(id, "CANCELADA", "Cancelado pelo RH/ADM");
      await window.VacationsView();
    });
  });
  view.querySelectorAll("[data-cancel-self]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-cancel-self");
      if (!id) return;
      if (!confirm("Confirmar cancelamento da solicitação?")) return;
      await changeStatus(id, "CANCELADA", "Cancelado pelo colaborador");
      await window.VacationsView();
    });
  });
}

function attachForms(role) {
  const selfForm = document.getElementById("vac-self-form");
  if (selfForm) {
    selfForm.addEventListener("submit", async (evt) => {
      evt.preventDefault();
      try {
        await createSelfRequest(new FormData(selfForm));
        alert("Solicitação enviada para aprovação do gestor.");
        await window.VacationsView();
      } catch (err) {
        alert(err.message || "Não foi possível enviar a solicitação.");
      }
    });
  }
  const managedForm = document.getElementById("vac-managed-form");
  if (managedForm) {
    managedForm.addEventListener("submit", async (evt) => {
      evt.preventDefault();
      try {
        await createManagedRequest(new FormData(managedForm));
        alert("Solicitação cadastrada e enviada ao gestor responsável.");
        await window.VacationsView();
      } catch (err) {
        alert(err.message || "Não foi possível cadastrar a solicitação.");
      }
    });
  }
}

window.VacationsView = async function VacationsView() {
  const user = getUser();
  const profile = getProfile();
  if (!user) {
    document.getElementById("view").innerHTML = `
      <div class="card">
        <h2>Férias</h2>
        <p>Entre na plataforma para visualizar suas férias.</p>
      </div>`;
    return;
  }

  await ensureEmployees();
  vacationsCache = await fetchVacations();

  const role = profile?.role || "Colaborador";
  const myEmployee = findEmployeeByUid(user.uid) || findEmployeeByEmail(user.email);
  const balance = getVacationBalance(profile, myEmployee);
  const scopedVacations = getScopedVacations(role, user);
  const myRequests = scopedVacations.filter((item) => {
    if (role === "ADM" || role === "RH" || role === "Gestor") {
      const email = String(user.email || "").toLowerCase();
      if (item.forUid && item.forUid === user.uid) return true;
      if (item.forEmail && String(item.forEmail).toLowerCase() === email) return true;
    }
    return item.forUid === user.uid || String(item.forEmail || "").toLowerCase() === String(user.email || "").toLowerCase();
  });

  const canCreateForOthers = CREATOR_ROLES.includes(role);
  const employeesOptions = canCreateForOthers
    ? (employeesCache || [])
        .filter((emp) => !emp.status || String(emp.status).toLowerCase() !== "inativo")
        .map((emp) => ({ id: emp.id, name: emp.name || emp.email || emp.id }))
    : [];

  const managerBoard = MANAGEMENT_ROLES.includes(role)
    ? renderManagerBoard(getScopedVacations(role === "Gestor" ? "Gestor" : "ADM", user), role)
    : "";
  const approvals = MANAGEMENT_ROLES.includes(role)
    ? renderApprovalsQueue(vacationsCache, role, user)
    : "";
  const secondaryCard = canCreateForOthers
    ? renderRequestForm("vac-managed", employeesOptions)
    : approvals || renderGuidelinesCard();

  document.getElementById("view").innerHTML = `
    <div class="grid cols-2">
      ${renderBalanceCard(balance)}
      ${renderMyRequests(myRequests, role)}
    </div>
    <div class="grid cols-2" style="margin-top:1rem">
      ${renderRequestForm("vac-self")}
      ${secondaryCard}
    </div>
    ${canCreateForOthers ? `<div class="grid cols-1" style="margin-top:1rem">${approvals}</div>` : ""}
    ${managerBoard ? `<div class="grid cols-1" style="margin-top:1rem">${managerBoard}</div>` : ""}
  `;

  attachForms(role);
  attachDayCalculator("vac-self-form", "vac-self-days");
  if (canCreateForOthers) {
    attachDayCalculator("vac-managed-form", "vac-managed-days");
  }
  attachActionButtons(role, user);
  if (managerBoard) {
    attachFilterEvents();
  }
};
