//! Cliente mínimo do Langfuse v4 para Rust/Wasm.
//!
//! - Traces e gerações vão como spans OpenTelemetry em OTLP/HTTP JSON para
//!   `POST /api/public/otel/v1/traces` (no v4 o endpoint `/api/public/ingestion` só aceita scores).
//! - Scores vão como `score-create` para `POST /api/public/ingestion`.
//!
//! Feito para `wasm32-unknown-unknown`: usa só `reqwest` (fetch do navegador), `serde_json` e
//! `js-sys`, sem SDK de OpenTelemetry nem tokio. O envio é "dispare e esqueça": nunca atrasa nem
//! derruba a resposta ao médico, e falhas viram apenas um aviso no console.
//!
//! A configuração é embutida em tempo de compilação pelo `build.rs` (LANGFUSE_HOST,
//! LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, ...). Sem host ou chaves a telemetria fica
//! desligada e todas as chamadas viram no-op.

use serde_json::{Value, json};
use std::cell::RefCell;

// Definidos pelo build.rs a partir do ambiente ou do .env (ausentes = telemetria desligada)
const LANGFUSE_HOST: Option<&str> = option_env!("LANGFUSE_HOST");
const LANGFUSE_PUBLIC_KEY: Option<&str> = option_env!("LANGFUSE_PUBLIC_KEY");
const LANGFUSE_SECRET_KEY: Option<&str> = option_env!("LANGFUSE_SECRET_KEY");
const LANGFUSE_ENVIRONMENT: Option<&str> = option_env!("LANGFUSE_ENVIRONMENT");
const LANGFUSE_CAPTURE_CONTENT: Option<&str> = option_env!("LANGFUSE_CAPTURE_CONTENT");

/// Ambiente usado quando LANGFUSE_ENVIRONMENT não é definido.
const AMBIENTE_PADRAO: &str = "development";
/// Nome do serviço e do escopo de instrumentação nos spans.
const SERVICO: &str = env!("CARGO_PKG_NAME");
/// Tempo máximo de um envio; depois disso o lote é descartado.
#[cfg(target_arch = "wasm32")]
const TIMEOUT_ENVIO_MS: u64 = 10_000;

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub host: String,
    pub public_key: String,
    pub secret_key: String,
    /// Separa os dados na UI do Langfuse (ex.: development, homologacao, avaliacao).
    pub environment: String,
    pub release: String,
    /// Se `false`, input/output não saem do navegador: só metadados, tokens e latência.
    pub capturar_conteudo: bool,
}

impl Config {
    /// Configuração embutida na compilação, ou `None` se a telemetria estiver desligada.
    pub fn do_build() -> Option<Self> {
        Self::de_valores(
            LANGFUSE_HOST,
            LANGFUSE_PUBLIC_KEY,
            LANGFUSE_SECRET_KEY,
            LANGFUSE_ENVIRONMENT,
            LANGFUSE_CAPTURE_CONTENT,
        )
    }

    fn de_valores(
        host: Option<&str>,
        public_key: Option<&str>,
        secret_key: Option<&str>,
        environment: Option<&str>,
        capturar_conteudo: Option<&str>,
    ) -> Option<Self> {
        fn preenchido(v: Option<&str>) -> Option<&str> {
            v.map(str::trim).filter(|v| !v.is_empty())
        }

        let host = preenchido(host)?.trim_end_matches('/').to_string();
        let public_key = preenchido(public_key).filter(|k| k.starts_with("pk-lf-"))?;
        let secret_key = preenchido(secret_key).filter(|k| k.starts_with("sk-lf-"))?;

        Some(Self {
            host,
            public_key: public_key.to_string(),
            secret_key: secret_key.to_string(),
            environment: preenchido(environment)
                .unwrap_or(AMBIENTE_PADRAO)
                .to_string(),
            release: env!("CARGO_PKG_VERSION").to_string(),
            capturar_conteudo: !matches!(
                preenchido(capturar_conteudo)
                    .map(str::to_lowercase)
                    .as_deref(),
                Some("false" | "0" | "nao" | "não")
            ),
        })
    }
}

// ---------------------------------------------------------------------------
// Sessão
// ---------------------------------------------------------------------------

thread_local! {
    static SESSAO: RefCell<Option<String>> = const { RefCell::new(None) };
}

/// Agrupa os próximos traces numa sessão do Langfuse (ex.: um atendimento).
/// Use um identificador aleatório, nunca um dado do paciente. `None` encerra a sessão.
pub fn definir_sessao(id: Option<String>) {
    SESSAO.with(|s| *s.borrow_mut() = id.filter(|i| !i.trim().is_empty()));
}

pub fn sessao_atual() -> Option<String> {
    SESSAO.with(|s| s.borrow().clone())
}

// ---------------------------------------------------------------------------
// Modelo de dados
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum Tipo {
    #[default]
    Span,
    Generation,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum Nivel {
    Debug,
    #[default]
    Default,
    Warning,
    Error,
}

impl Nivel {
    fn como_str(self) -> &'static str {
        match self {
            Self::Debug => "DEBUG",
            Self::Default => "DEFAULT",
            Self::Warning => "WARNING",
            Self::Error => "ERROR",
        }
    }
}

/// Contagem de tokens. `output` deve incluir os tokens de raciocínio cobrados como saída.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Uso {
    pub input: u32,
    pub output: u32,
    pub total: Option<u32>,
}

/// Atributos que só fazem sentido no span raiz de um trace.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DadosTrace {
    pub nome: String,
    pub session_id: Option<String>,
    pub tags: Vec<String>,
    /// Viram `metadata.<chave>` filtrável na UI.
    pub metadata: Vec<(String, String)>,
}

/// Uma observação do Langfuse (span OpenTelemetry).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Observacao {
    /// 32 caracteres hexadecimais.
    pub trace_id: String,
    /// 16 caracteres hexadecimais.
    pub id: String,
    pub pai: Option<String>,
    pub nome: String,
    pub tipo: Tipo,
    pub inicio_ms: f64,
    pub fim_ms: f64,
    pub input: Value,
    pub output: Value,
    pub nivel: Nivel,
    pub status: Option<String>,
    pub modelo: Option<String>,
    /// Objeto com valores escalares (ex.: `{"thinkingLevel": "LOW", "maxOutputTokens": 8192}`).
    pub parametros: Value,
    pub uso: Option<Uso>,
    pub metadata: Vec<(String, String)>,
    /// Preenchido só no span raiz.
    pub trace: Option<DadosTrace>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ValorScore {
    Numerico(f64),
    Booleano(bool),
    Categorico(String),
}

/// Avaliação de um trace ou de uma observação (ex.: feedback do médico, resultado de um teste).
#[derive(Clone, Debug, PartialEq)]
pub struct Score {
    pub trace_id: String,
    pub observation_id: Option<String>,
    pub nome: String,
    pub valor: ValorScore,
    pub comentario: Option<String>,
}

/// Resumo de uma chamada ao LLM, para o caso comum de um trace com uma única geração.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ChamadaLlm {
    /// Nome do trace (ex.: "chat", "escriba").
    pub operacao: String,
    pub modelo: String,
    pub inicio_ms: f64,
    pub fim_ms: f64,
    /// Mensagens enviadas, de preferência no formato `[{"role": ..., "content": ...}]`.
    pub input: Value,
    pub output: Value,
    pub parametros: Value,
    pub uso: Option<Uso>,
    pub nivel: Nivel,
    pub status: Option<String>,
    pub metadata: Vec<(String, String)>,
}

impl ChamadaLlm {
    /// Monta o span raiz (o trace) e a geração filha. `ids` = (trace, raiz, geração).
    pub fn em_observacoes(
        self,
        (trace_id, raiz_id, geracao_id): (String, String, String),
        session_id: Option<String>,
    ) -> [Observacao; 2] {
        let raiz = Observacao {
            trace_id: trace_id.clone(),
            id: raiz_id.clone(),
            pai: None,
            nome: self.operacao.clone(),
            tipo: Tipo::Span,
            inicio_ms: self.inicio_ms,
            fim_ms: self.fim_ms,
            input: self.input.clone(),
            output: self.output.clone(),
            nivel: self.nivel,
            status: self.status.clone(),
            trace: Some(DadosTrace {
                nome: self.operacao.clone(),
                session_id,
                tags: vec![self.operacao.clone()],
                metadata: self.metadata.clone(),
            }),
            ..Default::default()
        };
        let geracao = Observacao {
            trace_id,
            id: geracao_id,
            pai: Some(raiz_id),
            nome: self.modelo.clone(),
            tipo: Tipo::Generation,
            modelo: Some(self.modelo),
            parametros: self.parametros,
            uso: self.uso,
            metadata: self.metadata,
            trace: None,
            ..raiz.clone()
        };
        [raiz, geracao]
    }
}

// ---------------------------------------------------------------------------
// Montagem dos payloads (lógica pura, sem I/O)
// ---------------------------------------------------------------------------

fn attr_str(chave: &str, valor: impl Into<String>) -> Value {
    json!({ "key": chave, "value": { "stringValue": valor.into() } })
}

fn attr_json(chave: &str, valor: &Value) -> Value {
    attr_str(chave, valor.to_string())
}

fn nanos(ms: f64) -> String {
    format!("{}", (ms.max(0.0) * 1_000_000.0).round() as u128)
}

fn atributos(config: &Config, o: &Observacao) -> Vec<Value> {
    let tipo = match o.tipo {
        Tipo::Span => "span",
        Tipo::Generation => "generation",
    };
    let mut attrs = vec![
        attr_str("langfuse.observation.type", tipo),
        attr_str("langfuse.environment", &config.environment),
        attr_str("langfuse.release", &config.release),
        attr_str("langfuse.observation.level", o.nivel.como_str()),
    ];

    if let Some(status) = &o.status {
        attrs.push(attr_str("langfuse.observation.status_message", status));
    }
    if config.capturar_conteudo {
        if !o.input.is_null() {
            attrs.push(attr_json("langfuse.observation.input", &o.input));
        }
        if !o.output.is_null() {
            attrs.push(attr_json("langfuse.observation.output", &o.output));
        }
    }
    if let Some(modelo) = &o.modelo {
        attrs.push(attr_str("langfuse.observation.model.name", modelo));
    }
    if o.parametros.as_object().is_some_and(|p| !p.is_empty()) {
        attrs.push(attr_json("langfuse.observation.model.parameters", &o.parametros));
    }
    if let Some(uso) = &o.uso {
        let mut detalhes = json!({ "input": uso.input, "output": uso.output });
        if let Some(total) = uso.total {
            detalhes["total"] = json!(total);
        }
        attrs.push(attr_json("langfuse.observation.usage_details", &detalhes));
    }
    for (chave, valor) in &o.metadata {
        attrs.push(attr_str(&format!("langfuse.observation.metadata.{chave}"), valor));
    }

    if let Some(trace) = &o.trace {
        attrs.push(attr_str("langfuse.trace.name", &trace.nome));
        if let Some(sessao) = &trace.session_id {
            attrs.push(attr_str("langfuse.session.id", sessao));
        }
        if !trace.tags.is_empty() {
            let tags: Vec<Value> = trace.tags.iter().map(|t| json!({ "stringValue": t })).collect();
            attrs.push(json!({
                "key": "langfuse.trace.tags",
                "value": { "arrayValue": { "values": tags } }
            }));
        }
        for (chave, valor) in &trace.metadata {
            attrs.push(attr_str(&format!("langfuse.trace.metadata.{chave}"), valor));
        }
    }

    attrs
}

/// Monta o corpo OTLP/JSON (`ExportTraceServiceRequest`) de `POST /api/public/otel/v1/traces`.
pub fn montar_otlp(config: &Config, observacoes: &[Observacao]) -> Value {
    let spans: Vec<Value> = observacoes
        .iter()
        .map(|o| {
            let mut span = json!({
                "traceId": o.trace_id,
                "spanId": o.id,
                "name": o.nome,
                // 3 = CLIENT para chamadas ao LLM, 1 = INTERNAL para o resto
                "kind": if o.tipo == Tipo::Generation { 3 } else { 1 },
                "startTimeUnixNano": nanos(o.inicio_ms),
                "endTimeUnixNano": nanos(o.fim_ms),
                "attributes": atributos(config, o),
                "status": if o.nivel == Nivel::Error {
                    json!({ "code": 2, "message": o.status.clone().unwrap_or_default() })
                } else {
                    json!({ "code": 1 })
                },
            });
            if let Some(pai) = &o.pai {
                span["parentSpanId"] = json!(pai);
            }
            span
        })
        .collect();

    json!({
        "resourceSpans": [{
            "resource": { "attributes": [
                attr_str("service.name", SERVICO),
                attr_str("service.version", &config.release),
            ]},
            "scopeSpans": [{
                "scope": { "name": SERVICO, "version": config.release },
                "spans": spans,
            }],
        }]
    })
}

/// Monta o corpo de `POST /api/public/ingestion` com um `score-create` por score.
pub fn montar_scores(
    config: &Config,
    scores: &[Score],
    agora: &str,
    mut novo_id: impl FnMut() -> String,
) -> Value {
    let batch: Vec<Value> = scores
        .iter()
        .map(|s| {
            let (valor, tipo) = match &s.valor {
                ValorScore::Numerico(v) => (json!(v), "NUMERIC"),
                ValorScore::Booleano(v) => (json!(u8::from(*v)), "BOOLEAN"),
                ValorScore::Categorico(v) => (json!(v), "CATEGORICAL"),
            };
            let mut corpo = json!({
                "id": novo_id(),
                "traceId": s.trace_id,
                "name": s.nome,
                "value": valor,
                "dataType": tipo,
                "environment": config.environment,
            });
            if let Some(obs) = &s.observation_id {
                corpo["observationId"] = json!(obs);
            }
            if let Some(comentario) = &s.comentario {
                corpo["comment"] = json!(comentario);
            }
            json!({ "id": novo_id(), "timestamp": agora, "type": "score-create", "body": corpo })
        })
        .collect();

    json!({ "batch": batch })
}

/// Valida a resposta dos dois endpoints. A ingestão de scores responde 207 com
/// `{successes, errors}`; qualquer item em `errors` é falha.
pub fn interpretar_resposta(status: u16, corpo: &str) -> Result<(), String> {
    if !(200..300).contains(&status) {
        let mensagem = serde_json::from_str::<Value>(corpo)
            .ok()
            .and_then(|v| v.get("message").and_then(Value::as_str).map(String::from))
            .unwrap_or_default();
        return Err(format!("HTTP {status} {mensagem}").trim_end().to_string());
    }

    let erros = serde_json::from_str::<Value>(corpo)
        .ok()
        .and_then(|v| v.get("errors").and_then(Value::as_array).cloned())
        .unwrap_or_default();

    if erros.is_empty() {
        return Ok(());
    }

    let detalhes: Vec<String> = erros
        .iter()
        .map(|e| {
            format!(
                "{} {}",
                e.get("status").map(Value::to_string).unwrap_or_default(),
                e.get("message").and_then(Value::as_str).unwrap_or("sem detalhes")
            )
        })
        .collect();
    Err(format!(
        "{} evento(s) rejeitado(s): {}",
        erros.len(),
        detalhes.join("; ")
    ))
}

// ---------------------------------------------------------------------------
// Relógio e ids
// ---------------------------------------------------------------------------

/// Milissegundos desde a época Unix.
#[cfg(target_arch = "wasm32")]
pub fn agora_ms() -> f64 {
    js_sys::Date::now()
}

#[cfg(not(target_arch = "wasm32"))]
pub fn agora_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1_000.0)
        .unwrap_or_default()
}

/// Formata milissegundos Unix como ISO 8601 em UTC (`2026-10-20T13:05:09.123Z`).
pub fn iso_de_ms(ms: f64) -> String {
    let ms = ms.max(0.0) as i64;
    let (dias, resto) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));

    // Conversão de dias para data civil (algoritmo de Howard Hinnant)
    let z = dias + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let dia = doy - (153 * mp + 2) / 5 + 1;
    let mes = if mp < 10 { mp + 3 } else { mp - 9 };
    let ano = yoe + era * 400 + i64::from(mes <= 2);

    format!(
        "{ano:04}-{mes:02}-{dia:02}T{:02}:{:02}:{:02}.{:03}Z",
        resto / 3_600_000,
        resto / 60_000 % 60,
        resto / 1_000 % 60,
        resto % 1_000
    )
}

/// Id de trace: 32 caracteres hexadecimais.
pub fn novo_trace_id() -> String {
    hex_aleatorio(4)
}

/// Id de observação (span): 16 caracteres hexadecimais.
pub fn novo_span_id() -> String {
    hex_aleatorio(2)
}

fn hex_aleatorio(palavras: usize) -> String {
    (0..palavras).map(|_| format!("{:08x}", aleatorio_u32())).collect()
}

#[cfg(target_arch = "wasm32")]
fn aleatorio_u32() -> u32 {
    (js_sys::Math::random() * f64::from(u32::MAX)) as u32
}

#[cfg(not(target_arch = "wasm32"))]
fn aleatorio_u32() -> u32 {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
    );
    h.finish() as u32
}

// ---------------------------------------------------------------------------
// Envio
// ---------------------------------------------------------------------------

/// Registra uma chamada ao LLM (trace + geração) na sessão atual. Devolve o id do trace,
/// para que scores possam ser associados a ele depois.
pub fn registrar_chamada_llm(chamada: ChamadaLlm) -> String {
    let trace_id = novo_trace_id();
    let observacoes = chamada.em_observacoes(
        (trace_id.clone(), novo_span_id(), novo_span_id()),
        sessao_atual(),
    );
    registrar(observacoes.to_vec());
    trace_id
}

/// Envia observações em segundo plano. No-op sem configuração ou fora do Wasm (testes nativos).
pub fn registrar(observacoes: Vec<Observacao>) {
    if observacoes.is_empty() {
        return;
    }
    if let Some(config) = Config::do_build() {
        disparar(async move { enviar_observacoes(&config, &observacoes).await });
    }
}

/// Envia scores em segundo plano. No-op sem configuração ou fora do Wasm (testes nativos).
pub fn registrar_scores(scores: Vec<Score>) {
    if scores.is_empty() {
        return;
    }
    if let Some(config) = Config::do_build() {
        disparar(async move { enviar_scores(&config, &scores).await });
    }
}

#[cfg(target_arch = "wasm32")]
fn disparar(envio: impl std::future::Future<Output = Result<(), String>> + 'static) {
    wasm_bindgen_futures::spawn_local(async move {
        if let Err(e) = envio.await {
            // Nunca loga o payload: ele pode conter dado clínico
            web_sys::console::warn_1(&wasm_bindgen::JsValue::from_str(&format!(
                "[Copiloto-Wasm] Telemetria Langfuse não enviada: {e}"
            )));
        }
    });
}

#[cfg(not(target_arch = "wasm32"))]
fn disparar(_envio: impl std::future::Future<Output = Result<(), String>> + 'static) {}

/// Envia observações e espera a resposta.
pub async fn enviar_observacoes(config: &Config, observacoes: &[Observacao]) -> Result<(), String> {
    postar(
        config,
        "/api/public/otel/v1/traces",
        &montar_otlp(config, observacoes),
    )
    .await
}

/// Envia scores e espera a resposta.
pub async fn enviar_scores(config: &Config, scores: &[Score]) -> Result<(), String> {
    let lote = montar_scores(config, scores, &iso_de_ms(agora_ms()), novo_trace_id);
    postar(config, "/api/public/ingestion", &lote).await
}

async fn postar(config: &Config, caminho: &str, corpo: &Value) -> Result<(), String> {
    let requisicao = reqwest::Client::new()
        .post(format!("{}{}", config.host, caminho))
        .basic_auth(&config.public_key, Some(&config.secret_key))
        // Grava direto nas tabelas do v4, sem o atraso do pipeline de compatibilidade
        .header("x-langfuse-ingestion-version", "4")
        .json(corpo);

    #[cfg(target_arch = "wasm32")]
    let requisicao = requisicao.timeout(std::time::Duration::from_millis(TIMEOUT_ENVIO_MS));

    let res = requisicao
        .send()
        .await
        .map_err(|e| format!("falha de rede: {}", e.without_url()))?;
    let status = res.status().as_u16();
    let corpo = res.text().await.unwrap_or_default();

    interpretar_resposta(status, &corpo)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(capturar: bool) -> Config {
        Config {
            host: "http://localhost:3000".into(),
            public_key: "pk-lf-x".into(),
            secret_key: "sk-lf-y".into(),
            environment: "development".into(),
            release: "0.1.0".into(),
            capturar_conteudo: capturar,
        }
    }

    fn chamada() -> ChamadaLlm {
        ChamadaLlm {
            operacao: "chat".into(),
            modelo: "gemini-3.6-flash".into(),
            inicio_ms: 1_000.0,
            fim_ms: 2_500.5,
            input: json!([{"role": "user", "content": "oi"}]),
            output: json!("olá"),
            parametros: json!({"thinkingLevel": "LOW"}),
            uso: Some(Uso {
                input: 10,
                output: 5,
                total: None,
            }),
            metadata: vec![("operacao".into(), "chat".into())],
            ..Default::default()
        }
    }

    fn observacoes(c: ChamadaLlm) -> [Observacao; 2] {
        c.em_observacoes(
            ("t".repeat(32), "r".repeat(16), "g".repeat(16)),
            Some("sessao-1".into()),
        )
    }

    /// Atributos de um span como mapa chave → valor (`stringValue` ou o `value` cru).
    fn attrs(span: &Value) -> serde_json::Map<String, Value> {
        span["attributes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| {
                let v = &a["value"];
                let valor = v.get("stringValue").cloned().unwrap_or_else(|| v.clone());
                (a["key"].as_str().unwrap().to_string(), valor)
            })
            .collect()
    }

    #[test]
    fn config_exige_host_e_chaves_validas() {
        let c = |h, pk, sk| Config::de_valores(h, pk, sk, None, None);
        assert!(c(None, Some("pk-lf-a"), Some("sk-lf-b")).is_none());
        assert!(c(Some(" "), Some("pk-lf-a"), Some("sk-lf-b")).is_none());
        assert!(c(Some("http://h"), Some("SUA_CHAVE"), Some("sk-lf-b")).is_none());
        assert!(c(Some("http://h"), Some("pk-lf-a"), None).is_none());

        let ok = c(Some(" http://h:3000/ "), Some("pk-lf-a"), Some("sk-lf-b")).unwrap();
        assert_eq!(ok.host, "http://h:3000");
        assert_eq!(ok.environment, "development");
        assert!(ok.capturar_conteudo);
    }

    #[test]
    fn config_desliga_captura_de_conteudo() {
        for v in ["false", "FALSE", "0", "nao", "Não"] {
            let c = Config::de_valores(
                Some("http://h"),
                Some("pk-lf-a"),
                Some("sk-lf-b"),
                Some("homologacao"),
                Some(v),
            )
            .unwrap();
            assert!(!c.capturar_conteudo, "{v}");
            assert_eq!(c.environment, "homologacao");
        }
    }

    #[test]
    fn chamada_vira_raiz_e_geracao_filha() {
        let [raiz, geracao] = observacoes(chamada());

        assert_eq!(raiz.pai, None);
        assert_eq!(raiz.tipo, Tipo::Span);
        assert_eq!(raiz.modelo, None);
        assert_eq!(raiz.uso, None);
        let trace = raiz.trace.as_ref().unwrap();
        assert_eq!(trace.nome, "chat");
        assert_eq!(trace.session_id.as_deref(), Some("sessao-1"));
        assert_eq!(trace.tags, vec!["chat".to_string()]);

        assert_eq!(geracao.trace_id, raiz.trace_id);
        assert_eq!(geracao.pai.as_deref(), Some(raiz.id.as_str()));
        assert_eq!(geracao.tipo, Tipo::Generation);
        assert_eq!(geracao.modelo.as_deref(), Some("gemini-3.6-flash"));
        assert!(geracao.trace.is_none());
    }

    #[test]
    fn otlp_mapeia_atributos_do_langfuse() {
        let corpo = montar_otlp(&config(true), &observacoes(chamada()));
        let rs = &corpo["resourceSpans"][0];
        assert_eq!(rs["scopeSpans"][0]["scope"]["name"], SERVICO);
        let spans = rs["scopeSpans"][0]["spans"].as_array().unwrap();
        assert_eq!(spans.len(), 2);

        let raiz = &spans[0];
        assert!(raiz.get("parentSpanId").is_none());
        assert_eq!(raiz["kind"], 1);
        assert_eq!(raiz["startTimeUnixNano"], "1000000000");
        assert_eq!(raiz["endTimeUnixNano"], "2500500000");
        assert_eq!(raiz["status"]["code"], 1);
        let a = attrs(raiz);
        assert_eq!(a["langfuse.observation.type"], "span");
        assert_eq!(a["langfuse.environment"], "development");
        assert_eq!(a["langfuse.trace.name"], "chat");
        assert_eq!(a["langfuse.session.id"], "sessao-1");
        assert_eq!(a["langfuse.trace.tags"]["arrayValue"]["values"][0]["stringValue"], "chat");
        assert_eq!(a["langfuse.trace.metadata.operacao"], "chat");
        assert_eq!(a["langfuse.observation.output"], "\"olá\"");

        let geracao = &spans[1];
        assert_eq!(geracao["parentSpanId"], "r".repeat(16));
        assert_eq!(geracao["kind"], 3);
        let a = attrs(geracao);
        assert_eq!(a["langfuse.observation.type"], "generation");
        assert_eq!(a["langfuse.observation.model.name"], "gemini-3.6-flash");
        assert_eq!(a["langfuse.observation.model.parameters"], r#"{"thinkingLevel":"LOW"}"#);
        assert_eq!(a["langfuse.observation.usage_details"], r#"{"input":10,"output":5}"#);
        assert_eq!(a["langfuse.observation.input"], r#"[{"content":"oi","role":"user"}]"#);
        assert_eq!(a["langfuse.observation.metadata.operacao"], "chat");
        assert!(!a.contains_key("langfuse.trace.name"));
    }

    #[test]
    fn sem_captura_input_e_output_nao_saem() {
        let corpo = montar_otlp(&config(false), &observacoes(chamada()));
        for span in corpo["resourceSpans"][0]["scopeSpans"][0]["spans"].as_array().unwrap() {
            let a = attrs(span);
            assert!(!a.contains_key("langfuse.observation.input"));
            assert!(!a.contains_key("langfuse.observation.output"));
        }
    }

    #[test]
    fn erro_vira_status_e_nivel() {
        let corpo = montar_otlp(
            &config(true),
            &observacoes(ChamadaLlm {
                nivel: Nivel::Error,
                status: Some("HTTP 503".into()),
                output: Value::Null,
                uso: None,
                ..chamada()
            }),
        );
        let geracao = &corpo["resourceSpans"][0]["scopeSpans"][0]["spans"][1];
        assert_eq!(geracao["status"], json!({"code": 2, "message": "HTTP 503"}));
        let a = attrs(geracao);
        assert_eq!(a["langfuse.observation.level"], "ERROR");
        assert_eq!(a["langfuse.observation.status_message"], "HTTP 503");
        assert!(!a.contains_key("langfuse.observation.output"));
        assert!(!a.contains_key("langfuse.observation.usage_details"));
    }

    #[test]
    fn scores_por_tipo() {
        let score = |valor| Score {
            trace_id: "t1".into(),
            observation_id: None,
            nome: "aprovado".into(),
            valor,
            comentario: None,
        };
        let mut n = 0;
        let lote = montar_scores(
            &config(true),
            &[
                score(ValorScore::Booleano(true)),
                score(ValorScore::Numerico(0.75)),
                Score {
                    comentario: Some("faltou a conduta".into()),
                    observation_id: Some("g1".into()),
                    ..score(ValorScore::Categorico("parcial".into()))
                },
            ],
            "2026-10-20T10:00:00.000Z",
            || {
                n += 1;
                format!("id-{n}")
            },
        );
        let b = &lote["batch"];
        assert_eq!(b[0]["type"], "score-create");
        assert_eq!(b[0]["timestamp"], "2026-10-20T10:00:00.000Z");
        assert_eq!(b[0]["body"]["traceId"], "t1");
        assert_eq!(b[0]["body"]["value"], 1);
        assert_eq!(b[0]["body"]["dataType"], "BOOLEAN");
        assert_eq!(b[1]["body"]["value"], 0.75);
        assert_eq!(b[1]["body"]["dataType"], "NUMERIC");
        assert_eq!(b[2]["body"]["value"], "parcial");
        assert_eq!(b[2]["body"]["observationId"], "g1");
        assert_eq!(b[2]["body"]["comment"], "faltou a conduta");
        assert_ne!(b[0]["id"], b[0]["body"]["id"]);
    }

    #[test]
    fn respostas_de_erro() {
        assert!(interpretar_resposta(200, r#"{"name":"otel-ingestion-job"}"#).is_ok());
        assert!(interpretar_resposta(207, r#"{"successes":[{"id":"a","status":201}],"errors":[]}"#).is_ok());
        assert_eq!(interpretar_resposta(401, "").unwrap_err(), "HTTP 401");
        assert_eq!(
            interpretar_resposta(401, r#"{"message":"Invalid credentials"}"#).unwrap_err(),
            "HTTP 401 Invalid credentials"
        );

        let erro = interpretar_resposta(
            207,
            r#"{"successes":[],"errors":[{"id":"a","status":400,"message":"Event type not accepted"}]}"#,
        )
        .unwrap_err();
        assert!(erro.contains("1 evento(s)"));
        assert!(erro.contains("400 Event type not accepted"));
    }

    #[test]
    fn iso_em_utc() {
        assert_eq!(iso_de_ms(0.0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_de_ms(951_782_400_000.0), "2000-02-29T00:00:00.000Z");
        assert_eq!(iso_de_ms(1_792_501_509_123.0), "2026-10-20T13:05:09.123Z");
    }

    #[test]
    fn ids_no_formato_otel() {
        let (t, s) = (novo_trace_id(), novo_span_id());
        assert_eq!(t.len(), 32);
        assert_eq!(s.len(), 16);
        assert!(t.chars().chain(s.chars()).all(|c| c.is_ascii_hexdigit()));
        assert_ne!(t, novo_trace_id());
    }

    #[test]
    fn sessao_vazia_e_none() {
        definir_sessao(Some("atendimento-1".into()));
        assert_eq!(sessao_atual().as_deref(), Some("atendimento-1"));
        definir_sessao(Some("  ".into()));
        assert_eq!(sessao_atual(), None);
    }
}
