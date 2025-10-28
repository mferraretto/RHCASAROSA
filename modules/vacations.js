// Vacation management hub
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-auth.js";
import {
  getFirestore,
  collection,
  addDoc,
  getDocs,
  query,
  where,
  updateDoc,
  doc,
  orderBy,
  getDoc,
  runTransaction,
  setDoc
} from "https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js";
import { getStorage, ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-storage.js";
import { logActivity } from "./activity.js";

const db = getFirestore();
const storage = getStorage();
const auth = getAuth();

const MANAGER_ROLES = ["ADM", "Gestor", "RH"];

const VACATION_TYPES = [
  { value: "FULL", label: "30 dias" },
  { value: "20_10", label: "20 + 10" },
  { value: "15_15", label: "15 + 15" },
  { value: "SELL_10", label: "Abono 1/3 (venda de 10 dias)" },
  { value: "PARTIAL", label: "Férias parciais" }
];

const DEFAULT_SETTINGS = {
  minNoticeDays: 30,
  paymentAdvanceDays: 2,
  allowSellDays: true,
  allowSplit: true,
  maxSplits: 3,
  blockPointIntegration: true,
  sendNotifications: true
};

const STATUS_BADGES = {
  Pendente: "warn",
  Aprovada: "ok",
  Rejeitada: "danger",
  Cancelada: "",
  "Ajuste Solicitado": "warn"
};

let cachedContext = null;

function ensureArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

function formatDate(value) {
  if (!value) return "—";
  const d = new Date(`${value}T00:00:00`);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString("pt-BR");
}

function formatDateTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("pt-BR");
}

function diffInDays(start, end) {
  if (!start || !end) return 0;
  const a = new Date(`${start}T00:00:00`);
  const b = new Date(`${end}T00:00:00`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  const diff = (b - a) / (1000 * 60 * 60 * 24);
  return diff >= 0 ? diff + 1 : 0;
}

function todayISO() {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now.toISOString().slice(0, 10);
}

async function fetchVacationSettings() {
  const snap = await getDoc(doc(db, "vacationSettings", "general"));
  if (!snap.exists()) {
    return { ...DEFAULT_SETTINGS };
  }
  return { ...DEFAULT_SETTINGS, ...snap.data() };
}

async function saveVacationSettings(settings) {
  await setDoc(doc(db, "vacationSettings", "general"), settings, { merge: true });
}

async function fetchUserProfile(uid) {
  const ref = doc(db, "users", uid);
  const snap = await getDoc(ref);
  return snap.exists() ? { id: uid, ...snap.data() } : null;
}

async function listEmployeesMap() {
  const snap = await getDocs(collection(db, "employees"));
  const byEmail = new Map();
  const byUid = new Map();
  snap.forEach((d) => {
    const data = d.data();
    if (data.email) {
      byEmail.set(String(data.email).toLowerCase(), { id: d.id, ...data });
    }
    if (data.uid) {
      byUid.set(data.uid, { id: d.id, ...data });
    }
  });
  return { byEmail, byUid };
}

async function listVacationsByUser(uid) {
  const snap = await getDocs(
    query(collection(db, "vacations"), where("uid", "==", uid), orderBy("createdAt", "desc"))
  );
  const rows = [];
  snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
  return rows;
}

async function listAllVacations() {
  const snap = await getDocs(query(collection(db, "vacations"), orderBy("createdAt", "desc")));
  const rows = [];
  snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
  return rows;
}

function computeSegments(form) {
  const blocks = [];
  form.querySelectorAll(".vacation-period-row").forEach((row) => {
    const start = row.querySelector('[name="periodStart"]').value || null;
    const endInput = row.querySelector('[name="periodEnd"]');
    const endValue = endInput.value || null;
    const daysInput = row.querySelector('[name="periodDays"]');
    const manualDays = daysInput.value ? Number(daysInput.value) : null;
    let end = endValue;
    let days = manualDays;
    if (start && !days && end) {
      days = diffInDays(start, end);
    }
    if (start && days && !end) {
      const base = new Date(`${start}T00:00:00`);
      base.setDate(base.getDate() + (days - 1));
      end = base.toISOString().slice(0, 10);
    }
    if (start && (end || days)) {
      if (!days && start && end) {
        days = diffInDays(start, end);
      }
      blocks.push({ start, end, days });
    }
  });
  return blocks.filter((block) => block.days > 0);
}

function validateRequestPayload({ segments, balance, settings, abonoDays, existingApproved }) {
  const errors = [];
  if (!segments.length) {
    errors.push("Informe ao menos um período válido.");
  }
  const first = segments[0];
  if (first) {
    const diffNotice = diffInDays(todayISO(), first.start) - 1;
    if (settings?.minNoticeDays && diffNotice < settings.minNoticeDays) {
      errors.push(`O aviso mínimo é de ${settings.minNoticeDays} dias.`);
    }
  }
  const totalDays = segments.reduce((sum, item) => sum + (item.days || 0), 0);
  if (balance != null && totalDays + (abonoDays || 0) > balance) {
    errors.push("Saldo insuficiente para o total de dias solicitados.");
  }
  segments.forEach((segment) => {
    if (!segment.start) {
      errors.push("Informe a data de início.");
      return;
    }
    if (!segment.end) {
      errors.push("Informe a data final ou o total de dias.");
    }
    const overlap = existingApproved.some((req) => {
      if (req.status !== "Aprovada") return false;
      const reqSegments = ensureArray(req.segments && req.segments.length ? req.segments : [{ start: req.start, end: req.end }]);
      return reqSegments.some((range) => {
        if (!range.start || !range.end || !segment.end) return false;
        return !(segment.end < range.start || segment.start > range.end);
      });
    });
    if (overlap) {
      errors.push("O período informado sobrepõe férias já aprovadas.");
    }
  });
  return { errors, totalDays };
}

async function uploadAttachments(uid, files) {
  if (!files || !files.length) return [];
  const uploads = [];
  for (const file of files) {
    const path = `rh/vacations/${uid}/${Date.now()}-${file.name}`;
    const storageRef = ref(storage, path);
    await uploadBytes(storageRef, file);
    const url = await getDownloadURL(storageRef);
    uploads.push({ name: file.name, path, url, contentType: file.type || null });
  }
  return uploads;
}

async function createVacationRequest(form, context) {
  const segments = computeSegments(form);
  const abono = form.querySelector('[name="abono"]').checked;
  const abonoDaysInput = form.querySelector('[name="abonoDays"]');
  const abonoDays = abono ? Number(abonoDaysInput.value || 0) : 0;
  const splitType = form.querySelector('[name="splitType"]').value;
  const notes = form.querySelector('[name="notes"]').value.trim();
  const attachmentsInput = form.querySelector('[name="attachments"]');
  const attachmentsFiles = attachmentsInput?.files ? Array.from(attachmentsInput.files) : [];

  const { errors, totalDays } = validateRequestPayload({
    segments,
    balance: context?.profile?.vacationBalance ?? 30,
    settings: context?.settings,
    abonoDays,
    existingApproved: context?.myRequests || []
  });

  const feedback = form.querySelector('[data-feedback]');
  feedback.textContent = "";
  feedback.className = "helper";

  if (errors.length) {
    feedback.textContent = errors.join(" ");
    feedback.classList.add("danger");
    return;
  }

  const attachments = await uploadAttachments(context.user.uid, attachmentsFiles);
  const payload = {
    uid: context.user.uid,
    email: context.user.email,
    status: "Pendente",
    createdAt: new Date().toISOString(),
    splitType,
    abono,
    abonoDays,
    notes,
    days: totalDays,
    segments,
    start: segments[0]?.start || null,
    end: segments[segments.length - 1]?.end || null,
    attachments
  };

  await addDoc(collection(db, "vacations"), payload);
  await logActivity("vacation.request", { start: payload.start, end: payload.end, email: context.user.email, days: totalDays });
  feedback.textContent = "Solicitação registrada com sucesso.";
  feedback.classList.remove("danger");
  feedback.classList.add("ok");
  form.reset();
  const periodsContainer = form.querySelector('[data-periods]');
  if (periodsContainer) {
    periodsContainer.innerHTML = renderPeriodRow(1);
  }
  await reloadContext();
}

async function cancelRequest(id) {
  const requestRef = doc(db, "vacations", id);
  await updateDoc(requestRef, { status: "Cancelada", cancelledAt: new Date().toISOString() });
  await logActivity("vacation.update", { status: "Cancelada", id });
  if (cachedContext?.settings?.sendNotifications) {
    await queueNotification({
      uid: cachedContext.user.uid,
      email: cachedContext.user.email,
      status: "Cancelada",
      requestId: id,
      message: "Solicitação de férias cancelada pelo colaborador."
    });
  }
}

function buildNoticeDocument(request, employee) {
  const lines = [];
  lines.push("Casa Rosa — Aviso de Férias");
  lines.push("");
  lines.push(`Colaborador: ${employee?.name || request.email || "—"}`);
  lines.push(`E-mail: ${employee?.email || request.email || "—"}`);
  if (employee?.role) lines.push(`Cargo: ${employee.role}`);
  if (employee?.costCenter) lines.push(`Centro de custo: ${employee.costCenter}`);
  lines.push("");
  const segments = request.segments && request.segments.length ? request.segments : [{ start: request.start, end: request.end, days: request.days }];
  segments.forEach((segment, idx) => {
    lines.push(`Período ${idx + 1}: ${formatDate(segment.start)} até ${formatDate(segment.end)} (${segment.days || diffInDays(segment.start, segment.end)} dias)`);
  });
  lines.push(`Dias aprovados: ${request.approvedDays || request.days || segments.reduce((sum, seg) => sum + (seg.days || 0), 0)}`);
  if (request.abonoDays) {
    lines.push(`Dias vendidos (abono): ${request.abonoDays}`);
  }
  lines.push("");
  lines.push(`Emitido em: ${new Date().toLocaleDateString("pt-BR")}`);
  lines.push("");
  lines.push("Assinaturas:\n___________________________ (Empresa)\n___________________________ (Colaborador)");
  return lines.join("\n");
}

async function generateNoticePDF(request, employee) {
  const module = await import("https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js");
  const { jsPDF } = module;
  const docPdf = new jsPDF();
  const margin = 14;
  docPdf.setFont("helvetica", "bold");
  docPdf.setTextColor(255, 0, 138);
  docPdf.setFontSize(18);
  docPdf.text("Casa Rosa", margin, 20);
  docPdf.setFontSize(12);
  docPdf.setTextColor(0, 0, 0);
  docPdf.text("Aviso de Férias", margin, 30);
  docPdf.setFont("helvetica", "normal");

  const text = buildNoticeDocument(request, employee);
  docPdf.setFontSize(11);
  const split = docPdf.splitTextToSize(text, 180);
  docPdf.text(split, margin, 40);

  const fileName = `aviso-ferias-${request.id || Date.now()}.pdf`;
  const arrayBuffer = docPdf.output("arraybuffer");
  const path = `rh/vacations/notices/${request.uid}/${fileName}`;
  const storageRef = ref(storage, path);
  await uploadBytes(storageRef, new Uint8Array(arrayBuffer), { contentType: "application/pdf" });
  const url = await getDownloadURL(storageRef);

  await updateDoc(doc(db, "vacations", request.id), { noticeUrl: url, noticePath: path, noticeGeneratedAt: new Date().toISOString() });
  await addDoc(collection(db, "documents"), {
    employee: request.email,
    type: "Aviso de Férias",
    path,
    url,
    uploadedAt: new Date().toISOString()
  });
  return url;
}

async function queueNotification({ uid, email, status, requestId, message }) {
  try {
    await addDoc(collection(db, "notifications"), {
      uid,
      email,
      status,
      requestId,
      message,
      createdAt: new Date().toISOString(),
      channel: "email"
    });
  } catch (err) {
    console.warn("Não foi possível registrar notificação", err);
  }
}

async function applyStatusDecision(request, status, options = {}) {
  const manager = auth.currentUser;
  const requestRef = doc(db, "vacations", request.id);
  const updates = {
    status,
    decidedBy: manager ? { uid: manager.uid, email: manager.email } : null,
    decidedAt: new Date().toISOString(),
    decisionNotes: options.notes || ""
  };

  if (status === "Aprovada") {
    const approvedDays = options.approvedDays != null ? options.approvedDays : request.days;
    const abonoDays = options.abonoDays != null ? options.abonoDays : request.abonoDays || 0;
    const payrollDueDate = options.payrollDueDate || computePayrollDueDate(request, cachedContext?.settings);
    const integration = {
      payrollScheduled: !!options.schedulePayroll,
      payrollDueDate,
      pointBlocked: cachedContext?.settings?.blockPointIntegration ? true : false
    };

    await runTransaction(db, async (tx) => {
      const snap = await tx.get(requestRef);
      if (!snap.exists()) {
        throw new Error("Solicitação não encontrada");
      }
      const current = snap.data();
      const userRef = doc(db, "users", current.uid);
      const userSnap = await tx.get(userRef);
      const currentBalance = userSnap.exists() ? userSnap.data().vacationBalance ?? 0 : 0;
      const newBalance = Math.max(0, currentBalance - (approvedDays + abonoDays));
      tx.set(userRef, { vacationBalance: newBalance }, { merge: true });
      tx.update(requestRef, {
        ...updates,
        approvedDays,
        abonoDays,
        payrollDueDate,
        integration,
        lastManagerUpdate: new Date().toISOString()
      });
    });
  } else {
    await updateDoc(requestRef, updates);
  }

  await logActivity("vacation.update", { status, email: request.email, start: request.start, end: request.end });
  if (cachedContext?.settings?.sendNotifications) {
    await queueNotification({
      uid: request.uid,
      email: request.email,
      status,
      requestId: request.id,
      message: options.notes || "Sua solicitação de férias foi atualizada."
    });
  }
}

function computePayrollDueDate(request, settings) {
  if (!request?.start) return null;
  const date = new Date(`${request.start}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  const advance = settings?.paymentAdvanceDays ?? DEFAULT_SETTINGS.paymentAdvanceDays;
  date.setDate(date.getDate() - advance);
  return date.toISOString().slice(0, 10);
}

function computeBalanceInfo(profile, requests, employee) {
  const balance = profile?.vacationBalance ?? 30;
  const approved = requests.filter((req) => req.status === "Aprovada");
  const consumed = approved.reduce((sum, req) => sum + (req.approvedDays || req.days || 0), 0);
  const sold = approved.reduce((sum, req) => sum + (req.abonoDays || 0), 0);
  const accrual = 30;
  const projection = Math.max(0, balance + accrual - consumed - sold);
  const hireDate = employee?.hireDate || null;
  let periodLabel = "—";
  if (hireDate) {
    const [year, month, day] = hireDate.split("-");
    if (year) {
      const hire = new Date(Number(year), Number(month || 1) - 1, Number(day || 1));
      const now = new Date();
      const cycles = Math.floor(((now - hire) / (1000 * 60 * 60 * 24)) / 365.25);
      const periodStart = new Date(hire);
      periodStart.setFullYear(hire.getFullYear() + cycles);
      const periodEnd = new Date(periodStart);
      periodEnd.setFullYear(periodStart.getFullYear() + 1);
      periodEnd.setDate(periodEnd.getDate() - 1);
      periodLabel = `${periodStart.toLocaleDateString("pt-BR") } → ${periodEnd.toLocaleDateString("pt-BR")}`;
    }
  }
  return { balance, consumed, sold, projection, periodLabel };
}

function computeHeatmap(requests) {
  const months = Array.from({ length: 12 }, (_, i) => ({ month: i, label: new Date(2000, i, 1).toLocaleString("pt-BR", { month: "long" }), count: 0 }));
  requests.forEach((req) => {
    if (!req.start || !req.end) return;
    const start = new Date(`${req.start}T00:00:00`);
    const end = new Date(`${req.end}T00:00:00`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return;
    const current = new Date(start);
    while (current <= end) {
      months[current.getMonth()].count += 1;
      current.setDate(current.getDate() + 1);
    }
  });
  return months;
}

function detectConflicts(requests, employeesMap) {
  const alerts = [];
  const grouped = new Map();
  requests.forEach((req) => {
    if (!["Pendente", "Ajuste Solicitado"].includes(req.status)) return;
    const employee = employeesMap.byEmail.get(String(req.email || "").toLowerCase());
    const team = employee?.costCenter || "Geral";
    if (!grouped.has(team)) grouped.set(team, []);
    grouped.get(team).push(req);
  });
  grouped.forEach((list, team) => {
    list.sort((a, b) => (a.start || "").localeCompare(b.start || ""));
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i];
        const b = list[j];
        if (a.start && b.end && !(a.start > b.end || a.end < b.start)) {
          alerts.push({ team, a, b });
        }
      }
    }
  });
  return alerts;
}

function renderRequestForm(context) {
  const options = VACATION_TYPES.map((type) => `<option value="${type.value}">${type.label}</option>`).join("");
  return `
  <div class="card">
    <h2>📩 Solicitar Férias</h2>
    <form id="vacation-request" class="grid cols-2">
      <div class="vacation-periods" data-periods>
        ${renderPeriodRow(1)}
      </div>
      <div class="toolbar" style="grid-column:1/3">
        <button type="button" class="btn ghost" id="addPeriod">Adicionar período</button>
        <button type="button" class="btn ghost" id="clearPeriods">Limpar períodos</button>
      </div>
      <label class="field">
        <span class="field-label">Tipo de férias</span>
        <select class="input" name="splitType">
          ${options}
        </select>
      </label>
      <label class="field">
        <span class="field-label">Abono (venda de dias)</span>
        <div class="field-inline">
          <input type="checkbox" name="abono">
          <input class="input" type="number" min="0" max="10" step="1" name="abonoDays" value="10" style="width:80px" title="Dias vendidos">
        </div>
      </label>
      <label class="field" style="grid-column:1/3">
        <span class="field-label">Observações</span>
        <textarea class="input" name="notes" rows="3" placeholder="Observações importantes, feriados, combinações..."></textarea>
      </label>
      <label class="field" style="grid-column:1/3">
        <span class="field-label">Anexos (opcional)</span>
        <input class="input" type="file" name="attachments" multiple>
      </label>
      <div style="grid-column:1/3;display:flex;justify-content:flex-end;gap:.5rem">
        <button class="btn" type="submit">Enviar solicitação</button>
      </div>
      <small class="helper" data-feedback style="grid-column:1/3"></small>
    </form>
  </div>`;
}

function renderPeriodRow(idx) {
  return `
  <div class="grid cols-3 vacation-period-row" data-index="${idx}">
    <label class="field">
      <span class="field-label">Início</span>
      <input class="input" type="date" name="periodStart" required>
    </label>
    <label class="field">
      <span class="field-label">Fim</span>
      <input class="input" type="date" name="periodEnd">
    </label>
    <label class="field">
      <span class="field-label">Dias</span>
      <input class="input" type="number" min="1" max="30" name="periodDays" placeholder="Auto">
    </label>
  </div>`;
}

function renderMyRequests(context) {
  const list = context.myRequests || [];
  if (!list.length) {
    return `
    <div class="card">
      <h2>🔎 Minhas Solicitações</h2>
      <p class="helper">Nenhuma solicitação registrada.</p>
    </div>`;
  }
  const years = Array.from(new Set(list.map((item) => (item.start ? new Date(`${item.start}T00:00:00`).getFullYear() : new Date(item.createdAt || Date.now()).getFullYear())))).sort((a, b) => b - a);
  const rows = list
    .map((req) => {
      const badgeClass = STATUS_BADGES[req.status] || "";
      const segments = req.segments && req.segments.length ? req.segments : [{ start: req.start, end: req.end, days: req.days }];
      const segmentsHtml = segments
        .map((segment, idx) => `<div><strong>Período ${idx + 1}:</strong> ${formatDate(segment.start)} → ${formatDate(segment.end)} (${segment.days || diffInDays(segment.start, segment.end)} dias)</div>`) // eslint-disable-line max-len
        .join("");
      const actions = [];
      if (req.status === "Pendente") {
        actions.push(`<button class="btn ghost" data-cancel="${req.id}">Cancelar</button>`);
      }
      if (req.status === "Aprovada" && req.noticeUrl) {
        actions.push(`<a class="btn" href="${req.noticeUrl}" target="_blank">Baixar aviso (PDF)</a>`);
      }
      const actionsHtml = actions.length ? actions.join(" ") : '<small class="helper">—</small>';
      return `
      <tr data-year="${req.start ? new Date(`${req.start}T00:00:00`).getFullYear() : new Date(req.createdAt || Date.now()).getFullYear()}">
        <td>${segmentsHtml}</td>
        <td>${req.approvedDays || req.days || "—"}</td>
        <td>${VACATION_TYPES.find((t) => t.value === req.splitType)?.label || req.splitType || "—"}${req.abonoDays ? `<br><small class="helper">Abono: ${req.abonoDays} dias</small>` : ""}</td>
        <td><span class="badge ${badgeClass}">${req.status}</span>${req.decisionNotes ? `<br><small class="helper">${req.decisionNotes}</small>` : ""}</td>
        <td>${actionsHtml}</td>
      </tr>`;
    })
    .join("");
  return `
  <div class="card">
    <div class="toolbar">
      <h2>🔎 Minhas Solicitações</h2>
      <div class="toolbar-actions">
        <label class="field">
          <span class="field-label">Filtrar por ano</span>
          <select class="input" id="myRequestsYear">
            <option value="todos">Todos</option>
            ${years.map((year) => `<option value="${year}">${year}</option>`).join("")}
          </select>
        </label>
      </div>
    </div>
    <table class="table">
      <thead>
        <tr>
          <th>Período</th>
          <th>Dias</th>
          <th>Tipo</th>
          <th>Status</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </div>`;
}

function renderApprovalCard(request, employees) {
  const badgeClass = STATUS_BADGES[request.status] || "";
  const employee = employees.byEmail.get(String(request.email || "").toLowerCase()) || employees.byUid.get(request.uid);
  const segments = request.segments && request.segments.length ? request.segments : [{ start: request.start, end: request.end, days: request.days }];
  const attachments = request.attachments && request.attachments.length
    ? `<div class="helper">Anexos: ${request.attachments.map((file) => `<a href="${file.url}" target="_blank">${file.name}</a>`).join(", ")}</div>`
    : "";
  return `
  <div class="card" data-request-card="${request.id}">
    <div class="toolbar">
      <div>
        <h3 style="margin:0">${employee?.name || request.email || "—"}</h3>
        <small class="helper">${formatDate(request.start)} → ${formatDate(request.end)} (${request.days || "—"} dias)</small>
        ${employee?.costCenter ? `<small class="helper">Centro de custo: ${employee.costCenter}</small>` : ""}
      </div>
      <div>
        <span class="badge ${badgeClass}">${request.status}</span>
      </div>
    </div>
    <div class="grid cols-2">
      <div>
        <strong>Tipo:</strong> ${VACATION_TYPES.find((t) => t.value === request.splitType)?.label || request.splitType || "—"}<br>
        ${segments.map((segment, idx) => `<small class="helper">Período ${idx + 1}: ${formatDate(segment.start)} → ${formatDate(segment.end)} (${segment.days || diffInDays(segment.start, segment.end)} dias)</small>`).join("")}
        ${attachments}
      </div>
      <div>
        <strong>Observações</strong>
        <p class="helper">${request.notes || "—"}</p>
        ${request.decisionNotes ? `<p class="helper"><strong>Decisão:</strong> ${request.decisionNotes}</p>` : ""}
      </div>
    </div>
    <div class="actions" data-actions>
      ${request.status === "Pendente" || request.status === "Ajuste Solicitado" ? `
        <button class="btn" data-action="approve" data-id="${request.id}">Aprovar</button>
        <button class="btn ghost" data-action="adjust" data-id="${request.id}">Solicitar ajuste</button>
        <button class="btn warn" data-action="reject" data-id="${request.id}">Rejeitar</button>` : ""}
      ${request.status === "Aprovada" ? `
        <button class="btn ghost" data-action="schedule" data-id="${request.id}">${request.integration?.payrollScheduled ? "Agendado" : "Agendar pagamento"}</button>
        <button class="btn" data-action="notice" data-id="${request.id}">${request.noticeUrl ? "Reemitir aviso" : "Gerar aviso (PDF)"}</button>` : ""}
    </div>
  </div>`;
}

function renderApprovals(context) {
  if (!context.isManager) return "";
  const list = context.teamRequests || [];
  const filters = context.filters || {};
  const costCenters = Array.from(new Set(context.teamRequests.map((req) => {
    const employee = context.employees.byEmail.get(String(req.email || "").toLowerCase()) || context.employees.byUid.get(req.uid);
    return employee?.costCenter || "Geral";
  }))).sort();
  const months = Array.from({ length: 12 }, (_, i) => ({ value: i, label: new Date(2000, i, 1).toLocaleString("pt-BR", { month: "long" }) }));
  const filtered = list.filter((req) => {
    if (filters.costCenter && filters.costCenter !== "todos") {
      const employee = context.employees.byEmail.get(String(req.email || "").toLowerCase()) || context.employees.byUid.get(req.uid);
      const center = employee?.costCenter || "Geral";
      if (center !== filters.costCenter) return false;
    }
    if (filters.month && filters.month !== "todos") {
      const start = req.start ? new Date(`${req.start}T00:00:00`) : null;
      if (!start || String(start.getMonth()) !== filters.month) return false;
    }
    if (filters.status && filters.status !== "todos" && req.status !== filters.status) return false;
    return true;
  });

  const cards = filtered.map((req) => renderApprovalCard(req, context.employees)).join("");
  return `
  <div class="card">
    <div class="toolbar">
      <h2>✅ Aprovação</h2>
      <div class="toolbar-actions">
        <select class="input" id="filterCostCenter">
          <option value="todos">Todos os centros</option>
          ${costCenters.map((center) => `<option value="${center}" ${filters.costCenter === center ? "selected" : ""}>${center}</option>`).join("")}
        </select>
        <select class="input" id="filterMonth">
          <option value="todos">Todos os meses</option>
          ${months.map((month) => `<option value="${month.value}" ${filters.month === String(month.value) ? "selected" : ""}>${month.label}</option>`).join("")}
        </select>
        <select class="input" id="filterStatus">
          <option value="todos">Todos os status</option>
          <option value="Pendente" ${filters.status === "Pendente" ? "selected" : ""}>Pendentes</option>
          <option value="Aprovada" ${filters.status === "Aprovada" ? "selected" : ""}>Aprovadas</option>
          <option value="Rejeitada" ${filters.status === "Rejeitada" ? "selected" : ""}>Rejeitadas</option>
          <option value="Ajuste Solicitado" ${filters.status === "Ajuste Solicitado" ? "selected" : ""}>Ajuste solicitado</option>
        </select>
      </div>
    </div>
    ${cards || '<p class="helper">Nenhuma solicitação para os filtros selecionados.</p>'}
  </div>`;
}

function renderBalanceCard(context) {
  const info = context.balanceInfo;
  const rules = context.settings;
  return `
  <div class="card">
    <h2>🧮 Saldo de Férias</h2>
    <div class="grid cols-2">
      <div>
        <div class="kpi small"><div class="label">Saldo disponível</div><div class="value">${info.balance} dias</div></div>
        <div class="kpi small"><div class="label">Dias gozados</div><div class="value">${info.consumed}</div></div>
        <div class="kpi small"><div class="label">Dias vendidos</div><div class="value">${info.sold}</div></div>
        <div class="kpi small"><div class="label">Próxima projeção</div><div class="value">${info.projection} dias</div></div>
      </div>
      <div>
        <p><strong>Período aquisitivo atual:</strong><br><small class="helper">${info.periodLabel}</small></p>
        <p><strong>Regras Casa Rosa</strong></p>
        <ul class="helper">
          <li>Aviso mínimo: ${rules.minNoticeDays} dias</li>
          <li>Pagamento até ${rules.paymentAdvanceDays} dias antes do início</li>
          <li>Fracionamento: ${rules.allowSplit ? `até ${rules.maxSplits} períodos` : "não permitido"}</li>
          <li>Venda de dias: ${rules.allowSellDays ? "permitida" : "não permitida"}</li>
        </ul>
      </div>
    </div>
  </div>`;
}

function renderReportsCard(context) {
  if (!context.isManager) return "";
  if (!context.teamRequests.length) {
    return `
    <div class="card">
      <div class="toolbar"><h2>📊 Relatórios & Exportações</h2></div>
      <p class="helper">Sem solicitações registradas para gerar relatórios.</p>
    </div>`;
  }
  const yearOptions = Array.from(new Set(context.teamRequests.map((req) => (req.start ? new Date(`${req.start}T00:00:00`).getFullYear() : new Date(req.createdAt || Date.now()).getFullYear())))).sort((a, b) => b - a);
  const heatmap = computeHeatmap(context.teamRequests);
  const rows = heatmap
    .map((month) => `<tr><td>${month.label}</td><td><div class="heat" style="--value:${Math.min(month.count, 5)}"></div></td><td>${month.count}</td></tr>`)
    .join("");
  return `
  <div class="card">
    <div class="toolbar">
      <h2>📊 Relatórios & Exportações</h2>
      <div class="toolbar-actions">
        <select class="input" id="reportYear">
          ${yearOptions.map((year) => `<option value="${year}">${year}</option>`).join("")}
        </select>
        <button class="btn" id="exportVacations">Exportar CSV</button>
      </div>
    </div>
    <table class="table">
      <thead><tr><th>Mês</th><th>Mapa</th><th>Total de colaboradores em férias</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function renderAlertsCard(context) {
  if (!context.isManager) return "";
  if (!context.conflicts.length) return "";
  const items = context.conflicts
    .map((conflict) => `<li><strong>${conflict.team}</strong>: ${conflict.a.email} e ${conflict.b.email} solicitaram ${formatDate(conflict.a.start)} → ${formatDate(conflict.a.end)}</li>`)
    .join("");
  return `
  <div class="card warn">
    <h3>Barra de conflitos</h3>
    <ul>${items}</ul>
  </div>`;
}

function renderSettingsCard(context) {
  if (!context.isManager) return "";
  return `
  <div class="card">
    <h3>⚙️ Regras configuráveis</h3>
    <form id="vacation-settings" class="grid cols-2">
      <label class="field">
        <span class="field-label">Aviso mínimo (dias)</span>
        <input class="input" type="number" name="minNoticeDays" min="0" value="${context.settings.minNoticeDays}">
      </label>
      <label class="field">
        <span class="field-label">Pagamento antes do início (dias)</span>
        <input class="input" type="number" name="paymentAdvanceDays" min="0" value="${context.settings.paymentAdvanceDays}">
      </label>
      <label class="field">
        <span class="field-label">Permitir fracionamento</span>
        <input type="checkbox" name="allowSplit" ${context.settings.allowSplit ? "checked" : ""}>
      </label>
      <label class="field">
        <span class="field-label">Máximo de períodos</span>
        <input class="input" type="number" name="maxSplits" min="1" max="3" value="${context.settings.maxSplits}">
      </label>
      <label class="field">
        <span class="field-label">Permitir venda de dias</span>
        <input type="checkbox" name="allowSellDays" ${context.settings.allowSellDays ? "checked" : ""}>
      </label>
      <label class="field">
        <span class="field-label">Bloquear ponto automaticamente</span>
        <input type="checkbox" name="blockPointIntegration" ${context.settings.blockPointIntegration ? "checked" : ""}>
      </label>
      <label class="field">
        <span class="field-label">Enviar notificações</span>
        <input type="checkbox" name="sendNotifications" ${context.settings.sendNotifications ? "checked" : ""}>
      </label>
      <div style="grid-column:1/3;text-align:right">
        <button class="btn" type="submit">Salvar regras</button>
      </div>
      <small class="helper" data-settings-feedback style="grid-column:1/3"></small>
    </form>
  </div>`;
}

function renderIntegrationsCard(context) {
  if (!context.isManager) return "";
  return `
  <div class="card">
    <h3>🔔 Avisos & Integrações</h3>
    <ul class="helper">
      <li>Notificações automáticas para colaboradores ao aprovar, rejeitar ou solicitar ajustes.</li>
      <li>Integração com Ponto: bloqueio de batidas durante férias aprovadas (flag configurável).</li>
      <li>Integração com Holerite: marcação de 1/3 constitucional e abono para conferência da folha.</li>
      <li>Aviso de férias salvo em Documentos do colaborador via PDF.</li>
    </ul>
  </div>`;
}

function renderView(context) {
  const container = document.getElementById("view");
  container.innerHTML = `
    <div class="grid cols-2">
      ${renderRequestForm(context)}
      ${renderBalanceCard(context)}
    </div>
    <div class="grid cols-1" style="margin-top:1rem">
      ${renderMyRequests(context)}
      ${renderAlertsCard(context)}
      ${renderApprovals(context)}
      ${renderReportsCard(context)}
      ${renderIntegrationsCard(context)}
      ${renderSettingsCard(context)}
    </div>
  `;
}

function exportCsv(requests) {
  if (!requests.length) {
    alert("Nada para exportar.");
    return;
  }
  const headers = ["Colaborador", "Centro de Custo", "Período", "Dias", "Tipo", "Status", "Abono", "Aprovador"];
  const { byEmail, byUid } = cachedContext.employees;
  const lines = [headers.join(",")];
  requests.forEach((req) => {
    const employee = byEmail.get(String(req.email || "").toLowerCase()) || byUid.get(req.uid);
    const center = employee?.costCenter || "Geral";
    const approver = req.decidedBy?.email || "";
    const period = `${formatDate(req.start)} -> ${formatDate(req.end)}`;
    const type = VACATION_TYPES.find((t) => t.value === req.splitType)?.label || req.splitType || "";
    lines.push([
      `"${req.email || ""}"`,
      `"${center}"`,
      `"${period}"`,
      req.approvedDays || req.days || 0,
      `"${type}"`,
      `"${req.status}"`,
      req.abonoDays || 0,
      `"${approver}"`
    ].join(","));
  });
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `ferias-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function bindRequestForm(context) {
  const form = document.getElementById("vacation-request");
  if (!form) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await createVacationRequest(form, context);
  });
  const add = document.getElementById("addPeriod");
  add.addEventListener("click", () => {
    const container = form.querySelector("[data-periods]");
    const next = container.querySelectorAll(".vacation-period-row").length + 1;
    container.insertAdjacentHTML("beforeend", renderPeriodRow(next));
  });
  const clear = document.getElementById("clearPeriods");
  clear.addEventListener("click", () => {
    const container = form.querySelector("[data-periods]");
    container.innerHTML = renderPeriodRow(1);
  });
}

function bindMyRequests(context) {
  const yearFilter = document.getElementById("myRequestsYear");
  if (yearFilter) {
    yearFilter.addEventListener("change", () => {
      const value = yearFilter.value;
      document.querySelectorAll("[data-year]").forEach((row) => {
        if (value === "todos" || row.getAttribute("data-year") === value) {
          row.style.display = "";
        } else {
          row.style.display = "none";
        }
      });
    });
  }
  document.querySelectorAll("button[data-cancel]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.getAttribute("data-cancel");
      if (!confirm("Cancelar esta solicitação?")) return;
      await cancelRequest(id);
      await reloadContext();
    });
  });
}

function bindFilters() {
  const costCenter = document.getElementById("filterCostCenter");
  const month = document.getElementById("filterMonth");
  const status = document.getElementById("filterStatus");
  if (costCenter) costCenter.addEventListener("change", handleFilterChange);
  if (month) month.addEventListener("change", handleFilterChange);
  if (status) status.addEventListener("change", handleFilterChange);
}

async function handleFilterChange() {
  cachedContext.filters = {
    costCenter: document.getElementById("filterCostCenter")?.value || "todos",
    month: document.getElementById("filterMonth")?.value || "todos",
    status: document.getElementById("filterStatus")?.value || "todos"
  };
  renderView(cachedContext);
  bindInteractions();
}

function bindApprovalActions(context) {
  if (!context.isManager) return;
  document.querySelectorAll("[data-actions]").forEach((container) => {
    container.querySelectorAll("button[data-action]").forEach((button) => {
      button.addEventListener("click", async () => {
        const action = button.getAttribute("data-action");
        const id = button.getAttribute("data-id");
        const request = context.teamRequests.find((item) => item.id === id) || context.myRequests.find((item) => item.id === id);
        if (!request) return;
        if (action === "approve") {
          const approvedDays = Number(prompt("Dias aprovados", request.days || 30)) || request.days || 30;
          const abonoDays = Number(prompt("Dias vendidos (abono)", request.abonoDays || 0)) || 0;
          const notes = prompt("Observações para o colaborador", "Aprovado!") || "";
          const schedulePayroll = confirm(`Agendar pagamento no holerite? (Pagamento até ${cachedContext.settings.paymentAdvanceDays} dias antes do início)`);
          const payrollDueDate = computePayrollDueDate(request, cachedContext.settings);
          await applyStatusDecision(request, "Aprovada", { approvedDays, abonoDays, notes, schedulePayroll, payrollDueDate });
        } else if (action === "reject") {
          const notes = prompt("Motivo da rejeição", "") || "";
          await applyStatusDecision(request, "Rejeitada", { notes });
        } else if (action === "adjust") {
          const notes = prompt("Descreva o ajuste solicitado", "") || "";
          await applyStatusDecision(request, "Ajuste Solicitado", { notes });
        } else if (action === "schedule") {
          const payrollDueDate = prompt("Data de pagamento (AAAA-MM-DD)", computePayrollDueDate(request, cachedContext.settings) || todayISO());
          await updateDoc(doc(db, "vacations", request.id), {
            integration: { ...(request.integration || {}), payrollScheduled: true, payrollDueDate },
            lastManagerUpdate: new Date().toISOString()
          });
        } else if (action === "notice") {
          const employee = context.employees.byEmail.get(String(request.email || "").toLowerCase()) || context.employees.byUid.get(request.uid);
          const url = await generateNoticePDF(request, employee);
          alert("Aviso de férias gerado e salvo nos documentos do colaborador.");
          window.open(url, "_blank");
        }
        await reloadContext();
      });
    });
  });
}

function bindReports(context) {
  if (!context.isManager) return;
  const exportBtn = document.getElementById("exportVacations");
  if (exportBtn) {
    exportBtn.addEventListener("click", () => {
      exportCsv(context.teamRequests);
    });
  }
}

function bindSettings(context) {
  if (!context.isManager) return;
  const form = document.getElementById("vacation-settings");
  if (!form) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const settings = { ...context.settings };
    settings.minNoticeDays = Number(data.get("minNoticeDays") || 0);
    settings.paymentAdvanceDays = Number(data.get("paymentAdvanceDays") || 0);
    settings.allowSplit = data.get("allowSplit") === "on";
    settings.maxSplits = Number(data.get("maxSplits") || 1);
    settings.allowSellDays = data.get("allowSellDays") === "on";
    settings.blockPointIntegration = data.get("blockPointIntegration") === "on";
    settings.sendNotifications = data.get("sendNotifications") === "on";
    await saveVacationSettings(settings);
    const feedback = form.querySelector("[data-settings-feedback]");
    feedback.textContent = "Regras atualizadas.";
    cachedContext.settings = settings;
  });
}

function bindInteractions() {
  bindRequestForm(cachedContext);
  bindMyRequests(cachedContext);
  bindFilters();
  bindApprovalActions(cachedContext);
  bindReports(cachedContext);
  bindSettings(cachedContext);
}

async function reloadContext() {
  const user = auth.currentUser;
  if (!user) return;
  const profile = (await fetchUserProfile(user.uid)) || window.__APP__?.profile || { role: "Colaborador", vacationBalance: 30 };
  const myRequests = await listVacationsByUser(user.uid);
  const settings = await fetchVacationSettings();
  const employees = await listEmployeesMap();
  const isManager = MANAGER_ROLES.includes(window.__APP__?.profile?.role || profile?.role || "");
  const teamRequests = isManager ? await listAllVacations() : [];
  const balanceInfo = computeBalanceInfo(profile, myRequests, employees.byEmail.get(String(user.email || "").toLowerCase()) || employees.byUid.get(user.uid));
  const conflicts = isManager ? detectConflicts(teamRequests, employees) : [];
  cachedContext = {
    user,
    profile,
    settings,
    myRequests,
    teamRequests,
    employees,
    isManager,
    balanceInfo,
    conflicts,
    filters: cachedContext?.filters || { costCenter: "todos", month: "todos", status: "todos" }
  };
  renderView(cachedContext);
  if (window.__APP__) {
    window.__APP__.profile = { ...(window.__APP__.profile || {}), ...profile };
  }
  bindInteractions();
}

window.VacationsView = async function VacationsView() {
  await reloadContext();
};
