// Employees module CRUD
import { getFirestore, collection, addDoc, getDocs, doc, updateDoc, deleteDoc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js";
import { getStorage, ref, uploadBytes } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-storage.js";
import { jsPDF } from "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js";
import { logActivity } from "./activity.js";

const db = getFirestore();
const storage = getStorage();
let employeesCache = [];
const FILTER_ALL = 'all';
const filterState = {
  search: '',
  status: FILTER_ALL,
  role: FILTER_ALL,
  costCenter: FILTER_ALL
};

const colors = {
  magenta: [255, 0, 138],
  tiffany: [0, 197, 192],
  yellow: [255, 212, 42],
  ink: [17, 24, 39]
};

function normalizeCurrency(value){
  if(value === null || value === undefined || value === '') return '';
  const num = Number(value);
  return Number.isNaN(num) ? '' : num.toFixed(2);
}

function formatCurrency(value){
  const num = Number(value);
  if(Number.isNaN(num)) return '—';
  return num.toLocaleString('pt-BR',{ style:'currency', currency:'BRL' });
}

function formatDate(value){
  if(!value) return '—';
  const date = new Date(value.includes('T') ? value : `${value}T00:00:00`);
  if(Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('pt-BR');
}

async function listEmployees(){
  const snap = await getDocs(collection(db,'employees'));
  const rows = [];
  snap.forEach(d=> rows.push({ id:d.id, ...d.data() }));
  rows.sort((a,b)=> (a.name || '').localeCompare(b.name || '', 'pt-BR', { sensitivity:'base' }));
  rows.forEach(row => {
    row.salary = normalizeCurrency(row.salary);
  });
  return rows;
}

async function saveEmployee(payload, id=null){
  if(id){
    await updateDoc(doc(db,'employees', id), payload);
    return id;
  } else {
    const ref = await addDoc(collection(db,'employees'), payload);
    return ref.id;
  }
}

async function removeEmployee(id){
  await deleteDoc(doc(db,'employees', id));
}

function renderTable(items){
  if(!items.length) return '<p>Nenhum colaborador encontrado.</p>';
  return `<table class="table">
    <thead>
      <tr>
        <th>Nome completo</th>
        <th>Cargo / Função</th>
        <th>Centro de custo</th>
        <th>Data de admissão</th>
        <th>Salário base (R$)</th>
        <th>Situação</th>
        <th>Ações</th>
      </tr>
    </thead>
    <tbody>
      ${items.map(e=>{
        const status = e.status || 'Ativo';
        const badgeClass = status === 'Ativo' ? 'ok' : 'neutral';
        return `<tr>
          <td>${e.name||''}<br><small class="helper">${e.email||''}</small></td>
          <td>${e.role||'—'}</td>
          <td>${e.costCenter||'—'}</td>
          <td>${formatDate(e.hireDate)}</td>
          <td class="num">${formatCurrency(e.salary)}</td>
          <td><span class="badge ${badgeClass}">${status}</span></td>
          <td class="actions">
            <button class="btn ghost" data-edit="${e.id}">Editar</button>
            <button class="btn warn" data-remove="${e.id}">Remover</button>
            <button class="btn secondary" data-paystub="${e.id}">Gerar Holerite</button>
            <button class="btn ghost" data-export="${e.id}">Exportar CSV</button>
          </td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>`;
}

function filterEmployees(items){
  return items.filter(e=>{
    const status = e.status || 'Ativo';
    if(filterState.status !== FILTER_ALL && status !== filterState.status){
      return false;
    }
    if(filterState.role !== FILTER_ALL && (e.role || '') !== filterState.role){
      return false;
    }
    if(filterState.costCenter !== FILTER_ALL && (e.costCenter || '') !== filterState.costCenter){
      return false;
    }
    if(filterState.search){
      const q = filterState.search.toLowerCase();
      const matches = [e.name, e.email, e.role, e.costCenter].some(field => (field||'').toLowerCase().includes(q));
      if(!matches) return false;
    }
    return true;
  });
}

function renderSummary(items){
  if(!items.length) return '<p class="helper">Cadastre colaboradores para ver indicadores.</p>';
  const total = items.length;
  const active = items.filter(e => (e.status || 'Ativo') === 'Ativo').length;
  const inactive = total - active;
  const today = new Date();
  const month = today.getMonth();
  const year = today.getFullYear();
  const hiresThisMonth = items.filter(e => {
    if(!e.hireDate) return false;
    const [yy, mm, dd] = e.hireDate.split('-');
    if(!yy || !mm) return false;
    const hire = new Date(Number(yy), Number(mm)-1, Number(dd||'1'));
    return hire.getFullYear() === year && hire.getMonth() === month;
  }).length;
  let salarySum = 0;
  let salaryCount = 0;
  items.forEach(e => {
    const value = Number(e.salary);
    if(!Number.isNaN(value) && value > 0){
      salarySum += value;
      salaryCount += 1;
    }
  });
  const avgSalary = salaryCount ? (salarySum / salaryCount).toLocaleString('pt-BR',{style:'currency',currency:'BRL'}) : '—';
  const monthLabel = today.toLocaleString('pt-BR',{ month:'long' });
  const cards = [];
  cards.push(`<div class="kpi small"><div class="label">Ativos</div><div class="value">${active}</div><small class="helper">Inativos: ${inactive}</small></div>`);
  cards.push(`<div class="kpi small"><div class="label">Novos em ${monthLabel}</div><div class="value">${hiresThisMonth}</div><small class="helper">Total geral: ${total}</small></div>`);
  cards.push(`<div class="kpi small"><div class="label">Média salarial</div><div class="value">${avgSalary}</div><small class="helper">Base em ${salaryCount} cadastros</small></div>`);
  return cards.join('');
}

async function openForm(existing=null){
  const container = document.getElementById('employees-form');
  container.innerHTML = `<div class="card">
    <h3>${existing?'Editar':'Novo'} colaborador</h3>
    <form id="femp" class="grid cols-3">
      <input class="input" name="name" placeholder="Nome completo" value="${existing?.name||''}" required>
      <input class="input" name="email" type="email" placeholder="Email" value="${existing?.email||''}" required>
      <input class="input" name="phone" placeholder="Celular" value="${existing?.phone||''}">
      <input class="input" name="role" placeholder="Cargo" value="${existing?.role||''}">
      <input class="input" name="costCenter" placeholder="Centro de custo" value="${existing?.costCenter||'Geral'}">
      <input class="input" name="hireDate" type="date" value="${existing?.hireDate||''}">
      <select class="input" name="status">
        <option ${existing?.status!=='Inativo'?'selected':''}>Ativo</option>
        <option ${existing?.status==='Inativo'?'selected':''}>Inativo</option>
      </select>
      <input class="input" name="salary" type="number" step="0.01" placeholder="Salário base (R$)" value="${existing?.salary||''}">
      <input class="input" name="doc" placeholder="CPF" value="${existing?.doc||''}">
      <div></div><div></div>
      <div style="display:flex;gap:.5rem;justify-content:flex-end">
        <button class="btn ghost" type="button" id="cancel">Cancelar</button>
        <button class="btn" type="submit">${existing?'Salvar':'Adicionar'}</button>
      </div>
    </form>
  </div>`;

  document.getElementById('cancel').onclick = ()=> container.innerHTML = '';
  const form = document.getElementById('femp');
  form.onsubmit = async (e)=>{
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    data.salary = normalizeCurrency(data.salary);
    if(existing){
      await saveEmployee(data, existing.id);
      await logActivity('employee.update', { name: data.name, email: data.email, role: data.role });
    } else {
      const id = await saveEmployee(data);
      await logActivity('employee.add', { id, name: data.name, email: data.email, role: data.role });
    }
    window.EmployeesView();
    container.innerHTML='';
  };
}

function attachRowActions(){
  const container = document.getElementById('view');
  container.querySelectorAll('button[data-edit]').forEach(btn=>{
    btn.onclick = async ()=>{
      const id = btn.getAttribute('data-edit');
      const snap = await getDoc(doc(db,'employees', id));
      await openForm({ id, ...snap.data() });
    };
  });
  container.querySelectorAll('button[data-remove]').forEach(btn=>{
    btn.onclick = async ()=>{
      if(confirm('Remover colaborador?')){
        const id = btn.getAttribute('data-remove');
        const record = employeesCache.find(e => e.id === id);
        await removeEmployee(id);
        await logActivity('employee.remove', { id, name: record?.name, email: record?.email });
        window.EmployeesView();
      }
    };
  });

  container.querySelectorAll('button[data-paystub]').forEach(btn=>{
    btn.onclick = ()=>{
      const id = btn.getAttribute('data-paystub');
      const employee = employeesCache.find(e => e.id === id);
      if(employee){
        openPaystubModal(employee);
      }
    };
  });

  container.querySelectorAll('button[data-export]').forEach(btn=>{
    btn.onclick = async ()=>{
      const id = btn.getAttribute('data-export');
      const employee = employeesCache.find(e => e.id === id);
      if(employee){
        exportEmployeesToCSV([employee], `colaborador-${employee.name?.replace(/\s+/g,'-').toLowerCase()||'dados'}.csv`);
        await logActivity('employee.export.single', { id: employee.id, name: employee.name, email: employee.email });
      }
    };
  });
}

function refreshEmployeesUI(){
  const summaryBox = document.getElementById('employees-summary');
  if(summaryBox){
    summaryBox.innerHTML = renderSummary(employeesCache);
  }
  const filtered = filterEmployees(employeesCache);
  updateFilterSelectors();
  const tableBox = document.getElementById('employees-table');
  if(tableBox){
    tableBox.innerHTML = renderTable(filtered);
  }
  const countLabel = document.getElementById('employees-count');
  if(countLabel){
    countLabel.textContent = filtered.length ? `${filtered.length} de ${employeesCache.length} colaboradores exibidos` : 'Nenhum colaborador encontrado.';
  }
  attachRowActions();
}

window.EmployeesView = async function EmployeesView(){
  const list = await listEmployees();
  const container = document.getElementById('view');
  container.innerHTML = `
    <div class="grid cols-1">
      <div class="card">
        <div class="toolbar">
          <div>
            <h2 style="margin:0">Colaboradores</h2>
            <small class="helper">Cadastro completo do time Casa Rosa</small>
          </div>
          <div class="toolbar-actions">
            <input class="input search" id="empSearch" placeholder="Buscar por nome, e-mail ou cargo">
            <button class="btn secondary" id="exportAll">📤 Exportar CSV</button>
            <button class="btn" id="addEmp">Adicionar</button>
          </div>
        </div>
        <div class="filters-row">
          <select class="input" id="filterStatus">
            <option value="${FILTER_ALL}">Status (todos)</option>
          </select>
          <select class="input" id="filterRole">
            <option value="${FILTER_ALL}">Cargo (todos)</option>
          </select>
          <select class="input" id="filterCenter">
            <option value="${FILTER_ALL}">Centro de custo (todos)</option>
          </select>
        </div>
        <div id="employees-summary" class="summary-grid"></div>
        <div id="employees-count" class="helper"></div>
        <div id="employees-table"></div>
        <div id="employees-form" style="margin-top:1rem"></div>
      </div>
    </div>
  `;

  document.getElementById('addEmp').onclick = ()=> openForm();
  const searchInput = document.getElementById('empSearch');
  if(searchInput){
    searchInput.oninput = (e)=>{
      filterState.search = e.target.value;
      refreshEmployeesUI();
    };
  }

  const statusSelect = document.getElementById('filterStatus');
  const roleSelect = document.getElementById('filterRole');
  const centerSelect = document.getElementById('filterCenter');
  if(statusSelect){
    statusSelect.onchange = (e)=>{
      filterState.status = e.target.value;
      refreshEmployeesUI();
    };
  }
  if(roleSelect){
    roleSelect.onchange = (e)=>{
      filterState.role = e.target.value;
      refreshEmployeesUI();
    };
  }
  if(centerSelect){
    centerSelect.onchange = (e)=>{
      filterState.costCenter = e.target.value;
      refreshEmployeesUI();
    };
  }

  const exportAllButton = document.getElementById('exportAll');
  if(exportAllButton){
    exportAllButton.onclick = async ()=>{
      const filtered = filterEmployees(employeesCache);
      exportEmployeesToCSV(filtered, 'colaboradores-casa-rosa.csv');
      await logActivity('employee.export.list', {
        total: filtered.length,
        status: filterState.status,
        role: filterState.role,
        costCenter: filterState.costCenter
      });
    };
  }

  employeesCache = list;
  filterState.search = '';
  filterState.status = FILTER_ALL;
  filterState.role = FILTER_ALL;
  filterState.costCenter = FILTER_ALL;
  refreshEmployeesUI();
}

function updateFilterSelectors(){
  const statusSelect = document.getElementById('filterStatus');
  const roleSelect = document.getElementById('filterRole');
  const centerSelect = document.getElementById('filterCenter');
  if(statusSelect){
    const options = [FILTER_ALL, 'Ativo', 'Inativo'];
    statusSelect.innerHTML = options.map(value => {
      const label = value === FILTER_ALL ? 'Status (todos)' : value;
      return `<option value="${value}">${label}</option>`;
    }).join('');
    statusSelect.value = options.includes(filterState.status) ? filterState.status : FILTER_ALL;
  }
  if(roleSelect){
    const roles = Array.from(new Set(employeesCache.map(e => (e.role || '').trim()).filter(Boolean))).sort((a,b)=>a.localeCompare(b,'pt-BR',{sensitivity:'base'}));
    roleSelect.innerHTML = [`<option value="${FILTER_ALL}">Cargo (todos)</option>`].concat(roles.map(role => `<option value="${role}">${role}</option>`)).join('');
    roleSelect.value = roles.includes(filterState.role) ? filterState.role : FILTER_ALL;
  }
  if(centerSelect){
    const centers = Array.from(new Set(employeesCache.map(e => (e.costCenter || '').trim()).filter(Boolean))).sort((a,b)=>a.localeCompare(b,'pt-BR',{sensitivity:'base'}));
    centerSelect.innerHTML = [`<option value="${FILTER_ALL}">Centro de custo (todos)</option>`].concat(centers.map(center => `<option value="${center}">${center}</option>`)).join('');
    centerSelect.value = centers.includes(filterState.costCenter) ? filterState.costCenter : FILTER_ALL;
  }
}

function exportEmployeesToCSV(items, filename){
  if(!items.length){
    alert('Nenhum dado para exportar.');
    return;
  }
  const headers = ['Nome', 'E-mail', 'Cargo', 'Centro de custo', 'Data de admissão', 'Salário base', 'Situação'];
  const rows = items.map(emp => [
    emp.name || '',
    emp.email || '',
    emp.role || '',
    emp.costCenter || '',
    formatDate(emp.hireDate),
    formatCurrency(emp.salary),
    emp.status || 'Ativo'
  ]);
  const csvContent = [headers, ...rows].map(line => line.map(value => `"${String(value).replace(/"/g,'""')}"`).join(';')).join('\n');
  const blob = new Blob(["\ufeff" + csvContent], { type:'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function openPaystubModal(employee){
  const existing = document.getElementById('paystub-modal');
  if(existing) existing.remove();
  const wrapper = document.createElement('div');
  wrapper.id = 'paystub-modal';
  wrapper.className = 'modal-overlay';
  const referenceDefault = new Date().toISOString().slice(0,7);
  wrapper.innerHTML = `
    <div class="modal-card">
      <h3>Gerar holerite</h3>
      <p class="helper">${employee.name || 'Colaborador'} — ${employee.role || 'Cargo não informado'}</p>
      <form class="grid cols-2" id="paystubForm">
        <label class="form-field">Referência (mês/ano)
          <input class="input" type="month" name="reference" value="${referenceDefault}" required>
        </label>
        <label class="form-field">Horas extras (R$)
          <input class="input" type="number" step="0.01" name="extras" placeholder="0,00" value="">
        </label>
        <label class="form-field">Descontos (R$)
          <input class="input" type="number" step="0.01" name="discounts" placeholder="0,00" value="">
        </label>
        <label class="form-field">Salvar no Storage?
          <select class="input" name="upload">
            <option value="yes" selected>Sim, salvar cópia</option>
            <option value="no">Não salvar</option>
          </select>
        </label>
        <div class="form-actions">
          <button class="btn ghost" type="button" data-close>Cancelar</button>
          <button class="btn" type="submit">Gerar PDF</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(wrapper);

  wrapper.querySelector('[data-close]').onclick = ()=> wrapper.remove();
  wrapper.onclick = (ev)=>{
    if(ev.target === wrapper){
      wrapper.remove();
    }
  };

  const form = wrapper.querySelector('#paystubForm');
  form.onsubmit = async (e)=>{
    e.preventDefault();
    const formData = new FormData(form);
    const reference = formData.get('reference');
    const extras = Number(formData.get('extras')) || 0;
    const discounts = Number(formData.get('discounts')) || 0;
    const shouldUpload = formData.get('upload') === 'yes';

    const baseSalary = Number(employee.salary) || 0;
    const totalProventos = baseSalary + extras;
    const totalDescontos = discounts;
    const totalLiquido = totalProventos - totalDescontos;

    let referenceLabel = reference || '';
    if(reference){
      const [year, month] = reference.split('-');
      if(year && month){
        referenceLabel = `${month}/${year}`;
      }
    }

    const docPdf = new jsPDF();
    const pageWidth = docPdf.internal.pageSize.getWidth();

    docPdf.setFillColor(...colors.magenta);
    docPdf.rect(0, 0, pageWidth, 32, 'F');
    docPdf.setTextColor(255,255,255);
    docPdf.setFontSize(18);
    docPdf.text('Casa Rosa RH', 14, 18);
    docPdf.setFontSize(12);
    docPdf.text(`Holerite — ${referenceLabel}`, 14, 27);

    docPdf.setFillColor(...colors.tiffany);
    docPdf.rect(0, 32, pageWidth, 2, 'F');

    docPdf.setTextColor(...colors.ink);
    docPdf.setFontSize(12);
    let y = 44;
    const lines = [
      `Colaborador: ${employee.name || '—'}`,
      `E-mail: ${employee.email || '—'}`,
      `CPF: ${employee.doc || '—'}`,
      `Cargo: ${employee.role || '—'}`,
      `Centro de custo: ${employee.costCenter || '—'}`,
      `Admissão: ${formatDate(employee.hireDate)}`
    ];
    lines.forEach(line => {
      docPdf.text(line, 14, y);
      y += 8;
    });

    y += 4;
    docPdf.setFillColor(...colors.yellow);
    docPdf.rect(14, y - 6, pageWidth - 28, 1, 'F');

    const tableY = y + 4;
    docPdf.setFontSize(11);
    docPdf.text('Salário base', 14, tableY);
    docPdf.text(formatCurrency(baseSalary), pageWidth - 20, tableY, { align: 'right' });
    docPdf.text('Horas extras', 14, tableY + 8);
    docPdf.text(formatCurrency(extras), pageWidth - 20, tableY + 8, { align: 'right' });
    docPdf.text('Total proventos', 14, tableY + 18);
    docPdf.text(formatCurrency(totalProventos), pageWidth - 20, tableY + 18, { align: 'right' });
    docPdf.text('Descontos', 14, tableY + 30);
    docPdf.text(formatCurrency(discounts), pageWidth - 20, tableY + 30, { align: 'right' });
    docPdf.text('Total descontos', 14, tableY + 40);
    docPdf.text(formatCurrency(totalDescontos), pageWidth - 20, tableY + 40, { align: 'right' });

    docPdf.setFontSize(12);
    docPdf.text('Total líquido', 14, tableY + 54);
    docPdf.text(formatCurrency(totalLiquido), pageWidth - 20, tableY + 54, { align: 'right' });

    docPdf.setFontSize(10);
    docPdf.text('Assinatura digital — Casa Rosa RH', 14, tableY + 70);

    const pdfBlob = docPdf.output('blob');
    const referenceKey = (referenceLabel || reference || 'referencia').replace(/[\s\/]/g,'-');
    const filename = `holerite-${(employee.name || 'colaborador').replace(/\s+/g,'-').toLowerCase()}-${referenceKey}.pdf`;
    const url = URL.createObjectURL(pdfBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    if(shouldUpload){
      try{
        const storagePath = `rh/holerites/${employee.id || employee.email || 'colaborador'}/${referenceKey}.pdf`;
        const storageRef = ref(storage, storagePath);
        await uploadBytes(storageRef, pdfBlob);
      }catch(err){
        console.error('Falha ao salvar PDF no Storage', err);
        alert('PDF gerado, mas não foi possível salvar no Storage. Verifique as permissões.');
      }
    }

    await logActivity('employee.paystub', { id: employee.id, name: employee.name, email: employee.email, reference, extras, discounts });
    wrapper.remove();
  };
}
