// Goals & feedback basic
import { getFirestore, collection, addDoc, getDocs } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js";

const db = getFirestore();

async function listGoals(){
  const snap = await getDocs(collection(db,'goals'));
  const rows=[]; snap.forEach(d=> rows.push({id:d.id,...d.data()})); return rows;
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
        <button class="btn" type="submit">Adicionar meta</button>
      </form>
    </div>
    <div class="card">
      <h2>Metas</h2>
      ${goals.length? `<table class="table">
        <thead><tr><th>Meta</th><th>Responsável</th><th>Prazo</th></tr></thead>
        <tbody>${goals.map(g=>`<tr><td>${g.title}</td><td>${g.owner||'-'}</td><td>${g.deadline||'-'}</td></tr>`).join('')}</tbody>
      </table>` : '<p>Nenhuma meta cadastrada.</p>'}
    </div>
  </div>`;

  document.getElementById('fgoal').onsubmit = async (e)=>{
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target).entries());
    await addDoc(collection(db,'goals'), { ...data, createdAt:new Date().toISOString() });
    alert('Meta adicionada!');
    window.PerformanceView();
  };
}
