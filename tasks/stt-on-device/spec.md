# Spec: Motor de transcrição contínua com reinício automático e Cloud → On-Device (SODA)

- **Status:** Implementado na branch `feat/stt-engine-restart-on-device` (on-device opt-in até o spike)
- **Autor:** Edson Moreira
- **Data:** 2026-10-16
- **Componentes afetados:** `extension/scripts/content_script.js`, novo `extension/scripts/stt_engine.js`, `extension/manifest.json`, `extension/ui/panel.js`, `tests/js/`
- **Relacionada a:** `tasks/scribe-reliability/spec.md` (R21–R26). Esta spec **detalha e substitui R21 e R22** (reinício e tratamento de erros) e acrescenta o modo on-device. R23–R26 continuam valendo.
- **Origem:** rascunho `SPEC-STT-001` (motor híbrido em Rust/Wasm). Seção 3 registra o que foi aproveitado, ajustado e descartado.

## 1. Contexto / Problema

A transcrição do Escriba AI roda em `content_script.js` com `webkitSpeechRecognition` (`continuous`, `interimResults`, `pt-BR`), no navegador do médico, dentro da página do teleatendimento. Hoje:

- **Não há reinício.** Não existe `recognition.onend`: o Chrome encerra a sessão sozinho (silêncio longo, `no-speech`, `network`, limite de tempo do serviço) enquanto o painel segue em "Gravando". Consultas longas ou com pausa perdem transcrição sem aviso (hipótese já registrada em `scribe-reliability` §1.2).
- **Erros são só logados.** `onerror` não informa o painel nem diferencia erro transitório de bloqueante.
- **Todo áudio vai para a nuvem do Google.** O Chrome moderno oferece reconhecimento on-device (pacote de idioma SODA) via `processLocally`, `SpeechRecognition.available()` e `SpeechRecognition.install()`. Para uma aplicação de saúde, processar localmente reduz exposição de dado sensível e elimina dependência de rede.

### 1.1 O que já está implementado e deve ser preservado

Commits recentes (`c914030`, `fix/reset-recording-on-appointment-change`) introduziram comportamentos que o motor novo **não pode regredir**:

- `CANCEL_RECORDING`: aborta, zera o acumulado e ignora áudio residual (troca de atendimento).
- `STOP_RECORDING` não zera `onresult`; a 2ª gravação transcreve normalmente.
- Guarda `gravando` para ignorar áudio residual.
- Testes em `tests/js/content-script-gravacao.test.mjs` (roda o `content_script.js` real em `vm` com `webkitSpeechRecognition` falso).

## 2. Objetivos

- A gravação continua capturando fala por toda a consulta (> 15 min), atravessando encerramentos do reconhecedor, sem perder o texto já acumulado.
- Começar a gravar imediatamente, sem configuração: se o pacote on-device não estiver pronto, iniciar na nuvem e migrar para local quando disponível.
- Nunca entrar em laço de reinício sem limite e sem *backoff*; erros bloqueantes chegam ao painel.
- Mostrar ao médico em qual modo a transcrição está rodando (local/nuvem).
- Manter a lógica testável sem navegador (mesma estratégia de `vm` + fakes).

## 3. Análise do rascunho SPEC-STT-001

### 3.1 Aproveitado

- Máquina de estados Cloud → Local com troca de modo **somente no `onend`** (nunca no meio de uma frase).
- Início imediato na nuvem quando o modelo é `downloadable`, com `install()` em segundo plano.
- Reinício transparente em `onend` com *fallback* de 150 ms se `start()` lançar `InvalidStateError`.
- *Downgrade* local → nuvem em `language-not-supported` / `service-not-allowed`.
- Acúmulo apenas de resultados `isFinal`; interino efêmero.
- Cenários BDD (§9), adaptados.

### 3.2 Ajustado (o rascunho tinha lacunas ou erros)

| Ponto do rascunho | Problema | Tratamento nesta spec |
|---|---|---|
| Implementação em Rust/Wasm | O STT vive no **content script** (página de terceiros, `<all_urls>`). O Wasm do projeto é carregado no **painel lateral**. Levar o Wasm (~1 MB) para o content script exige `web_accessible_resources` e instanciar Wasm sob a CSP de cada página; o painel não é lugar confiável para `SpeechRecognition` (permissão de microfone da origem da extensão). O núcleo útil (shim JS) já contém quase toda a lógica; o Rust seria só uma máquina de ~100 linhas. | **Descartado.** Motor em JS puro (§4). |
| RF-04 "texto só na memória do Rust" | Não traz ganho: o texto atravessa a fronteira como `String` a cada evento (cópia), e a consulta tem poucas dezenas de KB. | Acúmulo em variável do content script, como hoje. |
| RNF-01 (`Closure` sem `forget`, `Drop`) | Específico de FFI Wasm; no rascunho o `Drop` também não removia os handlers do JS, então um `onend` posterior chamaria `Closure` já liberado ("closure invoked after being dropped"). | Equivalente em JS: `dispose()` remove handlers e aborta (R14). |
| Reinício sem limite | `network` (ex.: Brave, que não alcança o serviço do Google) ou `audio-capture` gerariam laço infinito `onend → start → erro`. | Backoff e limite de **ciclos falhos** (R7–R9). |
| `service-not-allowed` sempre vira "nuvem" | Se já está na nuvem, é erro bloqueante, não *downgrade*; além disso, sem trava, `available()` poderia religar o local e alternar para sempre. | R11 (trava `localBloqueado` por sessão). |
| `onerror` ignora `network`/`audio-capture` | Falha invisível para o médico. | R12 notifica o painel. |
| Sem `CANCEL`, sem guarda de geração | `await available()` abre janela em que um STOP/CANCEL chega e depois o `start()` dispara mesmo assim. | Token de geração (R3). |
| `stop()` + `Idle` imediato, `onresult` ignorado após o stop | Perde as últimas palavras (o Chrome entrega o resultado final depois do `stop()`). | STOP gracioso (R15). |
| Estado `downloading` tratado como `downloadable` | Chamaria `install()` repetidas vezes. | `install()` no máximo 1× por sessão de página (R5). |
| `install()` como única fonte de "modelo pronto" | Há relato de `install()` que nunca resolve e `available()` preso em `downloading` (issue no Brave). | Reconsultar `available()` a cada reinício (R6). |
| "User Gesture" (RF-01) | O clique ocorre no **painel**; o content script recebe uma mensagem (`START_RECORDING`), sem ativação transitória na página. O fluxo atual já funciona assim. | Requisito removido; não depender de gesto. |
| `on_status_cb` / `onStatusChange` | Nunca é chamado (código morto). | Removido; status vai por `SCRIBE_STATUS` (R12). |
| `ui_observer.call3` dentro de `borrow_mut` | Reentrância (a UI chama `get_full_transcript` → panic). | N/A em JS; registrado para não reaparecer se o motor for portado. |

### 3.3 Premissas do rascunho **não verificadas** (viram itens do spike, §10)

- Limite de "~14m20s" da nuvem e "~8–15 s" de `no-speech`: não encontrado em documentação; tratar como observação empírica a confirmar. O motor **não depende** desses números.
- Disponibilidade de **pt-BR** on-device no Chrome: a documentação do Edge lista `pt-PT`, não `pt-BR`; é preciso confirmar no Chrome-alvo.
- Qualidade do on-device vs nuvem para vocabulário clínico (pode ser **pior**; ver §10).

## 4. Não-objetivos

- Reescrever o motor em Rust/Wasm (descartado em §3.2).
- Captura da fala do paciente (áudio da aba/Jitsi) ou STT server-side. O Web Speech só captura o microfone local; segue como candidato a spec própria (ver `scribe-reliability` §9).
- Eliminar a perda de áudio no intervalo entre `onend` e o novo `start()` (o Chrome reabre o microfone; ver R8 e §8 NFR2).
- Pós-processamento de pontuação do texto on-device.
- Sanitização/LGPD do texto enviado ao Gemini (pertence a `scribe-reliability`).

## 5. Cenários de usuário

1. **Como médico**, numa consulta de 40 minutos, quero que a gravação nunca "morra" sozinha e que o texto do início continue na tela.
2. **Como médico**, ao ficar 3 minutos em silêncio examinando o paciente, quero que a gravação retome sozinha quando eu voltar a falar, sem erro na tela.
3. **Como médico** num Chrome recém-instalado, quero apertar "Gravar" e já ser transcrito, sem esperar download.
4. **Como médico**, quero saber se estou em modo local ou nuvem, e ser avisado de forma clara se o microfone/serviço falhou.
5. **Como mantenedor**, quero testes automatizados dos ciclos de reinício, troca de modo e erros, sem navegador.

## 6. Arquitetura

- Novo arquivo `extension/scripts/stt_engine.js`, carregado **antes** de `content_script.js` no `content_scripts[].js` do manifest. Expõe uma fábrica (`criarMotorStt(opcoes)`) em namespace único do mundo isolado (ex.: `globalThis.__copilotoStt`).
- `content_script.js` mantém só a cola: recebe `START/STOP/CANCEL_RECORDING`, instancia o motor, repassa `onTexto` / `onStatus` via `chrome.runtime.sendMessage`.
- O motor recebe por injeção: construtor de reconhecimento, `setTimeout`/`clearTimeout`, relógio (`now`), e `contextoValido()` — para testar sem navegador.
- Reutiliza **uma** instância de reconhecimento por sessão de página, com handlers permanentes (R23 de `scribe-reliability`); cada `start` cria uma **geração** nova.

### 6.1 Estados

`parado` → `ouvindo_nuvem` | `ouvindo_local` → (`reiniciando` transitório) → `ouvindo_*` → `parando` → `parado`; `erro` (terminal até novo START).

| Estado | Evento | Próximo | Ação |
|---|---|---|---|
| `parado` | `START` + `available`=`available` | `ouvindo_local` | `processLocally=true`, `start()` |
| `parado` | `START` + `downloadable` ou `downloading` | `ouvindo_nuvem` | `processLocally=false`, `start()`, `install()` (1× por página) |
| `parado` | `START` + `unavailable`/erro/timeout da consulta | `ouvindo_nuvem` | `processLocally=false`, `start()` |
| `ouvindo_*` | `onend`, gravando, sem erro bloqueante | `reiniciando` → `ouvindo_*` | reconsulta `available` (se na nuvem e `!localBloqueado`), aplica modo, `start()` |
| `ouvindo_nuvem` | `install` resolve `true` / `available` passa a `available` | `ouvindo_nuvem` | `localPronto=true` (vale no próximo `onend`) |
| `ouvindo_local` | `onerror` `language-not-supported`/`service-not-allowed` | `ouvindo_nuvem` | `localPronto=false`, `localBloqueado=true`, avisa painel |
| `ouvindo_nuvem` | `onerror` `service-not-allowed` | `erro` | bloqueante |
| `ouvindo_*` | `onerror` `not-allowed` / `audio-capture` | `erro` | bloqueante |
| `ouvindo_*` | `onerror` `no-speech` / `aborted` | (mesmo) | transitório; o `onend` seguinte reinicia |
| `ouvindo_*` | `onerror` `network` / outros | (mesmo) | conta como ciclo falho (R8) |
| `ouvindo_*` | `STOP` | `parando` → `parado` | R15 |
| qualquer | `CANCEL` | `parado` | `abort()`, zera acumulado, invalida geração |

## 7. Requisitos funcionais (EARS)

Prefixo `S` para não colidir com a numeração de `scribe-reliability`.

### 7.1 Início e modo

- **S1:** QUANDO `START_RECORDING` for recebido, O SISTEMA DEVE zerar o acumulado, incrementar a geração e iniciar o reconhecimento. A resposta a `sendResponse` NÃO DEVE esperar a consulta de disponibilidade.
- **S2:** O SISTEMA DEVE consultar `SpeechRecognition.available({langs:['pt-BR'], processLocally:true})` com *timeout* de 300 ms. Se a API não existir, lançar, ou estourar o *timeout*, DEVE tratar como `unavailable` (nuvem). A ausência da API NÃO DEVE gerar exceção para a camada de UI.
- **S3:** ENTRE a consulta e o `start()`, O SISTEMA DEVE conferir se a geração ainda é a atual; se `STOP`/`CANCEL`/novo `START` ocorreu, NÃO DEVE iniciar.
- **S2a:** O modo on-device é **opt-in** até o spike validar `pt-BR`: SÓ DEVE consultar `available()`/`install()` se `chrome.storage.local.sttModo === 'auto'` (padrão: ausente = só nuvem). Habilitar: `chrome.storage.local.set({ sttModo: 'auto' })` no console da extensão.
- **S4:** O SISTEMA DEVE definir `processLocally` apenas se a propriedade existir (`'processLocally' in recognition`).

### 7.2 Hot-swap Cloud → Local

- **S5:** QUANDO o status for `downloadable` ou `downloading`, O SISTEMA DEVE iniciar na nuvem e chamar `SpeechRecognition.install(...)` **no máximo uma vez por carga de página**. A promessa NÃO DEVE bloquear nada; rejeição é ignorada (com `console.warn`).
- **S6:** ENQUANTO o `install()` estiver pendente, O SISTEMA DEVE reconsultar `available()` a cada 5 s em segundo plano (sem atrasar nenhum `start()`) e usar o resultado — e não apenas o resolve de `install()` — para decidir `localPronto`. Isto cobre `install()` que nunca resolve. O `onend` só lê o último valor conhecido, o que mantém S8 síncrono.
- **S7:** A troca de modo DEVE ocorrer somente no `onend`; NUNCA interromper uma sessão ativa para trocar.

### 7.3 Reinício e erros

- **S8:** ENQUANTO `gravando`, QUANDO `onend` disparar, O SISTEMA DEVE chamar `start()` **de forma síncrona dentro do `onend`** (sem timer) para minimizar o intervalo. SE `start()` lançar (ex.: `InvalidStateError`), DEVE repetir após 150 ms (uma tentativa por ciclo; falha repetida conta como ciclo falho).
- **S9:** Um **ciclo falho** é um ciclo que termina com erro diferente de `no-speech`/`aborted`, ou que dura menos de 500 ms sem nenhum resultado. O SISTEMA DEVE aplicar *backoff* entre ciclos falhos consecutivos (150 ms, 500 ms, 1 s, 2 s, 2 s…) e, ao atingir **5 ciclos falhos consecutivos**, parar de reiniciar, ir para `erro` e notificar o painel. Qualquer resultado (interino ou final) zera o contador.
- **S10:** Ciclos que terminam em `no-speech` NÃO DEVEM contar como falha nem ter limite: silêncio de minutos é normal (cenário 2). *Isto corrige a cláusula "limite de reinícios consecutivos sem resultado" de R21 de `scribe-reliability`, que bloquearia pausas longas.*
- **S11:** QUANDO ocorrer `language-not-supported` ou `service-not-allowed` **em modo local**, O SISTEMA DEVE fazer *downgrade* para nuvem e ligar `localBloqueado` pelo resto da carga de página (sem nova tentativa local, para não alternar em laço). Em modo nuvem, `service-not-allowed` é bloqueante.
- **S12:** O SISTEMA DEVE enviar ao painel `{action:"SCRIBE_STATUS", status, motivo?}` com `status` ∈ `ouvindo_local`, `ouvindo_nuvem`, `erro`, `parado`, ao iniciar, a cada troca de modo e em erro bloqueante (`motivo` ∈ `permissao_negada`, `microfone`, `servico_indisponivel`, `rede`, `nao_suportado`, `desconhecido`). Erros transitórios NÃO DEVEM gerar mensagem visual.
- **S13:** ANTES de cada reinício e de cada `sendMessage`, O SISTEMA DEVE verificar `contextoValido()` (`chrome.runtime?.id`). SE a extensão foi recarregada (script órfão), DEVE parar de reiniciar e liberar o reconhecimento.
- **S14:** `dispose()` DEVE remover os handlers, chamar `abort()` e cancelar timers pendentes; é chamado ao receber `CANCEL_RECORDING` quando o motor não será reutilizado, e em `pagehide`.

### 7.4 Parada e acúmulo

- **S15:** QUANDO `STOP_RECORDING` for recebido, O SISTEMA DEVE chamar `stop()` (não `abort()`), continuar aceitando resultados até `onend` ou até 1500 ms, e só então responder `sendResponse({status:"stopped", transcript})` com acumulado + interino pendente (alinhado com R24 de `scribe-reliability`). Após isso, resultados são ignorados.
- **S16:** `CANCEL_RECORDING` DEVE manter o comportamento atual: `abort()` imediato, acumulado zerado, geração invalidada, nenhum resultado residual aceito.
- **S17:** Apenas resultados `isFinal` DEVEM ser acrescentados ao acumulado (com `trim()` + espaço); o interino é enviado ao painel mas nunca persistido. O acumulado NÃO DEVE ser alterado por reinícios, trocas de modo ou erros.
- **S18:** Resultados de uma geração antiga (handlers de uma sessão anterior) DEVEM ser descartados.

### 7.5 Painel

- **S19:** O painel DEVE exibir um indicador discreto do modo ("Local" / "Nuvem") a partir de `SCRIBE_STATUS`, e uma mensagem clara e acionável em `erro` (ex.: `permissao_negada` → "Permita o microfone para este site"). Em `erro`, o texto acumulado DEVE permanecer visível e utilizável.

## 8. Requisitos não funcionais

- **NFR1 — Latência de reinício:** o `start()` ocorre no mesmo *tick* do `onend` (S8). O Chrome ainda leva algum tempo para reabrir o microfone; fala nesse intervalo pode se perder. Aceito; medir no spike (§10).
- **NFR2 — Sem vazamento:** nenhum timer ou handler sobrevive a `dispose()`/`CANCEL`; sem laço de reinício após erro bloqueante ou contexto inválido.
- **NFR3 — Privacidade (LGPD):** em modo local o áudio não sai do dispositivo; em modo nuvem segue para o serviço do Google, como hoje. A UI DEVE deixar o modo visível (S19). Nenhum log DEVE imprimir texto transcrito.
- **NFR4 — Degradação graciosa:** navegador sem `available`/`install`/`processLocally`, ou sem o pacote `pt-BR`, opera 100% em nuvem com reinício automático e sem exceção para a UI. Sem `webkitSpeechRecognition`: `SCRIBE_STATUS erro` com motivo `nao_suportado` e mensagem de navegador não suportado.
- **NFR5 — Observabilidade:** log `[Copiloto][Scribe]` com tag, modo, nº do ciclo, duração do ciclo, motivo do fim e contador de ciclos falhos (sem conteúdo clínico).
- **NFR6 — Compatibilidade:** `CANCEL_RECORDING`, 2ª gravação e demais mensagens permanecem com o contrato atual.

## 9. Testes e critérios de aceite

Estender o *harness* de `tests/js/content-script-gravacao.test.mjs`: o `FakeRecognition` ganha métodos estáticos `available`/`install` (configuráveis, com promessa que nunca resolve), propriedade `processLocally`, e helpers `terminar()` (dispara `onend`) e `errar(code)`. O motor recebe relógio/timers injetáveis, para testar *backoff* sem esperar.

- [ ] **Reinício:** `onend` com `gravando` chama `start()` no mesmo *tick*; o acumulado anterior permanece e o texto novo é concatenado (cenário 14 min).
- [ ] **Silêncio longo:** 20 ciclos `errar('no-speech')` + `terminar()` → 20 reinícios, sem `SCRIBE_STATUS erro`, acumulado intacto (cenário pausa).
- [ ] **Início por disponibilidade:** `available` → `processLocally=true`; `downloadable` → `false` + `install` 1×; `downloading` → `false` e **sem** nova chamada de `install`; `unavailable`/lançar/*timeout* → `false`.
- [ ] **Hot-swap:** em `downloadable`, `install` resolve `true`; o `start()` seguinte ao `onend` usa `processLocally=true` e `SCRIBE_STATUS ouvindo_local`; acumulado preservado. Variante: `install` nunca resolve, mas `available` passa a `available` no próximo `onend` → também migra (S6).
- [ ] **Downgrade:** em local, `errar('language-not-supported')` + `terminar()` → reinicia em nuvem, `localBloqueado`, e **não** volta ao local mesmo com `available` positivo.
- [ ] **Bloqueantes:** `not-allowed`, `audio-capture`, `service-not-allowed` (nuvem) → `SCRIBE_STATUS erro` com motivo, sem reinício.
- [ ] **Ciclos falhos:** 5× `errar('network')` + `terminar()` → *backoff* crescente e, no 5º, `erro`/`rede`; um resultado entre os erros zera o contador.
- [ ] **`start()` lançando:** primeira chamada lança → retry após 150 ms.
- [ ] **Corrida:** `STOP`/`CANCEL` durante o `await available()` → nenhum `start()` depois.
- [ ] **STOP gracioso:** resultado final chegando após `STOP` e antes do `onend` entra no `transcript` devolvido; resultado depois disso é ignorado. (Altera o teste atual "áudio que chega depois de parar é ignorado": ele passa a valer só após o `onend`/1500 ms.)
- [ ] **CANCEL / 2ª gravação:** testes existentes continuam passando sem alteração.
- [ ] **Contexto inválido:** `contextoValido()=false` → sem novo `start()`.
- [ ] **Resultado de geração antiga** é descartado.
- [ ] Manual (Chrome real): consulta ≥ 20 min contínua; cenário de Chrome limpo com migração; navegador sem o pacote; Brave (nuvem inacessível → erro de rede exibido, sem laço).

## 10. Plano de implementação

| # | Entrega | Requisitos | Risco |
|---|---------|-----------|-------|
| 0 | **Spike manual** no Chrome-alvo do consultório (§11) | — | Define se o modo local entra por padrão |
| 1 | `stt_engine.js` com reinício, backoff, erros, geração, STOP/CANCEL gracioso, e testes (sem on-device) | S1, S3, S7–S10, S12–S18 | Médio |
| 2 | On-device: `available`/`install`, hot-swap, downgrade, travas | S2, S4–S6, S11 | Médio (comportamento do Chrome) |
| 3 | Painel: indicador de modo e mensagens de erro | S19 | Baixo |

Commits atômicos. O item 1 sozinho já resolve a perda de transcrição; o item 2 só é ligado por padrão após o spike.

## 11. Riscos e questões em aberto

- **Spike (item 0), a medir no Chrome-alvo:** (a) `available()` para `pt-BR` retorna algo diferente de `unavailable`? (a doc do Edge lista só `pt-PT`); (b) `install()` exige ativação de usuário ou resolve sem ela no content script; (c) tamanho e tempo do download; (d) `install()` trava ou `available()` fica em `downloading`; (e) duração real de uma sessão na nuvem e da latência entre `onend` e o áudio voltar a ser capturado; (f) comparação de qualidade local × nuvem em frases clínicas (medicamentos, CID, doses).
- **Qualidade vs privacidade (decisão de produto):** se o local for pior em termos clínicos, "migrar sempre que disponível" pode piorar o prontuário. Proposta: flag em `chrome.storage` (`sttModo`: `auto` | `nuvem`), default `auto` somente se o spike aprovar `pt-BR`; senão default `nuvem` com o código de hot-swap pronto e desligado.
- **Download silencioso:** `install()` baixa um pacote na máquina do médico sem ação dele. Confirmar com TI/segurança da SESA se é aceitável em ambiente gerenciado.
- **Perda no intervalo do reinício:** inevitável com Web Speech; só uma captura própria de áudio (MediaRecorder + STT) elimina. Fora do escopo.
- **Brave/Chromium sem serviço do Google:** cairá em `erro/rede` após 5 ciclos; a mensagem deve orientar a usar o Chrome.
- **Conflito com `scribe-reliability` R21:** a cláusula de "limite de reinícios sem resultado" deve ser reescrita para referenciar S9/S10; atualizar aquela spec ao implementar.
- **R25 (aviso de 20 s sem transcrição)** convive com S10: silêncio legítimo não é erro; o aviso é só informativo e não deve parar o motor.
