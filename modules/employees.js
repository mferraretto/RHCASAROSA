// Employees module CRUD
import { getFirestore, collection, addDoc, getDocs, doc, setDoc, updateDoc, deleteDoc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js";

const db = getFirestore();

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
    if(existing) await saveEmployee(data, existing.id);
    else await saveEmployee(data);
    window.EmployeesView();
    container.innerHTML='';
  };
}

window.EmployeesView = async function EmployeesView(){
  const list = await listEmployees();
  const container = document.getElementById('view');
  container.innerHTML = `
    <div class="grid cols-1">
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h2>Colaboradores</h2>
          <button class="btn" id="addEmp">Adicionar</button>
        </div>
        <div id="employees-table">${renderTable(list)}</div>
        <div id="employees-form" style="margin-top:1rem"></div>
      </div>
    </div>
  `;

  document.getElementById('addEmp').onclick = ()=> openForm();

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
        await removeEmployee(btn.getAttribute('data-remove'));
        window.EmployeesView();
      }
    };
  });
}
