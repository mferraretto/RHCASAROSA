import {
  getFirestore,
  collection,
  query,
  where,
  orderBy,
  getDocs,
  addDoc,
  updateDoc,
  doc,
  setDoc
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

const MANAGEMENT_ROLES = ["ADM", "RH"];
const APPROVER_ROLES = ["ADM", "Gestor"];

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

const STATUS_INFO = {
  PENDENTE_GESTAO: { label: "Pendente gestão", badge: "status-badge pending" },
  APROVADO: { label: "Aprovado", badge: "status-badge approved" },
  REJEITADO: { label: "Rejeitado", badge: "status-badge rejected" },
  EM_FOLHA: { label: "Em folha", badge: "status-badge payroll" },
  CANCELADO: { label: "Cancelado", badge: "status-badge" }
};

const STATUS_FLOW_ORDER = [
  "PENDENTE_GESTAO",
  "APROVADO",
  "REJEITADO",
  "EM_FOLHA",
  "CANCELADO"
];

const MAX_VALUE_BY_TYPE = {
  Bonus: null,
  Premiacao: null,
  Abono: null,
  Gratificacao: null
};

let employeesCache = [];
let bonusesCache = [];
let currentFilters = {};
let currentSelection = new Set();

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

function canManage() {
  return MANAGEMENT_ROLES.includes(getProfile().role || "");
}

function canApprove() {
  return APPROVER_ROLES.includes(getProfile().role || "");
}

function normalizeStatus(value) {
  if (!value) return "PENDENTE_GESTAO";
  const key = String(value).toUpperCase();
  switch (key) {
    case "PENDENTE":
    case "PENDENTE_GESTAO":
      return "PENDENTE_GESTAO";
    case "APROVADO":
    case "APROVADA":
    case "APROVADOS":
      return "APROVADO";
    case "REJEITADO":
    case "REJEITADA":
    case "NEGADO":
    case "NEGADA":
      return "REJEITADO";
    case "EM_FOLHA":
    case "FOLHA":
      return "EM_FOLHA";
    case "CANCELADO":
    case "CANCELADA":
    case "CANCEL":
      return "CANCELADO";
    default:
      return "PENDENTE_GESTAO";
  }
}

function statusLabel(status) {
  return STATUS_INFO[status]?.label || status;
}

function statusBadge(status) {
  return STATUS_INFO[status]?.badge || "status-badge";
}

function formatCurrency(value) {
  if (!Number.isFinite(value)) return "—";
  return Number(value).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("pt-BR");
}

function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toLocaleDateString("pt-BR")} ${date.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit"
  })}`;
}

function slugify(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
}

async function ensureEmployees() {
  if (employeesCache.length) return employeesCache;
  try {
    const snap = await getDocs(collection(db, "employees"));
    const rows = [];
    snap.forEach((docSnap) => rows.push({ id: docSnap.id, ...docSnap.data() }));
    employeesCache = rows.map((row) => ({
      id: row.id,
      uid: row.uid || row.id,
      name: row.name || row.email || "—",
      email: row.email || "",
      managerUid: row.managerUid || row.manager || row.gestorUid || "",
      managerName: row.managerName || row.manager || row.gestor || "",
      costCenter: row.costCenter || row.center || row.centroCusto || "",
      role: row.role || "Colaborador"
    }));
  } catch (err) {
    console.warn("Falha ao carregar colaboradores", err);
    employeesCache = [];
  }
  return employeesCache;
}

function getEmployeeByUid(uid) {
  if (!uid || !employeesCache.length) return null;
  return employeesCache.find((emp) => emp.uid === uid || emp.id === uid) || null;
}

function getEmployeeByEmail(email) {
  if (!email || !employeesCache.length) return null;
  const lower = String(email).toLowerCase();
  return employeesCache.find((emp) => String(emp.email || "").toLowerCase() === lower) || null;
}

function normalizeBonusDoc(docSnap) {
  const raw = docSnap.data();
  const status = normalizeStatus(raw.status);
  const createdAt = raw.createdAt || raw.created_at || null;
  const decidedAt = raw.decidedAt || raw.decided_at || null;
  const reason = raw.reason || raw.motivo || "";
  const competence = raw.competence || raw.competencia || "";
  const attachments = Array.isArray(raw.attachments) ? raw.attachments : [];
  const managerUid = raw.managerUid || raw.manager || raw.gestorUid || null;
  const managerName = raw.managerName || raw.gestor || null;
  const forUid = raw.forUid || raw.uid || raw.employeeUid || null;
  const forEmail = raw.forEmail || raw.email || raw.employeeEmail || null;
  const type = raw.type || raw.tipo || "Bonus";
  const nature = raw.nature || raw.natureza || "Remuneratoria";
  const approvedValue = Number(raw.approvedValue);
  const value = Number(raw.value);
  const employee = forUid ? getEmployeeByUid(forUid) : getEmployeeByEmail(forEmail);
  const manager = managerUid ? getEmployeeByUid(managerUid) : null;
  return {
    id: docSnap.id,
    ...raw,
    status,
    reason,
    competence,
    attachments,
    managerUid,
    managerName: managerName || manager?.name || raw.manager || raw.gestor || "",
    forUid,
    forEmail,
    type,
    nature,
    value: Number.isFinite(value) ? value : 0,
    approvedValue: Number.isFinite(approvedValue) ? approvedValue : null,
    createdAt,
    decidedAt,
    employee
  };
}

async function ensureBonuses() {
  const user = getUser();
  if (!user) {
    bonusesCache = [];
    return;
  }
  let baseRef = collection(db, "bonuses");
  const constraints = [];
  if (!canManage() && isGestor() && !isAdmin()) {
    constraints.push(where("managerUid", "==", user.uid));
  } else if (!canManage() && !isGestor()) {
    constraints.push(where("forUid", "==", user.uid));
  }
  if (!constraints.length) {
    try {
      baseRef = query(baseRef, orderBy("createdAt", "desc"));
    } catch (err) {
      console.warn("Não foi possível ordenar por createdAt", err);
    }
  }
  const q = constraints.length ? query(baseRef, ...constraints) : baseRef;
  const snap = await getDocs(q);
  const rows = [];
  snap.forEach((docSnap) => rows.push(normalizeBonusDoc(docSnap)));
  if (!canManage() && !isGestor()) {
    const email = (user.email || "").toLowerCase();
    bonusesCache = rows.filter(
      (row) => row.forUid === user.uid || String(row.forEmail || "").toLowerCase() === email
    );
  } else {
    bonusesCache = rows;
  }
  bonusesCache.sort((a, b) => {
    const aDate = a.createdAt || "";
    const bDate = b.createdAt || "";
    return aDate > bDate ? -1 : aDate < bDate ? 1 : 0;
  });
}

function applyFilters(items) {
  if (!items.length) return [];
  return items.filter((item) => {
    if (currentFilters.period && item.competence !== currentFilters.period) return false;
    if (currentFilters.status && item.status !== currentFilters.status) return false;
    if (currentFilters.type && item.type !== currentFilters.type) return false;
    if (currentFilters.costCenter && (item.costCenter || "") !== currentFilters.costCenter)
      return false;
    if (currentFilters.manager && (item.managerUid || "") !== currentFilters.manager) return false;
    if (currentFilters.employee && (item.forUid || "") !== currentFilters.employee) return false;
    if (currentFilters.search) {
      const haystack = [
        item.reason,
        item.decisionNotes,
        item.employee?.name,
        item.employee?.email,
        item.managerName,
        item.costCenter,
        TYPE_LABEL[item.type] || item.type
      ]
        .map((field) => (field || "").toLowerCase())
        .join(" ");
      if (!haystack.includes(currentFilters.search)) return false;
    }
    return true;
  });
}

function computeKpis(items) {
  const total = items.length;
  let pending = 0;
  let approved = 0;
  let inPayroll = 0;
  const valueByType = { Bonus: 0, Premiacao: 0, Abono: 0, Gratificacao: 0 };
  let totalValue = 0;
  items.forEach((item) => {
    if (item.status === "PENDENTE_GESTAO") pending += 1;
    if (item.status === "APROVADO") approved += 1;
    if (item.status === "EM_FOLHA") inPayroll += 1;
    const baseValue = Number.isFinite(item.approvedValue) ? item.approvedValue : item.value;
    totalValue += baseValue;
    if (valueByType[item.type] !== undefined) {
      valueByType[item.type] += baseValue;
    }
  });
  return { total, pending, approved, inPayroll, valueByType, totalValue };
}

function getCostCenters() {
  const centers = new Set();
  employeesCache.forEach((emp) => {
    if (emp.costCenter) centers.add(emp.costCenter);
  });
  bonusesCache.forEach((bonus) => {
    if (bonus.costCenter) centers.add(bonus.costCenter);
  });
  return Array.from(centers).sort();
}

function getManagersOptions() {
  const managers = new Map();
  employeesCache.forEach((emp) => {
    if (emp.managerUid) {
      managers.set(emp.managerUid, emp.managerName || emp.managerUid);
    }
  });
  bonusesCache.forEach((bonus) => {
    if (bonus.managerUid) {
      managers.set(bonus.managerUid, bonus.managerName || bonus.managerUid);
    }
  });
  return Array.from(managers.entries()).sort((a, b) => a[1].localeCompare(b[1]));
}

function getEmployeeOptionsList() {
  const map = new Map();
  employeesCache.forEach((emp) => {
    map.set(emp.uid, `${emp.name || emp.email} (${emp.email || "sem e-mail"})`);
  });
  bonusesCache.forEach((bonus) => {
    const uid = bonus.forUid;
    if (uid && !map.has(uid)) {
      const label = `${bonus.forName || bonus.employee?.name || bonus.forEmail || uid}`;
      map.set(uid, label);
    }
  });
  return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
}

function canEditBonus(bonus) {
  return bonus.status === "PENDENTE_GESTAO" && canManage();
}

function canCancelBonus(bonus) {
  if (!canManage()) return false;
  return bonus.status === "PENDENTE_GESTAO" || bonus.status === "APROVADO";
}

function canSendToPayroll(bonus) {
  return canManage() && bonus.status === "APROVADO";
}

function canApproveBonus(bonus) {
  if (!canApprove()) return false;
  if (bonus.status !== "PENDENTE_GESTAO") return false;
  if (isGestor() && !isAdmin()) {
    const user = getUser();
    return bonus.managerUid === user?.uid;
  }
  return true;
}

function canRejectBonus(bonus) {
  return canApproveBonus(bonus);
}

function toCSV(items) {
  const header = [
    "Colaborador",
    "E-mail",
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
    "Decidido em"
  ];
  const rows = items.map((item) => [
    item.employee?.name || item.forName || item.forEmail || item.forUid || "—",
    item.employee?.email || item.forEmail || "—",
    TYPE_LABEL[item.type] || item.type,
    NATURE_LABEL[item.nature] || item.nature || "—",
    Number(item.value || 0).toFixed(2).replace(".", ","),
    item.approvedValue != null
      ? Number(item.approvedValue).toFixed(2).replace(".", ",")
      : "",
    item.costCenter || "—",
    item.competence || "—",
    (item.reason || "").replace(/\r?\n/g, " "),
    item.managerName || "—",
    statusLabel(item.status),
    item.createdAt ? new Date(item.createdAt).toISOString() : "",
    item.decidedAt ? new Date(item.decidedAt).toISOString() : ""
  ]);
  return [header, ...rows]
    .map((row) => row.map((field) => `"${String(field).replace(/"/g, '""')}"`).join(";"))
    .join("\n");
}

function downloadFile(filename, content, type = "text/csv;charset=utf-8;") {
  const blob = new Blob([content], { type });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 4000);
}
function buildDrawerSkeleton() {
  return `
    <div id="bonus-drawer-overlay" class="drawer-overlay hidden"></div>
    <aside id="bonus-drawer" class="drawer hidden">
      <div class="drawer-header">
        <div class="drawer-title"></div>
        <button class="btn ghost" data-bonus-action="close-drawer">Fechar</button>
      </div>
      <div class="drawer-content">
        <section>
          <h4>Resumo</h4>
          <div id="bonus-drawer-summary" class="stack"></div>
        </section>
        <section>
          <h4>Motivo</h4>
          <div id="bonus-drawer-reason" class="card mini"></div>
        </section>
        <section>
          <h4>Decisão e histórico</h4>
          <div id="bonus-drawer-history" class="card mini"></div>
        </section>
        <section>
          <h4>Anexos</h4>
          <div id="bonus-drawer-files" class="card mini"></div>
        </section>
        <section>
          <h4>Ações</h4>
          <div id="bonus-drawer-actions" class="stack"></div>
        </section>
      </div>
    </aside>
  `;
}

function ensureDrawerHandlers(container) {
  const overlay = container.querySelector("#bonus-drawer-overlay");
  const drawer = container.querySelector("#bonus-drawer");
  if (!overlay || !drawer) return;
  overlay.addEventListener("click", () => closeDrawer(container));
  drawer
    .querySelector("[data-bonus-action='close-drawer']")
    ?.addEventListener("click", () => closeDrawer(container));
}

function openDrawer(container, bonusId) {
  const overlay = container.querySelector("#bonus-drawer-overlay");
  const drawer = container.querySelector("#bonus-drawer");
  if (!overlay || !drawer) return;
  const bonus = bonusesCache.find((item) => item.id === bonusId);
  if (!bonus) return;
  const employeeLabel =
    bonus.employee?.name || bonus.forName || bonus.employee?.email || bonus.forEmail || "Colaborador";
  drawer.querySelector(".drawer-title").innerHTML = `
    <h3>${TYPE_LABEL[bonus.type] || bonus.type} • ${employeeLabel}</h3>
    <div><span class="${statusBadge(bonus.status)}">${statusLabel(bonus.status)}</span></div>
  `;
  const summary = `
    <ul class="list-unstyled">
      <li><strong>Colaborador:</strong> ${employeeLabel}</li>
      <li><strong>E-mail:</strong> ${bonus.employee?.email || bonus.forEmail || "—"}</li>
      <li><strong>Gestor:</strong> ${bonus.managerName || "—"}</li>
      <li><strong>Centro de Custo:</strong> ${bonus.costCenter || "—"}</li>
      <li><strong>Competência:</strong> ${bonus.competence || "—"}</li>
      <li><strong>Natureza:</strong> ${NATURE_LABEL[bonus.nature] || bonus.nature || "—"}</li>
      <li><strong>Valor solicitado:</strong> ${formatCurrency(bonus.value)}</li>
      <li><strong>Valor aprovado:</strong> ${
        bonus.approvedValue != null ? formatCurrency(bonus.approvedValue) : "—"
      }</li>
      <li><strong>Criado em:</strong> ${formatDateTime(bonus.createdAt)}</li>
    </ul>
  `;
  drawer.querySelector("#bonus-drawer-summary").innerHTML = summary;
  drawer.querySelector("#bonus-drawer-reason").innerHTML = `<p>${
    (bonus.reason || "—").replace(/\n/g, "<br>")
  }</p>`;
  const history = [];
  if (bonus.decidedAt) {
    history.push(
      `<li><strong>${statusLabel(bonus.status)}</strong> em ${formatDateTime(bonus.decidedAt)}<br><small>${
        bonus.decidedBy || "—"
      }</small></li>`
    );
  }
  history.push(
    `<li><strong>Criado</strong> em ${formatDateTime(bonus.createdAt)}<br><small>${
      bonus.createdBy || "—"
    }</small></li>`
  );
  drawer.querySelector("#bonus-drawer-history").innerHTML = `<ul class="list-unstyled">${history.join("")}</ul>`;
  if (bonus.attachments.length) {
    drawer.querySelector("#bonus-drawer-files").innerHTML = `
      <ul class="list-unstyled">
        ${bonus.attachments
          .map(
            (file) =>
              `<li><a href="${file.url}" target="_blank" rel="noopener">${file.name || file.url}</a></li>`
          )
          .join("")}
      </ul>`;
  } else {
    drawer.querySelector("#bonus-drawer-files").innerHTML = "<p class=\"helper\">Sem anexos.</p>";
  }
  const actions = [];
  if (canEditBonus(bonus)) {
    actions.push(`<button class="btn" data-bonus-action="drawer-edit" data-id="${bonus.id}">✏️ Editar</button>`);
  }
  if (canApproveBonus(bonus)) {
    actions.push(
      `<button class="btn" data-bonus-action="drawer-approve" data-id="${bonus.id}">✅ Aprovar</button>`
    );
    actions.push(
      `<button class="btn ghost" data-bonus-action="drawer-reject" data-id="${bonus.id}">❌ Rejeitar</button>`
    );
  }
  if (canSendToPayroll(bonus)) {
    actions.push(
      `<button class="btn" data-bonus-action="drawer-payroll" data-id="${bonus.id}">🧾 Enviar p/ Folha</button>`
    );
  }
  if (canCancelBonus(bonus)) {
    actions.push(
      `<button class="btn ghost" data-bonus-action="drawer-cancel" data-id="${bonus.id}">🗑️ Cancelar</button>`
    );
  }
  actions.push(
    `<button class="btn ghost" data-bonus-action="drawer-pdf" data-id="${bonus.id}">📄 Gerar PDF</button>`
  );
  drawer.querySelector("#bonus-drawer-actions").innerHTML = actions.length
    ? actions.join("<br>")
    : "<p class=\"helper\">Sem ações disponíveis.</p>";
  overlay.classList.remove("hidden");
  drawer.classList.remove("hidden");
  drawer.dataset.id = bonus.id;
}

function closeDrawer(container) {
  const overlay = container.querySelector("#bonus-drawer-overlay");
  const drawer = container.querySelector("#bonus-drawer");
  if (!overlay || !drawer) return;
  overlay.classList.add("hidden");
  drawer.classList.add("hidden");
  drawer.dataset.id = "";
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
  const content = document.createElement("div");
  content.className = "modal-content";
  card.append(closeBtn, content);
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);
  renderFn({ backdrop, card, content, close: () => closeModal(backdrop) });
}

function closeModal(backdrop) {
  if (!backdrop) return;
  backdrop.classList.add("closing");
  setTimeout(() => backdrop.remove(), 180);
}
function getEmployeeOptions(selected) {
  return employeesCache
    .slice()
    .sort((a, b) => (a.name || a.email || "").localeCompare(b.name || b.email || ""))
    .map(
      (emp) =>
        `<option value="${emp.uid}" ${selected === emp.uid ? "selected" : ""}>${emp.name || emp.email} (${emp.email ||
          "sem e-mail"})</option>`
    )
    .join("");
}

function getTypeOptions(selected) {
  return Object.entries(TYPE_LABEL)
    .map(([value, label]) => `<option value="${value}" ${selected === value ? "selected" : ""}>${label}</option>`)
    .join("");
}

function getNatureOptions(selected) {
  return Object.entries(NATURE_LABEL)
    .map(([value, label]) => `<option value="${value}" ${selected === value ? "selected" : ""}>${label}</option>`)
    .join("");
}

function validateBonusPayload(data) {
  const errors = [];
  if (!data.forUid) errors.push("Selecione o colaborador.");
  if (!data.value || data.value <= 0) errors.push("Valor deve ser maior que zero.");
  if (!data.costCenter) errors.push("Centro de custo é obrigatório.");
  if (!data.competence || !/^\d{4}-\d{2}$/.test(data.competence)) errors.push("Competência deve estar no formato AAAA-MM.");
  if (!data.reason || data.reason.trim().length < 10) errors.push("Motivo deve ter ao menos 10 caracteres.");
  const limit = MAX_VALUE_BY_TYPE[data.type];
  if (limit && data.value > limit) {
    errors.push(`Valor máximo para ${TYPE_LABEL[data.type]} é ${formatCurrency(limit)}.`);
  }
  return errors;
}

async function uploadAttachments(forUid, competence, files) {
  if (!files || !files.length) return [];
  const uploads = [];
  for (const file of files) {
    const stamp = Date.now();
    const slug = slugify(file.name.replace(/\.[^.]+$/, ""));
    const ext = file.name.includes(".") ? file.name.split(".").pop() : "dat";
    const path = `rh/bonuses/${forUid}/${competence}/${stamp}-${slug}.${ext}`;
    const storageRef = ref(storage, path);
    const buffer = await file.arrayBuffer();
    await uploadBytes(storageRef, new Uint8Array(buffer), {
      contentType: file.type || "application/octet-stream"
    });
    const url = await getDownloadURL(storageRef);
    uploads.push({ name: file.name, url });
  }
  return uploads;
}

async function submitBonusForm(form, existing) {
  const data = new FormData(form);
  const forUid = data.get("forUid");
  const employee = getEmployeeByUid(forUid) || getEmployeeByEmail(data.get("forEmail"));
  const costCenter = data.get("costCenter") || employee?.costCenter || "";
  const value = Number(parseFloat(String(data.get("value") || "0").replace(",", ".")));
  const payload = {
    forUid,
    forEmail: employee?.email || data.get("forEmail") || "",
    managerUid: employee?.managerUid || data.get("managerUid") || "",
    managerName: employee?.managerName || data.get("managerName") || "",
    costCenter,
    type: data.get("type") || "Bonus",
    nature: data.get("nature") || "Remuneratoria",
    value,
    reason: String(data.get("reason") || "").trim(),
    competence: data.get("competence") || "",
    attachments: existing?.attachments || [],
    status: existing?.status || "PENDENTE_GESTAO",
    createdAt: existing?.createdAt || new Date().toISOString(),
    createdBy: existing?.createdBy || getUser()?.uid || "",
    createdRole: existing?.createdRole || getProfile().role || "RH",
    decidedBy: existing?.decidedBy || null,
    decidedAt: existing?.decidedAt || null,
    decisionNotes: existing?.decisionNotes || "",
    approvedValue: existing?.approvedValue ?? null
  };
  const errors = validateBonusPayload(payload);
  if (errors.length) {
    throw new Error(errors.join("\n"));
  }
  const files = form.querySelector("input[type='file']")?.files;
  if (files && files.length) {
    const uploads = await uploadAttachments(payload.forUid, payload.competence, files);
    payload.attachments = [...payload.attachments, ...uploads];
  }
  if (existing) {
    await updateDoc(doc(db, "bonuses", existing.id), {
      forUid: payload.forUid,
      forEmail: payload.forEmail,
      managerUid: payload.managerUid,
      managerName: payload.managerName,
      costCenter: payload.costCenter,
      type: payload.type,
      nature: payload.nature,
      value: payload.value,
      reason: payload.reason,
      competence: payload.competence,
      attachments: payload.attachments,
      updatedAt: new Date().toISOString()
    });
    await logActivity("bonus.update", {
      id: existing.id,
      email: payload.forEmail,
      type: payload.type,
      competence: payload.competence
    });
  } else {
    const docRef = await addDoc(collection(db, "bonuses"), payload);
    await logActivity("bonus.create", {
      id: docRef.id,
      email: payload.forEmail,
      type: payload.type,
      competence: payload.competence
    });
  }
}

function openBonusModal(existing) {
  openModal(({ content, close }) => {
    const defaults = existing
      ? {
          forUid: existing.forUid || existing.employee?.uid || "",
          costCenter: existing.costCenter || existing.employee?.costCenter || "",
          type: existing.type || "Bonus",
          nature: existing.nature || "Remuneratoria",
          value: existing.value || 0,
          reason: existing.reason || "",
          competence: existing.competence || "",
          managerUid: existing.managerUid || existing.employee?.managerUid || "",
          managerName: existing.managerName || existing.employee?.managerName || "",
          attachments: existing.attachments || []
        }
      : {
          forUid: "",
          costCenter: "",
          type: "Bonus",
          nature: "Remuneratoria",
          value: 0,
          reason: "",
          competence: new Date().toISOString().slice(0, 7),
          managerUid: "",
          managerName: "",
          attachments: []
        };
    content.innerHTML = `
      <h2>${existing ? "Editar lançamento" : "Novo lançamento"}</h2>
      <form class="grid" id="bonus-form" style="grid-template-columns:1fr 1fr;gap:1rem">
        <label class="stack">
          <span>Colaborador</span>
          <select name="forUid" class="input" required>${getEmployeeOptions(defaults.forUid)}</select>
        </label>
        <label class="stack">
          <span>Gestor responsável</span>
          <input name="managerName" class="input" value="${defaults.managerName || ""}" readonly />
          <input type="hidden" name="managerUid" value="${defaults.managerUid || ""}" />
        </label>
        <label class="stack">
          <span>Tipo</span>
          <select name="type" class="input" required>${getTypeOptions(defaults.type)}</select>
        </label>
        <label class="stack">
          <span>Natureza</span>
          <select name="nature" class="input" required>${getNatureOptions(defaults.nature)}</select>
        </label>
        <label class="stack">
          <span>Valor (R$)</span>
          <input type="number" step="0.01" min="0" name="value" class="input" value="${Number(defaults.value || 0).toFixed(
            2
          )}" required />
        </label>
        <label class="stack">
          <span>Centro de Custo</span>
          <input name="costCenter" class="input" value="${defaults.costCenter || ""}" required />
        </label>
        <label class="stack">
          <span>Competência</span>
          <input type="month" name="competence" class="input" value="${defaults.competence || ""}" required />
        </label>
        <label class="stack" style="grid-column:span 2">
          <span>Motivo/Justificativa</span>
          <textarea name="reason" class="input" rows="4" minlength="10" required>${defaults.reason || ""}</textarea>
        </label>
        <label class="stack" style="grid-column:span 2">
          <span>Anexo (opcional)</span>
          <input type="file" class="input" accept="application/pdf,image/*" />
        </label>
        <div class="stack" style="grid-column:span 2">
          <button type="submit" class="btn">${existing ? "Salvar alterações" : "Criar lançamento"}</button>
        </div>
      </form>
    `;
    const form = content.querySelector("#bonus-form");
    const collaboratorSelect = form.querySelector("select[name='forUid']");
    collaboratorSelect.addEventListener("change", (event) => {
      const employee = getEmployeeByUid(event.target.value);
      if (employee) {
        form.querySelector("input[name='managerName']").value = employee.managerName || "";
        form.querySelector("input[name='managerUid']").value = employee.managerUid || "";
        const costCenterInput = form.querySelector("input[name='costCenter']");
        if (!costCenterInput.value) costCenterInput.value = employee.costCenter || "";
      }
    });
    if (defaults.forUid) {
      const employee = getEmployeeByUid(defaults.forUid);
      if (employee) {
        form.querySelector("input[name='managerName']").value = employee.managerName || defaults.managerName || "";
        form.querySelector("input[name='managerUid']").value = employee.managerUid || defaults.managerUid || "";
        const costCenterInput = form.querySelector("input[name='costCenter']");
        if (!costCenterInput.value) costCenterInput.value = employee.costCenter || defaults.costCenter || "";
      }
    }
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await submitBonusForm(form, existing);
        await ensureBonuses();
        renderCurrentView();
        close();
      } catch (err) {
        alert(err.message || "Não foi possível salvar o lançamento.");
      }
    });
  });
}
function renderValueByType(valueByType) {
  return `
    <ul class="list-inline">
      ${Object.entries(valueByType)
        .map(
          ([type, value]) => `<li><span class="pill">${TYPE_LABEL[type]}</span><span class="pill-value">${formatCurrency(
            value
          )}</span></li>`
        )
        .join("")}
    </ul>
  `;
}

function renderAdminSection(container) {
  const applied = applyFilters(bonusesCache);
  const kpis = computeKpis(applied);
  const costCenters = getCostCenters();
  const managers = getManagersOptions();
  const employees = getEmployeeOptionsList();
  container.innerHTML = `
    <div class="grid cols-5">
      <div class="kpi"><div class="label">Total de lançamentos</div><div class="value">${kpis.total}</div></div>
      <div class="kpi"><div class="label">Aguardando aprovação</div><div class="value">${kpis.pending}</div></div>
      <div class="kpi"><div class="label">Aprovados</div><div class="value">${kpis.approved}</div></div>
      <div class="kpi"><div class="label">Em folha</div><div class="value">${kpis.inPayroll}</div></div>
      <div class="kpi"><div class="label">Valor total</div><div class="value">${formatCurrency(
        kpis.totalValue
      )}</div><small class="helper">Somatório considerando valor aprovado.</small></div>
    </div>
    <div class="card" style="margin-top:1rem">
      <h3>Valor por tipo</h3>
      ${renderValueByType(kpis.valueByType)}
    </div>
    <div class="card" style="margin-top:1rem">
      <form id="bonus-filters" class="grid" style="grid-template-columns:repeat(6,1fr);gap:1rem">
        <label class="stack">
          <span>Período (competência)</span>
          <input type="month" name="period" class="input" value="${currentFilters.period || ""}" />
        </label>
        <label class="stack">
          <span>Status</span>
          <select name="status" class="input">
            <option value="">Todos</option>
            ${STATUS_FLOW_ORDER.map(
              (status) =>
                `<option value="${status}" ${currentFilters.status === status ? "selected" : ""}>${statusLabel(
                  status
                )}</option>`
            ).join("")}
          </select>
        </label>
        <label class="stack">
          <span>Tipo</span>
          <select name="type" class="input">
            <option value="">Todos</option>
            ${Object.entries(TYPE_LABEL)
              .map(
                ([value, label]) =>
                  `<option value="${value}" ${currentFilters.type === value ? "selected" : ""}>${label}</option>`
              )
              .join("")}
          </select>
        </label>
        <label class="stack">
          <span>Centro de Custo</span>
          <select name="costCenter" class="input">
            <option value="">Todos</option>
            ${costCenters
              .map(
                (center) =>
                  `<option value="${center}" ${currentFilters.costCenter === center ? "selected" : ""}>${center}</option>`
              )
              .join("")}
          </select>
        </label>
        <label class="stack">
          <span>Gestor</span>
          <select name="manager" class="input">
            <option value="">Todos</option>
            ${managers
              .map(
                ([value, label]) =>
                  `<option value="${value}" ${currentFilters.manager === value ? "selected" : ""}>${label}</option>`
              )
              .join("")}
          </select>
        </label>
        <label class="stack">
          <span>Colaborador</span>
          <select name="employee" class="input">
            <option value="">Todos</option>
            ${employees
              .map(
                ([value, label]) =>
                  `<option value="${value}" ${currentFilters.employee === value ? "selected" : ""}>${label}</option>`
              )
              .join("")}
          </select>
        </label>
        <label class="stack" style="grid-column:span 6">
          <span>Busca livre</span>
          <input type="search" name="search" class="input" placeholder="Motivo, colaborador, gestor..." value="${
            currentFilters.searchRaw || ""
          }" />
        </label>
      </form>
    </div>
    <div class="card" style="margin-top:1rem">
      <div style="display:flex;justify-content:space-between;gap:1rem;align-items:center;margin-bottom:1rem">
        <div class="stack" style="flex-direction:row;gap:.5rem;flex-wrap:wrap">
          <button class="btn" data-bonus-action="new">➕ Novo Lançamento</button>
          <button class="btn ghost" data-bonus-action="import">📥 Importar CSV</button>
          <button class="btn ghost" data-bonus-action="send-payroll">🧾 Enviar mês para Folha</button>
        </div>
        <div class="stack" style="flex-direction:row;gap:.5rem">
          <button class="btn ghost" data-bonus-action="export">📤 Exportar CSV/Excel</button>
        </div>
      </div>
      <div class="table-scroll">
        <table class="table" id="bonus-table">
          <thead>
            <tr>
              <th></th>
              <th>Colaborador</th>
              <th>Tipo</th>
              <th>Valor (R$)</th>
              <th>Centro de Custo</th>
              <th>Motivo</th>
              <th>Gestor</th>
              <th>Status</th>
              <th>Criado em</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            ${applied
              .map((item) => {
                const baseValue = item.approvedValue != null ? item.approvedValue : item.value;
                const canSelect = item.status === "APROVADO";
                return `
                  <tr data-id="${item.id}">
                    <td>${
                      canSelect
                        ? `<input type="checkbox" data-bonus-action="select" value="${item.id}" ${
                            currentSelection.has(item.id) ? "checked" : ""
                          } />`
                        : ""
                    }</td>
                    <td><strong>${
                      item.employee?.name || item.forName || item.employee?.email || item.forEmail || "—"
                    }</strong><br><small class="helper">${item.employee?.email || item.forEmail || "—"}</small></td>
                    <td>${TYPE_LABEL[item.type] || item.type}</td>
                    <td>${formatCurrency(baseValue)}</td>
                    <td>${item.costCenter || "—"}</td>
                    <td>${(item.reason || "—").slice(0, 70)}${item.reason?.length > 70 ? "…" : ""}</td>
                    <td>${item.managerName || "—"}</td>
                    <td><span class="${statusBadge(item.status)}">${statusLabel(item.status)}</span></td>
                    <td>${formatDate(item.createdAt)}</td>
                    <td>
                      <div class="stack" style="flex-direction:row;gap:.25rem;flex-wrap:wrap">
                        <button class="btn ghost" data-bonus-action="detail" data-id="${item.id}">🔎 Detalhes</button>
                        ${
                          canEditBonus(item)
                            ? `<button class="btn ghost" data-bonus-action="edit" data-id="${item.id}">✏️ Editar</button>`
                            : ""
                        }
                        ${
                          canCancelBonus(item)
                            ? `<button class="btn ghost" data-bonus-action="cancel" data-id="${item.id}">🗑️ Cancelar</button>`
                            : ""
                        }
                        ${
                          canSendToPayroll(item)
                            ? `<button class="btn ghost" data-bonus-action="payroll" data-id="${item.id}">🧾 Enviar p/ Folha</button>`
                            : ""
                        }
                        <button class="btn ghost" data-bonus-action="pdf" data-id="${item.id}">📄 PDF</button>
                        <button class="btn ghost" data-bonus-action="export-single" data-id="${item.id}">📤 CSV</button>
                      </div>
                    </td>
                  </tr>
                `;
              })
              .join("")}
          </tbody>
        </table>
      </div>
      ${buildDrawerSkeleton()}
    </div>
  `;
  ensureDrawerHandlers(container);
  bindAdminEvents(container);
}
function renderGestorSection(container) {
  const user = getUser();
  const pending = bonusesCache.filter((item) => item.status === "PENDENTE_GESTAO");
  const scopedPending = pending.filter((item) => item.managerUid === user?.uid);
  const approved = bonusesCache.filter((item) => item.status === "APROVADO" && item.managerUid === user?.uid);
  const totalApproved = approved.reduce((sum, item) => {
    const baseValue = item.approvedValue != null ? item.approvedValue : item.value;
    return sum + baseValue;
  }, 0);
  container.innerHTML = `
    <div class="grid cols-2">
      <div class="kpi"><div class="label">Pendentes para aprovar</div><div class="value">${scopedPending.length}</div></div>
      <div class="kpi"><div class="label">Valor aprovado no mês</div><div class="value">${formatCurrency(
        totalApproved
      )}</div></div>
    </div>
    <div class="card" style="margin-top:1rem">
      <h3>Fila de aprovação</h3>
      ${scopedPending.length
        ? `<div class="table-scroll">
            <table class="table">
              <thead>
                <tr>
                  <th>Colaborador</th>
                  <th>Tipo</th>
                  <th>Valor (R$)</th>
                  <th>Centro de Custo</th>
                  <th>Motivo</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${scopedPending
                  .map((item) => `
                      <tr data-id="${item.id}">
                        <td>${item.employee?.name || item.forEmail || "—"}</td>
                        <td>${TYPE_LABEL[item.type] || item.type}</td>
                        <td>${formatCurrency(item.value)}</td>
                        <td>${item.costCenter || "—"}</td>
                        <td>${(item.reason || "—").slice(0, 80)}${item.reason?.length > 80 ? "…" : ""}</td>
                        <td>
                          <div class="stack" style="flex-direction:row;gap:.25rem;flex-wrap:wrap">
                            <button class="btn" data-bonus-action="approve" data-id="${item.id}">✅ Aprovar</button>
                            <button class="btn ghost" data-bonus-action="reject" data-id="${item.id}">❌ Rejeitar</button>
                            <button class="btn ghost" data-bonus-action="detail" data-id="${item.id}">🔎 Detalhes</button>
                          </div>
                        </td>
                      </tr>
                    `)
                  .join("")}
              </tbody>
            </table>
          </div>`
        : `<p class="helper">Sem pendências no momento.</p>`}
    </div>
    <div class="card" style="margin-top:1rem">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem">
        <h3>Histórico do time</h3>
        <button class="btn ghost" data-bonus-action="export">📤 Exportar CSV</button>
      </div>
      <div class="table-scroll">
        <table class="table">
          <thead>
            <tr>
              <th>Colaborador</th>
              <th>Tipo</th>
              <th>Valor aprovado</th>
              <th>Status</th>
              <th>Competência</th>
              <th>Atualizado em</th>
            </tr>
          </thead>
          <tbody>
            ${bonusesCache
              .filter((item) => item.managerUid === user?.uid)
              .map(
                (item) => `
                  <tr data-id="${item.id}">
                    <td>${item.employee?.name || item.forEmail || "—"}</td>
                    <td>${TYPE_LABEL[item.type] || item.type}</td>
                    <td>${formatCurrency(item.approvedValue != null ? item.approvedValue : item.value)}</td>
                    <td><span class="${statusBadge(item.status)}">${statusLabel(item.status)}</span></td>
                    <td>${item.competence || "—"}</td>
                    <td>${formatDate(item.decidedAt || item.createdAt)}</td>
                  </tr>
                `
              )
              .join("")}
          </tbody>
        </table>
      </div>
      ${buildDrawerSkeleton()}
    </div>
  `;
  ensureDrawerHandlers(container);
  bindGestorEvents(container);
}

function renderCollaboratorSection(container) {
  container.innerHTML = `
    <div class="card">
      <h3>Meus lançamentos</h3>
      <p class="helper">Acompanhe o status dos seus bônus, premiações, abonos e gratificações.</p>
      <div class="table-scroll">
        <table class="table">
          <thead>
            <tr>
              <th>Tipo</th>
              <th>Valor</th>
              <th>Status</th>
              <th>Competência</th>
              <th>Motivo</th>
              <th>Gestor</th>
              <th>Atualizado em</th>
            </tr>
          </thead>
          <tbody>
            ${
              bonusesCache.length
                ? bonusesCache
                    .map(
                      (item) => `
                        <tr>
                          <td>${TYPE_LABEL[item.type] || item.type}</td>
                          <td>${formatCurrency(item.approvedValue != null ? item.approvedValue : item.value)}</td>
                          <td><span class="${statusBadge(item.status)}">${statusLabel(item.status)}</span></td>
                          <td>${item.competence || "—"}</td>
                          <td>${(item.reason || "—").slice(0, 90)}${item.reason?.length > 90 ? "…" : ""}</td>
                          <td>${item.managerName || "—"}</td>
                          <td>${formatDate(item.decidedAt || item.createdAt)}</td>
                        </tr>
                      `
                    )
                    .join("")
                : `<tr><td colspan="7"><p class="helper">Nenhum lançamento registrado.</p></td></tr>`
            }
          </tbody>
        </table>
      </div>
    </div>
  `;
}
function attachCommonHandlers(container) {
  if (container.__bonusHandlers) return;
  const clickHandler = (event) => {
    const actionTarget = event.target.closest("[data-bonus-action]");
    if (!actionTarget) {
      const row = event.target.closest("tbody tr");
      if (row && !event.target.closest("button") && !event.target.closest("a") && !event.target.closest("input")) {
        openDrawer(container, row.dataset.id);
      }
      return;
    }
    event.preventDefault();
    const action = actionTarget.dataset.bonusAction;
    const id = actionTarget.dataset.id || actionTarget.value;
    handleBonusAction(action, id, container);
  };
  const changeHandler = (event) => {
    if (event.target.matches("[data-bonus-action='select']")) {
      const id = event.target.value;
      if (event.target.checked) {
        currentSelection.add(id);
      } else {
        currentSelection.delete(id);
      }
    }
  };
  container.addEventListener("click", clickHandler);
  container.addEventListener("change", changeHandler);
  container.__bonusHandlers = { clickHandler, changeHandler };
}

function bindAdminEvents(container) {
  attachCommonHandlers(container);
  const form = container.querySelector("#bonus-filters");
  if (form) {
    const handler = () => {
      const data = new FormData(form);
      const rawSearch = String(data.get("search") || "");
      currentFilters = {
        period: data.get("period") || "",
        status: data.get("status") || "",
        type: data.get("type") || "",
        costCenter: data.get("costCenter") || "",
        manager: data.get("manager") || "",
        employee: data.get("employee") || "",
        search: rawSearch.trim().toLowerCase(),
        searchRaw: rawSearch
      };
      renderCurrentView();
    };
    form.addEventListener("change", handler);
    form.addEventListener("input", handler);
  }
}

function bindGestorEvents(container) {
  attachCommonHandlers(container);
}

function handleBonusAction(action, id, container) {
  switch (action) {
    case "new":
      openBonusModal();
      break;
    case "import":
      openImportModal();
      break;
    case "send-payroll":
      openSendPayrollModal(container);
      break;
    case "export":
      exportCurrentView();
      break;
    case "detail":
      openDrawer(container, id);
      break;
    case "edit":
    case "drawer-edit":
      openBonusModal(bonusesCache.find((item) => item.id === id));
      break;
    case "cancel":
    case "drawer-cancel":
      confirmCancel(id);
      break;
    case "payroll":
    case "drawer-payroll":
      sendBonusesToPayroll([id]);
      break;
    case "pdf":
    case "drawer-pdf":
      generateBonusPdf(id);
      break;
    case "export-single":
      exportSingleBonus(id);
      break;
    case "approve":
    case "drawer-approve":
      openDecisionModal(id, "approve");
      break;
    case "reject":
    case "drawer-reject":
      openDecisionModal(id, "reject");
      break;
    default:
      break;
  }
}

function exportCurrentView() {
  const profile = getProfile();
  let items = bonusesCache;
  if (canManage()) {
    items = applyFilters(bonusesCache);
  } else if (isGestor() && !isAdmin()) {
    items = bonusesCache.filter((item) => item.managerUid === getUser()?.uid);
  }
  if (!items.length) {
    alert("Sem registros para exportar.");
    return;
  }
  downloadFile(`bonuses-${new Date().toISOString().slice(0, 10)}.csv`, toCSV(items));
}

function exportSingleBonus(id) {
  const bonus = bonusesCache.find((item) => item.id === id);
  if (!bonus) return;
  downloadFile(`bonus-${id}.csv`, toCSV([bonus]));
}

function generateBonusPdf(id) {
  const bonus = bonusesCache.find((item) => item.id === id);
  if (!bonus) return;
  const employeeLabel =
    bonus.employee?.name || bonus.forName || bonus.employee?.email || bonus.forEmail || "Colaborador";
  const win = window.open("", "_blank");
  if (!win) {
    alert("Permita pop-ups para gerar o PDF.");
    return;
  }
  const approvedValue = bonus.approvedValue != null ? bonus.approvedValue : bonus.value;
  win.document.write(`
    <html>
      <head>
        <meta charset="utf-8" />
        <title>Resumo do lançamento</title>
        <style>
          body{font-family:Arial,sans-serif;padding:2rem;line-height:1.6}
          h1{margin-top:0}
          ul{list-style:none;padding:0}
          li{margin-bottom:.5rem}
          .badge{display:inline-block;padding:.25rem .5rem;border-radius:.4rem;background:#f1f5f9}
        </style>
      </head>
      <body>
        <h1>${TYPE_LABEL[bonus.type] || bonus.type}</h1>
        <p><span class="badge">${statusLabel(bonus.status)}</span></p>
        <ul>
          <li><strong>Colaborador:</strong> ${employeeLabel}</li>
          <li><strong>E-mail:</strong> ${bonus.employee?.email || bonus.forEmail || "—"}</li>
          <li><strong>Gestor:</strong> ${bonus.managerName || "—"}</li>
          <li><strong>Centro de Custo:</strong> ${bonus.costCenter || "—"}</li>
          <li><strong>Competência:</strong> ${bonus.competence || "—"}</li>
          <li><strong>Natureza:</strong> ${NATURE_LABEL[bonus.nature] || bonus.nature || "—"}</li>
          <li><strong>Valor solicitado:</strong> ${formatCurrency(bonus.value)}</li>
          <li><strong>Valor aprovado:</strong> ${formatCurrency(approvedValue)}</li>
          <li><strong>Motivo:</strong> ${(bonus.reason || "—").replace(/\n/g, "<br>")}</li>
          <li><strong>Criado em:</strong> ${formatDateTime(bonus.createdAt)}</li>
          <li><strong>Decisão:</strong> ${bonus.decidedAt ? `${formatDateTime(bonus.decidedAt)} • ${bonus.decidedBy || "—"}` : "—"}</li>
        </ul>
      </body>
    </html>
  `);
  win.document.close();
  setTimeout(() => win.print(), 200);
}

async function confirmCancel(id) {
  const bonus = bonusesCache.find((item) => item.id === id);
  if (!bonus || !canCancelBonus(bonus)) return;
  if (!confirm("Confirma cancelar este lançamento?")) return;
  await updateDoc(doc(db, "bonuses", id), {
    status: "CANCELADO",
    decidedAt: new Date().toISOString(),
    decidedBy: getUser()?.email || getProfile().name || "Sistema",
    decisionNotes: "Cancelado pelo RH/ADM"
  });
  await logActivity("bonus.cancel", {
    id,
    email: bonus.forEmail,
    type: bonus.type,
    competence: bonus.competence
  });
  currentSelection.delete(id);
  await ensureBonuses();
  renderCurrentView();
}

async function sendBonusesToPayroll(ids) {
  const list = bonusesCache.filter((item) => ids.includes(item.id) && canSendToPayroll(item));
  if (!list.length) {
    alert("Selecione ao menos um lançamento aprovado.");
    return;
  }
  for (const item of list) {
    const value = item.approvedValue != null ? item.approvedValue : item.value;
    try {
      await updateDoc(doc(db, "bonuses", item.id), {
        status: "EM_FOLHA",
        payrollSentAt: new Date().toISOString(),
        payrollSentBy: getUser()?.email || getProfile().name || "Sistema"
      });
      if (item.forUid) {
        await setDoc(doc(db, "holeriteItems", item.forUid, item.competence || "sem-competencia", item.id), {
          type: item.type,
          nature: item.nature,
          value,
          costCenter: item.costCenter || "",
          refBonusId: item.id,
          createdAt: new Date().toISOString()
        });
      }
      await logActivity("bonus.payroll", {
        id: item.id,
        email: item.forEmail,
        competence: item.competence,
        value
      });
      currentSelection.delete(item.id);
    } catch (err) {
      console.warn("Falha ao enviar para folha", err);
    }
  }
  await ensureBonuses();
  renderCurrentView();
}

function openSendPayrollModal(container) {
  const ids = [...currentSelection];
  if (!ids.length) {
    alert("Marque os lançamentos aprovados que deseja enviar.");
    return;
  }
  const items = bonusesCache.filter((item) => ids.includes(item.id));
  openModal(({ content, close }) => {
    const total = items.reduce((sum, item) => sum + (item.approvedValue != null ? item.approvedValue : item.value), 0);
    content.innerHTML = `
      <h2>Enviar para folha</h2>
      <p class="helper">${ids.length} lançamento(s) serão enviados para a competência indicada em cada registro.</p>
      <ul class="list-unstyled">
        ${items
          .map(
            (item) =>
              `<li><strong>${item.employee?.name || item.forEmail || item.id}</strong> • ${item.competence || "—"} • ${formatCurrency(
                item.approvedValue != null ? item.approvedValue : item.value
              )}</li>`
          )
          .join("")}
      </ul>
      <p><strong>Total:</strong> ${formatCurrency(total)}</p>
      <div class="stack" style="flex-direction:row;gap:.5rem">
        <button class="btn" id="confirm-send">Enviar agora</button>
        <button class="btn ghost" id="cancel-send">Cancelar</button>
      </div>
    `;
    content.querySelector("#confirm-send").addEventListener("click", async () => {
      await sendBonusesToPayroll(ids);
      close();
    });
    content.querySelector("#cancel-send").addEventListener("click", () => close());
  });
}

function normalizeTypeKey(value) {
  if (!value) return "Bonus";
  const lower = String(value).toLowerCase();
  const found = Object.entries(TYPE_LABEL).find(
    ([key, label]) => key.toLowerCase() === lower || label.toLowerCase() === lower
  );
  return found ? found[0] : "Bonus";
}

function normalizeNatureKey(value) {
  if (!value) return "Remuneratoria";
  const lower = String(value).toLowerCase();
  const found = Object.entries(NATURE_LABEL).find(
    ([key, label]) => key.toLowerCase() === lower || label.toLowerCase() === lower
  );
  return found ? found[0] : "Remuneratoria";
}

function parseBonusCsv(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error("Arquivo vazio.");
  const delimiter = lines[0].includes(";") ? ";" : ",";
  const header = lines[0].split(delimiter).map((h) => h.trim().toLowerCase());
  const required = ["email", "tipo", "valor", "centro", "competencia", "motivo"];
  const missing = required.filter((key) => !header.includes(key));
  if (missing.length) {
    throw new Error(`Cabeçalho inválido. Campos obrigatórios: ${missing.join(", ")}`);
  }
  return lines.slice(1).map((line) => {
    const cols = line.split(delimiter).map((c) => c.trim());
    const map = {};
    header.forEach((key, index) => {
      map[key] = cols[index] || "";
    });
    return {
      email: map.email,
      type: normalizeTypeKey(map.tipo),
      nature: normalizeNatureKey(map.natureza || map.nature || "Remuneratoria"),
      value: Number(parseFloat((map.valor || "0").replace(/[^0-9,.-]/g, "").replace(",", "."))),
      costCenter: map.centro || map["centro de custo"] || "",
      competence: (map.competencia || map.competência || "").replace("/", "-").slice(0, 7),
      reason: map.motivo || map.justificativa || "",
      attachments: []
    };
  });
}

async function importBonusRows(rows) {
  const created = [];
  for (const row of rows) {
    const employee = getEmployeeByEmail(row.email);
    if (!employee) continue;
    const payload = {
      forUid: employee.uid,
      forEmail: employee.email,
      managerUid: employee.managerUid || "",
      managerName: employee.managerName || "",
      costCenter: row.costCenter || employee.costCenter || "",
      type: row.type,
      nature: row.nature,
      value: row.value,
      reason: row.reason,
      competence: row.competence,
      attachments: row.attachments,
      status: "PENDENTE_GESTAO",
      createdAt: new Date().toISOString(),
      createdBy: getUser()?.uid || "",
      createdRole: getProfile().role || "RH",
      decidedBy: null,
      decidedAt: null,
      decisionNotes: "",
      approvedValue: null
    };
    const errors = validateBonusPayload(payload);
    if (errors.length) continue;
    const docRef = await addDoc(collection(db, "bonuses"), payload);
    created.push(docRef.id);
  }
  if (created.length) {
    await logActivity("bonus.import", { total: created.length });
  }
}

function openImportModal() {
  openModal(({ content, close }) => {
    content.innerHTML = `
      <h2>Importar CSV</h2>
      <p class="helper">Campos obrigatórios: email, tipo, valor, centro, competencia, motivo. Separador ; ou ,.</p>
      <form id="bonus-import-form" class="stack">
        <input type="file" class="input" accept=".csv,text/csv" required />
        <div class="stack" style="flex-direction:row;gap:.5rem">
          <button type="submit" class="btn">Importar</button>
          <button type="button" class="btn ghost" id="cancel-import">Cancelar</button>
        </div>
      </form>
    `;
    const form = content.querySelector("#bonus-import-form");
    const cancel = content.querySelector("#cancel-import");
    cancel.addEventListener("click", () => close());
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const file = form.querySelector("input[type='file']").files[0];
      if (!file) {
        alert("Selecione um arquivo CSV.");
        return;
      }
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const rows = parseBonusCsv(String(reader.result || ""));
          await importBonusRows(rows);
          await ensureBonuses();
          renderCurrentView();
          close();
        } catch (err) {
          alert(err.message || "Não foi possível importar o arquivo.");
        }
      };
      reader.readAsText(file, "utf-8");
    });
  });
}

function openDecisionModal(id, mode) {
  const bonus = bonusesCache.find((item) => item.id === id);
  if (!bonus || !canApproveBonus(bonus)) return;
  const title = mode === "approve" ? "Aprovar lançamento" : "Rejeitar lançamento";
  openModal(({ content, close }) => {
    content.innerHTML = `
      <h2>${title}</h2>
      <p class="helper">${TYPE_LABEL[bonus.type] || bonus.type} • ${bonus.employee?.name || bonus.forEmail || bonus.id}</p>
      <form id="bonus-decision" class="stack">
        <div class="card mini">
          <strong>Resumo</strong>
          <ul class="list-unstyled">
            <li><strong>Valor solicitado:</strong> ${formatCurrency(bonus.value)}</li>
            <li><strong>Centro de Custo:</strong> ${bonus.costCenter || "—"}</li>
            <li><strong>Competência:</strong> ${bonus.competence || "—"}</li>
            <li><strong>Motivo RH:</strong> ${(bonus.reason || "—").replace(/\n/g, "<br>")}</li>
          </ul>
        </div>
        ${
          mode === "approve"
            ? `<label class="stack"><span>Valor aprovado (R$)</span><input type="number" step="0.01" min="0" name="approvedValue" class="input" value="${
                bonus.value.toFixed(2)
              }" required /></label>`
            : ""
        }
        <label class="stack">
          <span>Decisão / Motivo do Gestor</span>
          <textarea name="decision" class="input" rows="4" minlength="5" required></textarea>
        </label>
        <div class="stack" style="flex-direction:row;gap:.5rem">
          <button type="submit" class="btn">${mode === "approve" ? "Aprovar" : "Rejeitar"}</button>
          <button type="button" class="btn ghost" id="close-decision">Cancelar</button>
        </div>
      </form>
    `;
    content.querySelector("#close-decision").addEventListener("click", () => close());
    const form = content.querySelector("#bonus-decision");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(form);
      const decisionNotes = String(formData.get("decision") || "").trim();
      if (decisionNotes.length < 5) {
        alert("Informe o motivo da decisão.");
        return;
      }
      const updates = {
        status: mode === "approve" ? "APROVADO" : "REJEITADO",
        decisionNotes,
        approvedValue: bonus.approvedValue
      };
      if (mode === "approve") {
        const approvedValue = Number(
          parseFloat(String(formData.get("approvedValue") || "0").replace(",", "."))
        );
        if (!Number.isFinite(approvedValue) || approvedValue <= 0) {
          alert("Informe um valor aprovado válido.");
          return;
        }
        if (approvedValue > bonus.value) {
          alert("Valor aprovado não pode ser maior que o solicitado.");
          return;
        }
        updates.approvedValue = approvedValue;
      }
      await decideBonus(bonus, updates);
      close();
    });
  });
}

async function decideBonus(bonus, updates) {
  await updateDoc(doc(db, "bonuses", bonus.id), {
    status: updates.status,
    approvedValue: updates.approvedValue != null ? updates.approvedValue : bonus.approvedValue ?? null,
    decidedAt: new Date().toISOString(),
    decidedBy: getUser()?.email || getProfile().name || "Gestor",
    decisionNotes: updates.decisionNotes
  });
  await logActivity(updates.status === "APROVADO" ? "bonus.approve" : "bonus.reject", {
    id: bonus.id,
    email: bonus.forEmail,
    competence: bonus.competence,
    value: updates.approvedValue != null ? updates.approvedValue : bonus.value
  });
  await ensureBonuses();
  renderCurrentView();
}

function renderCurrentView() {
  const view = document.getElementById("view");
  if (!view) return;
  const container = document.createElement("div");
  container.className = "stack";
  view.innerHTML = "";
  view.appendChild(container);
  if (canManage()) {
    renderAdminSection(container);
  } else if (isGestor()) {
    renderGestorSection(container);
  } else {
    renderCollaboratorSection(container);
  }
}

window.BonusesView = async function BonusesView() {
  await ensureEmployees();
  await ensureBonuses();
  currentSelection = new Set();
  currentFilters = {
    period: "",
    status: "",
    type: "",
    costCenter: "",
    manager: "",
    employee: "",
    search: "",
    searchRaw: ""
  };
  renderCurrentView();
};
