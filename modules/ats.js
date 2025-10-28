// Simple ATS: jobs and candidates
import { getFirestore, collection, addDoc, getDocs, query, where, doc, updateDoc } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js";

const db = getFirestore();

async function jobs(){
  const snap = await getDocs(collection(db,'jobs'));
  const rows=[]; snap.forEach(d=> rows.push({id:d.id,...d.data()})); return rows;
}

async function candidates(jobId){
  const snap = await getDocs(query(collection(db,'candidates'), where('jobId','==', jobId)));
  const rows=[]; snap.forEach(d=> rows.push({id:d.id,...d.data()})); return rows;
}

window.ATSView = async function ATSView(){
  const list = await jobs();
  document.getElementById('view').innerHTML = `
  <div class="grid cols-2">
    <div class="card">
      <h2>Abrir vaga</h2>
      <form id="fjob" class="grid">
        <input class="input" name="title" placeholder="Título da vaga" required>
        <input class="input" name="location" placeholder="Local (ex: Presencial - SP)">
        <select class="input" name="status"><option>Aberta</option><option>Pausada</option><option>Fechada</option></select>
        <textarea class="input" name="desc" placeholder="Descrição da vaga"></textarea>
        <button class="btn" type="submit">Criar vaga</button>
      </form>
      <hr class="split">
      <h3>Vagas</h3>
      ${list.length ? `<table class="table">
        <thead><tr><th>Título</th><th>Local</th><th>Status</th><th></th></tr></thead>
        <tbody>${list.map(j=>`<tr>
           <td>${j.title}</td><td>${j.location||'-'}</td><td><span class="badge ${j.status==='Aberta'?'ok':'warn'}">${j.status}</span></td>
           <td><button class="btn ghost" data-open="${j.id}">Abrir</button></td>
        </tr>`).join('')}</tbody>
      </table>` : '<p>Nenhuma vaga ainda.</p>'}
    </div>
    <div class="card" id="job-detail">
      <h2>Detalhes da vaga</h2>
      <p>Selecione uma vaga.</p>
    </div>
  </div>`;

  document.getElementById('fjob').onsubmit = async (e)=>{
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target).entries());
    await addDoc(collection(db,'jobs'), { ...data, createdAt:new Date().toISOString() });
    alert('Vaga criada!');
    window.ATSView();
  };

  document.querySelectorAll('[data-open]').forEach(btn=>{
    btn.onclick = async ()=>{
      const id = btn.getAttribute('data-open');
      const job = list.find(j=>j.id===id);
      const cands = await candidates(id);
      const box = document.getElementById('job-detail');
      box.innerHTML = `
        <h2>${job.title}</h2>
        <div class="badge">${job.status}</div>
        <p>${job.desc||''}</p>
        <hr class="split">
        <h3>Adicionar candidato</h3>
        <form id="fcand" class="grid cols-3">
          <input class="input" name="name" placeholder="Nome" required>
          <input class="input" name="email" placeholder="Email" required>
          <input class="input" name="stage" placeholder="Etapa (Triagem/Entrevista/Oferta)">
          <button class="btn" type="submit">Adicionar</button>
        </form>
        <h3>Pipeline</h3>
        ${cands.length ? `<table class="table">
          <thead><tr><th>Nome</th><th>Email</th><th>Etapa</th></tr></thead>
          <tbody>${cands.map(c=>`<tr><td>${c.name}</td><td>${c.email}</td><td>${c.stage||'-'}</td></tr>`).join('')}</tbody>
        </table>` : '<p>Nenhum candidato ainda.</p>'}
      `;
      box.querySelector('#fcand').onsubmit = async (e)=>{
        e.preventDefault();
        const data = Object.fromEntries(new FormData(e.target).entries());
        await addDoc(collection(db,'candidates'), { ...data, jobId:id, createdAt:new Date().toISOString() });
        alert('Candidato adicionado!');
        window.ATSView();
      };
    };
  });
}
