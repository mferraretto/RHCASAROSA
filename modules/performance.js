// Goals & feedback basic
import { getFirestore, collection, addDoc, getDocs, updateDoc, doc } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js";
import { logActivity } from "./activity.js";

const db = getFirestore();

async function listGoals(){
  const snap = await getDocs(collection(db,'goals'));
  const rows=[]; snap.forEach(d=> rows.push({id:d.id,...d.data()})); return rows;
}

function renderGoalsTable(goals){
  if(!goals.length) return '<p>Nenhuma meta cadastrada.</p>';
  return `<table class="table">
    <thead><tr><th>Meta</th><th>Responsável</th><th>Prazo</th><th>Status</th><th></th></tr></thead>
    <tbody>${goals.map(g=>{
      const badgeClass = g.status==='Concluída' ? 'ok' : (g.status==='Em risco' ? 'warn' : '');
      const actions = g.status==='Concluída' ? '<small class="helper">Finalizada</small>' : `<button class="btn ghost" data-complete="${g.id}">Marcar como concluída</button>`;
      return `<tr>
        <td>${g.title}${g.desc?`<br><small class=\"helper\">${g.desc}</small>`:''}</td>
        <td>${g.owner||'-'}</td>
        <td>${g.deadline||'-'}</td>
        <td><span class="badge ${badgeClass}">${g.status||'Em progresso'}</span></td>
        <td>${actions}</td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;
}

window.PerformanceView = async function PerformanceView(){
  const goals = await listGoals();
  document.getElementById('view').innerHTML = `
  <div class="grid cols-2">
    <div class="card">
      <h2>Nova meta</h2>
      <form id="fgoal" class="grid">
        <input class="input" name="title" placeholder="Meta" required>
        <textarea class="input" name="desc" placeholder="Descrição"></textarea>
        <input class="input" name="owner" placeholder="Responsável (email)">
        <input class="input" type="date" name="deadline">
        <select class="input" name="status">
          <option>Em progresso</option>
          <option>Em risco</option>
          <option>Concluída</option>
        </select>
        <button class="btn" type="submit">Adicionar meta</button>
      </form>
    </div>
    <div class="card">
      <h2>Metas</h2>
      ${renderGoalsTable(goals)}
    </div>
  </div>`;

  document.getElementById('fgoal').onsubmit = async (e)=>{
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target).entries());
    await addDoc(collection(db,'goals'), { ...data, createdAt:new Date().toISOString(), status: data.status || 'Em progresso' });
    await logActivity('goal.create', { title: data.title, status: data.status, owner: data.owner });
    alert('Meta adicionada!');
    window.PerformanceView();
  };

  document.querySelectorAll('button[data-complete]').forEach(btn=>{
    btn.onclick = async ()=>{
      const id = btn.getAttribute('data-complete');
      const goal = goals.find(g => g.id === id);
      if(!goal) return;
      await updateDoc(doc(db,'goals', id), { status: 'Concluída', completedAt: new Date().toISOString() });
      await logActivity('goal.update', { title: goal.title, status: 'Concluída' });
      window.PerformanceView();
    };
  });
};
