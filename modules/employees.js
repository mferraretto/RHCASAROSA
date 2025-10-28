// Gestão de colaboradores com visões adaptadas por perfil
import {
  getFirestore,
  collection,
  addDoc,
  getDocs,
  doc,
  updateDoc,
  getDoc,
  query,
  where,
  orderBy,
  limit
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
const managerRoles = ["ADM", "Gestor", "RH"];

let employeesCache = [];
let lastPunchCache = {};
let managerSummary = null;
let currentFilters = { search: "", status: "", role: "", costCenter: "" };

function normalizeEmail(value) {
  return (value || "").trim().toLowerCase();
}

function formatCurrency(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return "—";
  return num.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatDate(value) {
  if (!value) return "—";
  if (value instanceof Date) {
    return value.toLocaleDateString("pt-BR");
  }
  if (typeof value === "string" && value.includes("T")) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toLocaleDateString("pt-BR");
  }
  if (typeof value === "string" && value.includes("-")) {
    const [yyyy, mm, dd] = value.split("-");
    if (yyyy && mm) {
      return `${dd || "01"}/${mm}/${yyyy}`;
    }
  }
  return value;
}

function getProfile() {
  return window.__APP__?.profile || { role: "Colaborador" };
}

function isManager() {
  const role = getProfile().role || "";
  return managerRoles.includes(role);
}

async function listEmployees() {
  const snap = await getDocs(collection(db, "employees"));
  const rows = [];
  snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
  return rows;
}

async function getEmployeeByUid(uid, email) {
  if (!uid && !email) return null;
  if (uid) {
    const q = query(collection(db, "employees"), where("uid", "==", uid));
    const snap = await getDocs(q);
    if (!snap.empty) {
      const docSnap = snap.docs[0];
      return { id: docSnap.id, ...docSnap.data() };
    }
  }
  if (email) {
    const q = query(collection(db, "employees"), where("email", "==", email));
    const snap = await getDocs(q);
    if (!snap.empty) {
      const docSnap = snap.docs[0];
      return { id: docSnap.id, ...docSnap.data() };
    }
  }
  return null;
}

async function saveEmployee(payload, id = null) {
  const data = { ...payload };
  if (data.salary) data.salary = Number(data.salary);
  if (id) {
    await updateDoc(doc(db, "employees", id), data);
    return id;
  }
  const refDoc = await addDoc(collection(db, "employees"), data);
  return refDoc.id;
}

async function fetchDocuments(email) {
  if (!email) return [];
  const q = query(collection(db, "documents"), where("employee", "==", email));
  const snap = await getDocs(q);
  const list = [];
  snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
  return list;
}

async function fetchPayslips(uid, email) {
  const filters = [];
  if (uid) filters.push(query(collection(db, "holerites"), where("uid", "==", uid)));
  if (email) filters.push(query(collection(db, "holerites"), where("email", "==", email)));
  if (!filters.length) return [];
  const snapshots = await Promise.all(filters.map((q) => getDocs(q).catch(() => null)));
  const rows = [];
  snapshots.forEach((snap) => {
    if (!snap) return;
    snap.forEach((docSnap) => rows.push({ id: docSnap.id, ...docSnap.data() }));
  });
  rows.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  const seen = new Set();
  return rows.filter((item) => {
    const key = `${item.reference}-${item.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchVacationHistory(uid, email) {
  if (!uid && !email) return [];
  const conditions = [];
  if (uid) conditions.push(query(collection(db, "vacations"), where("uid", "==", uid)));
  if (email) conditions.push(query(collection(db, "vacations"), where("email", "==", email)));
  const snapshots = await Promise.all(conditions.map((q) => getDocs(q).catch(() => null)));
  const rows = [];
  snapshots.forEach((snap) => {
    if (!snap) return;
    snap.forEach((docSnap) => rows.push({ id: docSnap.id, ...docSnap.data() }));
  });
  rows.sort((a, b) => new Date(b.start || 0) - new Date(a.start || 0));
  rows.reverse();
  return rows;
}

async function fetchLastPunchMap(employees) {
  const emails = Array.from(
    new Set(
      employees
        .map((emp) => normalizeEmail(emp.email))
        .filter((email) => email.length > 0)
    )
  );
  if (!emails.length) return {};
  const results = {};
  await Promise.all(
    emails.map(async (email) => {
      try {
        const q = query(
          collection(db, "attendance"),
          where("email", "==", email),
          orderBy("ts", "desc"),
          limit(1)
        );
        const snap = await getDocs(q);
        if (!snap.empty) {
          results[email] = snap.docs[0].data();
        }
      } catch (err) {
        console.warn("Erro ao buscar ponto de", email, err);
      }
    })
  );
  return results;
}

function buildCostCenterDistribution(items) {
  const map = new Map();
  items.forEach((emp) => {
    const key = emp.costCenter || "Não informado";
    map.set(key, (map.get(key) || 0) + 1);
  });
  return Array.from(map.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

function buildHeadcountHistory(items) {
  const months = [];
  const cursor = new Date();
  cursor.setDate(1);
  cursor.setHours(0, 0, 0, 0);
  for (let i = 0; i < 6; i += 1) {
    months.push({
      label: cursor.toLocaleString("pt-BR", { month: "short" }),
      date: new Date(cursor),
      key: `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`
    });
    cursor.setMonth(cursor.getMonth() - 1);
  }
  months.reverse();
  return months.map((month) => {
    const referenceDate = new Date(month.date);
    referenceDate.setMonth(referenceDate.getMonth() + 1, 0);
    const count = items.filter((emp) => {
      if ((emp.status || "Ativo") === "Inativo") return false;
      if (!emp.hireDate) return true;
      const hire = new Date(`${emp.hireDate}T00:00:00`);
      if (Number.isNaN(hire.getTime())) return true;
      return hire <= referenceDate;
    }).length;
    return { ...month, count };
  });
}

function buildBirthdays(items) {
  const today = new Date();
  const month = today.getMonth() + 1;
  return items
    .filter((emp) => {
      const birth = emp.birthDate || emp.birthday;
      if (!birth) return false;
      const parts = birth.split("-");
      if (parts.length < 2) return false;
      return Number(parts[1]) === month;
    })
    .map((emp) => ({
      name: emp.name,
      date: emp.birthDate || emp.birthday,
      email: emp.email
    }));
}

async function buildManagerSummary(items) {
  if (!items.length) {
    return {
      totals: { total: 0, active: 0, inactive: 0, averageSalary: "—" },
      distribution: [],
      headcount: [],
      birthdays: [],
      vacations: { pending: 0, approved: 0 },
      payslips: { reference: "", sent: 0, pending: 0 }
    };
  }

  const total = items.length;
  const active = items.filter((emp) => (emp.status || "Ativo") === "Ativo").length;
  const inactive = total - active;
  let salarySum = 0;
  let salaryCount = 0;
  items.forEach((emp) => {
    const salary = Number(emp.salary);
    if (!Number.isNaN(salary) && salary > 0) {
      salarySum += salary;
      salaryCount += 1;
    }
  });
  const averageSalary = salaryCount
    ? (salarySum / salaryCount).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
    : "—";

  const distribution = buildCostCenterDistribution(items);
  const headcount = buildHeadcountHistory(items);
  const birthdays = buildBirthdays(items);

  const monthKey = new Date().toISOString().slice(0, 7);
  let pendingVacations = 0;
  let approvedVacations = 0;
  try {
    const vacationSnap = await getDocs(collection(db, "vacations"));
    vacationSnap.forEach((d) => {
      const status = d.data().status;
      if (status === "Pendente") pendingVacations += 1;
      if (status === "Aprovada") approvedVacations += 1;
    });
  } catch (err) {
    console.warn("Falha ao carregar férias", err);
  }

  let sentPayslips = 0;
  try {
    const payslipSnap = await getDocs(query(collection(db, "holerites"), where("reference", "==", monthKey)));
    sentPayslips = payslipSnap.size;
  } catch (err) {
    console.warn("Falha ao consultar holerites", err);
  }
  const pendingPayslips = Math.max(active - sentPayslips, 0);

  return {
    totals: { total, active, inactive, averageSalary },
    distribution,
    headcount,
    birthdays,
    vacations: { pending: pendingVacations, approved: approvedVacations },
    payslips: { reference: monthKey, sent: sentPayslips, pending: pendingPayslips }
  };
}

function renderDistribution(distribution) {
  if (!distribution.length) {
    return "<p class=\"helper\">Cadastre centros de custo para acompanhar a distribuição.</p>";
  }
  const total = distribution.reduce((sum, item) => sum + item.count, 0);
  return `
    <ul class="list-unstyled">
      ${distribution
        .map((item) => {
          const percent = total ? Math.round((item.count / total) * 100) : 0;
          return `<li class="bar-row">
            <div class="bar-info">
              <strong>${item.name}</strong>
              <small>${item.count} (${percent}%)</small>
            </div>
            <div class="bar-track"><span style="width:${Math.max(percent, 6)}%"></span></div>
          </li>`;
        })
        .join("")}
    </ul>
  `;
}

function renderHeadcount(history) {
  if (!history.length) {
    return "<p class=\"helper\">Sem dados suficientes.</p>";
  }
  return `
    <ul class="list-inline">
      ${history
        .map(
          (item) => `<li>
            <span class="pill">${item.label.toUpperCase()}</span>
            <div class="pill-value">${item.count}</div>
          </li>`
        )
        .join("")}
    </ul>
  `;
}

function renderBirthdays(birthdays) {
  if (!birthdays.length) {
    return "<p class=\"helper\">Nenhum aniversariante este mês.</p>";
  }
  return `
    <ul class="list-unstyled">
      ${birthdays
        .map(
          (b) => `<li><strong>${b.name}</strong><br><small class="helper">${formatDate(b.date)} • ${b.email || "—"}</small></li>`
        )
        .join("")}
    </ul>
  `;
}

function renderManagerSummary(summary) {
  if (!summary || summary.totals.total === 0) {
    return "<p class=\"helper\">Cadastre colaboradores para ver indicadores.</p>";
  }
  const referenceDate = summary.payslips.reference
    ? new Date(`${summary.payslips.reference}-01`)
    : null;
  const monthLabel = referenceDate && !Number.isNaN(referenceDate.getTime())
    ? referenceDate.toLocaleString("pt-BR", { month: "long", year: "numeric" })
    : "Mês atual";
  return `
    <div class="metrics-grid">
      <div class="kpi">
        <div class="label">Equipe ativa</div>
        <div class="value">${summary.totals.active}/${summary.totals.total}</div>
        <small class="helper">Inativos: ${summary.totals.inactive}</small>
      </div>
      <div class="kpi">
        <div class="label">Média salarial</div>
        <div class="value">${summary.totals.averageSalary}</div>
        <small class="helper">Base em ${summary.totals.total} cadastros</small>
      </div>
      <div class="kpi">
        <div class="label">Férias pendentes</div>
        <div class="value">${summary.vacations.pending}</div>
        <small class="helper">Aprovadas: ${summary.vacations.approved}</small>
      </div>
      <div class="kpi">
        <div class="label">Holerites • ${monthLabel}</div>
        <div class="value">${summary.payslips.sent}</div>
        <small class="helper">Pendentes: ${summary.payslips.pending}</small>
      </div>
    </div>
    <div class="grid cols-3">
      <div class="card mini">
        <h4>Centros de custo</h4>
        ${renderDistribution(summary.distribution)}
      </div>
      <div class="card mini">
        <h4>Evolução (6 meses)</h4>
        ${renderHeadcount(summary.headcount)}
      </div>
      <div class="card mini">
        <h4>Aniversariantes</h4>
        ${renderBirthdays(summary.birthdays)}
      </div>
    </div>
  `;
}

function filterEmployees(items, filters) {
  const queryText = filters.search.trim().toLowerCase();
  return items.filter((emp) => {
    if (queryText) {
      const haystack = [emp.name, emp.email, emp.doc, emp.role, emp.costCenter]
        .map((field) => (field || "").toLowerCase())
        .join(" ");
      if (!haystack.includes(queryText)) return false;
    }
    if (filters.status && (emp.status || "Ativo") !== filters.status) return false;
    if (filters.role && (emp.role || "") !== filters.role) return false;
    if (filters.costCenter && (emp.costCenter || "") !== filters.costCenter) return false;
    return true;
  });
}

function renderManagerTable(items) {
  if (!items.length) {
    return "<p class=\"helper\">Nenhum colaborador encontrado.</p>";
  }
  return `
    <div class="table-scroll">
      <table class="table">
        <thead>
          <tr>
            <th>Nome</th>
            <th>Cargo</th>
            <th>Centro de Custo</th>
            <th>Admissão</th>
            <th>Salário</th>
            <th>Status</th>
            <th>Último ponto</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${items
            .map((emp) => {
              const lastPunch = lastPunchCache[normalizeEmail(emp.email)];
              const lastPunchLabel = lastPunch
                ? `${new Date(lastPunch.ts).toLocaleDateString("pt-BR")} ${new Date(lastPunch.ts).toLocaleTimeString("pt-BR", {
                    hour: "2-digit",
                    minute: "2-digit"
                  })}`
                : "—";
              const punchType = lastPunch ? (lastPunch.type === "in" ? "Entrada" : "Saída") : "";
              const badgeClass = (emp.status || "Ativo") === "Ativo" ? "ok" : "warn";
              return `
                <tr>
                  <td>
                    <strong>${emp.name || "—"}</strong>
                    <br><small class="helper">${emp.email || ""}</small>
                  </td>
                  <td>${emp.role || "—"}</td>
                  <td>${emp.costCenter || "—"}</td>
                  <td>${formatDate(emp.hireDate)}</td>
                  <td class="num">${formatCurrency(emp.salary)}</td>
                  <td><span class="badge ${badgeClass}">${emp.status || "Ativo"}</span></td>
                  <td>${lastPunchLabel ? `${lastPunchLabel}<br><small class="helper">${punchType}</small>` : "—"}</td>
                  <td class="actions">
                    <button class="btn ghost" data-action="edit" data-id="${emp.id}">✏️</button>
                    <button class="btn ghost" data-action="payslip" data-id="${emp.id}">📄</button>
                    <button class="btn ghost" data-action="export" data-id="${emp.id}">📤</button>
                    <button class="btn ghost" data-action="documents" data-email="${emp.email || ""}">📁</button>
                    <button class="btn ghost" data-action="vacations" data-email="${emp.email || ""}">🏝️</button>
                    <button class="btn warn" data-action="deactivate" data-id="${emp.id}">❌</button>
                  </td>
                </tr>
              `;
            })
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function populateFilters(list) {
  const statusSelect = document.getElementById("filter-status");
  const roleSelect = document.getElementById("filter-role");
  const costCenterSelect = document.getElementById("filter-cost");
  if (!statusSelect || !roleSelect || !costCenterSelect) return;

  const statuses = Array.from(new Set(list.map((emp) => emp.status || "Ativo")));
  const roles = Array.from(new Set(list.map((emp) => emp.role).filter(Boolean)));
  const centers = Array.from(new Set(list.map((emp) => emp.costCenter).filter(Boolean)));

  statusSelect.innerHTML = `<option value="">Status</option>${statuses
    .map((status) => `<option value="${status}">${status}</option>`)
    .join("")}`;
  roleSelect.innerHTML = `<option value="">Cargo</option>${roles
    .map((role) => `<option value="${role}">${role}</option>`)
    .join("")}`;
  costCenterSelect.innerHTML = `<option value="">Centro de custo</option>${centers
    .map((center) => `<option value="${center}">${center}</option>`)
    .join("")}`;

  statusSelect.value = currentFilters.status;
  roleSelect.value = currentFilters.role;
  costCenterSelect.value = currentFilters.costCenter;
}

function exportCsv(rows, filename = "colaboradores.csv") {
  if (!rows.length) {
    alert("Nada para exportar.");
    return;
  }
  const headers = Object.keys(rows[0]);
  const csv = [headers.join(";")].concat(
    rows.map((row) =>
      headers
        .map((header) => {
          const value = row[header];
          if (value == null) return "";
          const text = String(value).replace(/"/g, '""');
          return `"${text}"`;
        })
        .join(";")
    )
  );
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

async function ensureJsPDF() {
  if (window.__jspdf) return window.__jspdf.jsPDF;
  window.__jspdf = await import("https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.es.min.js");
  return window.__jspdf.jsPDF;
}

function closeModal(modal) {
  if (!modal) return;
  modal.classList.add("closing");
  setTimeout(() => modal.remove(), 180);
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
  modal.querySelector(".modal-close").onclick = () => closeModal(modal);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeModal(modal);
  });
  return modal;
}

function renderPayslipForm(employee) {
  const today = new Date();
  const ref = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
  return `
    <h3>Gerar holerite</h3>
    <p><small class="helper">${employee.name || "Colaborador"} • ${employee.email || ""}</small></p>
    <form id="payslip-form" class="grid cols-2">
      <label class="field">
        <span>Referência (AAAA-MM)</span>
        <input class="input" name="reference" value="${ref}" required pattern="\\d{4}-\\d{2}">
      </label>
      <label class="field">
        <span>Salário base</span>
        <input class="input" name="base" type="number" step="0.01" value="${employee.salary || ""}" required>
      </label>
      <label class="field">
        <span>Vencimentos</span>
        <textarea class="input" name="earnings" placeholder="Salário, Horas extras, Adicionais"></textarea>
      </label>
      <label class="field">
        <span>Descontos</span>
        <textarea class="input" name="discounts" placeholder="INSS, VT, Faltas"></textarea>
      </label>
      <label class="field">
        <span>Valor líquido</span>
        <input class="input" name="net" type="number" step="0.01" value="${employee.salary || ""}" required>
      </label>
      <label class="field">
        <span>Observações</span>
        <textarea class="input" name="notes" placeholder="Mensagem adicional"></textarea>
      </label>
      <div></div>
      <div style="display:flex;gap:.5rem;justify-content:flex-end">
        <button type="submit" class="btn">Salvar no Storage</button>
      </div>
    </form>
  `;
}

async function handleGeneratePayslip(employee) {
  const modal = showModal(renderPayslipForm(employee));
  const form = modal.querySelector("#payslip-form");
  form.onsubmit = async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    const reference = data.reference;
    const netValue = Number(data.net || employee.salary || 0);
    try {
      const jsPDF = await ensureJsPDF();
      const pdf = new jsPDF();
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(16);
      pdf.setTextColor(255, 0, 138);
      pdf.text("Casa Rosa RH", 20, 20);
      pdf.setFontSize(11);
      pdf.setFont("helvetica", "normal");
      pdf.setTextColor(0, 0, 0);
      pdf.text(`Holerite • ${reference}`, 20, 30);
      pdf.text(`Colaborador: ${employee.name || "—"}`, 20, 40);
      pdf.text(`E-mail: ${employee.email || "—"}`, 20, 48);
      pdf.text(`Cargo: ${employee.role || "—"}`, 20, 56);
      pdf.line(20, 60, 190, 60);
      pdf.text("Vencimentos:", 20, 70);
      pdf.text((data.earnings || "—").split("\n").join("\n"), 20, 78);
      pdf.text("Descontos:", 110, 70);
      pdf.text((data.discounts || "—").split("\n").join("\n"), 110, 78);
      pdf.line(20, 120, 190, 120);
      pdf.setFont("helvetica", "bold");
      pdf.text(`Valor líquido: ${formatCurrency(netValue)}`, 20, 132);
      if (data.notes) {
        pdf.setFont("helvetica", "normal");
        pdf.text(`Observações: ${data.notes}`, 20, 144);
      }
      pdf.text("Assinatura digital: Casa Rosa", 20, 160);

      const blob = pdf.output("blob");
      const path = `rh/holerites/${employee.uid || normalizeEmail(employee.email) || employee.id}/${reference}.pdf`;
      const fileRef = ref(storage, path);
      await uploadBytes(fileRef, blob, { contentType: "application/pdf" });
      const url = await getDownloadURL(fileRef);

      await addDoc(collection(db, "holerites"), {
        uid: employee.uid || null,
        email: employee.email || null,
        employeeId: employee.id,
        reference,
        netValue,
        baseValue: Number(data.base) || null,
        earnings: data.earnings || "",
        discounts: data.discounts || "",
        notes: data.notes || "",
        url,
        storagePath: path,
        createdAt: new Date().toISOString()
      });
      await logActivity("payslip.generate", {
        employee: employee.email || employee.name,
        reference,
        netValue
      });
      alert("Holerite gerado e salvo no Storage!");
      closeModal(modal);
      await window.EmployeesView();
    } catch (err) {
      console.error(err);
      alert("Não foi possível gerar o holerite. Consulte o console para detalhes.");
    }
  };
}

async function openForm(existing = null) {
  const container = document.getElementById("employees-form");
  container.innerHTML = `
    <div class="card">
      <h3>${existing ? "Editar" : "Novo"} colaborador</h3>
      <form id="femp" class="grid cols-3">
        <input class="input" name="name" placeholder="Nome completo" value="${existing?.name || ""}" required>
        <input class="input" name="doc" placeholder="CPF / RG" value="${existing?.doc || ""}">
        <input class="input" name="email" type="email" placeholder="Email" value="${existing?.email || ""}" required>
        <input class="input" name="phone" placeholder="Telefone" value="${existing?.phone || ""}">
        <input class="input" name="role" placeholder="Cargo / Função" value="${existing?.role || ""}">
        <input class="input" name="costCenter" placeholder="Centro de Custo" value="${existing?.costCenter || ""}">
        <input class="input" name="hireDate" type="date" value="${existing?.hireDate || ""}">
        <select class="input" name="contractType">
          ${["CLT", "PJ", "Estágio", "Autônomo"].map((option) => `<option value="${option}" ${existing?.contractType === option ? "selected" : ""}>${option}</option>`).join("")}
        </select>
        <input class="input" name="salary" type="number" step="0.01" placeholder="Salário base (R$)" value="${existing?.salary || ""}">
        <input class="input" name="workload" placeholder="Jornada (ex: 44h semanais)" value="${existing?.workload || ""}">
        <input class="input" name="supervisor" placeholder="Supervisor / Gestor" value="${existing?.supervisor || ""}">
        <select class="input" name="status">
          <option value="Ativo" ${existing?.status !== "Inativo" ? "selected" : ""}>Ativo</option>
          <option value="Inativo" ${existing?.status === "Inativo" ? "selected" : ""}>Inativo</option>
        </select>
        <input class="input" name="uid" placeholder="UID (opcional)" value="${existing?.uid || ""}">
        <textarea class="input" name="notes" placeholder="Observações">${existing?.notes || ""}</textarea>
        <input class="input" name="birthDate" type="date" value="${existing?.birthDate || existing?.birthday || ""}">
        <div></div>
        <div style="display:flex;gap:.5rem;justify-content:flex-end">
          <button class="btn ghost" type="button" id="cancel">Cancelar</button>
          <button class="btn" type="submit">${existing ? "Salvar" : "Adicionar"}</button>
        </div>
      </form>
    </div>
  `;

  document.getElementById("cancel").onclick = () => {
    container.innerHTML = "";
  };

  document.getElementById("femp").onsubmit = async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target).entries());
    if (!data.contractType) data.contractType = "CLT";
    try {
      if (existing) {
        await saveEmployee(data, existing.id);
        await logActivity("employee.update", {
          name: data.name,
          email: data.email,
          role: data.role
        });
      } else {
        const id = await saveEmployee(data);
        await logActivity("employee.add", {
          id,
          name: data.name,
          email: data.email,
          role: data.role
        });
      }
      container.innerHTML = "";
      await window.EmployeesView();
    } catch (err) {
      console.error(err);
      alert("Não foi possível salvar o colaborador.");
    }
  };
}

function attachManagerEvents() {
  const container = document.getElementById("view");
  if (!container) return;
  container.querySelector("#empSearch")?.addEventListener("input", (event) => {
    currentFilters.search = event.target.value || "";
    refreshManagerUI();
  });
  container.querySelector("#filter-status")?.addEventListener("change", (event) => {
    currentFilters.status = event.target.value;
    refreshManagerUI();
  });
  container.querySelector("#filter-role")?.addEventListener("change", (event) => {
    currentFilters.role = event.target.value;
    refreshManagerUI();
  });
  container.querySelector("#filter-cost")?.addEventListener("change", (event) => {
    currentFilters.costCenter = event.target.value;
    refreshManagerUI();
  });
  container.querySelector("#clearFilters")?.addEventListener("click", () => {
    currentFilters = { search: "", status: "", role: "", costCenter: "" };
    const search = container.querySelector("#empSearch");
    if (search) search.value = "";
    container.querySelectorAll(".filter-select").forEach((select) => {
      select.value = "";
    });
    refreshManagerUI();
  });
  container.querySelector("#addEmp")?.addEventListener("click", () => openForm());
  container.querySelector("#exportAll")?.addEventListener("click", () => {
    const filtered = filterEmployees(employeesCache, currentFilters);
    exportCsv(
      filtered.map((emp) => ({
        id: emp.id,
        nome: emp.name,
        email: emp.email,
        cargo: emp.role,
        centroCusto: emp.costCenter,
        admissao: emp.hireDate,
        contrato: emp.contractType,
        salario: emp.salary,
        status: emp.status
      })),
      "colaboradores-casa-rosa.csv"
    );
  });

  const table = container.querySelector("#employees-table");
  if (table) {
    table.addEventListener("click", async (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      const id = button.getAttribute("data-id");
      const action = button.getAttribute("data-action");
      const email = button.getAttribute("data-email");
      const employee = employeesCache.find((emp) => emp.id === id) || null;
      switch (action) {
        case "edit":
          if (employee) {
            const snap = await getDoc(doc(db, "employees", employee.id));
            await openForm({ id: employee.id, ...snap.data() });
          }
          break;
        case "deactivate":
          if (employee && confirm("Desativar colaborador?")) {
            await updateDoc(doc(db, "employees", employee.id), { status: "Inativo" });
            await logActivity("employee.deactivate", {
              id: employee.id,
              name: employee.name
            });
            await window.EmployeesView();
          }
          break;
        case "payslip":
          if (employee) handleGeneratePayslip(employee);
          break;
        case "documents":
          if (email) {
            location.hash = "#documents";
            alert(`Abrindo documentos de ${email}. Utilize o filtro por e-mail na aba Documentos.`);
          }
          break;
        case "vacations":
          location.hash = "#vacations";
          break;
        case "export":
          if (employee) {
            exportCsv(
              [
                {
                  id: employee.id,
                  nome: employee.name,
                  email: employee.email,
                  cargo: employee.role,
                  centroCusto: employee.costCenter,
                  admissao: employee.hireDate,
                  contrato: employee.contractType,
                  salario: employee.salary,
                  status: employee.status
                }
              ],
              `colaborador-${employee.name || employee.id}.csv`
            );
          }
          break;
        default:
      }
    });
  }
}

function refreshManagerUI() {
  const summaryBox = document.getElementById("employees-summary");
  if (summaryBox) {
    summaryBox.innerHTML = renderManagerSummary(managerSummary);
  }
  const tableBox = document.getElementById("employees-table");
  const list = filterEmployees(employeesCache, currentFilters);
  if (tableBox) {
    tableBox.innerHTML = renderManagerTable(list);
  }
  const countLabel = document.getElementById("employees-count");
  if (countLabel) {
    countLabel.textContent = list.length
      ? `${list.length} de ${employeesCache.length} colaboradores exibidos`
      : "Nenhum colaborador encontrado.";
  }
}

function renderCollaboratorView(state) {
  const container = document.getElementById("view");
  if (!container) return;
  const employee = state.employee;
  const documents = state.documents;
  const payslips = state.payslips;
  const vacations = state.vacations;
  const statusBadge = employee?.status === "Inativo" ? "warn" : "ok";
  container.innerHTML = `
    <div class="grid cols-2">
      <div class="card">
        <h2>Meus dados</h2>
        ${employee
          ? `<div class="profile-card">
              <div>
                <h3>${employee.name || "—"}</h3>
                <p class="helper">${employee.role || "—"} • ${employee.costCenter || "—"}</p>
              </div>
              <div class="profile-grid">
                <div><strong>Admissão</strong><br><span>${formatDate(employee.hireDate)}</span></div>
                <div><strong>Salário</strong><br><span>${formatCurrency(employee.salary)}</span></div>
                <div><strong>Jornada</strong><br><span>${employee.workload || "—"}</span></div>
                <div><strong>Status</strong><br><span class="badge ${statusBadge}">${employee.status || "Ativo"}</span></div>
                <div><strong>Gestor</strong><br><span>${employee.supervisor || "—"}</span></div>
                <div><strong>Contato</strong><br><span>${employee.phone || "—"}</span></div>
                <div><strong>E-mail</strong><br><span>${employee.email || "—"}</span></div>
              </div>
              <button class="btn ghost" id="requestUpdate">Solicitar atualização cadastral</button>
            </div>`
          : `<p class="helper">Seus dados ainda não foram vinculados. Fale com o RH.</p>`}
      </div>
      <div class="card">
        <h2>Meus documentos</h2>
        ${documents.length
          ? `<table class="table">
              <thead><tr><th>Tipo</th><th>Disponível em</th></tr></thead>
              <tbody>
                ${documents
                  .map((doc) => `<tr><td>${doc.type}</td><td><a href="${doc.url}" target="_blank">Baixar</a></td></tr>`)
                  .join("")}
              </tbody>
            </table>`
          : `<p class="helper">Nenhum documento disponível.</p>`}
      </div>
      <div class="card">
        <h2>Meus holerites</h2>
        ${payslips.length
          ? `<table class="table">
              <thead><tr><th>Mês/Ano</th><th>Valor líquido</th><th>Ações</th></tr></thead>
              <tbody>
                ${payslips
                  .map(
                    (pay) => `<tr>
                      <td>${pay.reference}</td>
                      <td>${formatCurrency(pay.netValue)}</td>
                      <td><a href="${pay.url}" target="_blank">📄 Baixar PDF</a></td>
                    </tr>`
                  )
                  .join("")}
              </tbody>
            </table>`
          : `<p class="helper">Sem holerites gerados ainda.</p>`}
      </div>
      <div class="card">
        <h2>Minhas férias</h2>
        ${vacations.length
          ? `<table class="table">
              <thead><tr><th>Período</th><th>Status</th></tr></thead>
              <tbody>
                ${vacations
                  .map(
                    (item) => `<tr>
                      <td>${item.start || "—"} → ${item.end || "—"}</td>
                      <td><span class="badge ${item.status === "Aprovada" ? "ok" : item.status === "Rejeitada" ? "danger" : "warn"}">${item.status}</span></td>
                    </tr>`
                  )
                  .join("")}
              </tbody>
            </table>`
          : `<p class="helper">Você ainda não possui férias registradas.</p>`}
        <button class="btn secondary" id="requestVacation">Solicitar férias</button>
      </div>
    </div>
  `;

  container.querySelector("#requestVacation")?.addEventListener("click", () => {
    location.hash = "#vacations";
  });
  container.querySelector("#requestUpdate")?.addEventListener("click", () => {
    const email = "rh@casarosa.com";
    const subject = encodeURIComponent("Solicitação de atualização cadastral");
    const body = encodeURIComponent("Olá RH, gostaria de atualizar meus dados cadastrados.");
    window.open(`mailto:${email}?subject=${subject}&body=${body}`, "_blank");
  });
}

async function renderManagerView() {
  const view = document.getElementById("view");
  view.innerHTML = `
    <div class="grid cols-1">
      <div class="card">
        <div class="toolbar">
          <div>
            <h2 style="margin:0">Colaboradores</h2>
            <small class="helper">Centro de gestão completo do time Casa Rosa</small>
          </div>
          <div class="toolbar-actions">
            <input class="input search" id="empSearch" placeholder="Buscar por nome, CPF ou e-mail">
            <select class="input filter-select" id="filter-status"></select>
            <select class="input filter-select" id="filter-role"></select>
            <select class="input filter-select" id="filter-cost"></select>
            <button class="btn ghost" id="clearFilters">Limpar</button>
            <button class="btn ghost" id="exportAll">Exportar CSV</button>
            <button class="btn" id="addEmp">Adicionar</button>
          </div>
        </div>
        <div id="employees-summary"></div>
        <div id="employees-count" class="helper"></div>
        <div id="employees-table"></div>
        <div id="employees-form" style="margin-top:1rem"></div>
      </div>
    </div>
  `;

  populateFilters(employeesCache);
  attachManagerEvents();
  refreshManagerUI();
}

async function renderCollaborator() {
  const user = window.__APP__?.user;
  if (!user) {
    renderCollaboratorView({ employee: null, documents: [], payslips: [], vacations: [] });
    return;
  }
  const email = user.email;
  const employee = await getEmployeeByUid(user.uid, email);
  const [documents, payslips, vacations] = await Promise.all([
    fetchDocuments(email),
    fetchPayslips(user.uid, email),
    fetchVacationHistory(user.uid, email)
  ]);
  renderCollaboratorView({ employee, documents, payslips, vacations });
}

async function initializeManagerView() {
  employeesCache = await listEmployees();
  lastPunchCache = await fetchLastPunchMap(employeesCache);
  managerSummary = await buildManagerSummary(employeesCache);
  await renderManagerView();
}

window.EmployeesView = async function EmployeesView() {
  currentFilters = { search: "", status: "", role: "", costCenter: "" };
  if (isManager()) {
    await initializeManagerView();
  } else {
    await renderCollaborator();
  }
};
