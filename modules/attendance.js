// Attendance: clock in/out + list
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-auth.js";
import { getFirestore, collection, addDoc, getDocs, query, where, orderBy } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js";

const db = getFirestore();
const auth = getAuth();

async function clock(type){
  const user = auth.currentUser;
  if(!user) return alert('Faça login');
  await addDoc(collection(db,'attendance'), {
    uid: user.uid,
    email: user.email,
    type, // in | out
    ts: new Date().toISOString()
  });
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

window.AttendanceView = async function AttendanceView(){
  const mine = await myToday();
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
          ${mine.map(i=>`<tr><td>${new Date(i.ts).toLocaleString('pt-BR')}</td><td>${i.type==='in'?'Entrada':'Saída'}</td></tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div class="card">
      <h2>Relatório rápido</h2>
      <p><small class="helper">Exporte os dados para planilha pela interface do Firebase, se necessário.</small></p>
    </div>
  </div>`;
  document.getElementById('btnIn').onclick = ()=> clock('in');
  document.getElementById('btnOut').onclick = ()=> clock('out');
}
