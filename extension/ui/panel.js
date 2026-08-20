import init, { responder_chat, processar_historico, estruturar_prontuario } from '../pkg/acesso_saude_copilot.js';

let resumoJson = null;
let monitoramentoAtivo = null;

async function inicializar() {
  const resumoDiv = document.getElementById('resumoBox');

  try {
    resumoDiv.innerHTML = "<p>Carregando motor Wasm...</p>";
    // Inicializa o módulo WebAssembly apenas no Side Panel, fugindo dos bloqueios de segurança do site original
    await init('../pkg/acesso_saude_copilot_bg.wasm');
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
            <strong>Idade:</strong> ${resumoObj.paciente_idade} anos<br/>
            <strong>Atendimentos:</strong> ${resumoObj.total_atendimentos}<br/>
            <strong>Último Diagnóstico:</strong> ${resumoObj.ultimo_diagnostico || 'Nenhum'}<br/>
          `;

          if (document.querySelectorAll('.message.bot').length === 0) {
            addMessage("bot", "Olá, Doutor(a). O histórico foi processado (PII removido). Como posso ajudar?");
          }
        } catch (err) {
          console.error("Erro no processar_historico (Rust):", err);
          resumoDiv.innerHTML = `<p style='color:red;'>Erro na Engine Wasm: ${err.message || err}</p>`;
        }
      } else {
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
  if (monitoramentoAtivo) clearInterval(monitoramentoAtivo);
  monitoramentoAtivo = setInterval(verificarDadosDaTela, 1000);

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
      const tabs = await chrome.tabs.query({url: "*://*.vercel.app/*"}); // Mais flexível
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
  try {
    const btnRecord = document.getElementById('btnRecord');
    const btnStop = document.getElementById('btnStop');
    
    // Força a troca de display e das classes explicitamente
    if(btnRecord) btnRecord.style.display = 'none';
    if(btnStop) btnStop.style.display = 'inline-block';
    
    document.getElementById('scribeStatus').innerText = "Gravando... Fale normalmente.";

    const oldBackup = document.getElementById('backupScribe');
    if(oldBackup) oldBackup.remove(); // Limpa o backup da consulta anterior

    const divTranscript = document.getElementById('scribeTranscript');
    if(divTranscript) {
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

function ouvinteTranscricao(request) {
    if (request.action === "UPDATE_TRANSCRIPT") {
        const divTranscript = document.getElementById('scribeTranscript');
        if(divTranscript) {
            divTranscript.innerText = request.text;
            divTranscript.scrollTop = divTranscript.scrollHeight;
        }
    }
}

async function pararEPreencher() {
  console.log("[Copiloto] Clique no botão PARAR disparado!");
  
  const btnStop = document.getElementById('btnStop');
  const btnRecord = document.getElementById('btnRecord');
  if(btnStop) btnStop.style.display = 'none';
  if(btnRecord) btnRecord.style.display = 'inline-block';

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

          if (!conexaoAtiva) {
              document.getElementById('scribeStatus').innerHTML = `<span style="color:red">Aba desconectada. Dê F5 na página e tente de novo.</span>`;
              return;
          }

          if (textoDaTela && textoDaTela.trim() !== "" && textoDaTela !== "Aguardando áudio...") {
              if(scribeTransElement) scribeTransElement.innerText = textoDaTela + "\n\n[Enviando para o Gemini, aguarde...]";
              if(scribeTransElement) scribeTransElement.scrollTop = scribeTransElement.scrollHeight;

              document.getElementById('scribeStatus').innerHTML = "<strong>Passo 2/3:</strong> IA Estruturando Prontuário (Pode levar até 15s)...";
              console.log("[Copiloto] Enviando texto para o Wasm/LLM:", textoDaTela);

              // Chama a Engine RUST para estruturar o texto em JSON Clínico
              const jsonResultStr = await estruturar_prontuario(textoDaTela);
              console.log("[Copiloto] Resposta DEVOLVIDA pelo Rust/LLM:", jsonResultStr);

              let estruturado;
              try {
                  estruturado = JSON.parse(jsonResultStr);
              } catch (parseError) {
                  console.error("[Copiloto] Falha no JSON parse. A IA retornou:", jsonResultStr);
                  document.getElementById('scribeStatus').innerHTML = `<span style="color:red">Erro: IA não retornou JSON válido. Olhe o Console.</span>`;
                  return;
              }

              if (estruturado.error) {
                  console.error("[Copiloto] O Rust devolveu um erro de IA:", estruturado.error);
                  document.getElementById('scribeStatus').innerHTML = `<span style="color:red">${estruturado.error}</span>`;
                  return;
              }

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
                <span style="font-size:0.8rem; color:#666">Se os campos não preencheram sozinhos, copie os textos abaixo:</span><br/><br/>
                <strong>Anamnese:</strong> <br/>${estruturado.anamnese || "N/A"}<br/><br/>
                <strong>Hipótese:</strong> <br/>${estruturado.hipotese || "N/A"}<br/><br/>
                <strong>Conduta:</strong> <br/>${estruturado.conduta || "N/A"}<br/><br/>
                <strong>Observações:</strong> <br/>${estruturado.observacoes || "N/A"}
              `;
              
              const container = document.getElementById('scribeBox');
              const oldBackup = document.getElementById('backupScribe');
              if(oldBackup) oldBackup.remove();
              backupDiv.id = 'backupScribe';
              if(container) container.appendChild(backupDiv);
              
              const scrollContainer = document.querySelector('.container');
              if(scrollContainer) scrollContainer.scrollTop = scrollContainer.scrollHeight;

              // EXECUTANDO DIRETO DO PAINEL NO MAIN WORLD (Bypass Supremo de CSP e IFrames)
              // EXECUTANDO DIRETO DO PAINEL NO MAIN WORLD (Bypass Supremo de CSP e IFrames)
              document.getElementById('scribeStatus').innerHTML = "<strong>Passo 3/3:</strong> Injetando na tela do Vercel...";
              console.log("[Copiloto] Iniciando injeção via chrome.scripting.executeScript com allFrames: true...");

              await chrome.scripting.executeScript({
                  target: { tabId: tab.id, allFrames: true },
                  world: "MAIN",
                  func: function(dados) {
                      const textareas = Array.from(document.querySelectorAll('textarea, input[type="text"]'));

                      textareas.forEach(ta => {
                          if (ta.style.visibility === 'hidden') return;

                          let contextoOriginal = `${ta.placeholder || ""} ${ta.name || ""} ${ta.id || ""} ${ta.className || ""}`;
                          let textoAoSedor = "";
                          
                          let pai = ta.parentElement;
                          for(let i=0; i<4; i++) {
                              if(pai) {
                                  const legend = pai.querySelector('legend');
                                  if(legend) textoAoSedor += " " + legend.innerText;
                                  
                                  const label = pai.querySelector('label');
                                  if(label) textoAoSedor += " " + label.innerText;

                                  if(pai.innerText && pai.innerText.length < 100) {
                                      textoAoSedor += " " + pai.innerText;
                                  }
                                  pai = pai.parentElement;
                              }
                          }

                          let contextoLimpo = (contextoOriginal + " " + textoAoSedor).toLowerCase();
                          console.log(`[Copiloto-MainWorld] CAIXA AVALIADA: id="${ta.id || 'vazio'}" | placeholder="${ta.placeholder || 'vazio'}" | contexto="${contextoLimpo}"`);

                          let valorAInserir = null;
                          if (contextoLimpo.includes("conduta") || contextoLimpo.includes("prescriç") || contextoLimpo.includes("encaminhamento") || contextoLimpo.includes("medicament")) {
                              // Caixa "Conduta" (Colocada no topo da prioridade)
                              valorAInserir = dados.conduta;
                          } else if (contextoLimpo.includes("suspeita") || (contextoLimpo.includes("hipótese") && contextoLimpo.includes("diagnóstica")) || contextoLimpo.includes("cid")) {
                              // Caixa "Hipótese Diagnóstica"
                              valorAInserir = dados.hipotese;
                          } else if (contextoLimpo.includes("observações") && contextoLimpo.includes("clínicas")) {
                              // Caixa "Observações Clínicas"
                              valorAInserir = dados.observacoes;
                          } else if (contextoLimpo.includes("anamnese") || contextoLimpo.includes("queixas")) {
                              // Caixa "Anamnese"
                              valorAInserir = dados.anamnese;
                          }

                          if (valorAInserir && valorAInserir.trim() !== "") {
                              console.log("[Copiloto-MainWorld] Escrevendo:", valorAInserir, "no campo", ta.id || "sem-id");
                              
                              ta.focus();
                              const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value") 
                                                             || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
                              
                              if (nativeInputValueSetter) {
                                  nativeInputValueSetter.set.call(ta, valorAInserir);
                              } else {
                                  ta.value = valorAInserir;
                              }

                              ta.dispatchEvent(new Event('input', { bubbles: true }));
                              ta.dispatchEvent(new Event('change', { bubbles: true }));
                              ta.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'a' }));
                              
                              ta.blur();
                          }
                      });
                  },
                  args: [estruturado]
              }).then(() => {
                  console.log("[Copiloto] executeScript finalizado com sucesso!");
              }).catch((e) => {
                  console.error("[Copiloto] ERRO CRÍTICO no executeScript:", e);
              });

              document.getElementById('scribeStatus').innerHTML = `<span style="color:green"><strong>Finalizado! ✓</strong> Verifique os campos.</span>`;

          } else {
              console.warn("[Copiloto] Parou mas não tinha texto válido na tela.");
              document.getElementById('scribeStatus').innerText = "Nenhum áudio válido capturado na tela.";
          }
      } else {
          document.getElementById('scribeStatus').innerHTML = `<span style="color:red">Aba de atendimento não encontrada.</span>`;
      }
  } catch (err) {
      console.error("[Copiloto] Erro Geral no preenchimento:", err);
      document.getElementById('scribeStatus').innerHTML = `<span style="color:red">Erro Geral: ${err.message}</span>`;
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
      document.getElementById(typingId).innerHTML = resposta.replace(/\n/g, '<br>');
    } catch (err) {
      document.getElementById(typingId).innerHTML = `<span style="color:red">Erro na IA: ${err.message || err}</span>`;
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

document.addEventListener("DOMContentLoaded", inicializar);
