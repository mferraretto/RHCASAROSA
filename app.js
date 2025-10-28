// Simple client-side router and ACL
import { getFirestore, collection, getDocs, query, where, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-auth.js";

const view = document.getElementById('view');
const menu = document.getElementById('menu');

const routes = {
  dashboard: renderDashboard,
  employees: window.EmployeesView,
  attendance: window.AttendanceView,
  vacations: window.VacationsView,
  documents: window.DocumentsView,
  ats: window.ATSView,
  performance: window.PerformanceView,
  settings: renderSettings
};

function activateMenu(hash){
  [...menu.querySelectorAll('a')].forEach(a=>{
    a.classList.toggle('active', a.getAttribute('href') === '#' + hash);
  });
}

async function renderDashboard(ctx){
  const auth = getAuth();
  const db = getFirestore();
  // small KPIs
  const usersSnap = await getDocs(collection(db, 'employees'));
  const countEmployees = usersSnap.size;

  const openJobs = await getDocs(query(collection(db,'jobs'), where('status','==','Aberta')));
  const openJobsCount = openJobs.size;

  view.innerHTML = `
    <div class="grid cols-3">
      <div class="kpi"><div class="label">Colaboradores</div><div class="value">${countEmployees}</div></div>
      <div class="kpi"><div class="label">Vagas Abertas</div><div class="value">${openJobsCount}</div></div>
      <div class="kpi"><div class="label">Mês Atual</div><div class="value">${new Date().toLocaleString('pt-BR',{month:'long'})}</div></div>
    </div>
    <div class="grid cols-2" style="margin-top:1rem">
      <div class="card">
        <h3>Atividades recentes</h3>
        <ul id="timeline"><li>Bem-vindo ao RH Casa Rosa 💖</li></ul>
      </div>
      <div class="card">
        <h3>Guia rápido</h3>
        <ol>
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
