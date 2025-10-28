// Auth + bootstrap of basic profile
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, updateProfile } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-auth.js";
import { getFirestore, doc, setDoc } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js";

const AUTH_ERROR_MESSAGES = {
  "auth/email-already-in-use": "Este e-mail já está cadastrado.",
  "auth/invalid-email": "O e-mail informado é inválido.",
  "auth/weak-password": "A senha deve conter ao menos 6 caracteres.",
  "auth/missing-password": "Informe a senha.",
  "auth/network-request-failed": "Não foi possível conectar ao servidor. Verifique sua internet.",
  "auth/too-many-requests": "Muitas tentativas consecutivas. Tente novamente mais tarde.",
  "auth/admin-restricted-operation": "Cadastros estão temporariamente indisponíveis. Fale com o administrador.",
  "auth/operation-not-allowed": "Este método de acesso está desativado no momento.",
  "auth/user-not-found": "Usuário não encontrado.",
  "auth/wrong-password": "Senha incorreta."
};

function translateAuthError(error) {
  if (!error) return "Erro desconhecido";
  const code = typeof error === "string" ? error : error.code;
  if (code && AUTH_ERROR_MESSAGES[code]) {
    return AUTH_ERROR_MESSAGES[code];
  }
  if (error.message) {
    return error.message;
  }
  return "Algo deu errado. Tente novamente.";
}

const auth = getAuth();
const db = getFirestore();

const loginForm = document.getElementById('login-form');
const signupForm = document.getElementById('signup-form');

if (loginForm){
  loginForm.addEventListener('submit', async (e)=>{
    e.preventDefault();
    const data = Object.fromEntries(new FormData(loginForm).entries());
    try{
      await signInWithEmailAndPassword(auth, data.email, data.password);
    }catch(err){
      alert('Erro ao entrar: ' + translateAuthError(err));
    }
  });
}

if (signupForm){
  signupForm.addEventListener('submit', async (e)=>{
    e.preventDefault();
    const data = Object.fromEntries(new FormData(signupForm).entries());
    try{
      const cred = await createUserWithEmailAndPassword(auth, data.email, data.password);
      await updateProfile(cred.user, { displayName: data.name });
      await setDoc(doc(db, 'users', cred.user.uid), {
        name: data.name,
        email: data.email,
        role: data.role || 'Colaborador',
        createdAt: new Date().toISOString()
      });
      alert('Conta criada. Você já está logado!');
    }catch(err){
      alert('Erro ao cadastrar: ' + translateAuthError(err));
    }
  });
}
