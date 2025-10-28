// Vacations requests
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-auth.js";
import { getFirestore, collection, addDoc, getDocs, query, where, updateDoc, doc } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js";

const db = getFirestore();
const auth = getAuth();

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
  await addDoc(collection(db,'vacations'), {
    uid:u.uid, email:u.email, status:'Pendente', ...payload, createdAt:new Date().toISOString()
  });
}

window.VacationsView = async function VacationsView(){
  const mine = await listMy();
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
        <tbody>
          ${mine.map(v=>`<tr><td>${v.start} → ${v.end}</td><td><span class="badge ${v.status==='Aprovada'?'ok':(v.status==='Rejeitada'?'danger':'warn')}">${v.status}</span></td></tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>`;

  document.getElementById('fvac').onsubmit = async (e)=>{
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target).entries());
    await createReq(data);
    alert('Solicitação enviada!');
    window.VacationsView();
  };
}
