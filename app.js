// Simple client-side router and ACL
import { getFirestore, collection, getDocs, query, where, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js";
import { fetchRecentActivities, describeActivity } from "./modules/activity.js";

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
  overtime: () => callModuleView('OvertimeView', 'Hora Extra'),
  bonuses: () => callModuleView('BonusesView', 'Bônus e Premiações'),
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

async function renderDashboard(ctx){
  const db = getFirestore();
  // small KPIs
  const usersSnap = await getDocs(collection(db, 'employees'));
  const countEmployees = usersSnap.size;

  const openJobs = await getDocs(query(collection(db,'jobs'), where('status','==','Aberta')));
  const openJobsCount = openJobs.size;

  const activities = await fetchRecentActivities(8);
  const timeline = activities.length ? activities.map(item => {
    const info = describeActivity(item);
    return `<li><div class="activity-line"><span class="when">${info.when}</span><span>${info.text}</span></div></li>`;
  }).join('') : '<li>Sem movimentações recentes.</li>';

  const approvedVacations = await getDocs(query(collection(db,'vacations'), where('status','==','APROVADA')));
  const today = new Date(); today.setHours(0,0,0,0);
  const upcoming = [];
  approvedVacations.forEach(doc => {
    const data = doc.data();
    if(!data.start) return;
    const start = new Date(`${data.start}T00:00:00`);
    if(Number.isNaN(start.getTime())) return;
    if(start >= today){
      upcoming.push({
        email: data.forEmail || data.email,
        start: data.start,
        end: data.end
      });
    }
  });
  upcoming.sort((a,b)=> new Date(`${a.start}T00:00:00`) - new Date(`${b.start}T00:00:00`));
  const upcomingList = upcoming.slice(0,5).map(item => {
    const start = new Date(`${item.start}T00:00:00`);
    const end = item.end ? new Date(`${item.end}T00:00:00`) : null;
    const period = `${start.toLocaleDateString('pt-BR')} → ${end ? end.toLocaleDateString('pt-BR') : '—'}`;
    return `<li><strong>${item.email || '—'}</strong><br><small class="helper">${period}</small></li>`;
  }).join('') || '<li>Sem férias aprovadas.</li>';

  view.innerHTML = `
    <div class="grid cols-3">
      <div class="kpi"><div class="label">Colaboradores</div><div class="value">${countEmployees}</div></div>
      <div class="kpi"><div class="label">Vagas Abertas</div><div class="value">${openJobsCount}</div></div>
      <div class="kpi"><div class="label">Mês Atual</div><div class="value">${new Date().toLocaleString('pt-BR',{month:'long'})}</div></div>
    </div>
    <div class="grid cols-3" style="margin-top:1rem">
      <div class="card">
        <h3>Atividades recentes</h3>
        <ul id="timeline">${timeline}</ul>
      </div>
      <div class="card">
        <h3>Próximas férias</h3>
        <ul>${upcomingList}</ul>
      </div>
      <div class="card">
        <h3>Guia rápido</h3>
        <ol>
          <li>Cadastre colaborador em <b>👥 Colaboradores</b></li>
          <li>Registre hora extra em <b>🕒 Hora Extra</b></li>
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
