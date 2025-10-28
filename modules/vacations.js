// Vacations requests
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-auth.js";
import { getFirestore, collection, addDoc, getDocs, query, where, updateDoc, doc, orderBy } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js";
import { logActivity } from "./activity.js";

const db = getFirestore();
const auth = getAuth();
const managerRoles = ['ADM','Gestor','RH'];

async function listMy(){
  const u = auth.currentUser;
  if(!u) return [];
  const snap = await getDocs(query(collection(db,'vacations'), where('uid','==',u.uid)));
  const rows=[]; snap.forEach(d=> rows.push({id:d.id,...d.data()}));
  return rows;
}

async function createReq(payload){
  const u = auth.currentUser;
  if(!u) return;
  const timestamp = new Date().toISOString();
  await addDoc(collection(db,'vacations'), {
    uid:u.uid, email:u.email, status:'Pendente', ...payload, createdAt: timestamp
  });
  await logActivity('vacation.request', { start: payload.start, end: payload.end, email: u.email });
}

async function listAll(){
  const snap = await getDocs(query(collection(db,'vacations'), orderBy('createdAt','desc')));
  const rows=[]; snap.forEach(d=> rows.push({ id:d.id, ...d.data() }));
  return rows;
}

async function updateStatus(request, status){
  await updateDoc(doc(db,'vacations', request.id), { status, decidedAt: new Date().toISOString() });
  await logActivity('vacation.update', { status, email: request.email, start: request.start, end: request.end });
}

function renderManagerTable(items){
  if(!items.length) return '<p>Nenhuma solicitação registrada.</p>';
  const ordered = items.slice().sort((a,b)=>{
    if(a.status === b.status) return new Date(`${b.start||''}T00:00:00`) - new Date(`${a.start||''}T00:00:00`);
    if(a.status === 'Pendente') return -1;
    if(b.status === 'Pendente') return 1;
    return 0;
  });
  return `<table class="table">
    <thead><tr><th>Colaborador</th><th>Período</th><th>Status</th><th>Observações</th><th></th></tr></thead>
    <tbody>
      ${ordered.map(req=>{
        const badgeClass = req.status==='Aprovada'?'ok':(req.status==='Rejeitada'?'danger':'warn');
        const period = req.start ? `${req.start} → ${req.end || '—'}` : '—';
        const actions = req.status==='Pendente' ? `<div class="actions"><button class="btn ghost" data-request="${req.id}" data-status="Aprovada">Aprovar</button><button class="btn warn" data-request="${req.id}" data-status="Rejeitada">Rejeitar</button></div>` : '<small class="helper">Finalizado</small>';
        return `<tr>
          <td>${req.email||'—'}</td>
          <td>${period}</td>
          <td><span class="badge ${badgeClass}">${req.status}</span></td>
          <td>${req.notes ? `<small>${req.notes}</small>` : '<small class="helper">—</small>'}</td>
          <td>${actions}</td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>`;
}

window.VacationsView = async function VacationsView(){
  const mine = await listMy();
  const profile = window.__APP__?.profile;
  const isManager = profile ? managerRoles.includes(profile.role) : false;
  const team = isManager ? await listAll() : [];
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
      ${mine.length ? `<table class="table">
        <thead><tr><th>Período</th><th>Status</th></tr></thead>
        <tbody>
          ${mine.map(v=>`<tr><td>${v.start} → ${v.end}</td><td><span class="badge ${v.status==='Aprovada'?'ok':(v.status==='Rejeitada'?'danger':'warn')}">${v.status}</span></td></tr>`).join('')}
        </tbody>
      </table>` : '<p>Nenhuma solicitação ainda.</p>'}
    </div>
  </div>
  ${isManager ? `<div class="grid cols-1" style="margin-top:1rem">
    <div class="card">
      <h2>Solicitações da equipe</h2>
      ${renderManagerTable(team)}
    </div>
  </div>` : ''}`;

  document.getElementById('fvac').onsubmit = async (e)=>{
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target).entries());
    await createReq(data);
    alert('Solicitação enviada!');
    window.VacationsView();
  };

  if(isManager){
    document.querySelectorAll('button[data-request]').forEach(btn=>{
      btn.onclick = async ()=>{
        const status = btn.getAttribute('data-status');
        const id = btn.getAttribute('data-request');
        const request = team.find(r => r.id === id);
        if(!request) return;
        await updateStatus(request, status);
        window.VacationsView();
      };
    });
  }
};
