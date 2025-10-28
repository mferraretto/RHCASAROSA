// Employees module with manager and collaborator experiences
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
import { getStorage, ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-storage.js";
import { logActivity } from "./activity.js";

const db = getFirestore();
const storage = getStorage();
const managerRoles = ["ADM", "Gestor", "RH"];
const monthNames = [
  "Janeiro",
  "Fevereiro",
  "Março",
  "Abril",
  "Maio",
  "Junho",
  "Julho",
  "Agosto",
  "Setembro",
  "Outubro",
  "Novembro",
  "Dezembro"
];

let employeesCache = [];
let attendanceCache = {};
let holeritesCache = [];
let vacationsCache = [];
let currentFilters = {
  search: "",
  status: "",
  role: "",
  costCenter: ""
};

function isManager(profile) {
  if (!profile) return false;
  return managerRoles.includes(profile.role || "");
}

function normalizeCurrency(value) {
  if (value === null || value === undefined || value === "") return "—";
  const num = Number(value);
  if (Number.isNaN(num)) return value;
  return num.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    return date.toLocaleDateString("pt-BR");
  }
  // fallback for YYYY-MM-DD
  const parts = value.split("-");
  if (parts.length >= 3) {
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }
  return value;
}

function formatAttendanceRecord(record) {
  if (!record) return "—";
  const when = record.ts ? new Date(record.ts) : null;
  return when && !Number.isNaN(when.getTime())
    ? `${when.toLocaleDateString("pt-BR")} ${when.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`
    : record.ts || "—";
}

async function listEmployees() {
  const snap = await getDocs(collection(db, "employees"));
  const rows = [];
  snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
  return rows;
}

async function listHolerites() {
  const snap = await getDocs(collection(db, "holerites"));
  const rows = [];
  snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
  return rows;
}

async function listVacations() {
  const snap = await getDocs(collection(db, "vacations"));
  const rows = [];
  snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
  return rows;
}

async function listDocsByEmail(email) {
  if (!email) return [];
  const snap = await getDocs(query(collection(db, "documents"), where("employee", "==", email)));
  const rows = [];
  snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
  return rows;
}

async function listHoleritesByUser(uid, email, employeeId) {
  const holeritesCol = collection(db, "holerites");
  let q = null;
  if (uid) {
    q = query(holeritesCol, where("uid", "==", uid), orderBy("generatedAt", "desc"));
  } else if (email) {
    q = query(holeritesCol, where("employeeEmail", "==", email), orderBy("generatedAt", "desc"));
  } else if (employeeId) {
    q = query(holeritesCol, where("employeeId", "==", employeeId), orderBy("generatedAt", "desc"));
  }
  if (!q) return [];
  const snap = await getDocs(q);
  const rows = [];
  snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
  return rows;
}

async function saveEmployee(payload, id = null) {
  if (payload.salary) {
    const salary = Number(payload.salary);
    payload.salary = Number.isNaN(salary) ? payload.salary : salary;
  }
  payload.updatedAt = new Date().toISOString();
  if (id) {
    await updateDoc(doc(db, "employees", id), payload);
    return id;
  }
  payload.createdAt = new Date().toISOString();
  const refDoc = await addDoc(collection(db, "employees"), payload);
  return refDoc.id;
}

async function fetchEmployeeByCurrentUser(user) {
  if (!user) return null;
  const employeesCol = collection(db, "employees");
  if (user.uid) {
    const q = query(employeesCol, where("uid", "==", user.uid), limit(1));
    const snap = await getDocs(q);
    if (!snap.empty) {
      const record = snap.docs[0];
      return { id: record.id, ...record.data() };
    }
  }
  if (user.email) {
    const q = query(employeesCol, where("email", "==", user.email), limit(1));
    const snap = await getDocs(q);
    if (!snap.empty) {
      const record = snap.docs[0];
      return { id: record.id, ...record.data() };
    }
  }
  return null;
}

async function fetchLastAttendance(employee) {
  if (!employee) return null;
  const byUid = employee.uid ? query(collection(db, "attendance"), where("uid", "==", employee.uid), orderBy("ts", "desc"), limit(1)) : null;
  const byEmail = employee.email
    ? query(collection(db, "attendance"), where("email", "==", employee.email), orderBy("ts", "desc"), limit(1))
    : null;
  let snap = null;
  if (byUid) {
    snap = await getDocs(byUid);
  }
  if (snap && !snap.empty) {
    return { id: snap.docs[0].id, ...snap.docs[0].data() };
  }
  if (byEmail) {
    snap = await getDocs(byEmail);
  }
  if (snap && !snap.empty) {
    return { id: snap.docs[0].id, ...snap.docs[0].data() };
  }
  return null;
}

async function ensureAttendanceCache(employees) {
  const entries = await Promise.all(
    employees.map(async (employee) => {
      try {
        const attendance = await fetchLastAttendance(employee);
        return [employee.id, attendance];
      } catch (err) {
        console.warn("Não foi possível carregar ponto para", employee.email, err);
        return [employee.id, null];
      }
    })
  );
  attendanceCache = Object.fromEntries(entries);
}

function filterEmployees(items) {
  return items.filter((employee) => {
    if (currentFilters.status && (employee.status || "Ativo") !== currentFilters.status) return false;
    if (currentFilters.role && (employee.role || "") !== currentFilters.role) return false;
    if (currentFilters.costCenter && (employee.costCenter || "") !== currentFilters.costCenter) return false;
    if (currentFilters.search) {
      const term = currentFilters.search.trim().toLowerCase();
      const searchable = [employee.name, employee.email, employee.doc, employee.role, employee.costCenter, employee.personalEmail]
        .filter(Boolean)
        .map((value) => value.toLowerCase());
      const matches = searchable.some((value) => value.includes(term));
      if (!matches) return false;
    }
    return true;
  });
}

function renderCostCenterDistribution(items) {
  if (!items.length) {
    return "<p class=\"helper\">Cadastre colaboradores para visualizar a distribuição.</p>";
  }
  const total = items.length;
  const countByCostCenter = items.reduce((acc, employee) => {
    const key = employee.costCenter || "Não informado";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const rows = Object.entries(countByCostCenter)
    .sort((a, b) => b[1] - a[1])
    .map(([costCenter, count]) => {
      const percentage = Math.round((count / total) * 100);
      return `<li><strong>${costCenter}</strong><br><small class=\"helper\">${count} colaborador(es) • ${percentage}%</small></li>`;
    })
    .join("");
  return `<ul class=\"list\">${rows}</ul>`;
}

function renderBirthdays(items) {
  const now = new Date();
  const month = now.getMonth() + 1;
  const birthdayEmployees = items.filter((employee) => {
    if (!employee.birthday) return false;
    const [, birthMonth] = employee.birthday.split("-");
    return Number(birthMonth) === month;
  });
  if (!birthdayEmployees.length) {
    return `<p class=\"helper\">Sem aniversariantes neste mês.</p>`;
  }
  const rows = birthdayEmployees
    .map((employee) => {
      const [, , day] = employee.birthday.split("-");
      return `<li><strong>${employee.name || employee.email}</strong><br><small class=\"helper\">${day.padStart(2, "0")}/${String(month).padStart(2, "0")}</small></li>`;
    })
    .join("");
  return `<ul class=\"list\">${rows}</ul>`;
}

function renderTeamEvolution(items) {
  if (!items.length) {
    return `<p class=\"helper\">Cadastre colaboradores para acompanhar o crescimento.</p>`;
  }
  const history = {};
  items.forEach((employee) => {
    if (!employee.hireDate) return;
    const [year, month] = employee.hireDate.split("-");
    if (!year || !month) return;
    const key = `${year}-${month}`;
    history[key] = (history[key] || 0) + 1;
  });
  const sortedKeys = Object.keys(history).sort();
  const lastSix = sortedKeys.slice(-6);
  if (!lastSix.length) {
    return `<p class=\"helper\">Sem dados suficientes.</p>`;
  }
  const rows = lastSix
    .map((key) => {
      const [year, month] = key.split("-");
      const label = `${monthNames[Number(month) - 1]}/${year}`;
      return `<li><strong>${history[key]} novo(s)</strong><br><small class=\"helper\">${label}</small></li>`;
    })
    .join("");
  return `<ul class=\"list\">${rows}</ul>`;
}

function renderVacationStatus() {
  if (!vacationsCache.length) {
    return `<p class=\"helper\">Sem solicitações registradas.</p>`;
  }
  const totals = vacationsCache.reduce(
    (acc, item) => {
      acc[item.status || "Pendente"] = (acc[item.status || "Pendente"] || 0) + 1;
      return acc;
    },
    {}
  );
  const rows = Object.entries(totals)
    .map(([status, count]) => `<li><strong>${count}</strong><br><small class=\"helper\">${status}</small></li>`)
    .join("");
  return `<ul class=\"list\">${rows}</ul>`;
}

function renderHoleriteStatus(items) {
  if (!items.length) {
    return `<p class=\"helper\">Nenhum holerite gerado ainda.</p>`;
  }
  const now = new Date();
  const currentKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const generated = new Set();
  items.forEach((item) => {
    const key = `${item.year}-${String(item.month).padStart(2, "0")}`;
    if (key === currentKey) {
      generated.add(item.uid || item.employeeId || item.employeeEmail);
    }
  });
  const pending = employeesCache.filter((employee) => (employee.status || "Ativo") === "Ativo").filter((employee) => {
    const key = employee.uid || employee.id || employee.email;
    return !generated.has(key);
  }).length;
  return `<div class=\"kpi small\"><div class=\"label\">Holerites pendentes (${monthNames[now.getMonth()]})</div><div class=\"value\">${pending}</div><small class=\"helper\">Colaboradores ativos sem holerite</small></div>`;
}

function renderSummary(items) {
  if (!items.length) {
    return '<p class="helper">Cadastre colaboradores para ver indicadores.</p>';
  }
  const total = items.length;
  const active = items.filter((employee) => (employee.status || "Ativo") === "Ativo").length;
  const inactive = total - active;
  let salarySum = 0;
  let salaryCount = 0;
  items.forEach((employee) => {
    const value = Number(employee.salary);
    if (!Number.isNaN(value) && value > 0) {
      salarySum += value;
      salaryCount += 1;
    }
  });
  const avgSalary = salaryCount
    ? (salarySum / salaryCount).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
    : "—";
  return [
    `<div class=\"kpi small\"><div class=\"label\">Colaboradores ativos</div><div class=\"value\">${active}</div><small class=\"helper\">Inativos: ${inactive}</small></div>`,
    `<div class=\"kpi small\"><div class=\"label\">Total cadastrado</div><div class=\"value\">${total}</div><small class=\"helper\">Equipe Casa Rosa</small></div>`,
    `<div class=\"kpi small\"><div class=\"label\">Média salarial</div><div class=\"value\">${avgSalary}</div><small class=\"helper\">Base em ${salaryCount} cadastros</small></div>`
  ].join("");
}

function renderTable(items) {
  if (!items.length) return '<p>Nenhum colaborador cadastrado.</p>';
  return `
    <table class="table">
      <thead>
        <tr>
          <th>Nome</th>
          <th>Cargo</th>
          <th>Centro de Custo</th>
          <th>Admissão</th>
          <th>Salário</th>
          <th>Status</th>
          <th>Último Ponto</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${items
          .map((employee) => {
            const attendance = attendanceCache[employee.id];
            const statusClass = (employee.status || "Ativo") === "Ativo" ? "ok" : "warn";
            return `
              <tr>
                <td>${employee.name || "—"}<br><small class="helper">${employee.email || ""}</small></td>
                <td>${employee.role || "—"}</td>
                <td>${employee.costCenter || "—"}</td>
                <td>${formatDate(employee.hireDate)}</td>
                <td class="num">${normalizeCurrency(employee.salary)}</td>
                <td><span class="badge ${statusClass}">${employee.status || "Ativo"}</span></td>
                <td><small class="helper">${formatAttendanceRecord(attendance)}</small></td>
                <td class="actions">
                  <button class="btn ghost" data-edit="${employee.id}">✏️ Editar</button>
                  <button class="btn ghost" data-payroll="${employee.id}">📄 Holerite</button>
                  <button class="btn ghost" data-export="${employee.id}">📤 CSV</button>
                  <button class="btn ghost" data-docs="${employee.id}">📁 Documentos</button>
                  <button class="btn ghost" data-vacations="${employee.id}">🏝️ Férias</button>
                  <button class="btn warn" data-deactivate="${employee.id}">${(employee.status || "Ativo") === "Ativo" ? "❌ Desativar" : "Reativar"}</button>
                </td>
              </tr>
            `;
          })
          .join("")}
      </tbody>
    </table>
  `;
}

function renderManagerInsights(items) {
  return `
    <div class="grid cols-2 insights-grid">
      <div class="card mini">
        <h4>Distribuição por centro de custo</h4>
        ${renderCostCenterDistribution(items)}
      </div>
      <div class="card mini">
        <h4>Aniversariantes do mês</h4>
        ${renderBirthdays(items)}
      </div>
      <div class="card mini">
        <h4>Evolução da equipe (6 meses)</h4>
        ${renderTeamEvolution(items)}
      </div>
      <div class="card mini">
        <h4>Status de férias</h4>
        ${renderVacationStatus()}
      </div>
      <div class="card mini">
        ${renderHoleriteStatus(holeritesCache)}
      </div>
    </div>
  `;
}

function exportEmployeesToCsv(items, fileName = "colaboradores.csv") {
  if (!items.length) {
    alert("Nada para exportar.");
    return;
  }
  const headers = [
    "Nome",
    "Email",
    "Cargo",
    "Centro de Custo",
    "Admissão",
    "Tipo de contrato",
    "Salário",
    "Jornada",
    "Gestor",
    "Status"
  ];
  const rows = items.map((employee) => [
    employee.name || "",
    employee.email || "",
    employee.role || "",
    employee.costCenter || "",
    employee.hireDate || "",
    employee.contractType || "",
    employee.salary || "",
    employee.workload || "",
    employee.manager || "",
    employee.status || "Ativo"
  ]);
  const csv = [headers, ...rows]
    .map((row) => row.map((field) => `"${String(field).replace(/"/g, '""')}"`).join(";"))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
}

function setFiltersOptions(items) {
  const roles = new Set();
  const statuses = new Set();
  const costCenters = new Set();
  items.forEach((employee) => {
    if (employee.role) roles.add(employee.role);
    if (employee.status) statuses.add(employee.status);
    if (employee.costCenter) costCenters.add(employee.costCenter);
  });
  const roleSelect = document.getElementById("filterRole");
  const statusSelect = document.getElementById("filterStatus");
  const costCenterSelect = document.getElementById("filterCost");
  if (roleSelect) {
    roleSelect.innerHTML = '<option value="">Cargo</option>' + [...roles].map((role) => `<option value="${role}">${role}</option>`).join("");
  }
  if (statusSelect) {
    statusSelect.innerHTML = '<option value="">Status</option>' + [...statuses]
      .map((status) => `<option value="${status}">${status}</option>`)
      .join("");
  }
  if (costCenterSelect) {
    costCenterSelect.innerHTML = '<option value="">Centro de custo</option>' + [...costCenters]
      .map((costCenter) => `<option value="${costCenter}">${costCenter}</option>`)
      .join("");
  }
}

function openModal(content) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.innerHTML = content;
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      overlay.remove();
    }
  });
  modal.querySelectorAll("[data-close]").forEach((element) => {
    element.addEventListener("click", () => overlay.remove());
  });
  return overlay;
}

function parseEntries(input) {
  if (!input) return [];
  return input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [label, value] = line.split(":");
      return {
        label: label?.trim() || "—",
        value: Number(value?.replace(/[^0-9,-]+/g, "").replace(",", ".")) || 0
      };
    });
}

async function generatePayrollPdf(employee, data) {
  const module = await import("https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.es.min.js");
  const { jsPDF } = module;
  const docPdf = new jsPDF();

  docPdf.setFillColor(255, 0, 138);
  docPdf.rect(0, 0, 210, 25, "F");
  docPdf.setTextColor(255, 255, 255);
  docPdf.setFontSize(18);
  docPdf.text("Casa Rosa RH", 10, 16);

  docPdf.setFontSize(11);
  docPdf.setTextColor(17, 24, 39);
  docPdf.text(`Holerite • ${monthNames[data.month - 1]} / ${data.year}`, 10, 35);

  docPdf.setFontSize(10);
  const details = [
    `Colaborador: ${employee.name || employee.email || "—"}`,
    `Cargo: ${employee.role || "—"}`,
    `Centro de Custo: ${employee.costCenter || "—"}`,
    `Admissão: ${formatDate(employee.hireDate)}`
  ];
  details.forEach((line, index) => {
    docPdf.text(line, 10, 45 + index * 6);
  });

  const tableStart = 75;
  docPdf.setFillColor(0, 197, 192);
  docPdf.rect(10, tableStart - 8, 90, 8, "F");
  docPdf.rect(110, tableStart - 8, 90, 8, "F");
  docPdf.setTextColor(255, 255, 255);
  docPdf.text("Vencimentos", 12, tableStart - 2);
  docPdf.text("Descontos", 112, tableStart - 2);

  docPdf.setTextColor(17, 24, 39);
  docPdf.setFontSize(10);
  const earnings = data.earnings;
  const deductions = data.deductions;
  const maxRows = Math.max(earnings.length, deductions.length);
  for (let index = 0; index < maxRows; index += 1) {
    const y = tableStart + index * 6;
    if (earnings[index]) {
      docPdf.text(`${earnings[index].label}: ${normalizeCurrency(earnings[index].value)}`, 12, y);
    }
    if (deductions[index]) {
      docPdf.text(`${deductions[index].label}: ${normalizeCurrency(deductions[index].value)}`, 112, y);
    }
  }

  docPdf.setDrawColor(255, 212, 42);
  docPdf.setLineWidth(0.6);
  const summaryY = tableStart + maxRows * 6 + 8;
  docPdf.line(10, summaryY, 200, summaryY);
  docPdf.setFontSize(12);
  docPdf.text(`Valor líquido: ${normalizeCurrency(data.netValue)}`, 12, summaryY + 8);
  docPdf.setFontSize(10);
  docPdf.text(`Gerado em ${new Date().toLocaleString("pt-BR")}`, 12, summaryY + 18);
  docPdf.text("Assinatura digital: Casa Rosa RH", 12, summaryY + 28);

  return docPdf;
}

async function handlePayrollGeneration(employee, form, overlay) {
  const formData = new FormData(form);
  const month = Number(formData.get("month"));
  const year = Number(formData.get("year"));
  const earnings = parseEntries(formData.get("earnings"));
  const deductions = parseEntries(formData.get("deductions"));
  const netValueRaw = Number(formData.get("netValue"));
  const netValue = Number.isNaN(netValueRaw) ? 0 : netValueRaw;

  const pdf = await generatePayrollPdf(employee, { month, year, earnings, deductions, netValue });
  const blob = pdf.output("blob");
  const fileName = `holerite-${employee.name || employee.email || employee.id}-${String(month).padStart(2, "0")}-${year}.pdf`
    .replace(/\s+/g, "-")
    .toLowerCase();
  const storagePath = `rh/holerites/${employee.uid || employee.id || employee.email}/${year}-${String(month).padStart(2, "0")}.pdf`;
  const storageRef = ref(storage, storagePath);
  await uploadBytes(storageRef, blob, { contentType: "application/pdf" });
  const downloadUrl = await getDownloadURL(storageRef);

  await addDoc(collection(db, "holerites"), {
    employeeId: employee.id,
    uid: employee.uid || null,
    employeeEmail: employee.email || null,
    month,
    year,
    netValue,
    earnings,
    deductions,
    path: storagePath,
    url: downloadUrl,
    generatedAt: new Date().toISOString()
  });

  await logActivity("employee.payroll", {
    employee: employee.email || employee.name,
    month,
    year,
    netValue
  });

  const downloadLink = document.createElement("a");
  downloadLink.href = URL.createObjectURL(blob);
  downloadLink.download = fileName;
  document.body.appendChild(downloadLink);
  downloadLink.click();
  document.body.removeChild(downloadLink);
  URL.revokeObjectURL(downloadLink.href);

  overlay.remove();
  alert("Holerite gerado e salvo no Storage!");
  holeritesCache = await listHolerites();
  refreshEmployeesUI();
}

function openPayrollModal(employee) {
  const now = new Date();
  const content = `
    <header>
      <h3>Gerar Holerite • ${employee.name || employee.email}</h3>
      <button class="btn ghost" data-close>Fechar</button>
    </header>
    <form class="grid cols-2" id="payrollForm">
      <label class="stacked">
        <span>Mês</span>
        <select class="input" name="month" required>
          ${monthNames
            .map((label, index) => {
              const month = index + 1;
              const selected = month === now.getMonth() + 1 ? "selected" : "";
              return `<option value="${month}" ${selected}>${label}</option>`;
            })
            .join("")}
        </select>
      </label>
      <label class="stacked">
        <span>Ano</span>
        <input class="input" type="number" name="year" value="${now.getFullYear()}" min="2000" required />
      </label>
      <label class="stacked full">
        <span>Vencimentos (um por linha: Descrição: valor)</span>
        <textarea class="input" name="earnings" rows="4">Salário base: ${employee.salary || 0}</textarea>
      </label>
      <label class="stacked full">
        <span>Descontos (um por linha: Descrição: valor)</span>
        <textarea class="input" name="deductions" rows="4">INSS: 0</textarea>
      </label>
      <label class="stacked">
        <span>Valor líquido (R$)</span>
        <input class="input" type="number" step="0.01" name="netValue" value="${employee.salary || 0}" required />
      </label>
      <div class="actions-right">
        <button class="btn" type="submit">Gerar PDF</button>
      </div>
    </form>
  `;
  const overlay = openModal(content);
  const form = overlay.querySelector("#payrollForm");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = form.querySelector("button[type=submit]");
    submitButton.disabled = true;
    submitButton.textContent = "Gerando...";
    try {
      await handlePayrollGeneration(employee, form, overlay);
    } catch (err) {
      console.error("Erro ao gerar holerite", err);
      alert("Não foi possível gerar o holerite. Tente novamente.");
      submitButton.disabled = false;
      submitButton.textContent = "Gerar PDF";
    }
  });
}

function openForm(existing = null) {
  const container = document.getElementById("employees-form");
  container.innerHTML = `
    <div class="card">
      <h3>${existing ? "Editar" : "Novo"} colaborador</h3>
      <form id="femp" class="grid cols-3">
        <input class="input" name="name" placeholder="Nome completo" value="${existing?.name || ""}" required />
        <input class="input" name="email" type="email" placeholder="Email" value="${existing?.email || ""}" required />
        <input class="input" name="personalEmail" type="email" placeholder="Email pessoal" value="${existing?.personalEmail || ""}" />
        <input class="input" name="phone" placeholder="Celular" value="${existing?.phone || ""}" />
        <input class="input" name="doc" placeholder="CPF" value="${existing?.doc || ""}" />
        <input class="input" name="rg" placeholder="RG" value="${existing?.rg || ""}" />
        <input class="input" name="role" placeholder="Cargo" value="${existing?.role || ""}" />
        <input class="input" name="costCenter" placeholder="Centro de custo" value="${existing?.costCenter || "Geral"}" />
        <input class="input" name="workload" placeholder="Jornada (ex: 44h)" value="${existing?.workload || "44h"}" />
        <input class="input" name="hireDate" type="date" value="${existing?.hireDate || ""}" />
        <input class="input" name="birthday" type="date" value="${existing?.birthday || ""}" />
        <input class="input" name="manager" placeholder="Supervisor / Gestor" value="${existing?.manager || ""}" />
        <select class="input" name="contractType">
          ${["CLT", "PJ", "Estágio", "Autônomo"]
            .map((type) => `<option value="${type}" ${existing?.contractType === type ? "selected" : ""}>${type}</option>`)
            .join("")}
        </select>
        <input class="input" name="salary" type="number" step="0.01" placeholder="Salário base (R$)" value="${existing?.salary || ""}" />
        <select class="input" name="status">
          <option value="Ativo" ${existing?.status !== "Inativo" ? "selected" : ""}>Ativo</option>
          <option value="Inativo" ${existing?.status === "Inativo" ? "selected" : ""}>Inativo</option>
        </select>
        <input class="input" name="uid" placeholder="UID (opcional)" value="${existing?.uid || ""}" />
        <textarea class="input full" name="notes" placeholder="Observações">${existing?.notes || ""}</textarea>
        <div class="actions-right full">
          <button class="btn ghost" type="button" id="cancel">Cancelar</button>
          <button class="btn" type="submit">${existing ? "Salvar" : "Adicionar"}</button>
        </div>
      </form>
    </div>
  `;

  document.getElementById("cancel").onclick = () => {
    container.innerHTML = "";
  };

  const form = document.getElementById("femp");
  form.onsubmit = async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    if (existing) {
      await saveEmployee(data, existing.id);
      await logActivity("employee.update", { name: data.name, email: data.email, role: data.role });
    } else {
      const id = await saveEmployee(data);
      await logActivity("employee.add", { id, name: data.name, email: data.email, role: data.role });
    }
    await hydrateCaches();
    refreshEmployeesUI();
    container.innerHTML = "";
  };
}

function exportSingleEmployee(employee) {
  exportEmployeesToCsv([employee], `colaborador-${employee.name || employee.id}.csv`);
}

async function deactivateEmployee(employee) {
  const newStatus = (employee.status || "Ativo") === "Ativo" ? "Inativo" : "Ativo";
  await updateDoc(doc(db, "employees", employee.id), { status: newStatus, updatedAt: new Date().toISOString() });
  await logActivity("employee.update", { name: employee.name, email: employee.email, status: newStatus });
  await hydrateCaches();
  refreshEmployeesUI();
}

function goToDocuments(employee) {
  sessionStorage.setItem("documents:search", employee.email || "");
  location.hash = "#documents";
}

function goToVacations(employee) {
  sessionStorage.setItem("vacations:focus", employee.email || "");
  location.hash = "#vacations";
}

function attachRowActions() {
  const container = document.getElementById("employees-table");
  if (!container) return;
  container.querySelectorAll("button[data-edit]").forEach((button) => {
    button.onclick = async () => {
      const id = button.getAttribute("data-edit");
      const record = employeesCache.find((employee) => employee.id === id);
      const snap = await getDoc(doc(db, "employees", id));
      await openForm({ id, ...snap.data(), ...record });
    };
  });
  container.querySelectorAll("button[data-payroll]").forEach((button) => {
    button.onclick = () => {
      const id = button.getAttribute("data-payroll");
      const employee = employeesCache.find((item) => item.id === id);
      openPayrollModal(employee);
    };
  });
  container.querySelectorAll("button[data-export]").forEach((button) => {
    button.onclick = () => {
      const id = button.getAttribute("data-export");
      const employee = employeesCache.find((item) => item.id === id);
      exportSingleEmployee(employee);
    };
  });
  container.querySelectorAll("button[data-docs]").forEach((button) => {
    button.onclick = () => {
      const id = button.getAttribute("data-docs");
      const employee = employeesCache.find((item) => item.id === id);
      goToDocuments(employee);
    };
  });
  container.querySelectorAll("button[data-vacations]").forEach((button) => {
    button.onclick = () => {
      const id = button.getAttribute("data-vacations");
      const employee = employeesCache.find((item) => item.id === id);
      goToVacations(employee);
    };
  });
  container.querySelectorAll("button[data-deactivate]").forEach((button) => {
    button.onclick = async () => {
      const id = button.getAttribute("data-deactivate");
      const employee = employeesCache.find((item) => item.id === id);
      const action = (employee.status || "Ativo") === "Ativo" ? "desativar" : "reativar";
      if (confirm(`Deseja ${action} este colaborador?`)) {
        await deactivateEmployee(employee);
      }
    };
  });
}

function refreshEmployeesUI() {
  const summaryBox = document.getElementById("employees-summary");
  if (summaryBox) {
    summaryBox.innerHTML = renderSummary(employeesCache);
  }
  const insightsBox = document.getElementById("employees-insights");
  if (insightsBox) {
    insightsBox.innerHTML = renderManagerInsights(employeesCache);
  }
  const filtered = filterEmployees(employeesCache);
  const tableBox = document.getElementById("employees-table");
  if (tableBox) {
    tableBox.innerHTML = renderTable(filtered);
  }
  const countLabel = document.getElementById("employees-count");
  if (countLabel) {
    countLabel.textContent = filtered.length ? `${filtered.length} de ${employeesCache.length} colaboradores exibidos` : "Nenhum colaborador encontrado.";
  }
  attachRowActions();
}

async function hydrateCaches() {
  employeesCache = await listEmployees();
  await ensureAttendanceCache(employeesCache);
  holeritesCache = await listHolerites();
  vacationsCache = await listVacations();
  setFiltersOptions(employeesCache);
}

async function renderManagerView() {
  currentFilters = { search: "", status: "", role: "", costCenter: "" };
  const container = document.getElementById("view");
  container.innerHTML = `
    <div class="grid cols-1">
      <div class="card">
        <div class="toolbar">
          <div>
            <h2 style="margin:0">Colaboradores</h2>
            <small class="helper">Cadastro completo do time Casa Rosa</small>
          </div>
          <div class="toolbar-actions">
            <input class="input search" id="empSearch" placeholder="Buscar por nome, e-mail ou cargo" />
            <select class="input" id="filterRole"></select>
            <select class="input" id="filterStatus"></select>
            <select class="input" id="filterCost"></select>
            <button class="btn ghost" id="exportAll">Exportar CSV</button>
            <button class="btn" id="addEmp">Adicionar</button>
          </div>
        </div>
        <div id="employees-summary" class="summary-grid"></div>
        <div id="employees-insights" class="insights"></div>
        <div id="employees-count" class="helper"></div>
        <div id="employees-table"></div>
        <div id="employees-form" style="margin-top:1rem"></div>
      </div>
    </div>
  `;

  document.getElementById("addEmp").onclick = () => openForm();
  document.getElementById("exportAll").onclick = () => exportEmployeesToCsv(filterEmployees(employeesCache));
  const searchInput = document.getElementById("empSearch");
  if (searchInput) {
    searchInput.oninput = (event) => {
      currentFilters.search = event.target.value;
      refreshEmployeesUI();
    };
  }
  [
    ["filterRole", "role"],
    ["filterStatus", "status"],
    ["filterCost", "costCenter"]
  ].forEach(([elementId, key]) => {
    const element = document.getElementById(elementId);
    if (!element) return;
    element.onchange = (event) => {
      currentFilters[key] = event.target.value;
      refreshEmployeesUI();
    };
  });

  await hydrateCaches();
  refreshEmployeesUI();
}

function renderContactCard(employee) {
  if (!employee) {
    return `<p class=\"helper\">Nenhum cadastro encontrado. Procure o RH.</p>`;
  }
  return `
    <div class="card">
      <h3>Meus dados</h3>
      <div class="grid cols-2">
        <div>
          <strong>${employee.name || "—"}</strong>
          <p><small class="helper">${employee.role || "—"} • ${employee.costCenter || "—"}</small></p>
        </div>
        <div class="actions-right">
          <button class="btn ghost" id="requestUpdate">Solicitar atualização cadastral</button>
        </div>
      </div>
      <div class="grid cols-2" style="margin-top:1rem">
        <div>
          <div><strong>Admissão:</strong> ${formatDate(employee.hireDate)}</div>
          <div><strong>Salário base:</strong> ${normalizeCurrency(employee.salary)}</div>
          <div><strong>Jornada:</strong> ${employee.workload || "—"}</div>
        </div>
        <div>
          <div><strong>Status:</strong> ${employee.status || "Ativo"}</div>
          <div><strong>Gestor:</strong> ${employee.manager || "—"}</div>
          <div><strong>Contrato:</strong> ${employee.contractType || "—"}</div>
        </div>
      </div>
      <hr class="split" />
      <div class="grid cols-2">
        <div>
          <div><strong>Email corporativo:</strong> ${employee.email || "—"}</div>
          <div><strong>Email pessoal:</strong> ${employee.personalEmail || "—"}</div>
        </div>
        <div>
          <div><strong>Telefone:</strong> ${employee.phone || "—"}</div>
          <div><strong>CPF:</strong> ${employee.doc || "—"}</div>
        </div>
      </div>
    </div>
  `;
}

function renderDocumentsList(documents) {
  if (!documents.length) {
    return `<p class=\"helper\">Nenhum documento disponível ainda.</p>`;
  }
  const rows = documents
    .sort((a, b) => new Date(b.uploadedAt || 0) - new Date(a.uploadedAt || 0))
    .map((docItem) => `<tr><td>${docItem.type || "Documento"}</td><td><a href="${docItem.url}" target="_blank">Baixar</a></td><td>${docItem.uploadedAt ? new Date(docItem.uploadedAt).toLocaleDateString("pt-BR") : "—"}</td></tr>`)
    .join("");
  return `
    <table class="table">
      <thead><tr><th>Tipo</th><th>Arquivo</th><th>Disponível desde</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderHoleritesList(items) {
  if (!items.length) {
    return `<p class=\"helper\">Nenhum holerite disponível.</p>`;
  }
  const rows = items
    .sort((a, b) => new Date(b.generatedAt || 0) - new Date(a.generatedAt || 0))
    .map((holerite) => {
      const label = `${monthNames[(holerite.month || 1) - 1]}/${holerite.year}`;
      return `<tr><td>${label}</td><td>${normalizeCurrency(holerite.netValue)}</td><td><a href="${holerite.url}" target="_blank">Baixar PDF</a></td></tr>`;
    })
    .join("");
  return `
    <table class="table">
      <thead><tr><th>Mês/Ano</th><th>Valor líquido</th><th>Ações</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderVacationsList(items) {
  if (!items.length) {
    return `<p class=\"helper\">Nenhum período registrado.</p>`;
  }
  const rows = items
    .sort((a, b) => new Date(b.start || 0) - new Date(a.start || 0))
    .map((vacation) => `<tr><td>${vacation.start || "—"} → ${vacation.end || "—"}</td><td>${vacation.status || "Pendente"}</td></tr>`)
    .join("");
  return `
    <table class="table">
      <thead><tr><th>Período</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function openUpdateRequestModal(employee) {
  const content = `
    <header>
      <h3>Solicitar atualização cadastral</h3>
      <button class="btn ghost" data-close>Fechar</button>
    </header>
    <form class="grid" id="updateForm">
      <input class="input" name="phone" placeholder="Telefone" value="${employee?.phone || ""}" />
      <input class="input" name="personalEmail" type="email" placeholder="Email pessoal" value="${employee?.personalEmail || ""}" />
      <textarea class="input" name="message" rows="4" placeholder="Descreva a alteração desejada"></textarea>
      <button class="btn" type="submit">Enviar pedido</button>
    </form>
  `;
  const overlay = openModal(content);
  const form = overlay.querySelector("#updateForm");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    const updates = {};
    if (data.phone !== undefined) updates.phone = data.phone;
    if (data.personalEmail !== undefined) updates.personalEmail = data.personalEmail;
    updates.updatedAt = new Date().toISOString();
    if (employee?.id) {
      await updateDoc(doc(db, "employees", employee.id), updates);
    }
    await addDoc(collection(db, "updateRequests"), {
      employeeId: employee?.id || null,
      uid: employee?.uid || null,
      message: data.message || "",
      requestedAt: new Date().toISOString()
    });
    alert("Solicitação enviada ao RH!");
    overlay.remove();
  });
}

async function renderCollaboratorView() {
  const container = document.getElementById("view");
  const user = window.__APP__?.user;
  const employee = await fetchEmployeeByCurrentUser(user);
  const documents = await listDocsByEmail(employee?.email || user?.email);
  const holerites = await listHoleritesByUser(employee?.uid || user?.uid, employee?.email || user?.email, employee?.id);
  const vacations = employee?.uid
    ? await (async () => {
        const snap = await getDocs(query(collection(db, "vacations"), where("uid", "==", employee.uid)));
        const rows = [];
        snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
        return rows;
      })()
    : [];
  container.innerHTML = `
    <div class="grid cols-2">
      <div id="employee-card"></div>
      <div class="card">
        <h3>Meus documentos</h3>
        ${renderDocumentsList(documents)}
      </div>
    </div>
    <div class="grid cols-2" style="margin-top:1rem">
      <div class="card">
        <h3>Meus holerites</h3>
        ${renderHoleritesList(holerites)}
      </div>
      <div class="card">
        <h3>Minhas férias</h3>
        ${renderVacationsList(vacations)}
        <div class="actions-right" style="margin-top:1rem">
          <button class="btn ghost" onclick="location.hash='#vacations'">Solicitar férias</button>
        </div>
      </div>
    </div>
  `;
  const card = document.getElementById("employee-card");
  card.innerHTML = renderContactCard(employee);
  const button = card.querySelector("#requestUpdate");
  if (button) {
    button.onclick = () => openUpdateRequestModal(employee);
  }
}

window.EmployeesView = async function EmployeesView() {
  const profile = window.__APP__?.profile || {};
  if (isManager(profile)) {
    await renderManagerView();
  } else {
    await renderCollaboratorView();
  }
};

*** End of File
