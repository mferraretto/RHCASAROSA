import {
  getFirestore,
  collection,
  addDoc,
  getDocs,
  doc,
  updateDoc,
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

const OVERTIME_CONFIG = {
  monthlyHours: 220,
  rate50: 1.5,
  rate100: 2.0,
  nightExtra: 0.2,
  dailyLimit: 2,
  monthlyLimit: 40
};

const STATUS_INFO = {
  PENDENTE_GESTAO: { label: "Pendente gestão", badge: "status-badge pending" },
  APROVADA: { label: "Aprovada", badge: "status-badge approved" },
  REJEITADA: { label: "Rejeitada", badge: "status-badge rejected" },
  EXECUTADA: { label: "Executada", badge: "status-badge executed" },
  EM_FOLHA: { label: "Em folha", badge: "status-badge payroll" }
};

const STATUS_ORDER = [
  "PENDENTE_GESTAO",
  "APROVADA",
  "REJEITADA",
  "EXECUTADA",
  "EM_FOLHA"
];

const TYPE_LABEL = {
  extra50: "50%",
  extra100: "100%",
  night: "Noturna"
};

let employeesCache = [];
let managersCache = [];
let overtimeCache = [];
let selection = new Set();

const now = new Date();
const defaultStart = new Date(now.getFullYear(), now.getMonth(), 1)
  .toISOString()
  .slice(0, 10);
const defaultEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0)
  .toISOString()
  .slice(0, 10);

const filters = {
  start: defaultStart,
  end: defaultEnd,
  statuses: new Set(Object.keys(STATUS_INFO)),
  manager: "",
  costCenter: "",
  employee: ""
};

function getProfile() {
  return window.__APP__?.profile || { role: "Colaborador" };
}

function getUser() {
  return window.__APP__?.user || null;
}

function isAdmin() {
  return (getProfile().role || "") === "ADM";
}

function isRH() {
  return (getProfile().role || "") === "RH";
}

function isGestor() {
  return (getProfile().role || "") === "Gestor";
}

function isCollaborator() {
  return !isAdmin() && !isRH() && !isGestor();
}

function ensureStatus(value) {
  if (!value) return "PENDENTE_GESTAO";
  const key = String(value).toUpperCase();
  if (STATUS_INFO[key]) return key;
  switch (key) {
    case "PENDENTE":
    case "PENDENTE_GESTAO":
      return "PENDENTE_GESTAO";
    case "APROVADA":
    case "APROVADO":
      return "APROVADA";
    case "REJEITADA":
    case "REJEITADO":
    case "NEGADA":
      return "REJEITADA";
    case "EXECUTADA":
      return "EXECUTADA";
    case "EM_FOLHA":
    case "FOLHA":
      return "EM_FOLHA";
    default:
      return "PENDENTE_GESTAO";
  }
}

function formatCurrency(value) {
  if (!Number.isFinite(value) || value <= 0) return "—";
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatHours(value) {
  if (!Number.isFinite(value) || value <= 0) return "0h";
  const hours = Math.floor(value);
  const minutes = Math.round((value - hours) * 60);
  if (!minutes) return `${hours}h`;
  return `${hours}h${String(minutes).padStart(2, "0")}m`;
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value.includes("T") ? value : `${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("pt-BR");
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    return date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }
  if (value.includes("T")) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    }
  }
  if (value.length === 5 && value.includes(":")) return value;
  return value;
}

function getEmployeeByUid(uid, email) {
  if (!employeesCache.length) return null;
  if (uid) {
    const found = employeesCache.find((emp) => emp.uid === uid || emp.id === uid);
    if (found) return found;
  }
  if (email) {
    const lower = String(email).toLowerCase();
    return (
      employeesCache.find((emp) => String(emp.email || "").toLowerCase() === lower) || null
    );
  }
  return null;
}

function mapType(type) {
  if (!type) return [];
  if (Array.isArray(type)) return type;
  if (typeof type === "string") return type.split(",").map((t) => t.trim()).filter(Boolean);
  if (typeof type === "object") {
    return Object.entries(type)
      .filter(([, value]) => !!value)
      .map(([key]) => key);
  }
  return [];
}

function extractRecordDate(record) {
  if (record.date) return record.date;
  if (record.start) return record.start.slice(0, 10);
  return null;
}

function calculateNightHours(start, end) {
  if (!start || !end) return 0;
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return 0;

  let total = 0;
  const cursor = new Date(startDate);
  while (cursor < endDate) {
    const next = new Date(cursor.getTime() + 30 * 60000);
    const hour = cursor.getHours() + cursor.getMinutes() / 60;
    const inNight = hour >= 22 || hour < 5;
    if (inNight) {
      const segmentEnd = next > endDate ? endDate : next;
      total += (segmentEnd - cursor) / 3600000;
    }
    cursor.setTime(next.getTime());
  }
  return Number(total.toFixed(2));
}

function computeHours(record) {
  const hoursCalc = record.hoursCalc || {};
  if (hoursCalc && typeof hoursCalc.total === "number") {
    return {
      total: hoursCalc.total,
      h50: hoursCalc.h50 || 0,
      h100: hoursCalc.h100 || 0,
      hNight: hoursCalc.hNight || 0
    };
  }
  const start = record.start ? new Date(record.start) : null;
  const end = record.end ? new Date(record.end) : null;
  if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return { total: 0, h50: 0, h100: 0, hNight: 0 };
  }
  const breakMinutes = Number(record.breakMins || 0);
  let totalHours = (end - start) / 3600000 - breakMinutes / 60;
  if (totalHours < 0) totalHours = 0;
  const types = mapType(record.type);
  const has100 = types.includes("extra100");
  const has50 = types.includes("extra50") || !has100;
  const nightHours = calculateNightHours(record.start, record.end);
  return {
    total: Number(totalHours.toFixed(2)),
    h50: Number((has50 ? totalHours : 0).toFixed(2)),
    h100: Number((has100 ? totalHours : 0).toFixed(2)),
    hNight: Number(nightHours.toFixed(2))
  };
}

function computeCost(record) {
  const employee = getEmployeeByUid(record.forUid, record.forEmail);
  if (!employee || !employee.salary) return 0;
  const hours = computeHours(record);
  const baseHour = Number(employee.salary) / OVERTIME_CONFIG.monthlyHours;
  const nightExtra = hours.hNight * baseHour * OVERTIME_CONFIG.nightExtra;
  const fifty = hours.h50 * baseHour * OVERTIME_CONFIG.rate50;
  const hundred = hours.h100 * baseHour * OVERTIME_CONFIG.rate100;
  return Number((nightExtra + fifty + hundred).toFixed(2));
}

function allowedRecords() {
  const user = getUser();
  const all = overtimeCache.map((item) => ({ ...item, status: ensureStatus(item.status) }));
  if (isAdmin() || isRH()) return all;
  if (isGestor()) {
    return all.filter((item) => item.managerUid === user?.uid);
  }
  if (!user) return [];
  const email = String(user.email || "").toLowerCase();
  return all.filter(
    (item) => item.forUid === user.uid || String(item.forEmail || "").toLowerCase() === email
  );
}

function applyFilters(records) {
  return records.filter((record) => {
    const statusAllowed = !filters.statuses.size || filters.statuses.has(ensureStatus(record.status));
    if (!statusAllowed) return false;
    const recordDateValue = extractRecordDate(record);
    if (filters.start && recordDateValue && recordDateValue < filters.start) return false;
    if (filters.end && recordDateValue && recordDateValue > filters.end) return false;
    if (filters.manager && record.managerUid !== filters.manager) return false;
    if (filters.costCenter && (record.costCenter || "") !== filters.costCenter) return false;
    if (filters.employee) {
      const normalized = String(filters.employee).toLowerCase();
      const employee = getEmployeeByUid(record.forUid, record.forEmail);
      const identifier = employee
        ? `${employee.name || ""} ${employee.email || ""}`.toLowerCase()
        : `${record.forEmail || ""}`.toLowerCase();
      if (!identifier.includes(normalized)) return false;
    }
    return true;
  });
}
function getCostCenters() {
  const centers = new Set();
  employeesCache.forEach((emp) => {
    if (emp.costCenter) centers.add(emp.costCenter);
  });
  overtimeCache.forEach((item) => {
    if (item.costCenter) centers.add(item.costCenter);
  });
  return Array.from(centers).sort();
}

function getManagers() {
  if (managersCache.length) return managersCache;
  const managers = employeesCache.filter((emp) => {
    const role = String(emp.role || "").toUpperCase();
    return role === "GESTOR" || role === "ADM";
  });
  managersCache = managers.map((manager) => ({
    uid: manager.uid || manager.id,
    name: manager.name || manager.email || "—",
    email: manager.email || ""
  }));
  return managersCache;
}

function buildKpis(filteredRecords, accessibleRecords) {
  const pending = accessibleRecords.filter((r) => ensureStatus(r.status) === "PENDENTE_GESTAO").length;
  const approved = filteredRecords.filter((r) =>
    ["APROVADA", "EXECUTADA", "EM_FOLHA"].includes(ensureStatus(r.status))
  );
  const hours = approved.reduce((sum, r) => sum + computeHours(r).total, 0);
  const cost = approved.reduce((sum, r) => sum + computeCost(r), 0);
  return {
    pending,
    hours: Number(hours.toFixed(2)),
    cost: Number(cost.toFixed(2))
  };
}

function buildTopLists(records) {
  const byEmployee = new Map();
  const byCostCenter = new Map();
  records.forEach((record) => {
    const hours = computeHours(record).total;
    if (!hours) return;
    const employee = getEmployeeByUid(record.forUid, record.forEmail);
    const employeeName = employee?.name || record.forEmail || "—";
    byEmployee.set(employeeName, (byEmployee.get(employeeName) || 0) + hours);
    const center = record.costCenter || employee?.costCenter || "—";
    byCostCenter.set(center, (byCostCenter.get(center) || 0) + hours);
  });
  const topEmployees = Array.from(byEmployee.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  const topCenters = Array.from(byCostCenter.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  return { topEmployees, topCenters };
}

function renderStatus(status) {
  const normalized = ensureStatus(status);
  const meta = STATUS_INFO[normalized] || { label: normalized, badge: "status-badge" };
  return `<span class="${meta.badge}">${meta.label}</span>`;
}

function renderTypes(record) {
  const types = mapType(record.type);
  if (!types.length) return "—";
  return types
    .map((type) => `<span class="pill badge-type">${TYPE_LABEL[type] || type}</span>`)
    .join(" ");
}

function renderFiltersSection() {
  const managers = getManagers();
  const centers = getCostCenters();
  const showManagerFilter = isAdmin() || isRH();
  const managerOptions = managers
    .map(
      (manager) =>
        `<option value="${manager.uid}" ${filters.manager === manager.uid ? "selected" : ""}>${manager.name}</option>`
    )
    .join("");
  const centerOptions = centers
    .map(
      (center) =>
        `<option value="${center}" ${filters.costCenter === center ? "selected" : ""}>${center}</option>`
    )
    .join("");
  const statusOptions = Object.entries(STATUS_INFO)
    .map(
      ([key, info]) => `
      <label class="status-filter">
        <input type="checkbox" data-action="filter-status" value="${key}" ${
          filters.statuses.has(key) ? "checked" : ""
        }>
        <span>${info.label}</span>
      </label>`
    )
    .join("");
  return `
    <div class="card">
      <div class="card-header">
        <div>
          <h2>🕒 Hora Extra</h2>
          <p class="helper">Solicitações, aprovações e execução em um único fluxo.</p>
        </div>
      </div>
      <div class="filters-grid">
        <div class="field">
          <label>Início</label>
          <input class="input" type="date" data-action="filter-start" value="${filters.start}">
        </div>
        <div class="field">
          <label>Fim</label>
          <input class="input" type="date" data-action="filter-end" value="${filters.end}">
        </div>
        ${
          showManagerFilter
            ? `<div class="field">
                <label>Gestor</label>
                <select class="input" data-action="filter-manager">
                  <option value="">Todos</option>
                  ${managerOptions}
                </select>
              </div>`
            : ""
        }
        <div class="field">
          <label>Centro de Custo</label>
          <select class="input" data-action="filter-cost-center">
            <option value="">Todos</option>
            ${centerOptions}
          </select>
        </div>
        <div class="field">
          <label>Colaborador</label>
          <input class="input" type="search" placeholder="Buscar por nome ou e-mail" data-action="filter-employee" value="${
            filters.employee
          }">
        </div>
      </div>
      <div class="status-grid">${statusOptions}</div>
    </div>
  `;
}

function renderKpis(kpis) {
  const items = [
    `<div class="kpi"><div class="label">Pedidos pendentes</div><div class="value">${kpis.pending}</div></div>`,
    `<div class="kpi"><div class="label">Horas aprovadas</div><div class="value">${kpis.hours.toFixed(
      2
    )}h</div></div>`
  ];
  if (!isCollaborator()) {
    items.push(
      `<div class="kpi"><div class="label">Custo estimado</div><div class="value">${formatCurrency(kpis.cost)}</div></div>`
    );
  }
  return `<div class="metrics-grid">${items.join("")}</div>`;
}

function renderTopListsSection(top) {
  if (isCollaborator()) return "";
  const employees = top.topEmployees
    .map(
      ([name, hours]) => `
        <li><strong>${name}</strong><br><small class="helper">${formatHours(hours)}</small></li>
      `
    )
    .join("") || "<li>Sem registros no período.</li>";
  const centers = top.topCenters
    .map(
      ([name, hours]) => `
        <li><strong>${name}</strong><br><small class="helper">${formatHours(hours)}</small></li>
      `
    )
    .join("") || "<li>Sem registros no período.</li>";
  return `
    <div class="grid cols-2">
      <div class="card">
        <h3>Top 5 colaboradores</h3>
        <ul class="list-unstyled">${employees}</ul>
      </div>
      <div class="card">
        <h3>Top Centros de Custo</h3>
        <ul class="list-unstyled">${centers}</ul>
      </div>
    </div>
  `;
}
function renderToolbar(filteredRecords) {
  const totalSelected = selection.size;
  const selectedInfo = totalSelected
    ? `<div class="selection-info"><strong>${totalSelected}</strong> selecionado(s)</div>`
    : "";
  const hasPendingSelected = filteredRecords.some(
    (record) => selection.has(record.id) && ensureStatus(record.status) === "PENDENTE_GESTAO"
  );
  const hasApprovedSelected = filteredRecords.some(
    (record) => selection.has(record.id) && ensureStatus(record.status) === "APROVADA"
  );
  const hasExecutedSelected = filteredRecords.some(
    (record) => selection.has(record.id) && ensureStatus(record.status) === "EXECUTADA"
  );
  const buttons = [];
  if (isAdmin() || isRH()) {
    buttons.push(
      `<button class="btn" data-action="new-request">➕ Nova solicitação</button>`,
      `<button class="btn secondary" data-action="import-csv">📥 Importar CSV (lote)</button>`,
      `<button class="btn secondary" data-action="export">📤 Exportar</button>`,
      `<button class="btn ghost" data-action="send-payroll">🧾 Enviar mês para Folha</button>`
    );
    if (totalSelected && hasPendingSelected) {
      buttons.push(`<button class="btn" data-action="mass-approve">✅ Aprovar em massa</button>`);
    }
    if (totalSelected && (hasPendingSelected || hasApprovedSelected)) {
      buttons.push(`<button class="btn secondary" data-action="mass-adjust">✂️ Ajustar em massa</button>`);
    }
    if (totalSelected && hasExecutedSelected) {
      buttons.push(`<button class="btn ghost" data-action="mass-payroll">🧾 Enviar selecionados</button>`);
    }
  } else if (isGestor()) {
    buttons.push(
      `<button class="btn" data-action="mass-approve">✅ Aprovar em massa</button>`,
      `<button class="btn secondary" data-action="mass-adjust">✂️ Ajustar em massa</button>`,
      `<button class="btn secondary" data-action="export">📤 Exportar (meu time)</button>`
    );
  } else {
    buttons.push(`<button class="btn ghost" data-action="scroll-summary">🔎 Minhas horas</button>`);
  }
  return `
    <div class="card toolbar-card">
      <div class="toolbar">
        <div class="toolbar-left">${selectedInfo}</div>
        <div class="toolbar-actions">${buttons.join(" ")}</div>
      </div>
    </div>
  `;
}

function buildRowActions(record) {
  const status = ensureStatus(record.status);
  const actions = [];
  const user = getUser();
  const managerMatch = user && record.managerUid === user.uid;
  const owner = user && (record.forUid === user.uid || record.forEmail === user.email);
  if ((isAdmin() || isRH()) && status === "PENDENTE_GESTAO") {
    actions.push({ icon: "✏️", label: "Editar", action: "edit" });
  }
  if ((isAdmin() || managerMatch) && status === "PENDENTE_GESTAO") {
    actions.push({ icon: "✅", label: "Aprovar", action: "approve" });
    actions.push({ icon: "❌", label: "Rejeitar", action: "reject" });
    actions.push({ icon: "✂️", label: "Ajustar", action: "adjust" });
  }
  if ((isAdmin() || isRH() || managerMatch) && status === "APROVADA") {
    actions.push({ icon: "✔️", label: "Executada", action: "execute" });
  }
  if ((isAdmin() || isRH()) && status === "EXECUTADA") {
    actions.push({ icon: "🧾", label: "Enviar Folha", action: "send-payroll-single" });
  }
  if (!isCollaborator()) {
    actions.push({ icon: "📄", label: "Autorização", action: "pdf" });
    actions.push({ icon: "📤", label: "Exportar", action: "export-single" });
  }
  if (isCollaborator() && owner && status === "EXECUTADA") {
    actions.push({ icon: "👁️", label: "Dar ciência", action: "ack" });
  }
  return actions;
}

function renderTable(records) {
  const canSelect = !isCollaborator();
  const headers = `
    <tr>
      ${canSelect ? "<th style=\"width:32px\"><input type=\"checkbox\" data-action=\"select-all\"></th>" : ""}
      <th>Colaborador</th>
      <th>Data</th>
      <th>Início–Fim</th>
      <th>Horas (líquidas)</th>
      <th>Tipo</th>
      <th>Centro de Custo</th>
      <th>Gestor</th>
      <th>Status</th>
      <th>Motivo</th>
      <th>Ações</th>
    </tr>`;
  const rows = records
    .slice()
    .sort((a, b) => {
      const dateDiff = (extractRecordDate(b) || "").localeCompare(extractRecordDate(a) || "");
      if (dateDiff !== 0) return dateDiff;
      return STATUS_ORDER.indexOf(ensureStatus(a.status)) - STATUS_ORDER.indexOf(ensureStatus(b.status));
    })
    .map((record) => {
      const employee = getEmployeeByUid(record.forUid, record.forEmail);
      const manager = getEmployeeByUid(record.managerUid) ||
        managersCache.find((mgr) => mgr.uid === record.managerUid);
      const hours = computeHours(record);
      const actionButtons = buildRowActions(record)
        .map(
          (action) =>
            `<button class="btn ghost action" title="${action.label}" data-action="${action.action}" data-id="${record.id}">${action.icon}</button>`
        )
        .join(" ");
      const checkbox = canSelect
        ? `<input type="checkbox" class="row-check" data-id="${record.id}" ${
            selection.has(record.id) ? "checked" : ""
          }>`
        : "";
      const timeRange = `${formatTime(record.start)} – ${formatTime(record.end)}`;
      return `
        <tr>
          ${canSelect ? `<td>${checkbox}</td>` : ""}
          <td>
            <div class="cell-main">${employee?.name || record.forEmail || "—"}</div>
            <div class="cell-sub">${employee?.email || record.forEmail || ""}</div>
          </td>
          <td>${formatDate(extractRecordDate(record))}</td>
          <td>${timeRange}</td>
          <td>${formatHours(hours.total)}</td>
          <td>${renderTypes(record)}</td>
          <td>${record.costCenter || employee?.costCenter || "—"}</td>
          <td>${manager?.name || "—"}</td>
          <td>${renderStatus(record.status)}</td>
          <td><small class="helper">${record.reason || "—"}</small></td>
          <td class="actions">${actionButtons}</td>
        </tr>
      `;
    })
    .join("");
  const body = rows || `<tr><td colspan="${canSelect ? 11 : 10}"><p class="helper">Sem registros.</p></td></tr>`;
  return `
    <div class="card">
      <div class="table-scroll">
        <table class="table">
          <thead>${headers}</thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </div>
  `;
}

function renderCollaboratorSummary(records) {
  if (!isCollaborator()) return "";
  const grouped = records.reduce(
    (acc, record) => {
      const status = ensureStatus(record.status);
      const hours = computeHours(record).total;
      acc.total += hours;
      acc[status] = (acc[status] || 0) + hours;
      return acc;
    },
    { total: 0 }
  );
  const blocks = [
    `<div class="pill-block">
      <div class="pill-label">Total</div>
      <div class="pill-value">${formatHours(grouped.total)}</div>
    </div>`
  ];
  Object.entries(grouped)
    .filter(([key]) => key !== "total")
    .forEach(([status, value]) => {
      blocks.push(`
        <div class="pill-block">
          <div class="pill-label">${STATUS_INFO[status]?.label || status}</div>
          <div class="pill-value">${formatHours(value)}</div>
        </div>
      `);
    });
  return `
    <div class="card" id="my-summary">
      <h3>Minhas horas no período</h3>
      <div class="overtime-summary">${blocks.join("")}</div>
    </div>
  `;
}

function renderPage() {
  const accessibleRecords = allowedRecords();
  const filteredRecords = applyFilters(accessibleRecords);
  const kpis = buildKpis(filteredRecords, accessibleRecords);
  const top = buildTopLists(filteredRecords);
  const view = document.getElementById("view");
  if (!view) return;
  view.innerHTML = `
    <div class="overtime-layout">
      ${renderFiltersSection()}
      ${renderKpis(kpis)}
      ${renderTopListsSection(top)}
      ${renderToolbar(filteredRecords)}
      ${renderTable(filteredRecords)}
      ${renderCollaboratorSummary(filteredRecords)}
    </div>
  `;
  attachHandlers();
}
function attachHandlers() {
  const view = document.getElementById("view");
  if (!view) return;
  view.querySelectorAll("[data-action='filter-start']").forEach((input) => {
    input.addEventListener("change", (event) => {
      filters.start = event.target.value;
      renderPage();
    });
  });
  view.querySelectorAll("[data-action='filter-end']").forEach((input) => {
    input.addEventListener("change", (event) => {
      filters.end = event.target.value;
      renderPage();
    });
  });
  view.querySelectorAll("[data-action='filter-manager']").forEach((input) => {
    input.addEventListener("change", (event) => {
      filters.manager = event.target.value;
      renderPage();
    });
  });
  view.querySelectorAll("[data-action='filter-cost-center']").forEach((input) => {
    input.addEventListener("change", (event) => {
      filters.costCenter = event.target.value;
      renderPage();
    });
  });
  view.querySelectorAll("[data-action='filter-employee']").forEach((input) => {
    input.addEventListener("input", (event) => {
      filters.employee = event.target.value;
      renderPage();
    });
  });
  view.querySelectorAll("[data-action='filter-status']").forEach((checkbox) => {
    checkbox.addEventListener("change", (event) => {
      const value = event.target.value;
      if (event.target.checked) filters.statuses.add(value);
      else filters.statuses.delete(value);
      renderPage();
    });
  });
  const selectAll = view.querySelector("[data-action='select-all']");
  if (selectAll) {
    selectAll.addEventListener("change", (event) => {
      const checked = event.target.checked;
      const filteredRecords = applyFilters(allowedRecords());
      filteredRecords.forEach((record) => {
        if (checked) selection.add(record.id);
        else selection.delete(record.id);
      });
      renderPage();
    });
  }
  view.querySelectorAll(".row-check").forEach((checkbox) => {
    checkbox.addEventListener("change", (event) => {
      const id = event.target.dataset.id;
      if (event.target.checked) selection.add(id);
      else selection.delete(id);
    });
  });
  view.querySelectorAll(".action").forEach((button) => {
    button.addEventListener("click", (event) => {
      const action = event.currentTarget.dataset.action;
      const id = event.currentTarget.dataset.id;
      handleAction(action, id);
    });
  });
  view.querySelectorAll("[data-action]").forEach((element) => {
    const action = element.dataset.action;
    if (
      [
        "new-request",
        "import-csv",
        "export",
        "send-payroll",
        "mass-approve",
        "mass-adjust",
        "mass-payroll",
        "scroll-summary"
      ].includes(action)
    ) {
      element.addEventListener("click", (event) => {
        handleAction(event.currentTarget.dataset.action);
      });
    }
  });
}

function handleAction(action, id) {
  switch (action) {
    case "new-request":
      openRequestModal();
      break;
    case "edit":
      openRequestModal(id);
      break;
    case "approve":
      openDecisionModal(id, true);
      break;
    case "reject":
      openDecisionModal(id, false);
      break;
    case "adjust":
      openDecisionModal(id, true, true);
      break;
    case "execute":
      openExecutionModal(id);
      break;
    case "send-payroll-single":
      sendToPayroll([id]);
      break;
    case "export":
      exportCsv(applyFilters(allowedRecords()));
      break;
    case "export-single":
      exportCsv(allowedRecords().filter((record) => record.id === id));
      break;
    case "pdf":
      generateAuthorization(id);
      break;
    case "import-csv":
      openImportModal();
      break;
    case "mass-approve":
      openMassApproveModal();
      break;
    case "mass-adjust":
      openMassAdjustModal();
      break;
    case "mass-payroll":
      sendToPayroll(Array.from(selection));
      break;
    case "send-payroll":
      openPayrollModal();
      break;
    case "ack":
      acknowledgeExecution(id);
      break;
    case "scroll-summary":
      document.getElementById("my-summary")?.scrollIntoView({ behavior: "smooth" });
      break;
    default:
      break;
  }
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
    role: row.role || "Colaborador",
    managerUid: row.managerUid || row.manager || row.gestorUid || "",
    managerName: row.managerName || row.manager || row.gestor || "",
    costCenter: row.costCenter || row.center || row.centroCusto || "",
    salary: row.salary ? Number(row.salary) : 0
  }));
  managersCache = [];
}

async function ensureOvertime() {
  const baseQuery = query(collection(db, "overtime"), orderBy("date"));
  const snap = await getDocs(baseQuery);
  const rows = [];
  snap.forEach((docSnap) => rows.push({ id: docSnap.id, ...docSnap.data() }));
  overtimeCache = rows;
}

function closeModal(modal) {
  if (!modal) return;
  modal.classList.add("closing");
  setTimeout(() => modal.remove(), 180);
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

function getRequestDefaults(record) {
  if (!record) {
    return {
      collaborator: "",
      date: filters.start,
      start: "18:00",
      end: "20:00",
      breakMins: 0,
      type: "extra50",
      night: false,
      costCenter: "",
      reason: "",
      attachments: []
    };
  }
  const types = mapType(record.type);
  const startDate = record.start ? new Date(record.start) : null;
  const endDate = record.end ? new Date(record.end) : null;
  const format = (date) =>
    date
      ? `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
      : "18:00";
  return {
    collaborator: record.forUid || record.forEmail || "",
    date: extractRecordDate(record) || filters.start,
    start: startDate ? format(startDate) : "18:00",
    end: endDate ? format(endDate) : "20:00",
    breakMins: record.breakMins || 0,
    type: types.includes("extra100") ? "extra100" : "extra50",
    night: types.includes("night"),
    costCenter: record.costCenter || "",
    reason: record.reason || "",
    attachments: Array.isArray(record.attachments) ? record.attachments : []
  };
}

function getEmployeeOptions(selected) {
  return employeesCache
    .slice()
    .sort((a, b) => (a.name || a.email || "").localeCompare(b.name || b.email || ""))
    .map(
      (employee) =>
        `<option value="${employee.uid}" ${selected === employee.uid ? "selected" : ""}>${
          employee.name
        } (${employee.email})</option>`
    )
    .join("");
}

function updatePreview(content, data) {
  const employee = getEmployeeByUid(data.collaborator);
  const dateIso = `${data.date}T${data.start}:00`;
  const endIso = `${data.date}T${data.end}:00`;
  const record = {
    start: dateIso,
    end: endIso,
    breakMins: data.breakMins,
    type: { extra50: data.type === "extra50", extra100: data.type === "extra100", night: data.night },
    forUid: data.collaborator,
    forEmail: employee?.email
  };
  const hours = computeHours(record);
  const cost = computeCost(record);
  const preview = content.querySelector("#preview-info");
  if (preview) {
    preview.innerHTML = `
      <div class="pill-block">
        <div class="pill-label">Horas líquidas</div>
        <div class="pill-value">${formatHours(hours.total)}</div>
      </div>
      <div class="pill-block">
        <div class="pill-label">Adicional Noturno</div>
        <div class="pill-value">${formatHours(hours.hNight)}</div>
      </div>
      <div class="pill-block">
        <div class="pill-label">Custo estimado</div>
        <div class="pill-value">${formatCurrency(cost)}</div>
      </div>
    `;
  }
}
function bindRequestForm(content, defaults, recordId) {
  const form = content.querySelector("form");
  const employeeSelect = form.querySelector("[name='collaborator']");
  const managerField = form.querySelector("[name='managerUid']");

  const syncManager = () => {
    const employee = getEmployeeByUid(employeeSelect.value);
    if (!employee) return;
    if (managerField && !managerField.value) managerField.value = employee.managerUid || "";
    const ccField = form.querySelector("[name='costCenter']");
    if (ccField && !ccField.value) ccField.value = employee.costCenter || "";
    updatePreview(content, {
      collaborator: employeeSelect.value,
      date: form.date.value,
      start: form.start.value,
      end: form.end.value,
      breakMins: Number(form.breakMins.value || 0),
      type: form.type.value,
      night: form.night.checked
    });
  };

  form.addEventListener("input", () => {
    updatePreview(content, {
      collaborator: employeeSelect.value,
      date: form.date.value,
      start: form.start.value,
      end: form.end.value,
      breakMins: Number(form.breakMins.value || 0),
      type: form.type.value,
      night: form.night.checked
    });
  });

  employeeSelect.addEventListener("change", syncManager);
  syncManager();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const fd = new FormData(form);
    const collaborator = fd.get("collaborator");
    const date = fd.get("date");
    const start = fd.get("start");
    const end = fd.get("end");
    const breakMins = Number(fd.get("breakMins") || 0);
    const type = fd.get("type") || "extra50";
    const night = fd.get("night") === "on";
    const costCenter = fd.get("costCenter") || "";
    const reason = fd.get("reason");
    const attachment = fd.get("attachment");

    if (!collaborator) return alert("Selecione um colaborador");
    if (!date) return alert("Informe a data");
    if (!reason) return alert("Informe o motivo");
    const startDate = new Date(`${date}T${start}:00`);
    const endDate = new Date(`${date}T${end}:00`);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      return alert("Horários inválidos");
    }
    if (endDate <= startDate) {
      return alert("Fim deve ser maior que início");
    }
    const totalHours = (endDate - startDate) / 3600000 - breakMins / 60;
    if (totalHours <= 0) {
      return alert("Horas líquidas devem ser positivas");
    }
    if (totalHours > OVERTIME_CONFIG.dailyLimit) {
      if (!confirm("Ultrapassa o limite diário configurado. Deseja continuar?")) return;
    }
    const employeeRecords = overtimeCache.filter((item) => item.forUid === collaborator && extractRecordDate(item) === date);
    const overlap = employeeRecords.some((item) => {
      if (item.id === recordId) return false;
      if (ensureStatus(item.status) === "REJEITADA") return false;
      const otherStart = new Date(item.start || `${date}T00:00:00`);
      const otherEnd = new Date(item.end || `${date}T23:59:59`);
      return startDate < otherEnd && endDate > otherStart;
    });
    if (overlap) {
      if (!confirm("Existe sobreposição com outro pedido. Deseja continuar?")) return;
    }

    let attachmentInfo = defaults.attachments || [];
    if (attachment && attachment.size) {
      const path = `rh/overtime/${collaborator}/${Date.now()}-${attachment.name}`;
      const storageRef = ref(storage, path);
      await uploadBytes(storageRef, attachment);
      const url = await getDownloadURL(storageRef);
      attachmentInfo = [...attachmentInfo, { name: attachment.name, url }];
    }

    const payload = {
      forUid: collaborator,
      forEmail: getEmployeeByUid(collaborator)?.email || null,
      managerUid: fd.get("managerUid") || "",
      costCenter,
      date,
      start: startDate.toISOString(),
      end: endDate.toISOString(),
      breakMins,
      type: { extra50: type === "extra50", extra100: type === "extra100", night },
      hoursCalc: computeHours({
        start: startDate.toISOString(),
        end: endDate.toISOString(),
        breakMins,
        type: { extra50: type === "extra50", extra100: type === "extra100", night }
      }),
      reason,
      attachments: attachmentInfo,
      status: "PENDENTE_GESTAO",
      createdBy: getUser()?.uid || null,
      createdRole: getProfile().role,
      createdAt: new Date().toISOString()
    };

    if (recordId) {
      await updateDoc(doc(db, "overtime", recordId), payload);
      await logActivity("overtime.update", { id: recordId, forUid: collaborator });
    } else {
      await addDoc(collection(db, "overtime"), payload);
      await logActivity("overtime.create", { forUid: collaborator });
    }
    await ensureOvertime();
    closeModal(content.closest(".modal-backdrop"));
    renderPage();
  });
}

function openRequestModal(recordId = null) {
  const record = recordId ? overtimeCache.find((item) => item.id === recordId) : null;
  if (recordId && ensureStatus(record?.status) !== "PENDENTE_GESTAO") {
    alert("Somente pedidos pendentes podem ser editados");
    return;
  }
  openModal(({ content, close }) => {
    const defaults = getRequestDefaults(record);
    content.innerHTML = `
      <h2>${record ? "Editar" : "Nova"} solicitação de hora extra</h2>
      <form class="grid">
        <div class="field">
          <label>Colaborador</label>
          <select class="input" name="collaborator" required>
            <option value="">Selecione</option>
            ${getEmployeeOptions(defaults.collaborator)}
          </select>
        </div>
        <div class="field">
          <label>Gestor responsável</label>
          <select class="input" name="managerUid">
            <option value="">(defina o gestor)</option>
            ${getManagers()
              .map(
                (manager) =>
                  `<option value="${manager.uid}" ${
                    manager.uid === (record?.managerUid || "") ? "selected" : ""
                  }>${manager.name}</option>`
              )
              .join("")}
          </select>
        </div>
        <div class="grid cols-2">
          <div class="field">
            <label>Data</label>
            <input class="input" type="date" name="date" value="${defaults.date}" required>
          </div>
          <div class="field">
            <label>Centro de Custo</label>
            <input class="input" name="costCenter" value="${defaults.costCenter}">
          </div>
        </div>
        <div class="grid cols-3">
          <div class="field">
            <label>Início</label>
            <input class="input" type="time" name="start" value="${defaults.start}" required>
          </div>
          <div class="field">
            <label>Fim</label>
            <input class="input" type="time" name="end" value="${defaults.end}" required>
          </div>
          <div class="field">
            <label>Intervalo (min)</label>
            <input class="input" type="number" name="breakMins" value="${defaults.breakMins}" min="0" step="5">
          </div>
        </div>
        <div class="grid cols-2">
          <div class="field">
            <label>Tipo de hora</label>
            <select class="input" name="type">
              <option value="extra50" ${defaults.type === "extra50" ? "selected" : ""}>Extra 50%</option>
              <option value="extra100" ${defaults.type === "extra100" ? "selected" : ""}>Extra 100%</option>
            </select>
          </div>
          <label class="field" style="flex-direction:row;align-items:center;gap:.5rem;margin-top:1.75rem">
            <input type="checkbox" name="night" ${defaults.night ? "checked" : ""}>
            Adicional noturno (22h-05h)
          </label>
        </div>
        <div class="field">
          <label>Motivo</label>
          <textarea class="input" name="reason" required rows="3">${defaults.reason}</textarea>
        </div>
        <div class="field">
          <label>Anexo (opcional)</label>
          <input class="input" type="file" name="attachment" accept="application/pdf,image/*">
        </div>
        <div class="field">
          <label>Preview</label>
          <div class="overtime-summary" id="preview-info"></div>
        </div>
        <div style="display:flex;gap:.75rem;justify-content:flex-end">
          <button type="button" class="btn ghost" data-close>Cancelar</button>
          <button type="submit" class="btn">Salvar</button>
        </div>
      </form>
    `;
    content.querySelector("[data-close]").addEventListener("click", close);
    bindRequestForm(content, defaults, recordId);
    updatePreview(content, {
      collaborator: defaults.collaborator,
      date: defaults.date,
      start: defaults.start,
      end: defaults.end,
      breakMins: defaults.breakMins,
      type: defaults.type,
      night: defaults.night
    });
  });
}
function openDecisionModal(id, approve, adjustOnly = false) {
  const record = overtimeCache.find((item) => item.id === id);
  if (!record) return;
  const hours = computeHours(record);
  openModal(({ content, close }) => {
    content.innerHTML = `
      <h2>${approve ? (adjustOnly ? "Ajustar" : "Aprovar") : "Rejeitar"} solicitação</h2>
      <div class="card mini">
        <strong>${getEmployeeByUid(record.forUid, record.forEmail)?.name || record.forEmail}</strong>
        <small class="helper">${formatDate(extractRecordDate(record))} • ${formatTime(record.start)} – ${formatTime(record.end)}</small>
        <small class="helper">Horas calculadas: ${formatHours(hours.total)} | Custo: ${formatCurrency(
          computeCost(record)
        )}</small>
      </div>
      <form class="grid">
        <div class="grid cols-3">
          <div class="field">
            <label>Início aprovado</label>
            <input class="input" type="time" name="start" value="${formatTime(record.start)}">
          </div>
          <div class="field">
            <label>Fim aprovado</label>
            <input class="input" type="time" name="end" value="${formatTime(record.end)}">
          </div>
          <div class="field">
            <label>Intervalo (min)</label>
            <input class="input" type="number" name="breakMins" value="${record.breakMins || 0}" min="0" step="5">
          </div>
        </div>
        <div class="field">
          <label>Decisão / Motivo</label>
          <textarea class="input" name="decision" required rows="3"></textarea>
        </div>
        <div style="display:flex;gap:.75rem;justify-content:flex-end">
          <button type="button" class="btn ghost" data-close>Cancelar</button>
          ${approve
            ? `<button type="submit" class="btn">${adjustOnly ? "Aplicar ajuste" : "Aprovar"}</button>`
            : `<button type="submit" class="btn">Rejeitar</button>`}
        </div>
      </form>
    `;
    content.querySelector("[data-close]").addEventListener("click", close);
    const form = content.querySelector("form");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const fd = new FormData(form);
      const start = fd.get("start");
      const end = fd.get("end");
      const breakMins = Number(fd.get("breakMins") || 0);
      const decision = fd.get("decision");
      if (!decision) return alert("Informe o motivo/decisão");
      const date = extractRecordDate(record);
      const startDate = new Date(`${date}T${start}:00`);
      const endDate = new Date(`${date}T${end}:00`);
      if (endDate <= startDate) return alert("Fim deve ser maior que início");
      const type = record.type;
      const hoursResult = computeHours({
        start: startDate.toISOString(),
        end: endDate.toISOString(),
        breakMins,
        type
      });
      const payload = {
        start: startDate.toISOString(),
        end: endDate.toISOString(),
        breakMins,
        hoursCalc: hoursResult,
        decisionNotes: decision,
        decidedBy: getUser()?.uid || null,
        decidedAt: new Date().toISOString()
      };
      if (!approve) {
        payload.status = "REJEITADA";
      } else if (!adjustOnly) {
        payload.status = "APROVADA";
      }
      await updateDoc(doc(db, "overtime", id), payload);
      await logActivity("overtime.decision", { id, status: payload.status || record.status });
      await ensureOvertime();
      close();
      renderPage();
    });
  });
}

function openExecutionModal(id) {
  const record = overtimeCache.find((item) => item.id === id);
  if (!record) return;
  openModal(({ content, close }) => {
    content.innerHTML = `
      <h2>Apontar execução</h2>
      <p class="helper">Registre as horas reais trabalhadas para liberar para folha.</p>
      <form class="grid">
        <div class="grid cols-2">
          <div class="field">
            <label>Horas reais (decimal)</label>
            <input class="input" type="number" name="hoursReal" min="0" step="0.25" value="${
              record.executed?.hoursReal || computeHours(record).total
            }">
          </div>
          <div class="field">
            <label>Anexo (opcional)</label>
            <input class="input" type="file" name="attachment">
          </div>
        </div>
        <div class="field">
          <label>Observação</label>
          <textarea class="input" name="notes" rows="3">${record.executed?.notes || ""}</textarea>
        </div>
        <div style="display:flex;gap:.75rem;justify-content:flex-end">
          <button type="button" class="btn ghost" data-close>Cancelar</button>
          <button type="submit" class="btn">Marcar como executada</button>
        </div>
      </form>
    `;
    content.querySelector("[data-close]").addEventListener("click", close);
    const form = content.querySelector("form");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const fd = new FormData(form);
      const hoursReal = Number(fd.get("hoursReal") || 0);
      const notes = fd.get("notes") || "";
      const attachment = fd.get("attachment");
      let attachments = record.executed?.attachments || [];
      if (attachment && attachment.size) {
        const path = `rh/overtime/executados/${id}/${Date.now()}-${attachment.name}`;
        const storageRef = ref(storage, path);
        await uploadBytes(storageRef, attachment);
        const url = await getDownloadURL(storageRef);
        attachments = [...attachments, { name: attachment.name, url }];
      }
      const payload = {
        status: "EXECUTADA",
        executed: {
          done: true,
          at: new Date().toISOString(),
          hoursReal,
          notes,
          by: getUser()?.uid || null,
          attachments
        }
      };
      await updateDoc(doc(db, "overtime", id), payload);
      await logActivity("overtime.executed", { id, hoursReal });
      await ensureOvertime();
      close();
      renderPage();
    });
  });
}

function openPayrollModal() {
  const month = filters.start ? filters.start.slice(0, 7) : new Date().toISOString().slice(0, 7);
  const executed = applyFilters(allowedRecords()).filter((record) => ensureStatus(record.status) === "EXECUTADA");
  if (!executed.length) {
    alert("Nenhuma execução disponível para o período selecionado.");
    return;
  }
  openModal(({ content, close }) => {
    const rows = executed
      .map((record) => {
        const employee = getEmployeeByUid(record.forUid, record.forEmail);
        return `<tr><td>${employee?.name || record.forEmail}</td><td>${formatDate(
          extractRecordDate(record)
        )}</td><td>${formatHours(record.executed?.hoursReal || computeHours(record).total)}</td></tr>`;
      })
      .join("");
    content.innerHTML = `
      <h2>Enviar para holerite</h2>
      <p class="helper">${executed.length} registro(s) serão enviados para o mês ${month}.</p>
      <div class="table-scroll">
        <table class="table">
          <thead><tr><th>Colaborador</th><th>Data</th><th>Horas</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div style="display:flex;gap:.75rem;justify-content:flex-end;margin-top:1rem">
        <button class="btn ghost" data-close>Cancelar</button>
        <button class="btn" data-confirm>Enviar</button>
      </div>
    `;
    content.querySelector("[data-close]").addEventListener("click", close);
    content.querySelector("[data-confirm]").addEventListener("click", async () => {
      await sendToPayroll(executed.map((record) => record.id), month);
      close();
    });
  });
}

async function sendToPayroll(ids, monthOverride = null) {
  if (!ids.length) return;
  const month = monthOverride || (filters.start ? filters.start.slice(0, 7) : new Date().toISOString().slice(0, 7));
  await Promise.all(
    ids.map((targetId) =>
      updateDoc(doc(db, "overtime", targetId), {
        status: "EM_FOLHA",
        payroll: {
          month,
          sent: true,
          sentAt: new Date().toISOString()
        }
      })
    )
  );
  await logActivity("overtime.payroll", { ids, month });
  await ensureOvertime();
  renderPage();
}

function exportCsv(records) {
  if (!records.length) {
    alert("Nenhum registro para exportar.");
    return;
  }
  const header = [
    "colaborador",
    "email",
    "gestor",
    "centroCusto",
    "data",
    "inicio",
    "fim",
    "intervalo",
    "h50",
    "h100",
    "hNoturna",
    "status",
    "motivo",
    "decididoPor",
    "decididoEm",
    "enviadoFolha"
  ];
  const rows = records.map((record) => {
    const employee = getEmployeeByUid(record.forUid, record.forEmail);
    const manager = getEmployeeByUid(record.managerUid) ||
      managersCache.find((mgr) => mgr.uid === record.managerUid);
    const hours = computeHours(record);
    return [
      employee?.name || record.forEmail || "",
      employee?.email || record.forEmail || "",
      manager?.name || "",
      record.costCenter || employee?.costCenter || "",
      extractRecordDate(record) || "",
      formatTime(record.start),
      formatTime(record.end),
      record.breakMins || 0,
      hours.h50,
      hours.h100,
      hours.hNight,
      ensureStatus(record.status),
      record.reason || "",
      record.decidedBy || "",
      record.decidedAt || "",
      record.payroll?.sent ? record.payroll.month : ""
    ]
      .map((value) => `"${String(value).replace(/"/g, '""')}"`)
      .join(";");
  });
  const csv = [header.join(";"), ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `hora-extra-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function generateAuthorization(id) {
  const record = overtimeCache.find((item) => item.id === id);
  if (!record) return;
  const employee = getEmployeeByUid(record.forUid, record.forEmail);
  const manager = getEmployeeByUid(record.managerUid) ||
    managersCache.find((mgr) => mgr.uid === record.managerUid);
  const hours = computeHours(record);
  const html = `<!doctype html>
  <html><head><meta charset="utf-8"><title>Autorização de Hora Extra</title>
  <style>
    body{font-family:Arial,sans-serif;padding:2rem;color:#111}
    h1{margin-bottom:.5rem;color:#ff008a}
    table{width:100%;border-collapse:collapse;margin-top:1rem}
    td,th{border:1px solid #ddd;padding:.75rem;text-align:left}
    .muted{color:#555}
  </style></head>
  <body>
    <h1>Autorização de Hora Extra</h1>
    <p class="muted">Casa Rosa — Registro de aprovação formal.</p>
    <table>
      <tr><th>Colaborador</th><td>${employee?.name || record.forEmail || "—"}</td></tr>
      <tr><th>Gestor</th><td>${manager?.name || "—"}</td></tr>
      <tr><th>Data</th><td>${formatDate(extractRecordDate(record))}</td></tr>
      <tr><th>Horário</th><td>${formatTime(record.start)} – ${formatTime(record.end)}</td></tr>
      <tr><th>Intervalo</th><td>${record.breakMins || 0} min</td></tr>
      <tr><th>Horas aprovadas</th><td>${formatHours(hours.total)}</td></tr>
      <tr><th>Status</th><td>${STATUS_INFO[ensureStatus(record.status)]?.label || record.status}</td></tr>
      <tr><th>Motivo</th><td>${record.reason || "—"}</td></tr>
      <tr><th>Decisão</th><td>${record.decisionNotes || "—"}</td></tr>
    </table>
    <p class="muted">Gerado em ${new Date().toLocaleString("pt-BR")}.</p>
  </body></html>`;
  const win = window.open("", "_blank");
  if (!win) return;
  win.document.write(html);
  win.document.close();
}
function openImportModal() {
  openModal(({ content, close }) => {
    content.innerHTML = `
      <h2>Importar solicitações (CSV)</h2>
      <p class="helper">Formato esperado: colaboradorUid;data;inicio;fim;intervalo;tipo(50|100);noturna(0|1);centroCusto;motivo</p>
      <form class="grid">
        <div class="field">
          <label>Arquivo CSV</label>
          <input class="input" type="file" name="file" accept=".csv" required>
        </div>
        <div style="display:flex;gap:.75rem;justify-content:flex-end">
          <button type="button" class="btn ghost" data-close>Cancelar</button>
          <button type="submit" class="btn">Pré-visualizar</button>
        </div>
      </form>
      <div id="preview"></div>
    `;
    content.querySelector("[data-close]").addEventListener("click", close);
    const form = content.querySelector("form");
    const preview = content.querySelector("#preview");
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const file = form.file.files[0];
      if (!file) return alert("Selecione um arquivo");
      const reader = new FileReader();
      reader.onload = async (e) => {
        const text = e.target.result;
        const lines = text.split(/\r?\n/).filter(Boolean);
        if (!lines.length) return alert("Arquivo vazio");
        const parsed = lines.map((line) => line.split(";").map((part) => part.trim()));
        const items = parsed.map((cols) => ({
          collaborator: cols[0],
          date: cols[1],
          start: cols[2],
          end: cols[3],
          breakMins: Number(cols[4] || 0),
          type: cols[5] === "100" ? "extra100" : "extra50",
          night: cols[6] === "1" || cols[6]?.toLowerCase() === "true",
          costCenter: cols[7] || "",
          reason: cols[8] || ""
        }));
        preview.innerHTML = `
          <div class="card mini">
            <h3>Pré-visualização (${items.length} registros)</h3>
            <ul class="list-unstyled">${items
              .map((item) => `<li>${getEmployeeByUid(item.collaborator)?.name || item.collaborator} • ${item.date} ${item.start}-${item.end}</li>`)
              .join("")}</ul>
            <div style="display:flex;justify-content:flex-end;margin-top:1rem">
              <button class="btn" data-import>Importar</button>
            </div>
          </div>
        `;
        preview.querySelector("[data-import]").addEventListener("click", async () => {
          for (const item of items) {
            if (!item.collaborator || !item.date || !item.start || !item.end) continue;
            const startDate = new Date(`${item.date}T${item.start}:00`);
            const endDate = new Date(`${item.date}T${item.end}:00`);
            const payload = {
              forUid: item.collaborator,
              forEmail: getEmployeeByUid(item.collaborator)?.email || null,
              managerUid: getEmployeeByUid(item.collaborator)?.managerUid || "",
              costCenter: item.costCenter,
              date: item.date,
              start: startDate.toISOString(),
              end: endDate.toISOString(),
              breakMins: item.breakMins,
              type: { extra50: item.type === "extra50", extra100: item.type === "extra100", night: item.night },
              hoursCalc: computeHours({
                start: startDate.toISOString(),
                end: endDate.toISOString(),
                breakMins: item.breakMins,
                type: { extra50: item.type === "extra50", extra100: item.type === "extra100", night: item.night }
              }),
              reason: item.reason,
              attachments: [],
              status: "PENDENTE_GESTAO",
              createdBy: getUser()?.uid || null,
              createdRole: getProfile().role,
              createdAt: new Date().toISOString()
            };
            await addDoc(collection(db, "overtime"), payload);
          }
          await ensureOvertime();
          close();
          renderPage();
        });
      };
      reader.readAsText(file, "utf-8");
    });
  });
}

function openMassApproveModal() {
  const selectedRecords = allowedRecords().filter((record) => selection.has(record.id));
  if (!selectedRecords.length) return alert("Nenhum registro selecionado");
  openModal(({ content, close }) => {
    content.innerHTML = `
      <h2>Aprovação em massa</h2>
      <p class="helper">${selectedRecords.length} registros pendentes serão aprovados.</p>
      <form class="grid">
        <div class="field">
          <label>Decisão / Motivo</label>
          <textarea class="input" name="decision" required rows="3"></textarea>
        </div>
        <div style="display:flex;gap:.75rem;justify-content:flex-end">
          <button type="button" class="btn ghost" data-close>Cancelar</button>
          <button type="submit" class="btn">Aprovar todos</button>
        </div>
      </form>
    `;
    content.querySelector("[data-close]").addEventListener("click", close);
    const form = content.querySelector("form");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const decision = new FormData(form).get("decision");
      if (!decision) return alert("Informe o motivo");
      await Promise.all(
        selectedRecords.map((record) =>
          updateDoc(doc(db, "overtime", record.id), {
            status: "APROVADA",
            decisionNotes: decision,
            decidedBy: getUser()?.uid || null,
            decidedAt: new Date().toISOString()
          })
        )
      );
      await logActivity("overtime.massApprove", { ids: selectedRecords.map((r) => r.id) });
      selection.clear();
      await ensureOvertime();
      close();
      renderPage();
    });
  });
}

function openMassAdjustModal() {
  const selectedRecords = allowedRecords().filter((record) => selection.has(record.id));
  if (!selectedRecords.length) return alert("Nenhum registro selecionado");
  openModal(({ content, close }) => {
    content.innerHTML = `
      <h2>Ajuste em massa</h2>
      <p class="helper">Reduza as horas aprovadas aplicando um fator de redução (0.1 = reduz 10%).</p>
      <form class="grid">
        <div class="field">
          <label>Fator de redução</label>
          <input class="input" type="number" name="factor" min="0" max="1" step="0.05" value="0.1" required>
        </div>
        <div class="field">
          <label>Motivo</label>
          <textarea class="input" name="reason" required rows="3"></textarea>
        </div>
        <div style="display:flex;gap:.75rem;justify-content:flex-end">
          <button type="button" class="btn ghost" data-close>Cancelar</button>
          <button type="submit" class="btn">Aplicar ajuste</button>
        </div>
      </form>
    `;
    content.querySelector("[data-close]").addEventListener("click", close);
    content.querySelector("form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const fd = new FormData(event.currentTarget);
      const factor = Number(fd.get("factor"));
      const reason = fd.get("reason");
      if (!Number.isFinite(factor) || factor <= 0 || factor >= 1) {
        return alert("Informe um fator entre 0 e 1");
      }
      if (!reason) return alert("Informe o motivo");
      await Promise.all(
        selectedRecords.map(async (record) => {
          const hours = computeHours(record);
          const reduced = Number((hours.total * (1 - factor)).toFixed(2));
          const ratio = hours.total ? reduced / hours.total : 0;
          const adjusted = {
            total: reduced,
            h50: Number((hours.h50 * ratio).toFixed(2)),
            h100: Number((hours.h100 * ratio).toFixed(2)),
            hNight: Number((hours.hNight * ratio).toFixed(2))
          };
          const startDate = new Date(record.start);
          const endDate = new Date(startDate.getTime() + reduced * 3600000 + (record.breakMins || 0) * 60000);
          await updateDoc(doc(db, "overtime", record.id), {
            end: endDate.toISOString(),
            hoursCalc: adjusted,
            decisionNotes: `${record.decisionNotes || ""}\nAjuste em massa: ${reason}`
          });
        })
      );
      await logActivity("overtime.massAdjust", { ids: selectedRecords.map((r) => r.id), factor });
      await ensureOvertime();
      selection.clear();
      close();
      renderPage();
    });
  });
}

async function acknowledgeExecution(id) {
  const record = overtimeCache.find((item) => item.id === id);
  if (!record) return;
  try {
    await updateDoc(doc(db, "overtime", id), {
      executed: {
        ...(record.executed || {}),
        ackByEmployeeAt: new Date().toISOString()
      }
    });
    await ensureOvertime();
    renderPage();
  } catch (err) {
    console.warn("Não foi possível registrar ciência do colaborador", err);
    alert("Não foi possível registrar a ciência. Verifique as permissões.");
  }
}

async function bootstrap() {
  await ensureEmployees();
  await ensureOvertime();
  renderPage();
}

window.OvertimeView = bootstrap;
