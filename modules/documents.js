// Documents repository per employee (Storage + Firestore refs)
import { getFirestore, collection, addDoc, getDocs, query, where } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js";
import { getStorage, ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-storage.js";
import { logActivity } from "./activity.js";

const db = getFirestore();
const storage = getStorage();

async function listDocs(employeeEmail){
  const q = query(collection(db,'documents'), where('employee','==', employeeEmail));
  const snap = await getDocs(q);
  const rows = []; snap.forEach(d=> rows.push({id:d.id, ...d.data()}));
  return rows;
}

window.DocumentsView = async function DocumentsView(){
  document.getElementById('view').innerHTML = `
  <div class="grid cols-2">
    <div class="card">
      <h2>Enviar documento</h2>
      <form id="fdoc" class="grid">
        <input class="input" type="email" name="employee" placeholder="E-mail do colaborador" required>
        <select class="input" name="type">
          <option>Contrato</option><option>ASO</option><option>Holerite</option><option>Outros</option>
        </select>
        <input class="input" type="file" name="file" required>
        <button class="btn" type="submit">Enviar</button>
      </form>
      <small class="helper">Os arquivos são salvos no Firebase Storage e vinculados ao colaborador.</small>
    </div>
    <div class="card">
      <h2>Buscar por colaborador</h2>
      <form id="search" class="grid cols-3">
        <input class="input" type="email" name="employee" placeholder="E-mail do colaborador" required>
        <button class="btn" type="submit">Buscar</button>
      </form>
      <div id="docs-list" style="margin-top:1rem"></div>
    </div>
  </div>`;

  document.getElementById('fdoc').onsubmit = async (e)=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    const employee = fd.get('employee');
    const type = fd.get('type');
    const file = fd.get('file');
    const path = `rh/docs/${employee}/${Date.now()}-${file.name}`;
    const r = ref(storage, path);
    await uploadBytes(r, file);
    const url = await getDownloadURL(r);
    await addDoc(collection(db,'documents'), { employee, type, path, url, uploadedAt: new Date().toISOString() });
    await logActivity('documents.upload', { employee, type, filename: file.name });
    alert('Documento enviado!');
    e.target.reset();
  };

  document.getElementById('search').onsubmit = async (e)=>{
    e.preventDefault();
    const email = new FormData(e.target).get('employee');
    const list = await listDocs(email);
    document.getElementById('docs-list').innerHTML = list.length? `<table class="table">
      <thead><tr><th>Tipo</th><th>Arquivo</th><th>Quando</th></tr></thead>
      <tbody>${list.map(d=>`<tr><td>${d.type}</td><td><a href="${d.url}" target="_blank">Abrir</a></td><td>${new Date(d.uploadedAt).toLocaleString('pt-BR')}</td></tr>`).join('')}</tbody>
    </table>` : '<p>Nada encontrado.</p>';
  };
}
