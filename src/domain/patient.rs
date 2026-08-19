use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Paciente {
    pub id: String,
    pub nome: String,
    pub cpf: String,
    pub idade: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Atendimento {
    pub data_hora: String,
    pub especialidade: String,
    pub profissional_nome: String,
    pub profissional_crm: Option<String>,
    pub anamnese: String,
    pub hipotese_diagnostica: String,
    pub conduta_medica: String,
    pub observacoes_adicionais: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Historico {
    pub paciente: Paciente,
    pub atendimentos: Vec<Atendimento>,
    pub alergias: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResumoClinico {
    pub paciente_idade: u8,
    pub paciente_id: String,
    pub alergias: Vec<String>,
    pub total_atendimentos: usize,
    pub ultimo_diagnostico: Option<String>,
    pub ultima_conduta: Option<String>,
    pub historico_atendimentos: Vec<Atendimento>,
}
