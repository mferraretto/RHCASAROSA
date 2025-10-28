// Simple client-side router and ACL
import { getFirestore, collection, getDocs, query, where, doc, getDoc, orderBy, limit } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js";

const view = document.getElementById('view');
const menu = document.getElementById('menu');

function callModuleView(name, fallbackLabel){
  const fn = window[name];
  if(typeof fn === 'function'){
    return fn();
  }

  console.warn(`View "${name}" ainda não está disponível.`);
  view.innerHTML = `
    <div class="card">
      <h2>${fallbackLabel}</h2>
      <p class="helper">Não foi possível carregar esta área. Recarregue a página e tente novamente.</p>
    </div>
  `;
}

const routes = {
  dashboard: renderDashboard,
  employees: () => callModuleView('EmployeesView', 'Colaboradores'),
  attendance: () => callModuleView('AttendanceView', 'Ponto'),
  vacations: () => callModuleView('VacationsView', 'Férias'),
  documents: () => callModuleView('DocumentsView', 'Documentos'),
  ats: () => callModuleView('ATSView', 'Recrutamento'),
  performance: () => callModuleView('PerformanceView', 'Desempenho'),
  settings: renderSettings
};

function activateMenu(hash){
  [...menu.querySelectorAll('a')].forEach(a=>{
    a.classList.toggle('active', a.getAttribute('href') === '#' + hash);
  });
}

async function fetchTimeline(){
  const db = getFirestore();
  const [latestEmployees, latestVacations, latestDocs, latestAttendance] = await Promise.all([
    getDocs(query(collection(db,'employees'), orderBy('createdAt','desc'), limit(3))),
    getDocs(query(collection(db,'vacations'), orderBy('createdAt','desc'), limit(3))),
    getDocs(query(collection(db,'documents'), orderBy('uploadedAt','desc'), limit(3))),
    getDocs(query(collection(db,'attendance'), orderBy('ts','desc'), limit(3)))
  ]);

  const events = [];
  latestEmployees.forEach(d=>{
    const data = d.data();
    if(data?.createdAt){
      events.push({
        ts: data.createdAt,
        icon: '👤',
        text: `Novo colaborador: <strong>${data.name || data.email || 'Sem nome'}</strong>`
      });
    }
  });
  latestVacations.forEach(d=>{
    const data = d.data();
    if(data?.createdAt){
      events.push({
        ts: data.createdAt,
        icon: data.status==='Aprovada' ? '✅' : data.status==='Rejeitada' ? '❌' : '🏝️',
        text: `Férias ${data.start} → ${data.end} (${data.status || 'Pendente'})`
      });
    }
  });
  latestDocs.forEach(d=>{
    const data = d.data();
    if(data?.uploadedAt){
      events.push({
        ts: data.uploadedAt,
        icon: '📁',
        text: `Documento ${data.type || 'Arquivo'} para ${data.employee}`
      });
    }
  });
  latestAttendance.forEach(d=>{
    const data = d.data();
    if(data?.ts){
      events.push({
        ts: data.ts,
        icon: data.type==='in' ? '🟢' : '🔴',
        text: `${data.email || 'Colaborador'} registrou ${data.type==='in'?'entrada':'saída'}`
      });
    }
  });

  return events
    .sort((a,b)=> new Date(b.ts) - new Date(a.ts))
    .slice(0,8)
    .map(evt => ({
      ...evt,
      when: new Date(evt.ts).toLocaleString('pt-BR', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' })
    }));
}

async function renderDashboard(ctx){
  const db = getFirestore();
  const [employeesSnap, openJobsSnap, pendingVacationsSnap, timeline] = await Promise.all([
    getDocs(collection(db,'employees')),
    getDocs(query(collection(db,'jobs'), where('status','==','Aberta'))),
    getDocs(query(collection(db,'vacations'), where('status','==','Pendente'))),
    fetchTimeline()
  ]);

  const countEmployees = employeesSnap.size;
  const openJobsCount = openJobsSnap.size;
  const pendingVacations = pendingVacationsSnap.size;
  const timelineHtml = timeline.length
    ? timeline.map(item=>`<li><span class="badge ghost">${item.when}</span> ${item.icon} ${item.text}</li>`).join('')
    : '<li>Nenhuma atividade recente.</li>';

  view.innerHTML = `
    <div class="grid cols-3">
      <div class="kpi"><div class="label">Colaboradores</div><div class="value">${countEmployees}</div></div>
      <div class="kpi"><div class="label">Vagas abertas</div><div class="value">${openJobsCount}</div></div>
      <div class="kpi"><div class="label">Férias pendentes</div><div class="value">${pendingVacations}</div></div>
    </div>
    <div class="grid cols-2" style="margin-top:1rem">
      <div class="card">
        <h3>Atividades recentes</h3>
        <ul id="timeline">${timelineHtml}</ul>
      </div>
      <div class="card">
        <h3>Guia rápido</h3>
        <ol>
          <li>Mês atual: <b>${new Date().toLocaleString('pt-BR',{month:'long', year:'numeric'})}</b></li>
          <li>Cadastre colaborador em <b>👥 Colaboradores</b></li>
          <li>Peça para bater ponto em <b>⏱️ Ponto</b></li>
          <li>Suba documentos em <b>📁 Documentos</b></li>
          <li>Abra vagas e gerencie candidatos em <b>🧲 Recrutamento</b></li>
          <li>Registre metas/avaliações em <b>⭐ Desempenho</b></li>
        </ol>
      </div>
    </div>
  `;
}

function renderSettings(){
  view.innerHTML = `
  <div class="grid cols-2">
    <div class="card">
      <h3>Identidade visual</h3>
      <p>Casa Rosa — Magenta, Verde Tiffany e Amarelo.</p>
      <div style="display:flex;gap:.5rem">
        <span class="color-pill" style="background:var(--magenta)"></span>
        <span class="color-pill" style="background:var(--tiffany)"></span>
        <span class="color-pill" style="background:var(--yellow)"></span>
      </div>
    </div>
    <div class="card">
      <h3>Acesso e Perfis</h3>
      <p>Perfis: <span class="badge">ADM</span> <span class="badge">Gestor</span> <span class="badge">RH</span> <span class="badge">Colaborador</span></p>
      <small class="helper">Regras detalhadas estão em <code>firestore.rules</code>.</small>
    </div>
  </div>`;
}

function parseRoute(){
  let hash = (location.hash || "#dashboard").slice(1);
  if(!routes[hash]) hash = 'dashboard';
  activateMenu(hash);
  const handler = routes[hash];
  handler && handler();
}

window.addEventListener('hashchange', parseRoute);
window.addEventListener('app:ready', parseRoute);
if (!location.hash) location.hash = '#dashboard';
