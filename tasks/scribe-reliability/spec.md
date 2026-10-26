# Spec: Confiabilidade do Escriba AI (transcrição → JSON → preenchimento do formulário)

- **Status:** Draft
- **Autor:** Edson Moreira
- **Data:** 2026-09-30
- **Componentes afetados:** `src/infrastructure/gemini_client.rs`, `src/lib.rs`, `extension/ui/panel.js`, `extension/scripts/content_script.js`
- **Relacionada a:** `tasks/dom-selector-resilience/spec.md` (matching de labels; ver seção 3)

## 1. Contexto / Problema

O fluxo do Escriba AI é: Web Speech API (content script) → texto no painel → `estruturar_prontuario` (Wasm/Rust) → Gemini → JSON → `JSON.parse` no painel → `executeScript` (MAIN world) preenchendo os campos do prontuário. O comportamento é **não determinístico** e se manifesta de três formas:

1. A transcrição funciona e todos os campos são preenchidos.
2. O LLM/preenchimento cobre apenas parte dos campos.
3. Erro de parse do JSON no painel ("IA não retornou JSON válido").

O diagnóstico identificou causas independentes em quatro camadas. Itens marcados **[confirmado]** foram verificados no código, na doc ou por reprodução; **[hipótese]** exigem validação no navegador (ver seção 9).

### 1.1 Erro de parse do JSON

- **[confirmado] JSON de erro montado com `format!`** — `src/lib.rs`:
  `format!("{{\"error\": \"Erro na IA: {:?}\"}}", e)`. O `Debug` de `JsValue` produz `JsValue("...")` (wasm-bindgen `lib.rs:1336`), com aspas literais dentro de uma string JSON. O resultado é sempre JSON inválido (reproduzido em Node). Todo erro de rede/API vira "JSON inválido" no painel e a causa real fica oculta; o ramo `estruturado.error` do `panel.js` é praticamente inalcançável.
- **[confirmado] Status HTTP e metadados ignorados** — `gemini_client.rs` não checa `res.status()`, `promptFeedback.blockReason` nem `candidates[].finishReason`. Um 429/503 (`{"error":{...}}`) desserializa com `candidates: None` e cai em "formato desconhecido". `MAX_TOKENS`, `SAFETY` e `RECITATION` não são distinguidos.
- **[confirmado] Só a última part é lida** — `.and_then(|mut p| p.pop())`. Respostas com várias parts, ou cuja última part não tenha `text`, perdem conteúdo ou geram erro.
- **[confirmado] JSON só por prompt** — não há `responseMimeType`/schema. O modelo pode responder com prosa, cercas de código ou JSON truncado. O `.replace("```", "")` é frágil e corrompe texto que contenha crases.

### 1.2 Preenchimento parcial dos campos

- **[confirmado] Sem schema, tipos livres** — o modelo pode devolver array/objeto em vez de string (ex.: `conduta` como lista). `valorAInserir.trim()` (`panel.js`) lança `TypeError`, e como está dentro de `forEach`, **aborta o laço** e os campos seguintes não são preenchidos.
- **[confirmado no código, hipótese no navegador] Setter nativo errado** — `panel.js` usa `Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value") || ...HTMLInputElement...`. O `||` nunca troca para o input; chamar o setter de textarea em `<input type="text">` lança `TypeError: Illegal invocation`, o que também aborta o `forEach`. O seletor inclui `input[type="text"]`.
- **[confirmado] Falha silenciosa** — o painel exibe "Finalizado ✓" incondicionalmente, mesmo com 0 campos preenchidos ou exceção no script injetado (o `.then` do `executeScript` resolve mesmo assim).
- **[confirmado] Heurística de contexto contaminada** — `querySelector('label'|'legend')` em ancestrais devolve o primeiro label do subárvore (não o do campo); `className` (com classes geradas por emotion/MUI) entra no contexto e pode conter `"cid"` por acaso; keywords amplas (`"cid"`, `"medicament"`); sem normalização de acento. Tratado em `dom-selector-resilience`; aqui só se cobre o mínimo de contenção (R13–R15).
- **[hipótese, alta probabilidade] Transcrição incompleta na origem** — `content_script.js`:
  - não há `recognition.onend` com reinício; o modo `continuous` do Chrome encerra sozinho (silêncio, `no-speech`, `network`) enquanto a UI segue em "Gravando";
  - `STOP_RECORDING` faz `recognition.onresult = null` e `START_RECORDING` nunca restaura, então a 2ª gravação na mesma sessão de página não captura nada;
  - o Web Speech captura só o microfone local (voz do médico); a fala do paciente depende de fone/alto-falante.
- **[confirmado] Aba errada** — `getVercelTab()` usa `tabs[0]` de qualquer `*.vercel.app`.

### 1.3 Outros achados

- `backupDiv.innerHTML` recebe texto do LLM (injeção de HTML); deveria usar `textContent`.
- `estruturar_prontuario` envia a transcrição crua ao Gemini sem passar pelo `Sanitizer` (PII falada: nome, CPF).
- `GEMINI_API_KEY` é embutida no `.wasm` em tempo de compilação e trafega na query string (extraível por quem tiver a extensão).

## 2. Objetivos

- Eliminar o erro de parse do JSON como classe de falha: o Rust **sempre** devolve JSON válido e tipado, e erros chegam ao painel com causa legível.
- Garantir que o resultado do LLM tenha sempre as 4 chaves como strings, via schema no lado da API e validação no lado do Rust.
- Distinguir, para o médico e nos logs, "o LLM não tinha informação" de "a injeção falhou" e de "a transcrição foi interrompida".
- Impedir que a falha em um campo impeça o preenchimento dos demais.
- Reduzir a perda de transcrição (reinício automático, 2ª gravação funcional).
- Manter o backup textual (`backupScribe`) como rede de segurança em qualquer cenário.

## 3. Não-objetivos

- Reescrever o matching de labels/`label[for]`/detecção de ambiguidade/centralização de seletores: pertence a `dom-selector-resilience` (R1–R11). Esta spec só adiciona contenção de falha por campo.
- Trocar o motor de STT (Web Speech) por captura de áudio + transcrição server-side (ver seção 8).
- Mover a API key para um backend/proxy (registrado como risco; tratar em spec própria).
- Alterar `chamar_gemini` usado pelo chat (`responder_chat`) além do estritamente necessário para compartilhar o cliente HTTP (ver R5).

## 4. Cenários de usuário

1. **Como médico**, quando a API do Gemini está sobrecarregada, eu quero que a extensão tente novamente e, se falhar, me diga "IA indisponível, tente de novo" com a transcrição preservada, e não "JSON inválido".
2. **Como médico**, ao terminar a consulta, eu quero ver quantos campos foram preenchidos e quais não foram (e por quê: vazio na fala vs. campo não encontrado), em vez de um "Finalizado ✓" genérico.
3. **Como médico**, numa consulta longa ou com pausa, eu quero que a gravação continue capturando fala e que eu seja avisado se o microfone parou.
4. **Como médico**, ao gravar uma segunda consulta sem recarregar a página, eu quero que a transcrição funcione como na primeira.
5. **Como mantenedor**, eu quero testes automatizados que cubram respostas reais problemáticas do Gemini (503, `MAX_TOKENS`, multi-part, tipos errados) sem depender da rede.

## 5. Requisitos funcionais (EARS)

### 5.1 Cliente Gemini (`gemini_client.rs`)

- **R1:** QUANDO a resposta HTTP não for 2xx, O SISTEMA DEVE retornar um erro tipado contendo o status e `error.message` do corpo (quando presente), sem tentar interpretá-la como resposta de sucesso.
- **R2:** QUANDO `promptFeedback.blockReason` estiver presente, ou `candidates` estiver vazio/ausente, O SISTEMA DEVE retornar erro tipado `Bloqueado(reason)` / `SemCandidatos`.
- **R3:** O SISTEMA DEVE aceitar o texto somente se `finishReason == "STOP"`. QUANDO for `MAX_TOKENS`, `SAFETY`, `RECITATION` ou outro, DEVE retornar erro tipado com o valor recebido.
- **R4:** O SISTEMA DEVE extrair o texto concatenando, em ordem, o `text` de **todas** as parts do primeiro candidato cuja flag `thought` não seja `true`. Parts sem `text` são ignoradas. QUANDO o texto resultante for vazio, DEVE retornar erro `RespostaVazia`.
- **R5:** O cliente DEVE aceitar um `GenerationConfig` opcional (`response_mime_type`, `response_json_schema`, `thinking_config`, `max_output_tokens`). O chat (`responder_chat`) DEVE continuar funcionando sem configuração (comportamento atual).
- **R6:** QUANDO o status for 429, 500, 502, 503 ou 504, ou a requisição falhar por erro de rede, O SISTEMA DEVE repetir até 2 vezes (3 tentativas no total) com backoff exponencial (~500 ms, ~1500 ms) e jitter. Demais erros 4xx NÃO devem ser repetidos. Como o WASM não tem `tokio::time`, o atraso DEVE usar `setTimeout` via `web-sys`/`gloo-timers` (ver R27 sobre dependências).
- **R7:** O erro final DEVE ser um `enum` Rust (`GeminiError`) com `Display` em português legível; conversão para `JsValue` só na borda do `wasm_bindgen`. O corpo bruto da resposta DEVE ir apenas para `console.error`, nunca embutido em strings de erro exibidas ao usuário.

### 5.2 Saída estruturada (`lib.rs` — `estruturar_prontuario`)

- **R8:** A chamada DEVE enviar `generationConfig.responseMimeType = "application/json"` e `generationConfig.responseJsonSchema` com objeto de 4 propriedades `string` (`anamnese`, `observacoes`, `hipotese`, `conduta`), todas em `required`. NÃO DEVE usar o campo `responseSchema` (deprecated).
- **R9:** A instrução de comportamento DEVE ir em `systemInstruction` e a transcrição no `contents`, para separar instrução de dado (mitiga injeção via fala/transcrição). O prompt DEVE deixar de pedir "sem markdown/sem ```json" (o schema garante o formato) e manter: ignorar saudações/conversas paralelas, não inventar informação ausente, string vazia para campo sem informação.
- **R10:** O modelo é Gemini 3.6 ou posterior. O SISTEMA DEVE enviar `thinkingConfig.thinkingLevel = "LOW"` (constante única, ajustável), pois o default de modelos Flash é `high` (dinâmico) e desnecessário para extração. O SISTEMA NÃO DEVE definir `temperature` (a doc do Gemini 3 recomenda manter 1.0; determinismo vem do schema e da validação). `maxOutputTokens` DEVE ser definido com folga (ex.: 8192), lembrando que o limite cobre thinking + saída.
- **R11:** QUANDO a API rejeitar `thinkingConfig` (HTTP 400 mencionando `thinking`), O SISTEMA DEVE repetir uma vez sem `thinkingConfig` e registrar aviso no console (proteção caso `GEMINI_MODEL` seja configurado para modelo anterior ao 3.x).
- **R12:** O texto retornado DEVE ser desserializado em uma struct `ProntuarioEstruturado { anamnese, observacoes, hipotese, conduta }` com `#[serde(default)]` e `String`. QUANDO a desserialização falhar, DEVE haver **um** fallback de extração (primeiro `{` até o último `}`) antes de retornar erro `JsonInvalido`. O código NÃO DEVE mais remover crases do texto.
- **R12a:** A função pública `estruturar_prontuario` DEVE retornar sempre uma `String` JSON produzida com `serde_json` (nunca `format!`), com um dos formatos: `{"ok":true,"data":{...4 chaves...}}` ou `{"ok":false,"error":{"kind":"...","message":"..."}}`. `kind` ∈ `config`, `rede`, `indisponivel`, `bloqueado`, `truncado`, `vazio`, `invalido`. Todas as strings DEVEM ser escapadas pelo serializador.
- **R12b:** QUANDO a API key estiver ausente/placeholder, O SISTEMA DEVE retornar `{"ok":false,"error":{"kind":"config",...}}`, e NÃO o texto de aviso solto que hoje `chamar_gemini` retorna como se fosse sucesso (isso hoje seria "parseado" como resposta do LLM).

### 5.3 Painel — consumo e preenchimento (`panel.js`)

- **R13:** O painel DEVE tratar o envelope de R12a: em `ok:false`, exibir `error.message` por `kind` (ex.: `indisponivel` → "IA indisponível no momento. Sua transcrição foi mantida — tente novamente."), manter a transcrição na tela e oferecer botão **Tentar novamente** que reenvia a mesma transcrição sem regravar. NÃO DEVE existir mais o ramo "IA não retornou JSON válido" para falhas de API.
- **R14:** O script injetado (`world: "MAIN"`) DEVE tratar cada campo em `try/catch` independente; uma exceção em um campo NÃO DEVE interromper os demais. Só DEVE processar valores `typeof === "string"`; qualquer outro tipo é registrado como campo rejeitado.
- **R15:** O setter nativo DEVE ser escolhido pelo tipo do elemento: `HTMLTextAreaElement.prototype` para `<textarea>`, `HTMLInputElement.prototype` para `<input>`, com fallback para `el.value = ...`.
- **R16:** O script injetado DEVE **retornar** (via `result` do `executeScript`, consolidando todos os frames) um relatório por campo clínico: `preenchido` | `vazio_na_fala` | `campo_nao_encontrado` | `erro(<mensagem>)`. Campo com valor vazio vindo do LLM é `vazio_na_fala` e NÃO é erro.
- **R17:** O status final DEVE refletir o relatório: "Finalizado ✓ 4/4", "Parcial: 3/4 — não encontrado: Conduta; sem informação na fala: Observações", ou erro. "Finalizado ✓" NÃO DEVE aparecer quando `preenchidos == 0` a partir de campos não vazios. Este relatório também DEVE ser acrescentado ao `backupScribe`.
- **R18:** `backupScribe` DEVE ser montado com `textContent`/`createElement` (sem `innerHTML` para texto do LLM).
- **R19:** `getVercelTab()` DEVE preferir a aba ativa da janela atual cujo host seja `teleatendimento.vercel.app` (`chrome.tabs.query({active:true, currentWindow:true, url:...})`), com fallback para a primeira aba desse host; DEVE ignorar demais `*.vercel.app`. Se houver mais de uma candidata e nenhuma ativa, DEVE avisar o usuário em vez de escolher silenciosamente.
- **R20:** O envio a `estruturar_prontuario` DEVE ser protegido contra concorrência (botão desabilitado / flag `emProcessamento` enquanto uma chamada está em andamento) e contra timeout: se a chamada Wasm não responder em 45 s, exibir erro `rede` e manter a transcrição.

### 5.4 Transcrição (`content_script.js`)

- **R21:** ENQUANTO `gravando == true`, QUANDO `recognition.onend` disparar, O SISTEMA DEVE reiniciar o reconhecimento (com pequeno atraso e limite de reinícios consecutivos sem resultado, ex.: 5), preservando `transcricaoAcumulada`.
- **R22:** `recognition.onerror` DEVE notificar o painel (`action: "SCRIBE_STATUS"`) para erros `network`, `audio-capture`, `not-allowed` e `service-not-allowed` (bloqueantes: exibir aviso e parar de reiniciar). `no-speech` e `aborted` são tratados como transitórios (apenas reinício).
- **R23:** O SISTEMA NÃO DEVE zerar `recognition.onresult` em `STOP_RECORDING`. A guarda `gravando` já impede novos dados. O handler DEVE ser permanente, e cada `START_RECORDING` DEVE começar com `transcricaoAcumulada = ""`.
- **R24:** QUANDO `STOP_RECORDING` for recebido, O SISTEMA DEVE devolver no `sendResponse` a transcrição final acumulada **incluindo texto interino pendente**, e o painel DEVE usar esse valor (não o `innerText` do `<div>`) como entrada da IA. Isso remove a dependência do DOM do painel e a corrida com mensagens `UPDATE_TRANSCRIPT` em trânsito.
- **R25:** O painel DEVE indicar quando nenhuma atualização de transcrição chegou há mais de 20 s durante a gravação ("Não estou ouvindo fala — verifique o microfone"), para tornar visível o caso de captura interrompida ou microfone do paciente ausente.
- **R26:** O listener de `runtime.onMessage` do content script DEVE retornar `true` apenas nos ramos que respondem de forma assíncrona (hoje retorna `true` sempre).

### 5.5 Dependências e build

- **R27:** Novas dependências Wasm (se necessárias para R6, ex.: `gloo-timers` com feature `futures`) DEVEM ser adicionadas ao `Cargo.toml` com versão explícita e mantidas compatíveis com `wasm32-unknown-unknown`. O binário `.wasm` gerado NÃO deve crescer perceptivelmente (perfil `opt-level = "z"` mantido).

## 6. Requisitos não funcionais

- **NFR1 — Privacidade (LGPD):** nenhuma mudança pode aumentar o dado enviado ao Gemini. Logs de console NÃO DEVEM imprimir o corpo bruto completo da resposta clínica em produção; logar tamanho, status e `finishReason`. (Decisão sobre sanitizar a transcrição fica em aberto, seção 8.)
- **NFR2 — Segurança clínica:** na dúvida, não preencher; nenhum fallback deve escrever conteúdo em campo por adivinhação. O texto estruturado sempre permanece visível no backup.
- **NFR3 — Latência:** no caminho feliz, a latência deve ser igual ou menor que a atual (thinking `LOW` reduz). Retries só ocorrem em falha; o pior caso (3 tentativas) deve ficar abaixo do timeout de 45 s de R20.
- **NFR4 — Compatibilidade:** o chat (`responder_chat`) e `processar_historico` não podem mudar de comportamento observável.
- **NFR5 — Observabilidade:** cada execução do Escriba DEVE registrar no console um resumo estruturado com tag `[Copiloto][Scribe]`: tamanho da transcrição, nº de tentativas, `finishReason`, tokens (se `usageMetadata` presente), relatório por campo de R16.

## 7. Plano de implementação (ordem sugerida)

| # | Entrega | Requisitos | Risco |
|---|---------|-----------|-------|
| 1 | `GeminiError`, checagem de status/`blockReason`/`finishReason`, extração multi-part, `GenerationConfig` opcional | R1–R5, R7 | Baixo |
| 2 | Envelope JSON com `serde_json` + struct tipada + schema + `systemInstruction` + `thinkingLevel` | R8–R12b | Médio (validar schema aceito por 3.6) |
| 3 | Retry/backoff com timer Wasm | R6, R11, R27 | Médio (dep. de timer) |
| 4 | Painel: consumo do envelope, retry manual, timeout, guarda de concorrência, `textContent`, `getVercelTab` | R13, R18–R20 | Baixo |
| 5 | Injeção: `try/catch` por campo, setter correto, relatório e status | R14–R17 | Baixo |
| 6 | Transcrição: reinício, `onresult` permanente, transcrição no `sendResponse`, aviso de silêncio | R21–R26 | Médio (comportamento do Chrome) |
| 7 | Testes e fixtures | seção 8 | Baixo |

Cada item deve ser um commit atômico e revisável isoladamente. Os itens 1–2 já eliminam o erro de parse; 4–5 eliminam o preenchimento parcial silencioso; 6 ataca a perda de transcrição.

## 8. Testes e critérios de aceite

### 8.1 Rust (`cargo test`, sem rede)

Separar a lógica pura do I/O (função `interpretar_resposta(status, corpo) -> Result<String, GeminiError>` e `parse_prontuario(&str)`), testando com fixtures JSON:

- [ ] 200 com uma part de texto → texto.
- [ ] 200 com várias parts (texto dividido; part `thought:true`; part final sem `text`) → concatenação correta.
- [ ] 200 com `finishReason: MAX_TOKENS` → `Truncado`.
- [ ] 200 com `promptFeedback.blockReason` e sem `candidates` → `Bloqueado`.
- [ ] 429 e 503 com `{"error":{...}}` → `Indisponivel`, marcado como *retryable*; 400 → não *retryable*.
- [ ] `parse_prontuario`: JSON completo; chaves ausentes (default `""`); tipo errado (array em `conduta`) → `invalido`; texto com prosa ao redor → fallback `{...}`; texto com crases preservado.
- [ ] Serialização do envelope: mensagem de erro contendo aspas, quebras de linha e `\u{...}` produz JSON válido (teste de regressão do bug de `format!`).
- [ ] API key ausente → `kind: "config"`.

### 8.2 JS (manual guiado + teste unitário do injetor, se viável com jsdom)

- [ ] Formulário com `<input type="text">` de CID antes dos `<textarea>`: todos os campos são preenchidos (regressão do `Illegal invocation`).
- [ ] `conduta` como valor não-string: os demais campos preenchem e o relatório marca `erro`.
- [ ] Nenhum campo encontrado: status "0/4", backup completo visível.
- [ ] Segunda gravação sem recarregar a página: transcrição atualiza normalmente.
- [ ] Silêncio > 60 s durante a gravação: reconhecimento reinicia e o texto anterior é preservado.
- [ ] Duas abas `*.vercel.app` abertas: usa a de `teleatendimento.vercel.app`.
- [ ] Simular 503 (bloquear host no DevTools/offline): mensagem legível, transcrição mantida, botão "Tentar novamente" funciona.

### 8.3 Critérios de aceite gerais

- [ ] Nenhum caminho de erro de `estruturar_prontuario` produz JSON inválido (garantido por teste).
- [ ] O painel nunca mostra "Finalizado ✓" quando nenhum campo não vazio foi preenchido.
- [ ] Exceção em um campo não impede o preenchimento dos demais.
- [ ] Relatório por campo (R16) visível ao médico e no console.
- [ ] `cargo test`, `cargo clippy` e o build Wasm (`wasm-pack`/pipeline atual) passam.
- [ ] O chat continua funcionando (teste manual de regressão).

## 9. Riscos e questões em aberto

- **Nome/valores exatos no 3.6:** validar em ambiente real que `thinkingLevel: "LOW"` é aceito por `gemini-3.6-flash` e se `MINIMAL` é suficiente (mais barato/rápido). R11 cobre modelos que rejeitem o campo.
- **Suporte a `responseJsonSchema` no 3.6:** o discovery doc lista `responseJsonSchema` em `GenerationConfig` e marca `responseSchema` como deprecated; confirmar na prática, e manter `propertyOrdering` se o modelo exigir.
- **Hipóteses de transcrição (1.2):** o reinício automático e o microfone do paciente precisam ser confirmados com logs em consultas reais antes de considerar o item 6 "resolvido". Se o microfone do paciente for o problema dominante, a solução real é captura de áudio da aba/Jitsi + STT server-side, fora do escopo desta spec (candidata a spec própria).
- **Sanitização da transcrição (LGPD):** decidir se a transcrição passa por um `Sanitizer` (CPF por regex é viável; nome próprio falado não) ou se se aceita o envio como está com base no contrato/DPA vigente com o provedor. Requer decisão de produto/jurídico.
- **API key no cliente:** a chave embutida é extraível. Solução (proxy com autenticação/limite por usuário) exige backend e está fora do escopo; registrar como dívida de segurança prioritária.
- **Retry em UI bloqueada:** o retry acontece dentro do Wasm assíncrono; validar que não congela o painel (deve ser 100% assíncrono/`await`).
- **Duplicidade com `dom-selector-resilience`:** a contenção por campo (R14–R17) sobrepõe parcialmente R6/R8 daquela spec; ao implementar, alinhar para que o relatório de R16 seja a base do indicador de R5 (`dom-selector-resilience`).
