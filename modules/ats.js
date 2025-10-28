// Simple ATS: jobs and candidates
import { getFirestore, collection, addDoc, getDocs, query, where, doc, updateDoc, orderBy } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js";

const db = getFirestore();

async function jobs(){
  const snap = await getDocs(query(collection(db,'jobs'), orderBy('createdAt','desc')));
  const rows=[]; snap.forEach(d=> rows.push({id:d.id,...d.data()})); return rows;
}

async function candidates(jobId){
  const snap = await getDocs(query(collection(db,'candidates'), where('jobId','==', jobId), orderBy('createdAt','desc')));
  const rows=[]; snap.forEach(d=> rows.push({id:d.id,...d.data()})); return rows;
}

async function updateJobStatus(id, status){
  await updateDoc(doc(db,'jobs', id), { status, updatedAt:new Date().toISOString() });
}

async function updateCandidateStage(id, stage){
  await updateDoc(doc(db,'candidates', id), { stage, updatedAt:new Date().toISOString() });
}

window.ATSView = async function ATSView(){
  const list = await jobs();
  const stageOptions = ['Triagem','Entrevista','Oferta','Contratado','Reprovado'];
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
    const timestamp = new Date().toISOString();
    await addDoc(collection(db,'jobs'), {
      ...data,
      status: data.status || 'Aberta',
      createdAt: timestamp,
      updatedAt: timestamp
    });
    alert('Vaga criada!');
    e.target.reset();
    window.ATSView();
  };

  document.querySelectorAll('[data-open]').forEach(btn=>{
    btn.onclick = async ()=>{
      const id = btn.getAttribute('data-open');
      const job = list.find(j=>j.id===id);
      const cands = await candidates(id);
      const box = document.getElementById('job-detail');
      const statusClass = job.status==='Aberta' ? 'ok' : (job.status==='Pausada' ? 'warn' : '');
      const createdInfo = job.createdAt ? new Date(job.createdAt).toLocaleDateString('pt-BR') : 'Sem data';
      const locationInfo = job.location || 'Local não informado';
      box.innerHTML = `
        <div style="display:flex;justify-content:space-between;gap:1rem;align-items:flex-start">
          <div>
            <h2>${job.title}</h2>
            <div class="badge ${statusClass}">${job.status}</div>
            <small class="helper">${locationInfo} • Criada em ${createdInfo}</small>
          </div>
          <div style="min-width:180px;">
            <label class="helper" for="job-status">Atualizar status</label>
            <select class="input" id="job-status">
              ${['Aberta','Pausada','Fechada'].map(opt=>`<option value="${opt}" ${job.status===opt?'selected':''}>${opt}</option>`).join('')}
            </select>
          </div>
        </div>
        <p>${job.desc||''}</p>
        <hr class="split">
        <h3>Adicionar candidato</h3>
        <form id="fcand" class="grid cols-3">
          <input class="input" name="name" placeholder="Nome" required>
          <input class="input" name="email" placeholder="Email" required>
          <select class="input" name="stage">
            ${stageOptions.map(opt=>`<option value="${opt}">${opt}</option>`).join('')}
          </select>
          <button class="btn" type="submit">Adicionar</button>
        </form>
        <h3>Pipeline</h3>
        ${cands.length ? `<table class="table">
          <thead><tr><th>Nome</th><th>Email</th><th>Etapa</th></tr></thead>
          <tbody>${cands.map(c=>`<tr>
            <td>${c.name}</td>
            <td>${c.email}</td>
            <td>
              <select class="input stage-select" data-id="${c.id}">
                ${stageOptions.map(opt=>`<option value="${opt}" ${(c.stage || stageOptions[0])===opt?'selected':''}>${opt}</option>`).join('')}
              </select>
            </td>
          </tr>`).join('')}</tbody>
        </table>
        <small class="helper">Altere a etapa e ela será salva automaticamente.</small>` : '<p>Nenhum candidato ainda.</p>'}
      `;
      box.querySelector('#fcand').onsubmit = async (e)=>{
        e.preventDefault();
        const data = Object.fromEntries(new FormData(e.target).entries());
        await addDoc(collection(db,'candidates'), { ...data, jobId:id, createdAt:new Date().toISOString() });
        alert('Candidato adicionado!');
        window.ATSView();
      };
      const statusSelect = box.querySelector('#job-status');
      statusSelect.onchange = async (event)=>{
        await updateJobStatus(id, event.target.value);
        alert('Status da vaga atualizado!');
        window.ATSView();
      };
      box.querySelectorAll('.stage-select').forEach(sel=>{
        sel.onchange = async (event)=>{
          await updateCandidateStage(sel.getAttribute('data-id'), event.target.value);
          alert('Etapa do candidato atualizada!');
        };
      });
    };
  });
}
