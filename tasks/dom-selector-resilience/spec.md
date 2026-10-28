# Spec: Resiliência da leitura e escrita no DOM do Vercel (Copiloto Scribe)

- **Status:** Draft
- **Autor:** Edson Moreira
- **Data:** 2026-09-14
- **Componentes afetados:** `extension/scripts/content_script.js`, `extension/ui/panel.js`, `extension/scripts/background.js`, `extension/manifest.json`

## 1. Contexto / Problema

A extensão extrai dados clínicos e injeta texto gerado por IA de volta no formulário do sistema `teleatendimento.vercel.app` sem nenhum contrato estável com esse frontend. Duas heurísticas independentes fazem esse trabalho hoje, e ambas dependem de detalhes de implementação visual que podem mudar a qualquer deploy do site:

1. **Leitura** (`content_script.js:extrairDadosDoDOM`) — usa seletores CSS de bibliotecas de terceiro (`p.text-muted`, `.MuiAccordionSummary-content`, `.badge.bg-secondary`, `.MuiAccordion-root`) e navegação relativa na árvore (`closest`, `parentElement.parentElement`) para achar nome do paciente, data de nascimento e histórico de atendimentos.
2. **Escrita** (`panel.js:pararEPreencher`, bloco `chrome.scripting.executeScript` com `world: "MAIN"`) — varre todo `textarea`/`input[type="text"]` da página, sobe 4 níveis de pais coletando texto de `legend`/`label`/containers, e decide por *keyword matching* em português (`"conduta"`, `"anamnese"`, `"hipótese"`...) qual trecho da resposta da IA vai em qual campo.

Riscos observados:

- Se as classes CSS mudarem (upgrade de lib, remoção do Bootstrap/MUI, renomeação de classes), a leitura para de encontrar dados **silenciosamente** — não há sinal de erro, apenas dados vazios/desatualizados persistidos em `chrome.storage.local`.
- Se o texto dos labels/placeholders dos formulários mudar, a escrita pode: (a) parar de preencher qualquer campo, ou (b) pior, **preencher o campo errado** por causa de correspondência ambígua de palavra-chave — isso é um risco clínico, não apenas funcional.
- Não existe teste automatizado, canário ou alerta que detecte quebra de seletor antes que um médico perceba em produção.
- O próprio código já reconhece a fragilidade (comentário em `content_script.js:32`: *"o ideal aqui no futuro é ler o DOM de verdade"*).

## 2. Objetivos

- Reduzir a fragilidade da leitura e da escrita no DOM da página do Vercel.
- Tornar visível (logs/alerta) quando uma extração ou injeção falha por mudança de layout, em vez de falhar silenciosamente.
- Reduzir o risco de a IA escrever informação clínica no campo errado do formulário.
- Não exigir necessariamente mudança no frontend do Vercel (fora do controle da extensão), mas descrever esse caminho como a solução ideal, caso haja colaboração possível com o time responsável por aquele sistema.

## 3. Não-objetivos

- Não é objetivo desta spec reescrever a lógica de negócio de extração (quais campos existem, quais dados são coletados) — isso permanece igual.
- Não é objetivo migrar a extensão para Manifest V2, mudar o motor de IA (Gemini) ou alterar `src/services/summarizer.rs` / `src/infrastructure/gemini_client.rs`.
- Não cobre autenticação, permissões do manifest, ou telemetria fora do escopo de leitura/escrita de DOM.

## 4. Cenários de usuário

1. **Como médico usuário da extensão**, quando o site de teleatendimento faz um deploy que renomeia uma classe CSS, eu quero que a extensão continue funcionando ou, na pior hipótese, me avise claramente que não conseguiu ler os dados — em vez de mostrar um histórico desatualizado sem eu perceber.
2. **Como médico usuário da extensão**, quando uso o Escriba AI para preencher o prontuário automaticamente, eu quero ter certeza de que o texto gerado pela IA caiu no campo clínico correto (anamnese, hipótese, conduta, observações) — e ser avisado se a extensão não teve certeza de onde inserir algum trecho.
3. **Como desenvolvedor mantenedor da extensão**, quando o site do Vercel muda de layout, eu quero conseguir localizar e corrigir os seletores afetados em um único lugar, sem precisar caçar `querySelectorAll` espalhados em múltiplos arquivos.

## 5. Requisitos funcionais (EARS)

### 5.1 Centralização de seletores

- **R1:** O sistema DEVE manter todos os seletores CSS/estratégias de localização de elementos (paciente, histórico, campos de formulário) em um único módulo de configuração, referenciado tanto por `content_script.js` quanto pelo script injetado em `panel.js`.
- **R2:** QUANDO um seletor precisar ser adicionado, removido ou alterado, O DESENVOLVEDOR DEVE conseguir fazer essa mudança editando apenas esse módulo central, sem tocar na lógica de extração/injeção.

### 5.2 Detecção de falha silenciosa (canário)

- **R3:** QUANDO `extrairDadosDoDOM()` rodar e o seletor de paciente (`p.text-muted` contendo "Data de Nascimento:") não retornar nenhum elemento em uma página que deveria ter esse dado, O SISTEMA DEVE registrar um aviso distinguível (ex: `console.warn` com tag específica) indicando possível quebra de seletor, em vez de apenas deixar os dados como estavam.
- **R4:** QUANDO o seletor de histórico de atendimentos (`.MuiAccordionSummary-content` e fallback `strong.text-dark`) retornar zero elementos em uma tela que antes retornava resultados na mesma sessão, O SISTEMA DEVE sinalizar essa regressão (log estruturado e/ou contador exposto no painel).
- **R5:** O painel lateral (`panel.js`) DEVE expor, de alguma forma visível ao usuário (ex: um indicador de status), quando a última leitura de DOM falhou ou retornou dados vazios, distinguindo esse caso de "nenhum paciente aberto ainda".

### 5.3 Redução de ambiguidade na injeção de formulário

- **R6:** QUANDO o script de injeção (`panel.js`, bloco `world: "MAIN"`) encontrar mais de um campo cujo contexto (label/legend/placeholder) corresponda à mesma categoria clínica (ex: dois campos batendo em "conduta"), O SISTEMA DEVE tratar isso como ambíguo e não escrever automaticamente em nenhum dos dois, sinalizando a ambiguidade no backup visual já existente (`backupScribe`).
- **R7:** O sistema DEVE priorizar associação explícita `label[for=<id-do-campo>]` sobre a heurística atual de "subir N níveis de pai e concatenar texto", usando a heurística de proximidade apenas como fallback quando não houver `label` associado explicitamente.
- **R8:** QUANDO nenhum campo bater com nenhuma categoria conhecida, O SISTEMA DEVE continuar exibindo o backup textual completo (`backupScribe`) — comportamento hoje já existente e que DEVE ser preservado como rede de segurança.

### 5.4 Observabilidade e testes de regressão

- **R9:** DEVE existir uma suíte de teste (ex: Playwright ou similar) capaz de rodar os seletores centralizados (R1) contra uma cópia estática/fixture do HTML da página de teleatendimento, para detectar quebra de seletor antes de publicar uma nova versão da extensão.
- **R10:** A fixture de HTML usada no teste (R9) DEVE ser atualizada manualmente sempre que alguém perceber uma mudança real no layout do site de produção, servindo como registro histórico do "contrato implícito" com o Vercel.

### 5.5 Caminho ideal (fora do controle direto da extensão)

- **R11 (aspiracional, depende de terceiros):** SE houver colaboração possível com o time responsável por `teleatendimento.vercel.app`, ENTÃO o sistema DEVERIA migrar para atributos estáveis dedicados (ex: `data-copiloto-field="anamnese"`, `data-copiloto-role="paciente-nome"`) expostos pelo próprio frontend, eliminando a dependência de classes de estilo (Bootstrap/MUI) e de correspondência textual em português.

## 6. Requisitos não funcionais

- **NFR1 — Performance:** a centralização de seletores e os canários de detecção (R3-R5) não devem aumentar perceptivelmente o custo do polling atual (hoje a cada 1-2s); preferir substituir polling por `MutationObserver` onde viável, mas isso é uma melhoria de custo, não um requisito bloqueante desta spec.
- **NFR2 — Segurança/Privacidade clínica:** qualquer mudança na lógica de injeção (seção 5.3) não pode aumentar o risco de dado clínico ser escrito no campo errado; na dúvida, o sistema deve preferir "não preencher automaticamente" a "preencher com baixa confiança".
- **NFR3 — Compatibilidade retroativa:** o comportamento de fallback textual (`backupScribe`) deve continuar funcionando mesmo se todos os seletores automáticos falharem, garantindo que o médico nunca perca o texto transcrito/estruturado pela IA.

## 7. Riscos e questões em aberto

- Não há acesso confirmado ao código-fonte/time do frontend `teleatendimento.vercel.app` — R11 depende de uma parceria externa e pode não ser viável no curto prazo.
- Definir o que conta como "ambiguidade" (R6) requer decidir um limiar: por exemplo, dois campos batendo com a mesma keyword é ambíguo, mas um campo batendo com duas keywords diferentes (ex: "hipótese" e "cid" no mesmo texto) pode não ser.
- A fixture de teste (R9/R10) exige capturar HTML real da aplicação Vercel — validar se isso é permitido do ponto de vista de dados de paciente (a fixture deve ser anonimizada/sintética, nunca conter dados reais de paciente).
- Ainda não está definido onde/como o indicador de status do R5 apareceria na UI do `panel.html` — precisa de uma decisão de UX antes de virar tarefa de implementação.

## 8. Critérios de aceite (resumo)

- [ ] Existe um único módulo de seletores usado por leitura e escrita.
- [ ] Falha de leitura de paciente/histórico gera log/aviso distinguível de "sem dados".
- [ ] Painel lateral mostra ao usuário quando a última leitura falhou.
- [ ] Injeção de formulário não escreve automaticamente em caso de ambiguidade detectada.
- [ ] Associação `label[for]` é tentada antes da heurística de proximidade.
- [ ] Suíte de teste roda os seletores contra fixture estática e falha caso algum seletor-chave pare de casar.
- [ ] Comportamento de backup textual continua intacto em qualquer cenário de falha.
