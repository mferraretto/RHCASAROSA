// Employees module CRUD
import { getFirestore, collection, addDoc, getDocs, doc, updateDoc, deleteDoc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js";
import { logActivity } from "./activity.js";

const db = getFirestore();
let employeesCache = [];
let currentFilter = '';

async function listEmployees(){
  const snap = await getDocs(collection(db,'employees'));
  const rows = [];
  snap.forEach(d=> rows.push({ id:d.id, ...d.data() }));
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
  if(!items.length) return '<p>Nenhum colaborador cadastrado.</p>';
  return `<table class="table">
    <thead><tr><th>Nome</th><th>Cargo</th><th>Centro de Custo</th><th>Admissão</th><th>Status</th><th></th></tr></thead>
    <tbody>
    ${items.map(e=>`<tr>
      <td>${e.name||''}<br><small class="helper">${e.email||''}</small></td>
      <td>${e.role||''}</td>
      <td>${e.costCenter||''}</td>
      <td>${e.hireDate||''}</td>
      <td><span class="badge ${e.status==='Ativo'?'ok':'warn'}">${e.status||'Ativo'}</span></td>
      <td class="actions">
        <button class="btn ghost" data-edit="${e.id}">Editar</button>
        <button class="btn warn" data-remove="${e.id}">Remover</button>
      </td>
    </tr>`).join('')}
    </tbody>
  </table>`;
}

function filterEmployees(items, term){
  if(!term) return [...items];
  const q = term.trim().toLowerCase();
  return items.filter(e=>{
    return [e.name, e.email, e.role, e.costCenter].some(field => (field||'').toLowerCase().includes(q));
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
  return [
    `<div class="kpi small"><div class="label">Ativos</div><div class="value">${active}</div><small class="helper">Inativos: ${inactive}</small></div>`,
    `<div class="kpi small"><div class="label">Novos em ${monthLabel}</div><div class="value">${hiresThisMonth}</div><small class="helper">Total geral: ${total}</small></div>`,
    `<div class="kpi small"><div class="label">Média salarial</div><div class="value">${avgSalary}</div><small class="helper">Base em ${salaryCount} cadastros</small></div>`
  ].join('');
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
}

function refreshEmployeesUI(){
  const summaryBox = document.getElementById('employees-summary');
  if(summaryBox){
    summaryBox.innerHTML = renderSummary(employeesCache);
  }
  const filtered = filterEmployees(employeesCache, currentFilter);
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
            <button class="btn" id="addEmp">Adicionar</button>
          </div>
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
      currentFilter = e.target.value;
      refreshEmployeesUI();
    };
  }

  employeesCache = list;
  currentFilter = '';
  refreshEmployeesUI();
}
