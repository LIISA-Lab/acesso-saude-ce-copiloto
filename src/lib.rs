mod domain;
mod infrastructure;
mod services;

use crate::domain::patient::Historico;
use crate::infrastructure::gemini_client::chamar_chat;
use crate::infrastructure::langfuse_client;
use crate::services::escriba::estruturar_prontuario_json;
use crate::services::prompts::{
    AVISO_PERGUNTA_LONGA, limpar_saida, pedido_chat, pergunta_longa, scores_chat,
};
use crate::services::sanitizer::Sanitizer;
use crate::services::summarizer::Summarizer;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

// Habilita mensagens de panic detalhadas no console do navegador
#[wasm_bindgen(start)]
pub fn main_js() -> Result<(), JsValue> {
    console_error_panic_hook::set_once();
    Ok(())
}

/// Inicia uma nova sessão de telemetria (um atendimento). O id é aleatório: nenhum dado
/// do paciente vai para o Langfuse como identificador. Devolve o id da sessão.
#[wasm_bindgen]
pub fn nova_sessao_telemetria() -> String {
    let id = langfuse_client::novo_trace_id();
    langfuse_client::definir_sessao(Some(id.clone()));
    id
}

/// Recebe o JSON do histórico capturado no DOM, sanitiza e gera um resumo clínico
#[wasm_bindgen]
pub fn processar_historico(json_dom: &str) -> Result<JsValue, JsValue> {
    // 1. Parsing do JSON de entrada (simulando a leitura do DOM via content script)
    let mut historico: Historico = serde_json::from_str(json_dom)
        .map_err(|e| JsValue::from_str(&format!("Erro de parsing: {}", e)))?;

    // 2. Sanitização (Remover PII para LGPD)
    Sanitizer::sanitizar_historico(&mut historico);

    // 3. Geração do Resumo Clínico
    let resumo = Summarizer::gerar_resumo(&historico);

    // 4. Converter de volta para JS
    let js_resumo = serde_wasm_bindgen::to_value(&resumo)
        .map_err(|e| JsValue::from_str(&format!("Erro ao converter resposta: {}", e)))?;

    Ok(js_resumo)
}

/// Interface de Chat que responde a perguntas baseadas no contexto (resumo clínico) integrando com o Gemini AI
#[wasm_bindgen]
pub async fn responder_chat(contexto_resumo_json: &str, pergunta_medico: &str) -> String {
    // Busca a chave embutida do .env em tempo de compilação e limpa espaços/quebras de linha
    let gemini_api_key = dotenvy_macro::dotenv!("GEMINI_API_KEY").trim();

    let resumo_clinico: Result<crate::domain::patient::ResumoClinico, _> =
        serde_json::from_str(contexto_resumo_json);

    if let Ok(resumo) = resumo_clinico {
        if pergunta_longa(pergunta_medico) {
            return AVISO_PERGUNTA_LONGA.to_string();
        }

        let (resultado, trace_id) =
            chamar_chat(pedido_chat(&resumo, pergunta_medico), gemini_api_key).await;
        return match resultado {
            Ok(resposta) => {
                if let Some(trace_id) = trace_id {
                    langfuse_client::registrar_scores(scores_chat(&trace_id, &resposta));
                }
                limpar_saida(&resposta)
            }
            Err(e) => format!("Erro na comunicação com a IA: {}", e),
        };
    }

    "Erro ao ler o contexto do paciente. Por favor, recarregue a página.".to_string()
}

/// Recebe uma transcrição de áudio bruta, envia pro Gemini e retorna um envelope JSON (sempre válido):
/// `{"ok":true,"data":{anamnese,observacoes,hipotese,cids,conduta}}` ou `{"ok":false,"error":{kind,message}}`
#[wasm_bindgen]
pub async fn estruturar_prontuario(transcricao_bruta: &str) -> String {
    let gemini_api_key = dotenvy_macro::dotenv!("GEMINI_API_KEY").trim();

    estruturar_prontuario_json(transcricao_bruta, gemini_api_key).await
}
