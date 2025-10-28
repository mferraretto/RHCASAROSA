// Attendance: clock in/out + list
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-auth.js";
import { getFirestore, collection, addDoc, getDocs, query, where, orderBy, limit } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js";
import { logActivity } from "./activity.js";

const db = getFirestore();
const auth = getAuth();

async function clock(type){
  const user = auth.currentUser;
  if(!user) return alert('Faça login');
  const timestamp = new Date().toISOString();
  await addDoc(collection(db,'attendance'), {
    uid: user.uid,
    email: user.email,
    type, // in | out
    ts: timestamp
  });
  await logActivity('attendance.clock', { type, ts: timestamp });
  alert(type==='in'?'Entrada registrada ✅':'Saída registrada ✅');
  window.AttendanceView();
}

async function myToday(){
  const user = auth.currentUser;
  if(!user) return [];
  const today = new Date(); today.setHours(0,0,0,0);
  const q = query(collection(db,'attendance'), where('uid','==',user.uid), orderBy('ts','asc'));
  const snap = await getDocs(q);
  const list=[];
  snap.forEach(d=>{
    const ts = new Date(d.data().ts);
    if(ts >= today){ list.push(d.data()); }
  });
  return list;
}

async function recentHistory(){
  const user = auth.currentUser;
  if(!user) return [];
  const q = query(collection(db,'attendance'), where('uid','==',user.uid), orderBy('ts','desc'), limit(10));
  const snap = await getDocs(q);
  const rows=[]; snap.forEach(d=> rows.push(d.data()));
  return rows;
}

function calculateWorkload(records){
  const sorted = [...records].sort((a,b)=> new Date(a.ts) - new Date(b.ts));
  let lastIn = null;
  let total = 0;
  sorted.forEach(rec => {
    const ts = new Date(rec.ts);
    if(rec.type === 'in'){
      lastIn = ts;
    } else if(rec.type === 'out' && lastIn){
      total += ts - lastIn;
      lastIn = null;
    }
  });
  return total;
}

function formatDuration(ms){
  if(!ms) return '—';
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2,'0')}h${String(minutes).padStart(2,'0')}min`;
}

window.AttendanceView = async function AttendanceView(){
  const mine = await myToday();
  const history = await recentHistory();
  const totalMs = calculateWorkload(mine);
  const lastRecord = mine.length ? mine[mine.length-1] : null;
  document.getElementById('view').innerHTML = `
  <div class="grid cols-2">
    <div class="card">
      <h2>Ponto diário</h2>
      <div style="display:flex;gap:.5rem">
        <button class="btn" id="btnIn">Bater entrada</button>
        <button class="btn secondary" id="btnOut">Bater saída</button>
      </div>
      <hr class="split">
      <table class="table">
        <thead><tr><th>Registro</th><th>Tipo</th></tr></thead>
        <tbody>
          ${mine.length ? mine.map(i=>`<tr><td>${new Date(i.ts).toLocaleString('pt-BR')}</td><td>${i.type==='in'?'Entrada':'Saída'}</td></tr>`).join('') : '<tr><td colspan="2"><small class="helper">Sem registros hoje.</small></td></tr>'}
        </tbody>
      </table>
    </div>
    <div class="card">
      <h2>Resumo diário</h2>
      <div class="kpi small">
        <div class="label">Total trabalhado</div>
        <div class="value">${formatDuration(totalMs)}</div>
        <small class="helper">Último registro: ${lastRecord ? new Date(lastRecord.ts).toLocaleTimeString('pt-BR') + ' (' + (lastRecord.type==='in'?'Entrada':'Saída') + ')' : 'Sem registros hoje.'}</small>
      </div>
      <hr class="split">
      <h3>Histórico recente</h3>
      ${history.length ? `<table class="table">
        <thead><tr><th>Data</th><th>Tipo</th></tr></thead>
        <tbody>${history.map(i=>`<tr><td>${new Date(i.ts).toLocaleString('pt-BR')}</td><td>${i.type==='in'?'Entrada':'Saída'}</td></tr>`).join('')}</tbody>
      </table>` : '<p>Nenhum registro ainda.</p>'}
    </div>
  </div>`;
  document.getElementById('btnIn').onclick = ()=> clock('in');
  document.getElementById('btnOut').onclick = ()=> clock('out');
}
