
# Casa Rosa • Sistema de RH (Firebase)

Sistema web simples, modular e **100% no Firebase** com autenticação, Firestore e Storage.

## Como rodar
1. **Hospede** estes arquivos (GitHub Pages, Firebase Hosting ou local com um servidorzinho).
2. Abra `index.html`. Crie sua conta (selecionando o perfil). O primeiro usuário pode ser `ADM`.
3. Ajuste as **Regras** de Firestore e Storage no console do Firebase usando `firestore.rules` e `storage.rules`.

> ⚠️ Observação do Storage: seu `storageBucket` veio como `*.firebasestorage.app`. Se algo falhar, troque para `matheus-35023.appspot.com` no `firebase-config.js`.

## Coleções (Firestore)
- `users/{uid}` → perfil, `role` ∈ {ADM, Gestor, RH, Colaborador}
- `employees/{id}` → cadastro dos colaboradores
- `attendance/{id}` → ponto (entrada/saída)
- `vacations/{id}` → solicitações de férias
- `documents/{id}` → metadados de arquivos do Storage
- `jobs/{id}` e `candidates/{id}` → vagas e candidatos
- `goals/{id}` → metas/desempenho

## Módulos
- **Painel**: KPIs básicos
- **Colaboradores**: CRUD completo
- **Ponto**: bater entrada/saída
- **Férias**: solicitar e listar
- **Documentos**: upload por colaborador (Storage)
- **Recrutamento**: vagas + pipeline
- **Desempenho**: metas simples

## Identidade visual
Cores oficiais: **Magenta** `#ff008a`, **Verde Tiffany** `#00c5c0`, **Amarelo** `#ffd42a`.
