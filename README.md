
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
- **Documentos**: repositório completo com filtros, versionamento e assinaturas
- **Recrutamento**: vagas + pipeline
- **Desempenho**: metas simples

## Identidade visual
Cores oficiais: **Magenta** `#ff008a`, **Verde Tiffany** `#00c5c0`, **Amarelo** `#ffd42a`.

## 📁 Documentos

### Objetivo da aba

Centralizar todos os arquivos trabalhistas e administrativos (contratos, ASO, holerites, PIS, RG/CPF, comprovantes, laudos, advertências, políticas assinadas, treinamentos) com controle de acesso por perfil, versões, vencimentos, assinatura e rastreamento.

### Tipos e tags sugeridas

- **Pessoais**: RG, CPF, CNH, Comprovante de Endereço, Certidões.
- **Admissionais**: Contrato, Ficha de Registro, PIS, Carteira de Trabalho Digital.
- **Médicos/Segurança**: ASO (admissional, periódico, demissional), PPRA/PCMSO/LTCAT, treinamentos NR (NR‑6/NR‑10/NR‑12/NR‑35...).
- **Financeiros**: Holerites, adiantamentos, aviso de férias, rescisão.
- **Jurídicos/Conduta**: Advertências, termos (LGPD/Conduta/Ética), acordos.
- **Operacionais**: Certificados, manuais, políticas internas.
- **Outros**: anexos livres.

Use **tipo** (categoria principal) + **tags (multi‑select)** para facilitar filtros.

### Estrutura da UI

- **Barra de filtros**: colaborador (autocomplete por perfil), tipo, tags, status (Válido, Vencendo, Vencido, Em aprovação, Aguardando assinatura), intervalo de validade, centro de custo, busca livre.
- **Ações rápidas** (por perfil): enviar documento, importar lote (CSV/ZIP), exportar CSV (metadados), solicitar assinatura.
- **Painéis**: vencendo em 30 dias, assinaturas pendentes, top tipos por volume/compliance.
- **Tabela/grade**: título + tipo + tags, colaborador/corporativo, validade (badge), versão, status, ações (preview, download, nova versão, histórico, assinatura, arquivar).
- **Drawer**: metadados, preview, histórico de versões, log de ações, permissões efetivas, vinculações.

### Perfis

- **ADM / RH**: acesso total; upload individual e em lote; editar metadados; versionar; solicitar assinatura; exportar CSV; arquivar/excluir; visualizar logs.
- **Gestor**: visibilidade apenas do time (com base em `managerUid`); baixar/visualizar; sugerir correções; (opcional) subir treinamentos; aprovar “Em aprovação”; exportar escopo; monitorar vencimentos do time.
- **Colaborador**: acessa somente os próprios documentos; pode subir atualizações com status “Em aprovação” (opcional); assina itens pendentes; visualiza vencimentos relevantes.

### Modelo de dados (Firestore)

Coleção `documents`:

```json
{
  "employeeUid": "UID do colaborador (ou null para corporativo)",
  "employeeEmail": "email@empresa.com",
  "title": "ASO Periódico",
  "type": "ASO",
  "tags": ["saude", "seguranca", "nr"],
  "costCenter": "Produção",
  "validUntil": "2026-05-01",
  "status": "Valido",
  "path": "rh/docs/{uid}/2025/10/2025-10-28-aso.pdf",
  "url": "<downloadURL>",
  "version": 2,
  "previousVersionId": "docId_v1",
  "uploadedBy": "UID",
  "uploadedAt": "ISO",
  "approval": {
    "required": false,
    "byUid": null,
    "at": null,
    "notes": ""
  },
  "sign": {
    "required": true,
    "status": "Pendente",
    "requestAt": "ISO",
    "signedAt": null,
    "byUid": null
  },
  "history": [
    { "version": 1, "path": "...", "url": "...", "uploadedAt": "ISO", "uploadedBy": "UID" }
  ],
  "audit": [
    { "who": "UID", "what": "upload|view|download|update|sign", "when": "ISO" }
  ],
  "notes": "Observações internas"
}
```

### Storage

- Convenção: `rh/docs/{employeeUid|corporativo}/YYYY/MM/{timestamp}-{slug}.{ext}`.
- Holerites: `rh/holerites/{employeeUid}/{aaaa-mm}.pdf`.
- Avisos de férias: `rh/ferias/avisos/{employeeUid}/{aaaa-mm}_aviso-ferias.pdf`.
- Hora extra/autorizações: `rh/overtime/autorizacoes/{employeeUid}/{aaaa-mm-dd}.pdf`.

Boas práticas:

1. Sempre gerar nomes slugados (sem espaços/acentos) e particionar por ano/mês para manter limites do Storage organizados.
2. Preferir `getDownloadURL` somente após checar permissão no Firestore ou usar Cloud Function como proxy para downloads sensíveis.
3. Registrar audit trail (`audit[]`) a cada visualização/baixa/atualização.
4. Programar alertas para vencimento (ex.: Cloud Functions agendadas disparando e-mail/WhatsApp).
5. Automatizar OCR ou modelos pré-preenchidos (contratos, termos LGPD) para acelerar cadastros.
6. Definir política de retenção/expurgo (ex.: holerites após X anos) e aplicar watermark/QR Code em previews quando necessário.
