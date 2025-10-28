// Vacations requests
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-auth.js";
import { getFirestore, collection, addDoc, getDocs, query, where, updateDoc, doc, orderBy } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js";

const db = getFirestore();
const auth = getAuth();

async function listMy(){
  const u = auth.currentUser;
  if(!u) return [];
  const snap = await getDocs(query(collection(db,'vacations'), where('uid','==',u.uid), orderBy('createdAt','desc')));
  const rows=[]; snap.forEach(d=> rows.push({id:d.id,...d.data()}));
  return rows;
}

async function listAll(){
  const snap = await getDocs(query(collection(db,'vacations'), orderBy('createdAt','desc')));
  const rows=[]; snap.forEach(d=> rows.push({id:d.id,...d.data()}));
  return rows;
}

async function createReq(payload){
  const u = auth.currentUser;
  if(!u) return;
  await addDoc(collection(db,'vacations'), {
    uid:u.uid, email:u.email, status:'Pendente', ...payload, createdAt:new Date().toISOString()
  });
}

async function updateStatus(id, status){
  await updateDoc(doc(db,'vacations', id), { status, updatedAt:new Date().toISOString() });
}

window.VacationsView = async function VacationsView(){
  const mine = await listMy();
  const profile = window.__APP__?.profile;
  const canManage = ['ADM','Gestor','RH'].includes(profile?.role);
  const team = canManage ? await listAll() : [];
  const myRows = mine.length
    ? mine.map(v=>`<tr><td>${v.start} → ${v.end}</td><td><span class="badge ${v.status==='Aprovada'?'ok':(v.status==='Rejeitada'?'danger':'warn')}">${v.status}</span></td></tr>`).join('')
    : '<tr><td colspan="2">Nenhuma solicitação registrada.</td></tr>';

  document.getElementById('view').innerHTML = `
  <div class="grid cols-2">
    <div class="card">
      <h2>Solicitar férias</h2>
      <form id="fvac" class="grid cols-2">
        <input class="input" type="date" name="start" required>
        <input class="input" type="date" name="end" required>
        <textarea class="input" name="notes" placeholder="Observações"></textarea>
        <div></div>
        <div style="display:flex;gap:.5rem;justify-content:flex-end">
          <button class="btn" type="submit">Enviar solicitação</button>
        </div>
      </form>
    </div>
    <div class="card">
      <h2>Minhas solicitações</h2>
      <table class="table">
        <thead><tr><th>Período</th><th>Status</th></tr></thead>
        <tbody>${myRows}</tbody>
      </table>
    </div>
    ${canManage ? `<div class="card">
      <h2>Solicitações da equipe</h2>
      ${team.length ? `<table class="table">
        <thead><tr><th>Colaborador</th><th>Período</th><th>Status</th><th>Observações</th><th></th></tr></thead>
        <tbody>
          ${team.map(v=>`<tr>
            <td>${v.email || '-'}<br><small class="helper">${v.createdAt ? new Date(v.createdAt).toLocaleDateString('pt-BR') : ''}</small></td>
            <td>${v.start} → ${v.end}</td>
            <td><span class="badge ${v.status==='Aprovada'?'ok':(v.status==='Rejeitada'?'danger':'warn')}">${v.status}</span></td>
            <td>${v.notes || '-'}</td>
            <td class="actions">
              ${v.status==='Pendente' ? `
                <button class="btn ghost" data-status="Aprovada" data-id="${v.id}">Aprovar</button>
                <button class="btn warn" data-status="Rejeitada" data-id="${v.id}">Rejeitar</button>
              ` : '<span class="helper">Finalizado</span>'}
            </td>
          </tr>`).join('')}
        </tbody>
      </table>` : '<p>Nenhuma solicitação para revisar.</p>'}
    </div>` : ''}
  </div>`;

  document.getElementById('fvac').onsubmit = async (e)=>{
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target).entries());
    await createReq(data);
    alert('Solicitação enviada!');
    window.VacationsView();
  };

  if(canManage){
    document.querySelectorAll('[data-status]').forEach(btn=>{
      btn.onclick = async ()=>{
        await updateStatus(btn.getAttribute('data-id'), btn.getAttribute('data-status'));
        alert('Status atualizado!');
        window.VacationsView();
      };
    });
  }
}
