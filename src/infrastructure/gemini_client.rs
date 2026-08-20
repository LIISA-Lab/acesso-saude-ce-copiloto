use serde::{Deserialize, Serialize};
use wasm_bindgen::JsValue;

#[derive(Serialize)]
struct GeminiRequest {
    contents: Vec<GeminiContent>,
}

#[derive(Serialize)]
struct GeminiContent {
    parts: Vec<GeminiPart>,
}

#[derive(Serialize)]
struct GeminiPart {
    text: String,
}

// Structs para a resposta do Gemini
#[derive(Deserialize)]
struct GeminiResponse {
    candidates: Option<Vec<GeminiCandidate>>,
}

#[derive(Deserialize)]
struct GeminiCandidate {
    content: Option<GeminiContentResponse>,
}

#[derive(Deserialize)]
struct GeminiContentResponse {
    parts: Option<Vec<GeminiPartResponse>>,
}

#[derive(Deserialize)]
struct GeminiPartResponse {
    text: Option<String>,
}

pub async fn chamar_gemini(prompt: String, api_key: &str) -> Result<String, JsValue> {
    if api_key.is_empty() || api_key == "SUA_CHAVE_AQUI" {
        return Ok("AVISO: A chave da API do Gemini não foi configurada. O sistema está rodando sem integração LLM no momento.".to_string());
    }

    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key={}",
        api_key
    );

    // Adicionamos logs no console do navegador para debugar a URL antes de enviar
    web_sys::console::log_1(&JsValue::from_str(&format!(
        "[Copiloto-Wasm] Enviando request para LLM (Tamanho da chave: {})",
        api_key.len()
    )));

    let body = GeminiRequest {
        contents: vec![GeminiContent {
            parts: vec![GeminiPart { text: prompt }],
        }],
    };

    let client = reqwest::Client::new();
    let res = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    let gemini_response_text = res
        .text()
        .await
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    // Tenta interpretar o JSON da resposta que chegou em String
    let gemini_response: GeminiResponse = match serde_json::from_str(&gemini_response_text) {
        Ok(parsed) => parsed,
        Err(e) => {
            return Err(JsValue::from_str(&format!(
                "Falha ao decodificar JSON. Erro: {}. Response: {}",
                e, gemini_response_text
            )));
        }
    };

    // Extrai o texto da resposta usando encadeamento funcional (and_then)
    if let Some(text) = gemini_response
        .candidates
        .and_then(|mut c| c.pop())
        .and_then(|c| c.content)
        .and_then(|c| c.parts)
        .and_then(|mut p| p.pop())
        .and_then(|p| p.text)
    {
        return Ok(text);
    }

    Err(JsValue::from_str(&format!(
        "A IA retornou uma resposta em formato desconhecido. Dump bruto: {}",
        gemini_response_text
    )))
}
