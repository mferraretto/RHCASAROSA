// Gestão completa da aba 📁 Documentos com filtros, versões e assinaturas
import {
  getFirestore,
  collection,
  addDoc,
  getDocs,
  doc as firestoreDoc,
  updateDoc,
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

const DOCUMENT_LIBRARY = [
  { value: "RG", label: "RG", category: "Pessoais", tags: ["pessoal", "identidade"] },
  { value: "CPF", label: "CPF", category: "Pessoais", tags: ["pessoal", "identidade"] },
  { value: "CNH", label: "CNH", category: "Pessoais", tags: ["pessoal", "transito"] },
  {
    value: "ComprovanteEndereco",
    label: "Comprovante de Endereço",
    category: "Pessoais",
    tags: ["pessoal", "endereco"]
  },
  { value: "Certidao", label: "Certidão", category: "Pessoais", tags: ["pessoal", "civil"] },
  {
    value: "Contrato",
    label: "Contrato de Trabalho",
    category: "Admissionais",
    tags: ["contrato", "admissional"]
  },
  {
    value: "FichaRegistro",
    label: "Ficha de Registro",
    category: "Admissionais",
    tags: ["admissional", "registro"]
  },
  { value: "PIS", label: "PIS", category: "Admissionais", tags: ["admissional", "beneficio"] },
  {
    value: "CarteiraTrabalho",
    label: "Carteira de Trabalho Digital",
    category: "Admissionais",
    tags: ["admissional", "ctps"]
  },
  { value: "ASO", label: "ASO", category: "Médicos/Segurança", tags: ["saude", "seguranca", "nr"] },
  {
    value: "PPRA",
    label: "PPRA / PCMSO / LTCAT",
    category: "Médicos/Segurança",
    tags: ["seguranca", "nr"]
  },
  {
    value: "TreinamentoNR",
    label: "Treinamentos NR",
    category: "Médicos/Segurança",
    tags: ["treinamento", "nr", "seguranca"]
  },
  { value: "Holerite", label: "Holerite", category: "Financeiros", tags: ["financeiro", "folha"] },
  {
    value: "Adiantamento",
    label: "Adiantamento",
    category: "Financeiros",
    tags: ["financeiro"]
  },
  {
    value: "AvisoFerias",
    label: "Aviso de Férias",
    category: "Financeiros",
    tags: ["ferias", "financeiro"]
  },
  { value: "Rescisao", label: "Rescisão", category: "Financeiros", tags: ["rescisao", "juridico"] },
  {
    value: "Advertencia",
    label: "Advertência",
    category: "Jurídicos/Conduta",
    tags: ["disciplina", "juridico"]
  },
  {
    value: "Termo",
    label: "Termos / Políticas",
    category: "Jurídicos/Conduta",
    tags: ["politica", "lgpd", "conduta"]
  },
  { value: "Acordo", label: "Acordo", category: "Jurídicos/Conduta", tags: ["juridico", "acordo"] },
  {
    value: "Certificado",
    label: "Certificado",
    category: "Operacionais",
    tags: ["operacional", "treinamento"]
  },
  { value: "Manual", label: "Manual", category: "Operacionais", tags: ["operacional", "processo"] },
  {
    value: "PoliticaInterna",
    label: "Política Interna",
    category: "Operacionais",
    tags: ["politica", "compliance"]
  },
  { value: "Outro", label: "Outro", category: "Outros", tags: ["outros"] }
];

const STATUS_LABELS = {
  Valido: { label: "Válido", badge: "ok" },
  Vencido: { label: "Vencido", badge: "danger" },
  "Em aprovacao": { label: "Em aprovação", badge: "warn" },
  "Em aprovação": { label: "Em aprovação", badge: "warn" },
  "Aguardando assinatura": { label: "Aguardando assinatura", badge: "ghost" }
};

const SIGN_STATUS_LABELS = {
  Pendente: { label: "Pendente", badge: "warn" },
  Assinado: { label: "Assinado", badge: "ok" },
  Recusado: { label: "Recusado", badge: "danger" }
};

const DEFAULT_FILTERS = {
  search: "",
  employeeUid: "",
  type: "",
  tags: [],
  status: "",
  costCenter: "",
  from: "",
  to: ""
};

const state = {
  loading: false,
  employees: [],
  employeeIndex: new Map(),
  documents: [],
  filtered: [],
  filters: { ...DEFAULT_FILTERS },
  teamUids: new Set(),
  selectedDocument: null
};

function getProfile() {
  return window.__APP__?.profile || { role: "Colaborador" };
}

function getUser() {
  return window.__APP__?.user || null;
}

function getRole() {
  return getProfile().role || "Colaborador";
}

function isADM() {
  return getRole() === "ADM";
}

function isRH() {
  return getRole() === "RH";
}

function isGestor() {
  return getRole() === "Gestor";
}

function isColaborador() {
  return getRole() === "Colaborador";
}

function canManageDocuments() {
  return isADM() || isRH();
}

function slugify(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function formatDate(value) {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("pt-BR");
}

function formatDateTime(value) {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("pt-BR");
}

function unique(array) {
  return Array.from(new Set(array.filter(Boolean)));
}

function buildTagOptions() {
  const fromLibrary = DOCUMENT_LIBRARY.flatMap((item) => item.tags || []);
  const fromDocuments = state.documents.flatMap((doc) => doc.tags || []);
  return unique([...fromLibrary, ...fromDocuments]).sort((a, b) => a.localeCompare(b));
}

function computeCostCenters() {
  const centers = state.documents
    .map((doc) => doc.costCenter)
    .concat(state.employees.map((emp) => emp.costCenter));
  return unique(centers).sort((a, b) => a.localeCompare(b));
}

function getDocumentTypeLabel(type) {
  if (!type) return "—";
  const item = DOCUMENT_LIBRARY.find((docType) => docType.value === type || docType.label === type);
  return item?.label || type;
}

function getDocumentCategory(type) {
  if (!type) return "—";
  const item = DOCUMENT_LIBRARY.find((docType) => docType.value === type || docType.label === type);
  return item?.category || "Outros";
}

function derivedStatus(doc) {
  const now = new Date();
  const status = doc.status || "Valido";
  if (status === "Valido" && doc.validUntil) {
    const validUntilDate = new Date(doc.validUntil);
    if (!Number.isNaN(validUntilDate.getTime())) {
      const difference = validUntilDate.getTime() - now.getTime();
      if (difference < 0) return "Vencido";
      if (difference <= 1000 * 60 * 60 * 24 * 30) return "Vencendo";
    }
  }
  return status;
}

function statusBadge(status) {
  if (status === "Vencendo") {
    return '<span class="badge warn">Vencendo</span>';
  }
  const info = STATUS_LABELS[status] || STATUS_LABELS[status?.replace("ç", "c")] || null;
  if (!info) return `<span class="badge ghost">${status || "—"}</span>`;
  return `<span class="badge ${info.badge}">${info.label}</span>`;
}

function validityBadge(doc) {
  if (!doc.validUntil) return "—";
  const expires = new Date(doc.validUntil);
  if (Number.isNaN(expires.getTime())) return "—";
  const today = new Date();
  const diffDays = Math.ceil((expires - today) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) {
    return `<span class="badge danger">Vencido há ${Math.abs(diffDays)} dia(s)</span>`;
  }
  if (diffDays === 0) {
    return '<span class="badge warn">Vence hoje</span>';
  }
  if (diffDays <= 30) {
    return `<span class="badge warn">Vence em ${diffDays} dia(s)</span>`;
  }
  return `<span class="badge ghost">${formatDate(doc.validUntil)}</span>`;
}

function signBadge(sign) {
  if (!sign || !sign.status) return "<span class=\"badge ghost\">—</span>";
  const info = SIGN_STATUS_LABELS[sign.status] || { label: sign.status, badge: "ghost" };
  return `<span class="badge ${info.badge}">${info.label}</span>`;
}

function employeeDisplay(doc) {
  if (!doc.employeeUid && !doc.employeeEmail) return "Corporativo";
  const byUid = doc.employeeUid ? state.employeeIndex.get(doc.employeeUid) : null;
  const byEmail = doc.employeeEmail ? state.employeeIndex.get(doc.employeeEmail.toLowerCase()) : null;
  const employee = byUid || byEmail;
  if (!employee) {
    return doc.employeeEmail || doc.employeeUid || "—";
  }
  return `${employee.name || employee.fullName || employee.email || "Colaborador"}`;
}

function employeeEmail(doc) {
  if (doc.employeeEmail) return doc.employeeEmail;
  const byUid = doc.employeeUid ? state.employeeIndex.get(doc.employeeUid) : null;
  const byEmail = doc.employeeEmail ? state.employeeIndex.get(doc.employeeEmail.toLowerCase()) : null;
  const employee = byUid || byEmail;
  return employee?.email || "";
}

function documentMatchesFilters(doc) {
  const filters = state.filters;
  if (filters.employeeUid && doc.employeeUid !== filters.employeeUid) return false;
  if (filters.type && doc.type !== filters.type) return false;
  if (filters.costCenter && (doc.costCenter || "") !== filters.costCenter) return false;
  if (filters.status) {
    const normalized = filters.status === "Vencendo" ? "Vencendo" : filters.status;
    const docStatus = derivedStatus(doc);
    if (normalized === "Vencendo") {
      if (docStatus !== "Vencendo") return false;
    } else if (docStatus !== normalized && (doc.status || "") !== normalized) {
      return false;
    }
  }
  if (filters.tags?.length) {
    const docTags = doc.tags || [];
    const hasAll = filters.tags.every((tag) => docTags.includes(tag));
    if (!hasAll) return false;
  }
  if (filters.from) {
    if (!doc.validUntil) return false;
    if (new Date(doc.validUntil) < new Date(filters.from)) return false;
  }
  if (filters.to) {
    if (!doc.validUntil) return false;
    if (new Date(doc.validUntil) > new Date(filters.to)) return false;
  }
  if (filters.search) {
    const needle = filters.search.toLowerCase();
    const haystack = [
      doc.title,
      doc.type,
      getDocumentTypeLabel(doc.type),
      employeeDisplay(doc),
      employeeEmail(doc),
      (doc.tags || []).join(" "),
      doc.notes,
      doc.path
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

function applyFilters() {
  state.filtered = state.documents.filter((doc) => !doc.archived && documentMatchesFilters(doc));
}

async function fetchEmployees() {
  const snapshot = await getDocs(collection(db, "employees"));
  const employees = [];
  snapshot.forEach((docSnap) => {
    employees.push({ id: docSnap.id, ...docSnap.data() });
  });
  return employees;
}

function buildEmployeeIndex(employees) {
  const map = new Map();
  employees.forEach((employee) => {
    if (employee.uid) map.set(employee.uid, employee);
    if (employee.id) map.set(employee.id, employee);
    if (employee.email) map.set(String(employee.email).toLowerCase(), employee);
  });
  state.employeeIndex = map;
}

function computeTeamUids(user) {
  if (!user) return;
  const teamMembers = state.employees.filter((emp) => {
    const managerUid = emp.managerUid || emp.manager || emp.approverUid;
    return managerUid && String(managerUid) === String(user.uid);
  });
  state.teamUids = new Set(teamMembers.map((emp) => emp.uid || emp.id));
}

function canSeeDocument(doc, user) {
  if (!user) return false;
  if (isADM() || isRH()) return true;
  if (isGestor()) {
    if (!doc.employeeUid) return false;
    return state.teamUids.has(doc.employeeUid);
  }
  return doc.employeeUid === user.uid;

}

async function fetchDocuments() {
  const user = getUser();
  if (!user) return [];
  const snapshot = await getDocs(collection(db, "documents"));
  const list = [];
  snapshot.forEach((docSnap) => {
    const data = docSnap.data();
    const entry = { id: docSnap.id, ...data };
    if (canSeeDocument(entry, user)) {
      list.push(entry);
    }
  });
  return list.sort((a, b) => {
    const aDate = new Date(a.uploadedAt || 0).getTime();
    const bDate = new Date(b.uploadedAt || 0).getTime();
    return bDate - aDate;
  });
}

function renderCards() {
  const expiring = state.filtered.filter((doc) => derivedStatus(doc) === "Vencendo");
  const pendingSignatures = state.filtered.filter((doc) => doc.sign?.status === "Pendente");
  const typeAggregations = new Map();
  state.filtered.forEach((doc) => {
    const key = doc.type || "Outro";
    const current = typeAggregations.get(key) || { total: 0, valid: 0 };
    current.total += 1;
    if (derivedStatus(doc) === "Valido") current.valid += 1;
    typeAggregations.set(key, current);
  });
  const topTypes = Array.from(typeAggregations.entries())
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 3);

  const expiringList = expiring
    .slice(0, 5)
    .map(
      (doc) => `
        <li>
          <strong>${doc.title || getDocumentTypeLabel(doc.type)}</strong>
          <br><small class="helper">${employeeDisplay(doc)} • ${formatDate(doc.validUntil)}</small>
        </li>
      `
    )
    .join("") || "<li>Nenhum documento nos próximos 30 dias.</li>";

  const signatureList = pendingSignatures
    .slice(0, 5)
    .map(
      (doc) => `
        <li>
          <strong>${doc.title || getDocumentTypeLabel(doc.type)}</strong>
          <br><small class="helper">${employeeDisplay(doc)} • solicitado em ${formatDate(doc.sign?.requestAt)}</small>
        </li>
      `
    )
    .join("") || "<li>Sem assinaturas pendentes.</li>";

  const complianceList = topTypes
    .map(([type, agg]) => {
      const percent = agg.total ? Math.round((agg.valid / agg.total) * 100) : 0;
      return `
        <li>
          <strong>${getDocumentTypeLabel(type)}</strong>
          <br><small class="helper">${agg.valid}/${agg.total} válidos (${percent}%)</small>
        </li>
      `;
    })
    .join("") || "<li>Nenhum documento para exibir.</li>";

  document.getElementById("card-expiring-count").textContent = expiring.length;
  document.getElementById("card-pending-signatures").textContent = pendingSignatures.length;
  document.getElementById("card-expiring-list").innerHTML = expiringList;
  document.getElementById("card-signature-list").innerHTML = signatureList;
  document.getElementById("card-top-types").innerHTML = complianceList;
}

function renderTable() {
  const tbody = document.getElementById("documents-table-body");
  if (!tbody) return;
  if (!state.filtered.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">Nenhum documento encontrado com os filtros atuais.</td></tr>';
    renderCards();
    return;
  }
  tbody.innerHTML = state.filtered
    .map((doc) => {
      const tags = (doc.tags || [])
        .map((tag) => `<span class="tag-chip">${tag}</span>`)
        .join(" ") || "<span class=\"tag-chip ghost\">Sem tags</span>";
      const actions = [
        `<button class="btn ghost doc-action" data-action="preview" data-id="${doc.id}">Abrir</button>`,
        `<button class="btn ghost doc-action" data-action="download" data-id="${doc.id}">Baixar</button>`
      ];
      if (canManageDocuments()) {
        actions.push(`<button class="btn ghost doc-action" data-action="new-version" data-id="${doc.id}">Nova versão</button>`);
      }
      actions.push(`<button class="btn ghost doc-action" data-action="history" data-id="${doc.id}">Histórico</button>`);
      if (canManageDocuments()) {
        actions.push(`<button class="btn ghost doc-action" data-action="request-signature" data-id="${doc.id}">${doc.sign?.status === "Pendente" ? "Lembrar" : "Solicitar"} assinatura</button>`);
      }
      if (doc.sign?.required && doc.sign?.status === "Pendente" && isColaborador() && doc.employeeUid === getUser()?.uid) {
        actions.push(`<button class="btn ghost doc-action" data-action="sign" data-id="${doc.id}">Assinar</button>`);
      }
      if (canManageDocuments()) {
        actions.push(`<button class="btn ghost danger doc-action" data-action="archive" data-id="${doc.id}">Arquivar</button>`);
      }
      return `
        <tr data-id="${doc.id}">
          <td>
            <div class="doc-title">${doc.title || getDocumentTypeLabel(doc.type)}</div>
            <div class="doc-meta">${getDocumentCategory(doc.type)} • ${tags}</div>
          </td>
          <td>${employeeDisplay(doc)}</td>
          <td>${doc.validUntil ? validityBadge(doc) : "—"}</td>
          <td><span class="badge ghost">v${doc.version || 1}</span></td>
          <td>${statusBadge(derivedStatus(doc))}</td>
          <td class="actions">${actions.join(" ")}</td>
        </tr>
      `;
    })
    .join("");
  renderCards();
  attachRowInteractions();
}

function renderFilters() {
  const typeSelect = document.getElementById("filter-type");
  if (typeSelect) {
    const options = DOCUMENT_LIBRARY.map(
      (item) => `<option value="${item.value}">${item.label} • ${item.category}</option>`
    ).join("");
    typeSelect.innerHTML = '<option value="">Tipo</option>' + options;
  }

  const tagSelect = document.getElementById("filter-tags");
  if (tagSelect) {
    const tags = buildTagOptions();
    tagSelect.innerHTML = tags
      .map((tag) => `<option value="${tag}">${tag}</option>`)
      .join("");
  }

  const costCenterSelect = document.getElementById("filter-cost-center");
  if (costCenterSelect) {
    const centers = computeCostCenters();
    costCenterSelect.innerHTML = '<option value="">Centro de Custo</option>' + centers.map((cc) => `<option value="${cc}">${cc}</option>`).join("");
  }

  const employeeInput = document.getElementById("filter-employee");
  const datalist = document.getElementById("filter-employee-list");
  if (employeeInput && datalist) {
    const user = getUser();
    if (isADM() || isRH()) {
      datalist.innerHTML = state.employees
        .map(
          (emp) => `
            <option value="${emp.uid || emp.id}" data-email="${emp.email || ""}">
              ${emp.name || emp.fullName || emp.email} (${emp.email || ""})
            </option>`
        )
        .join("");
      employeeInput.disabled = false;
    } else if (isGestor()) {
      const team = state.employees.filter((emp) => state.teamUids.has(emp.uid || emp.id));
      datalist.innerHTML = team
        .map(
          (emp) => `
            <option value="${emp.uid || emp.id}" data-email="${emp.email || ""}">
              ${emp.name || emp.fullName || emp.email} (${emp.email || ""})
            </option>`
        )
        .join("");
      employeeInput.placeholder = "Meu time";
      employeeInput.disabled = false;
    } else if (isColaborador()) {
      employeeInput.value = user?.uid || "";
      employeeInput.disabled = true;
    }
    if (!isColaborador()) {
      employeeInput.value = state.filters.employeeUid || "";
    }
  }

  document.getElementById("filter-status").value = state.filters.status || "";
  document.getElementById("filter-type").value = state.filters.type || "";
  document.getElementById("filter-cost-center").value = state.filters.costCenter || "";
  if (document.getElementById("filter-from")) document.getElementById("filter-from").value = state.filters.from || "";
  if (document.getElementById("filter-to")) document.getElementById("filter-to").value = state.filters.to || "";
}

function attachFilterListeners() {
  const searchInput = document.getElementById("filter-search");
  const employeeInput = document.getElementById("filter-employee");
  const typeSelect = document.getElementById("filter-type");
  const statusSelect = document.getElementById("filter-status");
  const tagsSelect = document.getElementById("filter-tags");
  const costCenterSelect = document.getElementById("filter-cost-center");
  const fromInput = document.getElementById("filter-from");
  const toInput = document.getElementById("filter-to");

  searchInput?.addEventListener("input", (event) => {
    state.filters.search = event.target.value.trim();
    applyFilters();
    renderTable();
  });

  employeeInput?.addEventListener("change", (event) => {
    const value = event.target.value;
    if (value) {
      state.filters.employeeUid = value;
    } else {
      state.filters.employeeUid = "";
    }
    applyFilters();
    renderTable();
  });

  typeSelect?.addEventListener("change", (event) => {
    state.filters.type = event.target.value;
    applyFilters();
    renderTable();
  });

  statusSelect?.addEventListener("change", (event) => {
    state.filters.status = event.target.value;
    applyFilters();
    renderTable();
  });

  tagsSelect?.addEventListener("change", (event) => {
    state.filters.tags = Array.from(event.target.selectedOptions).map((option) => option.value);
    applyFilters();
    renderTable();
  });

  costCenterSelect?.addEventListener("change", (event) => {
    state.filters.costCenter = event.target.value;
    applyFilters();
    renderTable();
  });

  fromInput?.addEventListener("change", (event) => {
    state.filters.from = event.target.value;
    applyFilters();
    renderTable();
  });

  toInput?.addEventListener("change", (event) => {
    state.filters.to = event.target.value;
    applyFilters();
    renderTable();
  });

  document.getElementById("filters-reset")?.addEventListener("click", () => {
    state.filters = { ...DEFAULT_FILTERS };
    renderFilters();
    applyFilters();
    renderTable();
  });
}

function attachQuickActions() {
  document.getElementById("btn-export")?.addEventListener("click", () => {
    exportDocuments(state.filtered);
  });

  document.getElementById("btn-import")?.addEventListener("click", () => {
    alert("Importação em lote disponível via CSV/ZIP. Prepare o arquivo conforme o modelo e arraste aqui. (Protótipo)");
  });

  document.getElementById("btn-request-signature")?.addEventListener("click", () => {
    const selected = state.filtered.filter((doc) => doc.sign?.status !== "Assinado");
    if (!selected.length) {
      alert("Nenhum documento pendente de assinatura no filtro atual.");
      return;
    }
    alert(`Solicitações geradas para ${selected.length} documento(s). Abra cada detalhe para acompanhar.`);
  });
}

function attachUploadForm() {
  const form = document.getElementById("doc-upload-form");
  if (!form) return;
  const employeeSelect = form.querySelector("[name='employeeUid']");
  const costCenterInput = form.querySelector("[name='costCenter']");
  const tagSelect = form.querySelector("[name='tags']");
  const typeSelect = form.querySelector("[name='type']");

  if (employeeSelect) {
    const options = [
      '<option value="">Selecione um colaborador</option>',
      '<option value="__corporativo__">Documento corporativo</option>',
      ...state.employees.map((emp) => {
        const value = emp.uid || emp.id || emp.email;
        const label = emp.name || emp.fullName || emp.email || value;
        const email = emp.email || "";
        return `<option value="${value}" data-email="${email}" data-cost-center="${emp.costCenter || ""}">${label} (${email})</option>`;
      })
    ];
    employeeSelect.innerHTML = options.join("");
  }

  if (tagSelect) {
    const tags = buildTagOptions();
    tagSelect.innerHTML = tags.map((tag) => `<option value="${tag}">${tag}</option>`).join("");
  }

  employeeSelect?.addEventListener("change", (event) => {
    const selectedOption = event.target.selectedOptions[0];
    if (!selectedOption) return;
    const costCenter = selectedOption.dataset.costCenter || "";
    if (costCenter && !costCenterInput.value) {
      costCenterInput.value = costCenter;
    }
    if (typeSelect && typeSelect.value && tagSelect) {
      const docType = DOCUMENT_LIBRARY.find((item) => item.value === typeSelect.value);
      if (docType?.tags?.length) {
        Array.from(tagSelect.options).forEach((opt) => {
          opt.selected = docType.tags.includes(opt.value);
        });
      }
    }
  });

  typeSelect?.addEventListener("change", () => {
    if (!tagSelect) return;
    const docType = DOCUMENT_LIBRARY.find((item) => item.value === typeSelect.value);
    Array.from(tagSelect.options).forEach((opt) => {
      opt.selected = docType?.tags?.includes(opt.value) || false;
    });
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const file = form.file.files[0];
    if (!file) {
      alert("Selecione um arquivo para enviar.");
      return;
    }
    const employeeValue = formData.get("employeeUid");
    const employeeOption = form.querySelector(`option[value='${employeeValue}']`);
    const employeeUid = employeeValue && employeeValue !== "__corporativo__" ? employeeValue : null;
    const employeeEmail = employeeOption?.dataset.email || "";
    const employee = employeeUid ? state.employeeIndex.get(employeeUid) : null;

    const type = formData.get("type") || "Outro";
    const tags = formData.getAll("tags");
    const title = formData.get("title") || file.name;
    const validUntil = formData.get("validUntil") || null;
    const costCenter = formData.get("costCenter") || employee?.costCenter || "";
    const requireSignature = formData.get("signRequired") === "on";
    const notes = formData.get("notes") || "";
    const statusRaw = formData.get("status") || "Valido";
    const version = 1;
    const now = new Date();
    const path = buildStoragePath(employeeUid || "corporativo", file.name);
    const storageRef = ref(storage, path);
    await uploadBytes(storageRef, file);
    const url = await getDownloadURL(storageRef);
    const user = getUser();
    const payload = {
      employeeUid,
      employeeEmail: employeeEmail || employee?.email || null,
      title,
      type,
      tags,
      costCenter: costCenter || null,
      validUntil: validUntil || null,
      status: requireSignature ? "Aguardando assinatura" : statusRaw,
      path,
      url,
      version,
      previousVersionId: null,
      uploadedBy: user?.uid || null,
      uploadedAt: now.toISOString(),
      approval: { required: false, byUid: null, at: null, notes: "" },
      sign: requireSignature
        ? {
            required: true,
            status: "Pendente",
            requestAt: now.toISOString(),
            signedAt: null,
            byUid: null
          }
        : { required: false, status: "Dispensada" },
      audit: [
        {
          who: user?.uid || null,
          what: "upload",
          when: now.toISOString()
        }
      ],
      history: [],
      notes: notes || null
    };
    await addDoc(collection(db, "documents"), payload);
    await logActivity("documents.upload", {
      employee: employeeEmail || (employeeUid ? employeeDisplay(payload) : "Corporativo"),
      type,
      title
    });
    alert("Documento enviado com sucesso!");
    form.reset();
    await reloadDocuments();
  });
}

function buildStoragePath(employeeUid, originalName) {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const sanitized = slugify(originalName);
  return `rh/docs/${employeeUid || "corporativo"}/${year}/${month}/${Date.now()}-${sanitized}`;
}

function attachRowInteractions() {
  const rows = document.querySelectorAll("#documents-table-body tr");
  rows.forEach((row) => {
    const id = row.dataset.id;
    row.addEventListener("click", (event) => {
      if (event.target.closest(".doc-action")) return;
      openDocumentDrawer(id);
    });
  });

  document.querySelectorAll(".doc-action").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const action = event.currentTarget.dataset.action;
      const id = event.currentTarget.dataset.id;
      handleDocumentAction(action, id);
    });
  });
}

async function handleDocumentAction(action, id) {
  const docData = state.documents.find((doc) => doc.id === id);
  if (!docData) return;
  switch (action) {
    case "preview":
      openDocumentDrawer(id);
      break;
    case "download":
      await recordAudit(id, "download");
      if (docData.url) window.open(docData.url, "_blank");
      break;
    case "new-version":
      if (!canManageDocuments()) {
        alert("Você não tem permissão para enviar uma nova versão.");
        return;
      }
      uploadNewVersion(docData);
      break;
    case "history":
      openDocumentDrawer(id, "history");
      break;
    case "sign":
      await handleSignDocument(docData);
      break;
    case "request-signature":
      await handleRequestSignature(docData);
      break;
    case "archive":
      await handleArchiveDocument(docData);
      break;
    default:
      break;
  }
}

async function uploadNewVersion(docData) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".pdf,.png,.jpg,.jpeg";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    const user = getUser();
    const now = new Date();
    const path = buildStoragePath(docData.employeeUid || "corporativo", file.name);
    const storageRef = ref(storage, path);
    await uploadBytes(storageRef, file);
    const url = await getDownloadURL(storageRef);
    const docRef = firestoreDoc(db, "documents", docData.id);
    const historyEntry = {
      version: docData.version || 1,
      path: docData.path,
      url: docData.url,
      uploadedAt: docData.uploadedAt || null,
      uploadedBy: docData.uploadedBy || null
    };
    await updateDoc(docRef, {
      version: (docData.version || 1) + 1,
      previousVersionId: docData.id,
      path,
      url,
      uploadedAt: now.toISOString(),
      uploadedBy: user?.uid || null,
      history: arrayUnion(historyEntry),
      audit: arrayUnion({
        who: user?.uid || null,
        what: "update",
        when: now.toISOString(),
        detail: "nova-versao"
      })
    });
    await logActivity("documents.version", {
      document: docData.id,
      version: (docData.version || 1) + 1,
      title: docData.title || docData.type
    });
    await reloadDocuments();
    openDocumentDrawer(docData.id);
  });
  input.click();
}

async function handleSignDocument(docData) {
  const user = getUser();
  if (!user || user.uid !== docData.employeeUid) {
    alert("Assinatura disponível apenas para o colaborador responsável.");
    return;
  }
  const now = new Date();
  const docRef = firestoreDoc(db, "documents", docData.id);
  await updateDoc(docRef, {
    "sign.status": "Assinado",
    "sign.signedAt": now.toISOString(),
    "sign.byUid": user.uid,
    status: "Valido",
    audit: arrayUnion({
      who: user.uid,
      what: "sign",
      when: now.toISOString()
    })
  });
  await logActivity("documents.sign", {
    document: docData.id,
    employee: employeeEmail(docData)
  });
  alert("Documento assinado com sucesso!");
  await reloadDocuments();
}

async function handleRequestSignature(docData) {
  if (!canManageDocuments() && !isGestor()) {
    alert("Apenas ADM/RH (ou gestor do time) podem solicitar assinatura.");
    return;
  }
  const user = getUser();
  const now = new Date();
  const docRef = firestoreDoc(db, "documents", docData.id);
  await updateDoc(docRef, {
    sign: {
      required: true,
      status: "Pendente",
      requestAt: now.toISOString(),
      signedAt: null,
      byUid: null
    },
    status: "Aguardando assinatura",
    audit: arrayUnion({
      who: user?.uid || null,
      what: "request-signature",
      when: now.toISOString()
    })
  });
  await logActivity("documents.request-signature", {
    document: docData.id,
    employee: employeeEmail(docData)
  });
  alert("Fluxo de assinatura iniciado / relembrado!");
  await reloadDocuments();
}

async function handleArchiveDocument(docData) {
  if (!canManageDocuments()) {
    alert("Somente ADM/RH podem arquivar ou excluir documentos.");
    return;
  }
  if (!confirm("Confirmar arquivamento deste documento?")) return;
  const user = getUser();
  const now = new Date();
  const docRef = firestoreDoc(db, "documents", docData.id);
  await updateDoc(docRef, {
    archived: true,
    status: "Arquivado",
    audit: arrayUnion({
      who: user?.uid || null,
      what: "archive",
      when: now.toISOString()
    })
  });
  await logActivity("documents.archive", {
    document: docData.id,
    title: docData.title || docData.type
  });
  await reloadDocuments();
}

async function recordAudit(documentId, action) {
  const user = getUser();
  if (!user) return;
  const docRef = firestoreDoc(db, "documents", documentId);
  try {
    await updateDoc(docRef, {
      audit: arrayUnion({
        who: user.uid,
        what: action,
        when: new Date().toISOString()
      })
    });
  } catch (err) {
    console.warn("Não foi possível registrar auditoria do documento", err);
  }
}

function exportDocuments(list) {
  if (!list.length) {
    alert("Nada para exportar.");
    return;
  }
  const header = [
    "colaborador",
    "email",
    "tipo",
    "tags",
    "centroCusto",
    "validade",
    "status",
    "versao",
    "uploadedAt",
    "uploadedBy",
    "url"
  ];
  const rows = list.map((doc) => {
    const uploader = state.employeeIndex.get(doc.uploadedBy) || {};
    return [
      employeeDisplay(doc),
      employeeEmail(doc),
      getDocumentTypeLabel(doc.type),
      (doc.tags || []).join("|"),
      doc.costCenter || "",
      doc.validUntil || "",
      derivedStatus(doc),
      doc.version || 1,
      doc.uploadedAt || "",
      uploader.name || uploader.email || doc.uploadedBy || "",
      doc.url || ""
    ]
      .map((value) => `"${String(value || "").replace(/"/g, '""')}"`)
      .join(",");
  });
  const csv = [header.join(","), ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `documentos-${Date.now()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function renderDrawer(docData, activeTab = "details") {
  const drawer = document.getElementById("document-drawer");
  const overlay = document.getElementById("document-drawer-overlay");
  if (!drawer || !overlay) return;
  if (!docData) {
    drawer.classList.add("hidden");
    overlay.classList.add("hidden");
    return;
  }
  const history = docData.history || [];
  const auditTrail = docData.audit || [];
  drawer.querySelector(".drawer-title").innerHTML = `
    <div>
      <h3>${docData.title || getDocumentTypeLabel(docData.type)}</h3>
      <small class="helper">${getDocumentCategory(docData.type)} • v${docData.version || 1}</small>
    </div>
  `;
  drawer.querySelector("#drawer-metadata").innerHTML = `
    <dl class="metadata">
      <div><dt>Colaborador</dt><dd>${employeeDisplay(docData)}</dd></div>
      <div><dt>Email</dt><dd>${employeeEmail(docData) || "—"}</dd></div>
      <div><dt>Tipo</dt><dd>${getDocumentTypeLabel(docData.type)}</dd></div>
      <div><dt>Tags</dt><dd>${(docData.tags || []).map((tag) => `<span class="tag-chip">${tag}</span>`).join(" ") || "—"}</dd></div>
      <div><dt>Centro de Custo</dt><dd>${docData.costCenter || "—"}</dd></div>
      <div><dt>Validade</dt><dd>${docData.validUntil ? formatDate(docData.validUntil) : "—"}</dd></div>
      <div><dt>Status</dt><dd>${statusBadge(derivedStatus(docData))}</dd></div>
      <div><dt>Assinatura</dt><dd>${signBadge(docData.sign)}</dd></div>
      <div><dt>Notas</dt><dd>${docData.notes || "—"}</dd></div>
    </dl>
  `;
  drawer.querySelector("#drawer-preview").innerHTML = docData.url
    ? `<iframe src="${docData.url}" title="Preview" loading="lazy"></iframe>`
    : '<p class="helper">Sem preview disponível.</p>';
  drawer.querySelector("#drawer-history").innerHTML = history.length
    ? `<ul class="timeline">${history
        .sort((a, b) => (new Date(b.uploadedAt || 0)) - (new Date(a.uploadedAt || 0)))
        .map(
          (entry) => `
            <li>
              <strong>v${entry.version}</strong>
              <br><small class="helper">${formatDateTime(entry.uploadedAt)} • <a href="${entry.url}" target="_blank">Abrir</a></small>
            </li>
          `
        )
        .join("")}</ul>`
    : '<p class="helper">Nenhuma versão anterior.</p>';
  drawer.querySelector("#drawer-audit").innerHTML = auditTrail.length
    ? `<ul class="timeline">${auditTrail
        .sort((a, b) => new Date(b.when || 0) - new Date(a.when || 0))
        .map(
          (entry) => `
            <li>
              <strong>${entry.what}</strong>
              <br><small class="helper">${formatDateTime(entry.when)} • ${entry.who || "—"}</small>
            </li>
          `
        )
        .join("")}</ul>`
    : '<p class="helper">Sem registros ainda.</p>';
  drawer.querySelector("#drawer-permissions").innerHTML = `
    <ul class="permission-list">
      <li><span class="badge">ADM</span> • acesso total</li>
      <li><span class="badge">RH</span> • acesso total</li>
      <li><span class="badge">Gestor</span> • equipe (${state.teamUids.size} vinculado)</li>
      <li><span class="badge">Colaborador</span> • apenas seus documentos</li>
    </ul>
  `;
  drawer.querySelector("#drawer-links").innerHTML = (docData.links || docData.vinculos || []).length
    ? `<ul>${(docData.links || docData.vinculos).map((link) => `<li>${link}</li>`).join("")}</ul>`
    : '<p class="helper">Sem vinculações registradas.</p>';
  drawer.classList.remove("hidden");
  overlay.classList.remove("hidden");
  drawer.dataset.activeTab = activeTab;
}

function openDocumentDrawer(id, tab = "details") {
  const docData = state.documents.find((doc) => doc.id === id);
  if (!docData) return;
  state.selectedDocument = docData;
  renderDrawer(docData, tab);
}

function closeDrawer() {
  state.selectedDocument = null;
  renderDrawer(null);
}

async function reloadDocuments() {
  state.documents = await fetchDocuments();
  applyFilters();
  renderFilters();
  renderTable();
}

window.DocumentsView = async function DocumentsView() {
  document.getElementById("view").innerHTML = `
    <div class="doc-layout">
      <div class="doc-header">
        <h2>📁 Documentos</h2>
        <p class="helper">Centralize contratos, ASO, holerites e demais arquivos com acesso controlado por perfil.</p>
      </div>
      <section class="filters card">
        <div class="filters-grid">
          <div class="input-group">
            <label>Colaborador</label>
            <input class="input" id="filter-employee" list="filter-employee-list" placeholder="Buscar" />
            <datalist id="filter-employee-list"></datalist>
          </div>
          <div class="input-group">
            <label>Tipo</label>
            <select class="input" id="filter-type"></select>
          </div>
          <div class="input-group">
            <label>Tags</label>
            <select class="input" id="filter-tags" multiple></select>
          </div>
          <div class="input-group">
            <label>Status</label>
            <select class="input" id="filter-status">
              <option value="">Status</option>
              <option value="Valido">Válido</option>
              <option value="Vencendo">Vencendo em 30 dias</option>
              <option value="Vencido">Vencido</option>
              <option value="Em aprovacao">Em aprovação</option>
              <option value="Aguardando assinatura">Aguardando assinatura</option>
            </select>
          </div>
          <div class="input-group">
            <label>Validade (de)</label>
            <input class="input" type="date" id="filter-from" />
          </div>
          <div class="input-group">
            <label>Validade (até)</label>
            <input class="input" type="date" id="filter-to" />
          </div>
          <div class="input-group">
            <label>Centro de custo</label>
            <select class="input" id="filter-cost-center"></select>
          </div>
          <div class="input-group full">
            <label>Busca livre</label>
            <input class="input" id="filter-search" placeholder="Título, observações, arquivo" />
          </div>
        </div>
        <div class="filters-actions">
          <button class="btn ghost" id="filters-reset">Limpar filtros</button>
        </div>
      </section>

      <section class="doc-actions card">
        ${canManageDocuments()
          ? `
            <button class="btn" id="btn-upload-toggle">➕ Enviar documento</button>
            <button class="btn ghost" id="btn-import">📥 Importar em lote</button>
          `
          : ""}
        ${(canManageDocuments() || isGestor()) ? '<button class="btn ghost" id="btn-export">📤 Exportar CSV</button>' : ""}
        ${canManageDocuments() ? '<button class="btn ghost" id="btn-request-signature">📝 Solicitar assinatura</button>' : ""}
      </section>

      ${(canManageDocuments())
        ? `
        <section class="card" id="upload-card" hidden>
          <h3>Enviar documento</h3>
          <form id="doc-upload-form" class="upload-grid">
            <div class="input-group">
              <label>Título</label>
              <input class="input" name="title" placeholder="Ex.: ASO Periódico" />
            </div>
            <div class="input-group">
              <label>Colaborador</label>
              <select class="input" name="employeeUid"></select>
            </div>
            <div class="input-group">
              <label>Tipo</label>
              <select class="input" name="type">
                ${DOCUMENT_LIBRARY.map((item) => `<option value="${item.value}">${item.label} • ${item.category}</option>`).join("")}
              </select>
            </div>
            <div class="input-group">
              <label>Tags</label>
              <select class="input" name="tags" multiple></select>
            </div>
            <div class="input-group">
              <label>Validade</label>
              <input class="input" type="date" name="validUntil" />
            </div>
            <div class="input-group">
              <label>Centro de custo</label>
              <input class="input" name="costCenter" placeholder="Ex.: Produção" />
            </div>
            <div class="input-group">
              <label>Status</label>
              <select class="input" name="status">
                <option value="Valido">Válido</option>
                <option value="Em aprovacao">Em aprovação</option>
                <option value="Vencido">Vencido</option>
              </select>
            </div>
            <div class="input-group checkbox">
              <label><input type="checkbox" name="signRequired" /> Requer assinatura</label>
            </div>
            <div class="input-group full">
              <label>Observações</label>
              <textarea class="input" name="notes" rows="2" placeholder="Notas internas, prazos, vínculos"></textarea>
            </div>
            <div class="input-group full">
              <label>Arquivo</label>
              <input class="input" type="file" name="file" required />
            </div>
            <div class="form-actions">
              <button class="btn" type="submit">Salvar</button>
            </div>
          </form>
        </section>
        `
        : ""}

      <section class="doc-cards">
        <div class="card">
          <h3>Vencendo em 30 dias <span class="badge warn" id="card-expiring-count">0</span></h3>
          <ul id="card-expiring-list"></ul>
        </div>
        <div class="card">
          <h3>Assinaturas pendentes <span class="badge warn" id="card-pending-signatures">0</span></h3>
          <ul id="card-signature-list"></ul>
        </div>
        <div class="card">
          <h3>Top tipos por compliance</h3>
          <ul id="card-top-types"></ul>
        </div>
      </section>

      <section class="card">
        <h3>Documentos</h3>
        <table class="table documents-table">
          <thead>
            <tr>
              <th>Documento</th>
              <th>Colaborador</th>
              <th>Validade</th>
              <th>Versão</th>
              <th>Status</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody id="documents-table-body">
            <tr><td colspan="6" class="empty">Carregando...</td></tr>
          </tbody>
        </table>
      </section>
    </div>

    <div id="document-drawer-overlay" class="drawer-overlay hidden"></div>
    <aside id="document-drawer" class="drawer hidden">
      <div class="drawer-header">
        <div class="drawer-title"></div>
        <button class="btn ghost" id="drawer-close">Fechar</button>
      </div>
      <div class="drawer-content">
        <section>
          <h4>Metadados</h4>
          <div id="drawer-metadata"></div>
        </section>
        <section>
          <h4>Preview</h4>
          <div id="drawer-preview" class="drawer-preview"></div>
        </section>
        <section>
          <h4>Histórico de versões</h4>
          <div id="drawer-history"></div>
        </section>
        <section>
          <h4>Log de ações</h4>
          <div id="drawer-audit"></div>
        </section>
        <section>
          <h4>Permissões efetivas</h4>
          <div id="drawer-permissions"></div>
        </section>
        <section>
          <h4>Vinculações</h4>
          <div id="drawer-links"></div>
        </section>
      </div>
    </aside>
  `;

  document.getElementById("btn-upload-toggle")?.addEventListener("click", () => {
    const card = document.getElementById("upload-card");
    if (!card) return;
    card.hidden = !card.hidden;
  });

  document.getElementById("drawer-close")?.addEventListener("click", () => closeDrawer());
  document.getElementById("document-drawer-overlay")?.addEventListener("click", () => closeDrawer());

  state.loading = true;
  state.employees = await fetchEmployees();
  buildEmployeeIndex(state.employees);
  computeTeamUids(getUser());
  state.documents = await fetchDocuments();
  state.loading = false;
  applyFilters();
  renderFilters();
  renderTable();
  attachFilterListeners();
  attachQuickActions();
  attachUploadForm();
};

