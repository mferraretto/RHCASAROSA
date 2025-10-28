// Auth + bootstrap of basic profile
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, updateProfile } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-auth.js";
import { getFirestore, doc, setDoc } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js";

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
      alert('Erro ao entrar: ' + err.message);
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
      alert('Erro ao cadastrar: ' + err.message);
    }
  });
}
