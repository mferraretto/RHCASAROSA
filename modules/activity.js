// Activity logging helpers
import { getFirestore, collection, addDoc, query, orderBy, limit, getDocs } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-auth.js";

const db = getFirestore();
const auth = getAuth();

export async function logActivity(action, meta = {}) {
  try {
    const actor = auth.currentUser ? {
      uid: auth.currentUser.uid,
      email: auth.currentUser.email || null
    } : null;
    await addDoc(collection(db, 'activities'), {
      action,
      meta,
      actor,
      createdAt: new Date().toISOString()
    });
  } catch (err) {
    console.warn('Não foi possível registrar atividade', err);
  }
}

export async function fetchRecentActivities(max = 8) {
  const q = query(collection(db, 'activities'), orderBy('createdAt', 'desc'), limit(max));
  const snap = await getDocs(q);
  const rows = [];
  snap.forEach(doc => rows.push({ id: doc.id, ...doc.data() }));
  return rows;
}

const labels = {
  'employee.add': (item) => `👥 Novo colaborador: ${item.meta?.name || item.meta?.email || 'Cadastro realizado'}`,
  'employee.update': (item) => `📝 Dados atualizados para ${item.meta?.name || item.meta?.email || 'colaborador'}`,
  'employee.remove': (item) => `🗑️ Colaborador removido (${item.meta?.name || item.meta?.email || 'registro'})`,
  'attendance.clock': (item) => `⏱️ ${item.meta?.type === 'in' ? 'Entrada' : 'Saída'} registrada`,
  'vacation.request': (item) => `🏝️ Solicitação de férias ${item.meta?.start ? `(${item.meta.start} → ${item.meta.end})` : ''}`,
  'vacation.update': (item) => `✅ Férias ${item.meta?.status?.toLowerCase() || 'atualizadas'} para ${item.meta?.email || 'colaborador'}`,
  'documents.upload': (item) => `📁 Documento (${item.meta?.type || 'Arquivo'}) enviado para ${item.meta?.employee || 'colaborador'}`,
  'job.create': (item) => `🧲 Nova vaga aberta: ${item.meta?.title || 'vaga'}`,
  'job.status': (item) => `🔁 Status da vaga atualizado para ${item.meta?.status || '—'}`,
  'candidate.add': (item) => `🙋 Candidato adicionado: ${item.meta?.name || 'candidato'} (${item.meta?.job || 'vaga'})`,
  'goal.create': (item) => `⭐ Nova meta criada: ${item.meta?.title || 'meta'}`,
  'goal.update': (item) => `🏁 Meta atualizada: ${item.meta?.title || 'meta'} (${item.meta?.status || ''})`
};

export function describeActivity(item) {
  const when = item.createdAt ? new Date(item.createdAt).toLocaleString('pt-BR') : '';
  const text = labels[item.action] ? labels[item.action](item) : item.action;
  return {
    text,
    when
  };
}
