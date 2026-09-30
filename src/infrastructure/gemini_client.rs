use serde::{Deserialize, Serialize};
use std::fmt;
use wasm_bindgen::JsValue;

// Definido pelo build.rs a partir de GEMINI_MODEL (padrão: gemini-3.6-flash)
const GEMINI_MODEL: &str = env!("GEMINI_MODEL");

// ---------------------------------------------------------------------------
// Requisição
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GeminiRequest {
    contents: Vec<GeminiContent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    system_instruction: Option<GeminiContent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    generation_config: Option<GenerationConfig>,
}

#[derive(Serialize)]
struct GeminiContent {
    parts: Vec<GeminiPart>,
}

#[derive(Serialize)]
struct GeminiPart {
    text: String,
}

/// Subconjunto de `generationConfig` da API v1beta usado pelo Copiloto.
#[derive(Serialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GenerationConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_json_schema: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_config: Option<ThinkingConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ThinkingConfig {
    pub thinking_level: String,
}

/// Pedido de geração. Sem `generation_config`/`system_instruction` o
/// comportamento é o mesmo do chat (texto livre, configuração padrão do modelo).
#[derive(Default, Clone, Debug)]
pub struct PedidoGemini {
    pub prompt: String,
    pub system_instruction: Option<String>,
    pub generation_config: Option<GenerationConfig>,
}

impl PedidoGemini {
    pub fn simples(prompt: String) -> Self {
        Self {
            prompt,
            ..Self::default()
        }
    }
}

// ---------------------------------------------------------------------------
// Resposta
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeminiResponse {
    candidates: Option<Vec<GeminiCandidate>>,
    prompt_feedback: Option<PromptFeedback>,
    error: Option<ApiError>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromptFeedback {
    block_reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeminiCandidate {
    content: Option<GeminiContentResponse>,
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct GeminiContentResponse {
    parts: Option<Vec<GeminiPartResponse>>,
}

#[derive(Deserialize)]
struct GeminiPartResponse {
    text: Option<String>,
    thought: Option<bool>,
}

#[derive(Deserialize)]
struct ApiErrorEnvelope {
    error: Option<ApiError>,
}

#[derive(Deserialize)]
struct ApiError {
    message: Option<String>,
}

// ---------------------------------------------------------------------------
// Erros
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum GeminiError {
    /// Chave da API ausente ou ainda com o valor de exemplo.
    ChaveNaoConfigurada,
    /// Falha de transporte (DNS, conexão, leitura do corpo).
    Rede(String),
    /// Resposta HTTP não 2xx (ou corpo de erro da API).
    Http { status: u16, mensagem: String },
    /// Prompt ou resposta bloqueados (`blockReason` / `finishReason` de segurança).
    Bloqueado(String),
    /// A geração parou em `MAX_TOKENS`; `parcial` guarda o que chegou.
    Truncado { parcial: String },
    /// A geração parou por outro motivo que não `STOP`.
    Interrompido(String),
    /// A API respondeu 2xx mas sem nenhum candidato.
    SemCandidatos,
    /// Candidato sem nenhum texto utilizável.
    RespostaVazia,
    /// O corpo da resposta não é um JSON no formato esperado da API.
    FormatoInvalido(String),
}

impl fmt::Display for GeminiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ChaveNaoConfigurada => {
                write!(f, "A chave da API do Gemini não foi configurada.")
            }
            Self::Rede(e) => write!(f, "Falha de rede ao contatar a IA: {e}"),
            Self::Http { status, mensagem } => {
                write!(f, "A API da IA respondeu com erro {status}: {mensagem}")
            }
            Self::Bloqueado(motivo) => {
                write!(f, "A IA bloqueou a solicitação (motivo: {motivo}).")
            }
            Self::Truncado { .. } => {
                write!(f, "A resposta da IA foi cortada por atingir o limite de tokens.")
            }
            Self::Interrompido(motivo) => {
                write!(f, "A IA interrompeu a resposta (motivo: {motivo}).")
            }
            Self::SemCandidatos => write!(f, "A IA não retornou nenhuma resposta."),
            Self::RespostaVazia => write!(f, "A IA retornou uma resposta vazia."),
            Self::FormatoInvalido(e) => {
                write!(f, "A resposta da IA veio em formato inesperado: {e}")
            }
        }
    }
}

impl std::error::Error for GeminiError {}

impl GeminiError {
    /// Categoria estável usada pela UI para escolher a mensagem ao médico.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::ChaveNaoConfigurada => "config",
            Self::Rede(_) => "rede",
            Self::Http { status, .. } => match status {
                429 | 500 | 502 | 503 | 504 => "indisponivel",
                400 | 401 | 403 | 404 => "config",
                _ => "indisponivel",
            },
            Self::Bloqueado(_) => "bloqueado",
            Self::Truncado { .. } => "truncado",
            Self::SemCandidatos | Self::RespostaVazia => "vazio",
            Self::Interrompido(_) | Self::FormatoInvalido(_) => "invalido",
        }
    }
}

// ---------------------------------------------------------------------------
// Interpretação da resposta (lógica pura, sem I/O)
// ---------------------------------------------------------------------------

/// Extrai a mensagem de um corpo de erro da API (`{"error":{"message":...}}`).
/// Corpos que não são JSON (ex.: HTML de um proxy) resultam em texto genérico:
/// o conteúdo bruto nunca é propagado para a mensagem.
fn mensagem_de_erro(corpo: &str) -> String {
    serde_json::from_str::<ApiErrorEnvelope>(corpo)
        .ok()
        .and_then(|e| e.error)
        .and_then(|e| e.message)
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| "sem detalhes".to_string())
}

/// Converte status + corpo HTTP no texto gerado, ou no erro apropriado.
///
/// - status não 2xx → `Http`
/// - `promptFeedback.blockReason` → `Bloqueado`
/// - sem candidatos → `SemCandidatos`
/// - `finishReason` diferente de `STOP` → `Truncado` / `Bloqueado` / `Interrompido`
///   (a ausência do campo é tolerada)
/// - texto = concatenação de todas as parts que não são `thought`
pub fn interpretar_resposta(status: u16, corpo: &str) -> Result<String, GeminiError> {
    if !(200..300).contains(&status) {
        return Err(GeminiError::Http {
            status,
            mensagem: mensagem_de_erro(corpo),
        });
    }

    let resposta: GeminiResponse =
        serde_json::from_str(corpo).map_err(|e| GeminiError::FormatoInvalido(e.to_string()))?;

    if let Some(erro) = resposta.error {
        return Err(GeminiError::Http {
            status,
            mensagem: erro
                .message
                .unwrap_or_else(|| "sem detalhes".to_string()),
        });
    }

    if let Some(motivo) = resposta.prompt_feedback.and_then(|p| p.block_reason) {
        return Err(GeminiError::Bloqueado(motivo));
    }

    let candidato = resposta
        .candidates
        .and_then(|c| c.into_iter().next())
        .ok_or(GeminiError::SemCandidatos)?;

    let texto: String = candidato
        .content
        .and_then(|c| c.parts)
        .unwrap_or_default()
        .into_iter()
        .filter(|p| p.thought != Some(true))
        .filter_map(|p| p.text)
        .collect();

    match candidato.finish_reason.as_deref() {
        None | Some("STOP") => {}
        Some("MAX_TOKENS") => return Err(GeminiError::Truncado { parcial: texto }),
        Some(
            motivo @ ("SAFETY" | "RECITATION" | "BLOCKLIST" | "PROHIBITED_CONTENT" | "SPII"
            | "LANGUAGE"),
        ) => return Err(GeminiError::Bloqueado(motivo.to_string())),
        Some(outro) => return Err(GeminiError::Interrompido(outro.to_string())),
    }

    if texto.trim().is_empty() {
        return Err(GeminiError::RespostaVazia);
    }

    Ok(texto)
}

// ---------------------------------------------------------------------------
// Chamadas
// ---------------------------------------------------------------------------

fn chave_valida(api_key: &str) -> bool {
    !api_key.is_empty() && api_key != "SUA_CHAVE_AQUI"
}

/// Envia o pedido ao Gemini e devolve o texto gerado ou um erro tipado.
pub async fn gerar_conteudo(pedido: PedidoGemini, api_key: &str) -> Result<String, GeminiError> {
    if !chave_valida(api_key) {
        return Err(GeminiError::ChaveNaoConfigurada);
    }

    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
        GEMINI_MODEL, api_key
    );

    web_sys::console::log_1(&JsValue::from_str(&format!(
        "[Copiloto-Wasm] Enviando request para LLM (Modelo: {})",
        GEMINI_MODEL
    )));

    let body = GeminiRequest {
        contents: vec![GeminiContent {
            parts: vec![GeminiPart {
                text: pedido.prompt,
            }],
        }],
        system_instruction: pedido.system_instruction.map(|texto| GeminiContent {
            parts: vec![GeminiPart { text: texto }],
        }),
        generation_config: pedido.generation_config,
    };

    let res = reqwest::Client::new()
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| GeminiError::Rede(e.without_url().to_string()))?;

    let status = res.status().as_u16();
    let corpo = res
        .text()
        .await
        .map_err(|e| GeminiError::Rede(e.without_url().to_string()))?;

    let resultado = interpretar_resposta(status, &corpo);

    // O corpo bruto só é logado em erro HTTP (não contém dado clínico) e nunca
    // vai para a mensagem exibida ao usuário. Respostas 2xx não são logadas.
    if let Err(GeminiError::Http { .. }) = &resultado {
        web_sys::console::error_1(&JsValue::from_str(&format!(
            "[Copiloto-Wasm] Erro HTTP {} da API Gemini: {}",
            status, corpo
        )));
    }

    resultado
}

/// Chamada de texto livre usada pelo chat. Mantém o comportamento anterior:
/// sem chave configurada devolve um aviso como texto e, se a resposta for
/// cortada por `MAX_TOKENS`, devolve o que chegou em vez de falhar.
pub async fn chamar_gemini(prompt: String, api_key: &str) -> Result<String, GeminiError> {
    if !chave_valida(api_key) {
        return Ok("AVISO: A chave da API do Gemini não foi configurada. O sistema está rodando sem integração LLM no momento.".to_string());
    }

    match gerar_conteudo(PedidoGemini::simples(prompt), api_key).await {
        Err(GeminiError::Truncado { parcial }) if !parcial.trim().is_empty() => Ok(parcial),
        outro => outro,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resposta_ok(parts: &str, finish: &str) -> String {
        format!(
            r#"{{"candidates":[{{"content":{{"parts":{parts},"role":"model"}},"finishReason":"{finish}"}}]}}"#
        )
    }

    #[test]
    fn uma_part_de_texto() {
        let corpo = resposta_ok(r#"[{"text":"olá"}]"#, "STOP");
        assert_eq!(interpretar_resposta(200, &corpo).unwrap(), "olá");
    }

    #[test]
    fn concatena_varias_parts_ignorando_thought_e_parts_sem_texto() {
        let corpo = resposta_ok(
            r#"[{"text":"pensando...","thought":true},{"text":"{\"a\":"},{"text":"1}"},{"thoughtSignature":"abc"}]"#,
            "STOP",
        );
        assert_eq!(interpretar_resposta(200, &corpo).unwrap(), r#"{"a":1}"#);
    }

    #[test]
    fn finish_reason_ausente_e_tolerado() {
        let corpo = r#"{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}"#;
        assert_eq!(interpretar_resposta(200, corpo).unwrap(), "ok");
    }

    #[test]
    fn max_tokens_vira_truncado_com_parcial() {
        let corpo = resposta_ok(r#"[{"text":"{\"anamnese\":\"dor"}]"#, "MAX_TOKENS");
        assert_eq!(
            interpretar_resposta(200, &corpo),
            Err(GeminiError::Truncado {
                parcial: r#"{"anamnese":"dor"#.to_string()
            })
        );
    }

    #[test]
    fn max_tokens_sem_texto_ainda_e_truncado() {
        // thinking consumiu todo o orçamento e nenhuma part de texto chegou
        let corpo = r#"{"candidates":[{"finishReason":"MAX_TOKENS"}]}"#;
        assert_eq!(
            interpretar_resposta(200, corpo),
            Err(GeminiError::Truncado {
                parcial: String::new()
            })
        );
    }

    #[test]
    fn finish_reason_de_seguranca_vira_bloqueado() {
        for motivo in ["SAFETY", "RECITATION", "PROHIBITED_CONTENT", "SPII"] {
            let corpo = resposta_ok(r#"[{"text":"x"}]"#, motivo);
            assert_eq!(
                interpretar_resposta(200, &corpo),
                Err(GeminiError::Bloqueado(motivo.to_string()))
            );
        }
    }

    #[test]
    fn outros_finish_reasons_viram_interrompido() {
        let corpo = resposta_ok(r#"[{"text":"x"}]"#, "MALFORMED_RESPONSE");
        assert_eq!(
            interpretar_resposta(200, &corpo),
            Err(GeminiError::Interrompido("MALFORMED_RESPONSE".to_string()))
        );
    }

    #[test]
    fn prompt_bloqueado_sem_candidatos() {
        let corpo = r#"{"promptFeedback":{"blockReason":"SAFETY"}}"#;
        assert_eq!(
            interpretar_resposta(200, corpo),
            Err(GeminiError::Bloqueado("SAFETY".to_string()))
        );
    }

    #[test]
    fn candidatos_ausentes_ou_vazios() {
        assert_eq!(
            interpretar_resposta(200, "{}"),
            Err(GeminiError::SemCandidatos)
        );
        assert_eq!(
            interpretar_resposta(200, r#"{"candidates":[]}"#),
            Err(GeminiError::SemCandidatos)
        );
    }

    #[test]
    fn candidato_sem_texto_e_resposta_vazia() {
        let corpo = resposta_ok(r#"[{"thoughtSignature":"abc"}]"#, "STOP");
        assert_eq!(
            interpretar_resposta(200, &corpo),
            Err(GeminiError::RespostaVazia)
        );
        let corpo = resposta_ok(r#"[{"text":"  \n"}]"#, "STOP");
        assert_eq!(
            interpretar_resposta(200, &corpo),
            Err(GeminiError::RespostaVazia)
        );
    }

    #[test]
    fn erro_http_usa_mensagem_da_api() {
        let corpo = r#"{"error":{"code":503,"message":"The model is overloaded.","status":"UNAVAILABLE"}}"#;
        assert_eq!(
            interpretar_resposta(503, corpo),
            Err(GeminiError::Http {
                status: 503,
                mensagem: "The model is overloaded.".to_string()
            })
        );
    }

    #[test]
    fn erro_http_com_corpo_nao_json_nao_vaza_o_corpo() {
        let erro = interpretar_resposta(502, "<html>Bad Gateway</html>").unwrap_err();
        assert_eq!(
            erro,
            GeminiError::Http {
                status: 502,
                mensagem: "sem detalhes".to_string()
            }
        );
        assert!(!erro.to_string().contains("<html>"));
    }

    #[test]
    fn corpo_2xx_que_nao_e_json_vira_formato_invalido() {
        assert!(matches!(
            interpretar_resposta(200, "não é json"),
            Err(GeminiError::FormatoInvalido(_))
        ));
    }

    #[test]
    fn corpo_de_erro_com_status_200_tambem_e_erro() {
        let corpo = r#"{"error":{"message":"quota"}}"#;
        assert_eq!(
            interpretar_resposta(200, corpo),
            Err(GeminiError::Http {
                status: 200,
                mensagem: "quota".to_string()
            })
        );
    }

    #[test]
    fn kind_agrupa_erros_para_a_ui() {
        let http = |status| GeminiError::Http {
            status,
            mensagem: String::new(),
        };
        assert_eq!(GeminiError::ChaveNaoConfigurada.kind(), "config");
        assert_eq!(GeminiError::Rede("x".into()).kind(), "rede");
        assert_eq!(http(429).kind(), "indisponivel");
        assert_eq!(http(503).kind(), "indisponivel");
        assert_eq!(http(400).kind(), "config");
        assert_eq!(http(403).kind(), "config");
        assert_eq!(GeminiError::Bloqueado("SAFETY".into()).kind(), "bloqueado");
        assert_eq!(GeminiError::Truncado { parcial: String::new() }.kind(), "truncado");
        assert_eq!(GeminiError::RespostaVazia.kind(), "vazio");
        assert_eq!(GeminiError::FormatoInvalido("x".into()).kind(), "invalido");
    }

    #[test]
    fn request_omite_campos_opcionais_e_usa_camel_case() {
        let simples = GeminiRequest {
            contents: vec![GeminiContent {
                parts: vec![GeminiPart { text: "oi".into() }],
            }],
            system_instruction: None,
            generation_config: None,
        };
        assert_eq!(
            serde_json::to_string(&simples).unwrap(),
            r#"{"contents":[{"parts":[{"text":"oi"}]}]}"#
        );

        let completo = GeminiRequest {
            contents: vec![],
            system_instruction: Some(GeminiContent {
                parts: vec![GeminiPart { text: "sys".into() }],
            }),
            generation_config: Some(GenerationConfig {
                response_mime_type: Some("application/json".into()),
                response_json_schema: Some(serde_json::json!({"type": "object"})),
                thinking_config: Some(ThinkingConfig {
                    thinking_level: "LOW".into(),
                }),
                max_output_tokens: Some(8192),
            }),
        };
        let v: serde_json::Value = serde_json::to_value(&completo).unwrap();
        assert_eq!(v["systemInstruction"]["parts"][0]["text"], "sys");
        assert_eq!(v["generationConfig"]["responseMimeType"], "application/json");
        assert_eq!(v["generationConfig"]["responseJsonSchema"]["type"], "object");
        assert_eq!(v["generationConfig"]["thinkingConfig"]["thinkingLevel"], "LOW");
        assert_eq!(v["generationConfig"]["maxOutputTokens"], 8192);
    }
}
