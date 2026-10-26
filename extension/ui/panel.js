import init, { responder_chat, processar_historico, estruturar_prontuario } from '../pkg/acesso_saude_ce_copiloto.js';
import { criarDetectorDeTroca } from './troca-atendimento.js';

let resumoJson = null;

// Escriba: cada reinício por troca de atendimento incrementa a "geração". Um
// pararEPreencher que começou antes do reinício compara a sua geração e se
// descarta, em vez de escrever a transcrição de um atendimento no outro.
let geracaoEscriba = 0;
let resetEscribaPendente = Promise.resolve();
const atendimentoMudou = criarDetectorDeTroca();
const STATUS_INICIAL_ESCRIBA = document.getElementById('scribeStatus').innerHTML;



function mensagemErro(err) {
  const txt = String(err?.message ?? err);
  if (/503|UNAVAILABLE|high demand/i.test(txt)) return "A IA está com uma alta demanda. Tente novamente em breve...";
  if (/429|RESOURCE_EXHAUSTED/i.test(txt)) return "Limite de requisições atingido. Tente novamente em breve...";
  if (/401|403|api key/i.test(txt)) return "Problema com a chave da API. Tente novamente em breve...";
  if (/failed to fetch|network/i.test(txt)) return "Sem conexão com a internet.";
  return "Não foi possível obter resposta da IA. Tente novamente.";
}

// Erros do Escriba chegam do Rust como {kind, message}; o kind é estável, o texto não.
function mensagemErroEscriba(erro) {
  switch (erro?.kind) {
    case 'rede': return "Sem conexão com a internet.";
    case 'config': return "Problema com a configuração da IA (chave ou modelo). Avise o suporte.";
    case 'bloqueado': return "A IA não pôde processar esta transcrição.";
    case 'truncado': return "A resposta da IA foi cortada. Tente novamente.";
    case 'vazio':
    case 'invalido': return "A IA não retornou um prontuário válido. Tente novamente.";
    default: return mensagemErro(erro?.message); // indisponivel: 503/429 pelo texto
  }
}

async function inicializar() {
  chrome.runtime.connect({ name: 'painel' }); // Conseguir indexar a conexão

  const resumoDiv = document.getElementById('resumoBox');

  try {
    resumoDiv.innerHTML = "<p>Carregando motor Wasm...</p>";
    // Inicializa o módulo WebAssembly apenas no Side Panel, fugindo dos bloqueios de segurança do site original
    await init('../pkg/acesso_saude_ce_copiloto_bg.wasm');
  } catch (e) {
    console.error("Erro Wasm:", e);
    resumoDiv.innerHTML = `<p style='color:red;'>Erro ao iniciar Wasm: ${e.message || e}</p>`;
    return;
  }

  resumoDiv.innerHTML = "<p>Wasm carregado. Monitorando a tela...</p>";

  // Função que puxa o texto bruto extraído da tela, processa no RUST e mostra na tela
  function verificarDadosDaTela() {
    chrome.storage.local.get(['dadosBrutosDaTela'], (result) => {
      if (chrome.runtime.lastError) {
        resumoDiv.innerHTML = `<p style='color:red;'>Erro no storage: ${chrome.runtime.lastError.message}</p>`;
        return;
      }

      if (result && result.dadosBrutosDaTela) {
        try {
          // CHAMA O RUST AQUI NO SIDE PANEL
          const resumoObj = processar_historico(result.dadosBrutosDaTela);

          // Salva como String JSON pra enviar pro LLM depois
          resumoJson = JSON.stringify(resumoObj);

          resumoDiv.innerHTML = `
            <strong>Paciente:</strong> ${resumoObj.paciente_id}<br/>
            <strong>Idade:</strong> ${resumoObj.paciente_idade ? `${resumoObj.paciente_idade} anos` : 'Desconhecida'}<br/>
            <strong>Atendimentos:</strong> ${resumoObj.total_atendimentos}<br/>
            <strong>Último Diagnóstico:</strong> ${resumoObj.ultimo_diagnostico || 'Nenhum'}<br/>
          `;

          if (document.querySelectorAll('.message.bot').length === 0) {
            addMessage("bot", "Olá, Doutor(a). O histórico foi processado (PII removido). Como posso ajudar?");
          }
        } catch (err) {
          console.error("Erro no processar_historico (Rust):", err);
          resumoJson = null;
          resumoDiv.innerHTML = `<p style='color:red;'>Erro na Engine Wasm: ${err.message || err}</p>`;
        }
      } else {
        resumoJson = null;
        resumoDiv.innerHTML = `
          <p style='color:orange;'>
            Nenhum histórico encontrado.<br>
            Acesse um paciente na página de <strong>agendamentos</strong>.
          </p>`;
      }
    });
  }

  // Verifica imediatamente
  verificarDadosDaTela();

  // Fica verificando a cada 1 segundo (Caso o médico clique em outro paciente na página web)
  chrome.storage.onChanged.addListener(() => {
    verificarDadosDaTela();
  });

  document.getElementById('sendBtn').addEventListener('click', handleSend);
  document.getElementById('chatInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleSend();
  });

  // Eventos do Escriba AI (Gravação)
  document.getElementById('btnRecord').addEventListener('click', iniciarEscuta);
  document.getElementById('btnStop').addEventListener('click', pararEPreencher);
}

async function getVercelTab() {
  // A mesma proteção que adicionei em pararEPreencher deve estar em getVercelTab
  try {
    const tabs = await chrome.tabs.query({ url: "*://*.vercel.app/*" }); // Mais flexível
    return tabs.length > 0 ? tabs[0] : null;
  } catch (e) {
    console.error("[Copiloto] Erro em getVercelTab:", e);
    return null;
  }
}

// ============================================
// ESCRIBA AI - Lógica de Gravação
// ============================================

async function iniciarEscuta() {
  console.log("[Copiloto] Clique no botão Gravar disparado!");
  await resetEscribaPendente; // evita que o CANCEL de um reinício recente alcance esta nova gravação
  resetTimer();
  try {
    const btnRecord = document.getElementById('btnRecord');
    const btnStop = document.getElementById('btnStop');

    // Força a troca de display e das classes explicitamente
    if (btnRecord) btnRecord.style.display = 'none';
    if (btnStop) btnStop.style.display = 'flex';

    document.getElementById('scribeStatus').innerText = "Gravando... Fale normalmente.";

    const oldBackup = document.getElementById('backupScribe');
    if (oldBackup) oldBackup.remove(); // Limpa o backup da consulta anterior

    const divTranscript = document.getElementById('scribeTranscript');
    if (divTranscript) {
      divTranscript.style.display = 'block';
      divTranscript.innerText = "Aguardando áudio...";
    }

    const tab = await getVercelTab();
    if (tab) {
      console.log("[Copiloto] Enviando comando START para a aba Vercel:", tab.id);
      chrome.tabs.sendMessage(tab.id, { action: "START_RECORDING" }).catch((e) => console.log("Aviso de msg:", e));
    } else {
      document.getElementById('scribeStatus').innerHTML = "<span style='color:red'>Aba Vercel não encontrada para gravar.</span>";
    }

    // Só adiciona se não tiver pra não duplicar eventos
    if (!chrome.runtime.onMessage.hasListener(ouvinteTranscricao)) {
      chrome.runtime.onMessage.addListener(ouvinteTranscricao);
    }
  } catch (error) {
    console.error("[Copiloto] Erro grave em iniciarEscuta:", error);
  }
}

// Texto de um CID sugerido: { busca, nome } (ou string solta)
const nomeDoCid = (c) => typeof c === 'string' ? c : ((c && (c.nome || c.busca)) || '');

function ouvinteTranscricao(request) {
  if (request.action === "UPDATE_TRANSCRIPT") {
    const divTranscript = document.getElementById('scribeTranscript');
    if (divTranscript) {
      divTranscript.innerText = request.text;
      divTranscript.scrollTop = divTranscript.scrollHeight;
    }
  }
}

// Descarta a gravação, a transcrição e o resultado do atendimento anterior e
// devolve o Escriba ao estado inicial. Chamado quando o médico troca de card.
function resetarEscriba() {
  geracaoEscriba++;

  if (chrome.runtime.onMessage.hasListener(ouvinteTranscricao)) {
    chrome.runtime.onMessage.removeListener(ouvinteTranscricao);
  }

  resetTimer();
  const btnStop = document.getElementById('btnStop');
  const btnRecord = document.getElementById('btnRecord');
  if (btnStop) btnStop.style.display = 'none';
  if (btnRecord) btnRecord.style.display = 'flex';

  document.getElementById('scribeStatus').innerHTML = STATUS_INICIAL_ESCRIBA;

  const divTranscript = document.getElementById('scribeTranscript');
  if (divTranscript) {
    divTranscript.innerText = "";
    divTranscript.style.display = 'none';
  }

  const backup = document.getElementById('backupScribe');
  if (backup) backup.remove();

  // Para o microfone no content script e zera o que ele acumulou
  resetEscribaPendente = (async () => {
    try {
      const tab = await getVercelTab();
      if (tab) await chrome.tabs.sendMessage(tab.id, { action: "CANCEL_RECORDING" });
    } catch (e) {
      console.warn("[Copiloto] Aviso ao cancelar gravação:", e.message || e);
    }
  })();
  return resetEscribaPendente;
}

async function pararEPreencher() {
  console.log("[Copiloto] Clique no botão PARAR disparado!");
  const geracao = geracaoEscriba;

  const btnStop = document.getElementById('btnStop');
  const btnRecord = document.getElementById('btnRecord');
  if (btnStop) btnStop.style.display = 'none';
  if (btnRecord) btnRecord.style.display = 'flex';

  // Remove o listener de atualizações textuais usando a API certa de extensões
  if (chrome.runtime.onMessage.hasListener(ouvinteTranscricao)) {
    chrome.runtime.onMessage.removeListener(ouvinteTranscricao);
  }

  const scribeTransElement = document.getElementById('scribeTranscript');
  const textoDaTela = scribeTransElement ? scribeTransElement.innerText : "";

  try {
    const tab = await getVercelTab();
    if (tab) {
      document.getElementById('scribeStatus').innerHTML = "<strong>Passo 1/3:</strong> Desligando microfone...";
      console.log("[Copiloto] Enviando STOP_RECORDING para a Vercel...");

      let conexaoAtiva = true;
      await chrome.tabs.sendMessage(tab.id, { action: "STOP_RECORDING" }).catch((e) => {
        console.warn("[Copiloto] Aviso no STOP:", e.message);
        // Se o content script morreu (Extension context invalidated), não tentamos enviar o formulário para ele.
        if (e.message.includes("Extension context invalidated")) conexaoAtiva = false;
      });

      if (geracao !== geracaoEscriba) return; // trocou de atendimento: já foi reiniciado

      if (!conexaoAtiva) {
        document.getElementById('scribeStatus').innerHTML = `<span style="color:red">Aba desconectada. Dê F5 na página e tente de novo.</span>`;
        return;
      }

      if (textoDaTela && textoDaTela.trim() !== "" && textoDaTela !== "Aguardando áudio...") {
        if (scribeTransElement) scribeTransElement.innerText = textoDaTela;
        if (scribeTransElement) scribeTransElement.scrollTop = scribeTransElement.scrollHeight;

        document.getElementById('scribeStatus').innerHTML = "<strong>Passo 2/3:</strong> IA Estruturando Prontuário (Pode levar até 15s)...";
        console.log("[Copiloto] Enviando texto para o Wasm/LLM:", textoDaTela);

        // Chama a Engine RUST para estruturar o texto em JSON Clínico
        const jsonResultStr = await estruturar_prontuario(textoDaTela);
        console.log("[Copiloto] Resposta DEVOLVIDA pelo Rust/LLM:", jsonResultStr);

        // O médico pode ter trocado de atendimento enquanto a IA respondia: descartar,
        // para não escrever o prontuário de um paciente no formulário de outro.
        if (geracao !== geracaoEscriba) {
          console.warn("[Copiloto] Atendimento mudou durante o processamento; resultado descartado.");
          return;
        }

        // Envelope do Rust: {ok:true,data:{...}} | {ok:false,error:{kind,message}}
        let envelope;
        try {
          envelope = JSON.parse(jsonResultStr);
        } catch (parseError) {
          console.error("[Copiloto] Envelope do Wasm não é JSON:", jsonResultStr);
          document.getElementById('scribeStatus').textContent = "Erro interno: resposta inesperada do motor Wasm. Olhe o Console.";
          return;
        }

        if (!envelope.ok) {
          const erro = envelope.error || {};
          console.error("[Copiloto] O Rust devolveu um erro de IA:", erro.kind, erro.message);
          document.getElementById('scribeStatus').textContent = mensagemErroEscriba(erro);
          return;
        }

        const estruturado = envelope.data;

        // ==========================================
        // BACKUP IMEDIATO: Mostra na tela ANTES de injetar
        // ==========================================
        console.log("[Copiloto] Criando visualização de Backup...");
        const backupDiv = document.createElement('div');
        backupDiv.style.marginTop = "15px";
        backupDiv.style.padding = "10px";
        backupDiv.style.backgroundColor = "#fff";
        backupDiv.style.borderRadius = "8px";
        backupDiv.style.border = "2px solid #28a745";
        backupDiv.innerHTML = `
                <strong style="color:#28a745">Resumo IA Concluído!</strong><br/>
                <span style="font-size:0.8rem; color:#666">Se os campos não preencheram sozinhos, copie os textos abaixo:</span><br/>
                <div style="margin:10px 0; padding:8px 10px; border-radius:6px; background:#fff3cd; border:1px solid #ffecb5; color:#664d03; font-size:0.8rem">
                  <strong>⚠ Atenção:</strong> a IA pode errar. É necessária a revisão do profissional antes de salvar o prontuário.
                </div>
                <strong>Anamnese:</strong> <br/>${estruturado.anamnese || "N/A"}<br/><br/>
                <strong>Hipótese:</strong> <br/>${estruturado.hipotese || "N/A"}<br/><br/>
                <strong>CID:</strong> <br/>${(estruturado.cids || []).map(nomeDoCid).join('<br/>') || "N/A"}<br/><br/>
                <strong>Conduta:</strong> <br/>${estruturado.conduta || "N/A"}<br/><br/>
                <strong>Observações:</strong> <br/>${estruturado.observacoes || "N/A"}
              `;

        const container = document.getElementById('scribeBox');
        const oldBackup = document.getElementById('backupScribe');
        if (oldBackup) oldBackup.remove();
        backupDiv.id = 'backupScribe';
        if (container) container.appendChild(backupDiv);

        const scrollContainer = document.querySelector('.container');
        if (scrollContainer) scrollContainer.scrollTop = scrollContainer.scrollHeight;

        // EXECUTANDO DIRETO DO PAINEL NO MAIN WORLD (Bypass Supremo de CSP e IFrames)
        // EXECUTANDO DIRETO DO PAINEL NO MAIN WORLD (Bypass Supremo de CSP e IFrames)
        document.getElementById('scribeStatus').innerHTML = "<strong>Passo 3/3:</strong> Injetando na tela do Vercel...";
        console.log("[Copiloto] Iniciando injeção via chrome.scripting.executeScript com allFrames: true...");

        // Define window.__copilotoCid (escolha da opção do campo de CID) em todos os frames
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          world: "MAIN",
          files: ['scripts/cid_match.js']
        }).catch((e) => console.warn("[Copiloto] Não foi possível carregar cid_match.js:", e));

        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          world: "MAIN",
          func: async function (dados) {
            const esperar = (ms) => new Promise(r => setTimeout(r, ms));

            // Campo de busca do CID (MUI Autocomplete múltiplo): digita `busca` (termo curto, porque o
            // campo filtra por trecho do nome), espera a busca do sistema e clica na opção que melhor
            // corresponde a `nome` (nome completo; ver scripts/cid_match.js). Sem correspondência não
            // clica em nada (nunca cai na primeira opção) e o campo é limpo. Devolve se algum CID foi marcado.
            async function preencherAutocomplete(input, busca, nome = busca) {
              const texto = busca;
              const fecharLista = () => {
                const proto = window.HTMLInputElement.prototype;
                const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
                if (descriptor && descriptor.set) descriptor.set.call(input, ''); else input.value = '';
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape', code: 'Escape' }));
                input.blur();
              };

              // Digita para disparar a busca, mas sem blur: o blur fecharia a lista antes das opções chegarem
              input.focus();
              const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
              if (descriptor && descriptor.set) descriptor.set.call(input, texto); else input.value = texto;
              input.dispatchEvent(new Event('input', { bubbles: true }));

              const listaId = input.getAttribute('aria-controls');
              const buscarOpcoes = () => {
                const lista = (listaId && document.getElementById(listaId)) || document.querySelector('[role="listbox"]');
                return lista ? Array.from(lista.querySelectorAll('[role="option"]')) : [];
              };

              const melhorOpcao = (opcoes) => {
                if (!window.__copilotoCid || opcoes.length === 0) return null;
                const i = window.__copilotoCid.escolher(opcoes.map(op => op.innerText || op.textContent), busca, nome);
                return i >= 0 ? opcoes[i] : null;
              };

              // A lista padrão (sem filtro) também aparece antes da busca responder, então não basta
              // ela existir: só vale a opção que corresponde ao termo; sem correspondência, espera
              // a lista parar de mudar antes de desistir.
              const inicio = Date.now();
              let opcao = null;
              let assinatura = '';
              let mudouEm = inicio;
              while (Date.now() - inicio < 5000) {
                await esperar(150);
                const opcoes = buscarOpcoes();
                opcao = melhorOpcao(opcoes);
                if (opcao) break;

                const atual = opcoes.map(o => o.textContent).join('|');
                if (atual !== assinatura) { assinatura = atual; mudouEm = Date.now(); }
                const estavel = Date.now() - mudouEm >= 1500;
                const semOpcoes = document.querySelector('.MuiAutocomplete-noOptions');
                if (estavel || (semOpcoes && Date.now() - inicio >= 1500)) break; // dá tempo ao debounce da busca
              }

              if (opcao) {
                console.log("[Copiloto-MainWorld] CID selecionado:", opcao.innerText, "<-", nome);
                opcao.click();
                await esperar(300); // deixa o chip entrar e a lista fechar antes do próximo CID
                return true;
              }
              console.warn("[Copiloto-MainWorld] Nenhum CID correspondente a:", nome, "(busca: " + busca + ") - fechando a lista.");
              fecharLista();
              return false;
            }

            // Escreve no campo disparando os eventos que o React/MUI do frontend escuta
            function escreverValor(el, valor) {
              el.focus();
              const proto = el.tagName.toLowerCase() === 'textarea'
                ? window.HTMLTextAreaElement.prototype
                : window.HTMLInputElement.prototype;
              const descriptor = Object.getOwnPropertyDescriptor(proto, "value");

              if (descriptor && descriptor.set) {
                descriptor.set.call(el, valor);
              } else {
                el.value = valor;
              }

              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'a' }));
              el.blur();
            }

            // A conduta fica num aninhamento do frontend que a heurística abaixo não alcança:
            // buscamos direto pelo id/name do campo. Aceita string, array ou objeto vindo do LLM.
            let condutaPreenchida = false;
            const semCid = [];
            let campoCidEncontrado = false;
            const condutaBruta = dados.conduta;
            const valorConduta = !condutaBruta ? '' :
              typeof condutaBruta === 'string' ? condutaBruta.trim() :
              Array.isArray(condutaBruta)
                ? condutaBruta.map(i => (typeof i === 'object' ? JSON.stringify(i) : String(i))).join('\n').trim()
                : JSON.stringify(condutaBruta, null, 2).trim();

            if (valorConduta) {
              const campoConduta = document.getElementById('prontuario-conduct')
                || document.querySelector('textarea[name="conduct"]');
              if (campoConduta) {
                console.log("[Copiloto-MainWorld] Escrevendo conduta por id/name em", campoConduta.id || campoConduta.name);
                escreverValor(campoConduta, valorConduta);
                condutaPreenchida = true;
              } else {
                console.warn("[Copiloto-MainWorld] Campo da conduta não encontrado por id/name; usando heurística.");
              }
            }

            const textareas = Array.from(document.querySelectorAll('textarea, input[type="text"]'));

            for (const ta of textareas) {
              if (ta.style.visibility === 'hidden') continue;

              let contextoOriginal = `${ta.placeholder || ""} ${ta.name || ""} ${ta.id || ""} ${ta.className || ""}`;
              let textoAoSedor = "";

              let pai = ta.parentElement;
              for (let i = 0; i < 4; i++) {
                if (pai) {
                  const legend = pai.querySelector('legend');
                  if (legend) textoAoSedor += " " + legend.innerText;

                  const label = pai.querySelector('label');
                  if (label) textoAoSedor += " " + label.innerText;

                  if (pai.innerText && pai.innerText.length < 100) {
                    textoAoSedor += " " + pai.innerText;
                  }
                  pai = pai.parentElement;
                }
              }

              let contextoLimpo = (contextoOriginal + " " + textoAoSedor).toLowerCase();
              console.log(`[Copiloto-MainWorld] CAIXA AVALIADA: id="${ta.id || 'vazio'}" | placeholder="${ta.placeholder || 'vazio'}" | contexto="${contextoLimpo}"`);

              let valorAInserir = null;
              let ehCampoHipotese = false;
              if (contextoLimpo.includes("conduta") || contextoLimpo.includes("prescriç") || contextoLimpo.includes("encaminhamento") || contextoLimpo.includes("medicament")) {
                // Caixa "Conduta" (já preenchida por id/name acima, quando encontrada)
                valorAInserir = condutaPreenchida ? null : valorConduta;
              } else if (contextoLimpo.includes("suspeita") || (contextoLimpo.includes("hipótese") && contextoLimpo.includes("diagnóstica")) || contextoLimpo.includes("cid")) {
                // Caixa "Hipótese Diagnóstica"
                valorAInserir = dados.hipotese;
                ehCampoHipotese = true;
              } else if (contextoLimpo.includes("observações") && contextoLimpo.includes("clínicas")) {
                // Caixa "Observações Clínicas"
                valorAInserir = dados.observacoes;
              } else if (contextoLimpo.includes("anamnese") || contextoLimpo.includes("queixas")) {
                // Caixa "Anamnese"
                valorAInserir = dados.anamnese;
              }

              const ehAutocomplete = ta.classList.contains('MuiAutocomplete-input') || !!ta.closest('.MuiAutocomplete-root');

              // Campo de CID: um termo por diagnóstico (lista do modelo), cada um buscado no sistema
              if (ehAutocomplete && ehCampoHipotese) {
                // Cada item é { busca, nome }; aceita também uma string solta
                const cids = (Array.isArray(dados.cids) ? dados.cids : [])
                  .map(c => typeof c === 'string' ? { busca: c, nome: c } : { busca: c && c.busca, nome: c && c.nome })
                  .map(c => ({ busca: String(c.busca || c.nome || '').trim(), nome: String(c.nome || c.busca || '').trim() }))
                  .filter(c => c.busca !== '');
                campoCidEncontrado = true;
                for (const cid of cids) {
                  console.log("[Copiloto-MainWorld] Buscando CID:", cid.busca, "->", cid.nome);
                  if (!await preencherAutocomplete(ta, cid.busca, cid.nome)) semCid.push(cid.nome);
                }
                continue;
              }

              if (valorAInserir && valorAInserir.trim() !== "") {
                console.log("[Copiloto-MainWorld] Escrevendo:", valorAInserir, "no campo", ta.id || "sem-id");

                if (ehAutocomplete) {
                  await preencherAutocomplete(ta, valorAInserir.trim());
                } else {
                  escreverValor(ta, valorAInserir);
                }
              }
            }

            return { semCid, campoCidEncontrado };
          },
          args: [estruturado]
        }).then((resultados) => {
          console.log("[Copiloto] executeScript finalizado com sucesso!");

          // Avisa quais CIDs a IA sugeriu mas não foram marcados no formulário
          const cids = (estruturado.cids || []).map(nomeDoCid);
          const frames = (resultados || []).map(r => r && r.result).filter(Boolean);
          const campoEncontrado = frames.some(r => r.campoCidEncontrado);
          const semCid = !cids.length ? [] : campoEncontrado ? [...new Set(frames.flatMap(r => r.semCid))] : cids;
          if (semCid.length) {
            const aviso = document.createElement('div');
            aviso.style.cssText = "margin-top:8px; padding:6px 8px; border-radius:6px; background:#fff3cd; color:#664d03; font-size:0.8rem";
            aviso.innerHTML = `<strong>CID não marcado automaticamente</strong> (busque manualmente):<br/>${semCid.join('<br/>')}`;
            const backup = document.getElementById('backupScribe');
            if (backup) backup.appendChild(aviso);
          }
        }).catch((e) => {
          console.error("[Copiloto] ERRO CRÍTICO no executeScript:", e);
        });

        document.getElementById('scribeStatus').innerHTML = `<span style="color:green"><strong>Finalizado! ✓</strong> Verifique os campos.</span>`;

      } else {
        console.warn("[Copiloto] Parou mas não tinha texto válido na tela.");
        document.getElementById('scribeStatus').innerText = "Nenhum áudio válido capturado.";
      }
    } else {
      document.getElementById('scribeStatus').innerHTML = `<span style="color:red">Aba de atendimento não encontrada.</span>`;
    }
  } catch (err) {
    console.error("[Copiloto] Erro Geral no preenchimento:", err);
    if (geracao !== geracaoEscriba) return;
    document.getElementById('scribeStatus').textContent = mensagemErro(err);
  }
}

// ============================================
// CHATBOT - Lógica
// ============================================

async function handleSend() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();

  if (!text) return;

  addMessage("user", text);
  input.value = "";

  const btn = document.getElementById('sendBtn');
  btn.disabled = true;

  if (resumoJson) {
    const typingId = "typing-" + Date.now();
    addMessage("bot", "Processando com IA (Liisa)...", typingId);

    try {
      // Chama o Rust/Wasm assíncrono para conversar com o LLM passando o contexto
      const resposta = await responder_chat(resumoJson, text);

      // O Rust devolve erros como texto normal (não lança exceção), então detectamos pelo prefixo
      if (/^Erro na (comunicação com a )?IA/i.test(resposta)) {
        throw resposta;
      }

      document.getElementById(typingId).innerHTML = resposta.replace(/\n/g, '<br>');
    } catch (err) {
      console.error("[Copiloto] Erro na IA:", err);
      document.getElementById(typingId).textContent = mensagemErro(err);
    }
  } else {
    addMessage("bot", "Sem contexto clínico disponível.");
  }

  btn.disabled = false;
}

function addMessage(sender, text, id = null) {
  const container = document.getElementById('chatContainer');
  const msgDiv = document.createElement('div');
  msgDiv.className = `message ${sender}`;
  msgDiv.innerHTML = text; // Permite HTML básico como <br> e cores
  if (id) msgDiv.id = id;

  container.appendChild(msgDiv);
  container.scrollTop = container.scrollHeight;
}
// Remove as mensagens da tela quando o paciente muda
function limparChat() {
  document.querySelectorAll('.message').forEach(msg => msg.remove());
}

// Reage sempre que o content script grava dados novos no storage
chrome.storage.onChanged.addListener((changes) => {
  if (!changes.dadosBrutosDaTela) return;

  if (!changes.dadosBrutosDaTela.newValeu) {
    resetarEscriba();
    limparChat();
    return;
  }

  const antigo = JSON.parse(changes.dadosBrutosDaTela.oldValue || '{}');
  const novo = JSON.parse(changes.dadosBrutosDaTela.newValue || '{}');

  if (atendimentoMudou(antigo.id_atendimento, novo.id_atendimento)) {
    resetarEscriba();
    limparChat();
  }
});

// Função para mostrar ou ocultar a caixa de escrita
function mostrarEscriba(visivel) {
    const box = document.getElementById('scribeBox');

    box.style.display = visivel ? '' : 'none';
}

// Diz se a URL é a da videochamada, onde o Escriba deve aparecer
function urlDoEscriba(url) {
  return url?.includes('teleatendimento.vercel.app/video-conference');
}

// Mostra ou oculta a caixa de escrita dependendo da URL da aba do teleatendimento
chrome.storage.session.get('urlTeleatendimento', ({ urlTeleatendimento }) => {
  mostrarEscriba(urlDoEscriba(urlTeleatendimento));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area == 'session' && changes.urlTeleatendimento) {
    mostrarEscriba(urlDoEscriba(changes.urlTeleatendimento.newValue));
  }
});


document.addEventListener("DOMContentLoaded", inicializar);

//Timer do gravador
var minutesLabel = document.getElementById("minutes");
var secondsLabel = document.getElementById("seconds");
var totalSeconds = 0;
setInterval(setTime, 1000);

function setTime() {
  ++totalSeconds;
  secondsLabel.innerHTML = pad(totalSeconds % 60);
  minutesLabel.innerHTML = pad(parseInt(totalSeconds / 60));
}

function pad(val) {
  var valString = val + "";
  if (valString.length < 2) {
    return "0" + valString;
  } else {
    return valString;
  }
}

function resetTimer() {
  totalSeconds = 0;
  secondsLabel.innerHTML = "00";
  minutesLabel.innerHTML = "00";
}
