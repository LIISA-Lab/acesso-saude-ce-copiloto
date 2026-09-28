// Resolve o modelo do Gemini em tempo de compilação: lê GEMINI_MODEL do ambiente
// ou do .env e, se ausente, usa o modelo padrão.
const MODELO_PADRAO: &str = "gemini-3.6-flash";

fn main() {
    println!("cargo:rerun-if-changed=.env");
    println!("cargo:rerun-if-env-changed=GEMINI_MODEL");

    let _ = dotenvy::dotenv();

    let modelo = std::env::var("GEMINI_MODEL")
        .map(|m| m.trim().to_string())
        .ok()
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| MODELO_PADRAO.to_string());

    println!("cargo:rustc-env=GEMINI_MODEL={}", modelo);
}
