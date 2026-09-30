mod domain;
mod infrastructure;
mod services;

use crate::domain::patient::Historico;
use crate::infrastructure::gemini_client::chamar_gemini;
use crate::services::escriba::estruturar_prontuario_json;
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
        // Montar a cronologia completa de atendimentos
        let mut cronologia_consultas = String::new();
        if resumo.historico_atendimentos.is_empty() {
            cronologia_consultas.push_str("Nenhum histórico capturado ainda.\n");
        } else {
            for (i, atendimento) in resumo.historico_atendimentos.iter().enumerate() {
                cronologia_consultas.push_str(&format!(
                    "Consulta {} ({}):\n- Diagnóstico: {}\n- Conduta: {}\n- Observações: {}\n",
                    i + 1,
                    atendimento.data_hora,
                    atendimento.hipotese_diagnostica,
                    atendimento.conduta_medica,
                    atendimento
                        .observacoes_adicionais
                        .as_deref()
                        .unwrap_or("Nenhuma")
                ));
            }
        }

        // Formatar o contexto para a IA
        let prompt_contexto = format!(
            "Você é um assistente médico especialista de IA chamado Copiloto Acesso Saúde CE.\n\
             Você está ajudando um médico durante uma teleconsulta. Use APENAS as informações abaixo para responder a pergunta.\n\
             Seja conciso, profissional e direito ao ponto.\n\
             \n\
             DADOS DO PACIENTE:\n\
             Idade: {}\n\
             Total de atendimentos: {}\n\
             Alergias conhecidas: {}\n\
             \n\
             CRONOLOGIA DO HISTÓRICO DE CONSULTAS (Analise toda a evolução):\n\
             {}\n\
             \n\
             PERGUNTA DO MÉDICO: {}",
            resumo.paciente_idade,
            resumo.total_atendimentos,
            if resumo.alergias.is_empty() {
                "Nenhuma registrada".to_string()
            } else {
                resumo.alergias.join(", ")
            },
            cronologia_consultas,
            pergunta_medico
        );

        // Chamar a API do Gemini
        match chamar_gemini(prompt_contexto, gemini_api_key).await {
            Ok(resposta) => return resposta,
            Err(e) => return format!("Erro na comunicação com a IA: {}", e),
        }
    }

    "Erro ao ler o contexto do paciente. Por favor, recarregue a página.".to_string()
}

/// Recebe uma transcrição de áudio bruta, envia pro Gemini e retorna um envelope JSON (sempre válido):
/// `{"ok":true,"data":{anamnese,observacoes,hipotese,conduta}}` ou `{"ok":false,"error":{kind,message}}`
#[wasm_bindgen]
pub async fn estruturar_prontuario(transcricao_bruta: &str) -> String {
    let gemini_api_key = dotenvy_macro::dotenv!("GEMINI_API_KEY").trim();

    estruturar_prontuario_json(transcricao_bruta, gemini_api_key).await
}
