import express from "express";
import pg from "pg";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const JWT_SECRET = process.env.JWT_SECRET || "crm-ricardo-2026";

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      senha TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'usuario'
    );
    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      fone TEXT,
      imovel TEXT,
      etapa TEXT DEFAULT 'novo',
      observacoes TEXT,
      criado_em TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS historico (
      id SERIAL PRIMARY KEY,
      lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
      texto TEXT NOT NULL,
      criado_em TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS lead_lembrete_config (
      etapa TEXT PRIMARY KEY,
      dias INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lead_lembrete_enviado (
      id SERIAL PRIMARY KEY,
      lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
      etapa TEXT NOT NULL,
      enviado_em TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS obras (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      endereco TEXT,
      etapa TEXT DEFAULT 'fundacao',
      data_inicio DATE,
      previsao_fim DATE,
      responsavel TEXT,
      status TEXT DEFAULT 'em_andamento',
      observacoes TEXT,
      criado_em TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS obra_diario (
      id SERIAL PRIMARY KEY,
      obra_id INTEGER REFERENCES obras(id) ON DELETE CASCADE,
      texto TEXT,
      foto_url TEXT,
      criado_em TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS obra_ocorrencias (
      id SERIAL PRIMARY KEY,
      obra_id INTEGER REFERENCES obras(id) ON DELETE CASCADE,
      tipo TEXT NOT NULL,
      etapa TEXT,
      descricao TEXT NOT NULL,
      causa TEXT,
      acao_corretiva TEXT,
      gravidade TEXT DEFAULT 'media',
      foto_url TEXT,
      responsavel TEXT,
      status TEXT DEFAULT 'aberta',
      criado_em TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS obra_checklist_itens (
      id SERIAL PRIMARY KEY,
      etapa TEXT NOT NULL,
      descricao TEXT NOT NULL,
      ordem INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS obra_checklist_execucoes (
      id SERIAL PRIMARY KEY,
      obra_id INTEGER REFERENCES obras(id) ON DELETE CASCADE,
      item_id INTEGER REFERENCES obra_checklist_itens(id) ON DELETE CASCADE,
      ok BOOLEAN DEFAULT FALSE,
      foto_url TEXT,
      observacao TEXT,
      executado_em TIMESTAMP,
      executado_por TEXT
    );
  `);

  // Garante a coluna role em bancos já existentes (a tabela usuarios já existia antes desta coluna ser criada)
  await pool.query("ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'usuario'");

  const existe = await pool.query("SELECT id FROM usuarios LIMIT 1");
  if (existe.rows.length === 0) {
    const senha = await bcrypt.hash("ricardo2026", 10);
    await pool.query("INSERT INTO usuarios (nome, email, senha, role) VALUES ($1,$2,$3,$4)",
      ["Ricardo Inácio", "ricardoinnacio@gmail.com", senha, "admin"]);
  }

  // Garante a existência da usuária Alessandra sem afetar usuários já cadastrados
  const existeAlessandra = await pool.query(
    "SELECT id FROM usuarios WHERE email=$1 OR nome=$2", ["ricardoinacioimoveis@gmail.com", "Alessandra"]);
  if (existeAlessandra.rows.length === 0) {
    const senhaAlessandra = await bcrypt.hash("alessandra2026", 10);
    await pool.query("INSERT INTO usuarios (nome, email, senha, role) VALUES ($1,$2,$3,$4)",
      ["Alessandra", "ricardoinacioimoveis@gmail.com", senhaAlessandra, "usuario"]);
  }

  // Atualiza emails para os endereços reais definidos pelo Ricardo (correção pontual — 19/06/2026)
  await pool.query("UPDATE usuarios SET email=$1 WHERE nome=$2 AND email=$3",
    ["ricardoinnacio@gmail.com", "Ricardo Inácio", "ricardo@inacio.com"]);
  await pool.query("UPDATE usuarios SET email=$1 WHERE nome=$2 AND email=$3",
    ["ricardoinacioimoveis@gmail.com", "Alessandra", "alessandra@inacio.com"]);

  // Garante papéis corretos: Ricardo é admin, Alessandra é usuário comum (sem permissão de excluir) — 19/06/2026
  await pool.query("UPDATE usuarios SET role='admin' WHERE nome='Ricardo Inácio'");
  await pool.query("UPDATE usuarios SET role='usuario' WHERE nome='Alessandra'");

  // Seed do checklist padrão de pré-concretagem de laje
  const existeChecklist = await pool.query("SELECT id FROM obra_checklist_itens WHERE etapa='pre_laje' LIMIT 1");
  if (existeChecklist.rows.length === 0) {
    const itensPreLaje = [
      "Escoramento espaçado conforme vão (máx. 1,0–1,20m entre pontaletes)",
      "Tábuas/vigas de madeira sem nós, rachaduras ou apodrecimento — inspeção visual",
      "Cunhas e contraventamento nas escoras (evitar tombamento)",
      "Teste de carga visual: pisar/saltar sobre a forma antes de concretar",
      "Foto do escoramento completo ANTES da concretagem (anexar ao diário)",
      "Verificar nível e prumo das formas",
      "Verificar prumo e alinhamento (não torto) de todas as vigas e pontaletes de escoramento",
      "Responsável técnico assina o checklist liberando a concretagem",
    ];
    for (let i = 0; i < itensPreLaje.length; i++) {
      await pool.query("INSERT INTO obra_checklist_itens (etapa, descricao, ordem) VALUES ($1,$2,$3)",
        ["pre_laje", itensPreLaje[i], i + 1]);
    }
  } else {
    // Item adicional incluído após ocorrência de viga de escoramento fora de alinhamento (13/06/2026)
    const novoItem = "Verificar prumo e alinhamento (não torto) de todas as vigas e pontaletes de escoramento";
    const jaExiste = await pool.query(
      "SELECT id FROM obra_checklist_itens WHERE etapa='pre_laje' AND descricao=$1", [novoItem]);
    if (jaExiste.rows.length === 0) {
      await pool.query(
        "INSERT INTO obra_checklist_itens (etapa, descricao, ordem) VALUES ($1,$2,$3)",
        ["pre_laje", novoItem, 7]);
    }
  }
  // Seed dos prazos padrão de lembrete de lead parado (em dias), por etapa do funil.
  // Etapas iniciais têm prazo curto (lead esfria rápido); etapas mais avançadas, prazo maior.
  const prazosPadrao = {
    novo: 1,
    contato: 3,
    visita: 5,
    proposta: 7,
  };
  for (const [etapa, dias] of Object.entries(prazosPadrao)) {
    await pool.query(
      "INSERT INTO lead_lembrete_config (etapa, dias) VALUES ($1,$2) ON CONFLICT (etapa) DO NOTHING",
      [etapa, dias]
    );
  }

  console.log("Banco iniciado! Deploy: 2026-06-13");
}

function auth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ erro: "Não autorizado" });
  try {
    req.usuario = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ erro: "Token inválido" }); }
}

function somenteAdmin(req, res, next) {
  if (req.usuario?.role !== "admin")
    return res.status(403).json({ erro: "Apenas o administrador pode excluir registros" });
  next();
}

// LOGIN
app.post("/api/login", async (req, res) => {
  const { email, senha } = req.body;
  const r = await pool.query("SELECT * FROM usuarios WHERE email=$1", [email]);
  if (!r.rows[0] || !await bcrypt.compare(senha, r.rows[0].senha))
    return res.status(401).json({ erro: "Email ou senha incorretos" });
  const token = jwt.sign({ id: r.rows[0].id, nome: r.rows[0].nome, role: r.rows[0].role }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, nome: r.rows[0].nome, role: r.rows[0].role });
});

// ROTA PÚBLICA — recebe leads do site sem autenticação
// Conversions API Meta — dispara evento Lead
async function dispararEventoMeta(nome, fone) {
  try {
    const PIXEL_ID = "1743544532467097";
    const TOKEN = process.env.META_CAPI_TOKEN;
    if (!TOKEN) return;
    const foneHash = fone.replace(/\D/g, "");
    const payload = {
      data: [{
        event_name: "Lead",
        event_time: Math.floor(Date.now() / 1000),
        action_source: "website",
        event_source_url: "https://ricardoinacioimoveis.com.br",
        user_data: { ph: [foneHash] }
      }]
    };
    const resp = await fetch(
      `https://graph.facebook.com/v18.0/${PIXEL_ID}/events?access_token=${TOKEN}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }
    );
    const data = await resp.json();
    console.log("Meta CAPI:", JSON.stringify(data));
  } catch (e) {
    console.error("Erro Meta CAPI:", e.message);
  }
}

// BOT ANA — disparo proativo ao receber lead
// Chama o endpoint /simular/:phone do bot para enviar a primeira mensagem
async function dispararBotAna(nome, fone, imovel) {
  try {
    const BOT_URL = process.env.BOT_ANA_URL || 'https://focused-comfort.up.railway.app';
    const primeiroNome = nome.split(' ')[0];
    const imovelTxt = imovel && imovel !== 'Não informado' ? imovel : null;
    const texto = imovelTxt
      ? `Olá, ${primeiroNome}! 😊 Vi que você se interessou pelo *${imovelTxt}*. Sou a Ana, assistente da Ricardo Inácio Imóveis. Posso te ajudar com mais informações e simular o financiamento pelo Minha Casa Minha Vida. Vamos conversar?`
      : `Olá, ${primeiroNome}! 😊 Sou a Ana, assistente da Ricardo Inácio Imóveis. Vi que você entrou em contato pelo site. Posso te ajudar a encontrar o imóvel ideal pelo Minha Casa Minha Vida. O que você está buscando?`;
    const foneNum = fone.replace(/\D/g, '');
    const phone55 = foneNum.startsWith('55') ? foneNum : `55${foneNum}`;
    const resp = await fetch(`${BOT_URL}/simular/${phone55}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texto_customizado: texto, nome_cliente: primeiroNome })
    });
    const data = await resp.json();
    console.log('Bot Ana disparado:', phone55, '->', JSON.stringify(data));
  } catch (e) {
    console.error('Erro ao disparar Bot Ana:', e.message);
  }
}

// ALERTA INTERNO — avisa a equipe (não o lead) via WhatsApp quando um lead fica parado
// Usa o mesmo bot Ana, mas como notificação direta para o número informado.
async function dispararAlertaInterno(numeroDestino, texto) {
  try {
    const BOT_URL = process.env.BOT_ANA_URL || 'https://focused-comfort.up.railway.app';
    const numNum = numeroDestino.replace(/\D/g, '');
    const phone55 = numNum.startsWith('55') ? numNum : `55${numNum}`;
    const resp = await fetch(`${BOT_URL}/simular/${phone55}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texto_customizado: texto, nome_cliente: null })
    });
    const data = await resp.json();
    console.log('Alerta interno disparado:', phone55, '->', JSON.stringify(data));
  } catch (e) {
    console.error('Erro ao disparar alerta interno:', e.message);
  }
}

// Números da equipe que recebem alertas de lead parado.
// Formato: lista separada por vírgula em ALERTA_LEAD_PARADO_NUMEROS, ex: "62992786934,62999998888"
function numerosAlerta() {
  const env = process.env.ALERTA_LEAD_PARADO_NUMEROS || "62992786934";
  return env.split(",").map(n => n.trim()).filter(Boolean);
}

const ELABEL_ALERTA = {
  novo: "Novo", contato: "Contato", visita: "Visita", proposta: "Proposta",
  fechado: "Fechado", comprou: "Comprou", sem_entrada: "Sem entrada",
  restricao: "Restrição", inativo: "Inativo", acompanhar: "Acompanhar",
};

// Verifica leads parados além do prazo configurado para sua etapa e dispara alerta (uma vez por etapa/lead)
async function verificarLeadsParados() {
  try {
    const config = await pool.query("SELECT etapa, dias FROM lead_lembrete_config");
    if (config.rows.length === 0) return;
    const prazoPorEtapa = {};
    config.rows.forEach(c => prazoPorEtapa[c.etapa] = c.dias);

    const leads = await pool.query(
      `SELECT id, nome, fone, imovel, etapa, observacoes, criado_em FROM leads WHERE etapa = ANY($1)`,
      [Object.keys(prazoPorEtapa)]
    );

    for (const lead of leads.rows) {
      const prazoDias = prazoPorEtapa[lead.etapa];
      if (!prazoDias) continue;

      // Data da última mudança de etapa: usa o histórico mais recente do lead, ou a criação se não houver
      const ultimaMudanca = await pool.query(
        `SELECT criado_em FROM historico WHERE lead_id=$1 ORDER BY criado_em DESC LIMIT 1`,
        [lead.id]
      );
      const referencia = ultimaMudanca.rows[0]?.criado_em || lead.criado_em;
      const diasParado = Math.floor((Date.now() - new Date(referencia).getTime()) / 86400000);
      if (diasParado < prazoDias) continue;

      // Evita reenviar o mesmo alerta repetidas vezes para a mesma etapa
      const jaAvisado = await pool.query(
        `SELECT id FROM lead_lembrete_enviado WHERE lead_id=$1 AND etapa=$2`,
        [lead.id, lead.etapa]
      );
      if (jaAvisado.rows.length > 0) continue;

      const texto =
        `⚠️ Lead parado há ${diasParado} dia(s)\n\n` +
        `Nome: ${lead.nome}\n` +
        `Telefone: ${lead.fone || "não informado"}\n` +
        `Imóvel: ${lead.imovel || "não informado"}\n` +
        `Etapa: ${ELABEL_ALERTA[lead.etapa] || lead.etapa}\n` +
        (lead.observacoes ? `Observações: ${lead.observacoes}\n` : "") +
        `\nPrazo configurado para esta etapa: ${prazoDias} dia(s).`;

      for (const numero of numerosAlerta()) {
        await dispararAlertaInterno(numero, texto);
      }

      await pool.query(
        `INSERT INTO lead_lembrete_enviado (lead_id, etapa) VALUES ($1,$2)`,
        [lead.id, lead.etapa]
      );
    }
  } catch (e) {
    console.error("Erro ao verificar leads parados:", e.message);
  }
}


async function criarLeadEDispararFluxo({ nome, fone, imovel, observacoes }) {
  // Evita duplicata: se já existe um lead com este telefone ainda na etapa "novo"
  // (ou seja, ainda não avançou no funil), atualiza esse registro em vez de criar outro.
  // Se o lead já avançou (visita, proposta etc.), trata como interesse novo de verdade
  // e cria um registro separado.
  const existente = await pool.query(
    "SELECT * FROM leads WHERE fone = $1 AND etapa = 'novo' ORDER BY criado_em DESC LIMIT 1",
    [fone]
  );

  if (existente.rows.length > 0) {
    const leadAtual = existente.rows[0];
    const r = await pool.query(
      "UPDATE leads SET nome = $1, imovel = $2, observacoes = $3 WHERE id = $4 RETURNING *",
      [nome, imovel || leadAtual.imovel || "Não informado", observacoes || leadAtual.observacoes, leadAtual.id]
    );
    await pool.query(
      "INSERT INTO historico (lead_id,texto) VALUES ($1,$2)",
      [leadAtual.id, `Lead atualizado: ${nome} (${fone})`]
    );
    return r.rows[0];
  }

  const r = await pool.query(
    "INSERT INTO leads (nome,fone,imovel,etapa,observacoes) VALUES ($1,$2,$3,$4,$5) RETURNING *",
    [nome, fone, imovel || "Não informado", "novo", observacoes || null]
  );
  await pool.query(
    "INSERT INTO historico (lead_id,texto) VALUES ($1,$2)",
    [r.rows[0].id, `Lead recebido: ${nome} (${fone})`]
  );
  dispararEventoMeta(nome, fone);
  const veioDoBotAna = (observacoes || "").includes("WhatsApp Bot Ana");
  if (!veioDoBotAna) dispararBotAna(nome, fone, imovel).catch(e => console.error('Bot Ana:', e.message));
  return r.rows[0];
}

app.post("/api/leads/publico", async (req, res) => {
  try {
    const { nome, fone, imovel, renda, observacoes } = req.body;
    if (!nome || !fone) {
      return res.status(400).json({ erro: "Nome e telefone são obrigatórios" });
    }
    const obs = [
      renda ? `Renda familiar: ${renda}` : null,
      observacoes || null
    ].filter(Boolean).join(" | ");

    const lead = await criarLeadEDispararFluxo({ nome, fone, imovel, observacoes: obs });
    console.log(`Novo lead pelo site: ${nome} - ${fone}`);
    res.json({ ok: true, id: lead.id });
  } catch (err) {
    console.error("Erro ao salvar lead público:", err);
    res.status(500).json({ erro: "Erro interno" });
  }
});

// ============ FACEBOOK / INSTAGRAM LEAD ADS ============
// Documentação: https://developers.facebook.com/docs/marketing-api/guides/lead-ads/
const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN || "ricardo-inacio-imoveis-webhook-2026";
const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;

// 1) Verificação do webhook — o Facebook chama esse GET uma vez, ao salvar a configuração no painel
app.get("/api/webhook/facebook-leads", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === FB_VERIFY_TOKEN) {
    console.log("Webhook Facebook verificado com sucesso");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// 2) Recebimento de leads — o Facebook chama esse POST toda vez que alguém preenche um Lead Ad
app.post("/api/webhook/facebook-leads", async (req, res) => {
  // Responde 200 imediatamente: o Facebook reenvia o evento se não receber confirmação rápida
  res.sendStatus(200);
  try {
    const entries = req.body.entry || [];
    for (const entry of entries) {
      const changes = entry.changes || [];
      for (const change of changes) {
        if (change.field !== "leadgen") continue;
        const leadgenId = change.value?.leadgen_id;
        if (!leadgenId) continue;
        await processarLeadFacebook(leadgenId);
      }
    }
  } catch (err) {
    console.error("Erro ao processar webhook do Facebook:", err.message);
  }
});

// Busca os dados completos do lead na Graph API a partir do leadgen_id recebido no webhook
async function processarLeadFacebook(leadgenId) {
  if (!FB_PAGE_ACCESS_TOKEN) {
    console.error("FB_PAGE_ACCESS_TOKEN não configurado — não foi possível buscar o lead", leadgenId);
    return;
  }
  try {
    const resp = await fetch(
      `https://graph.facebook.com/v19.0/${leadgenId}?access_token=${FB_PAGE_ACCESS_TOKEN}`
    );
    const data = await resp.json();
    if (data.error) {
      console.error("Erro Graph API ao buscar lead:", JSON.stringify(data.error));
      return;
    }
    // field_data vem como [{name: "full_name", values: ["..."]}, {name: "phone_number", values: ["..."]}, ...]
    const campos = {};
    (data.field_data || []).forEach(f => {
      campos[f.name] = (f.values || [])[0] || "";
    });
    const nome = campos.full_name || campos.nome || campos.name || "Lead Facebook (sem nome)";
    const fone = campos.phone_number || campos.telefone || campos.whatsapp || "";
    if (!fone) {
      console.error("Lead do Facebook sem telefone, ignorado:", leadgenId, JSON.stringify(campos));
      return;
    }
    const formNome = data.form_name || data.ad_name || "Anúncio Facebook/Instagram";
    const observacoes = `Origem: Facebook/Instagram Lead Ads (${formNome})`;
    const lead = await criarLeadEDispararFluxo({ nome, fone, imovel: "Não informado", observacoes });
    console.log(`Novo lead do Facebook Ads: ${nome} - ${fone} (leadgen_id ${leadgenId})`);
  } catch (e) {
    console.error("Erro ao processar lead do Facebook:", e.message);
  }
}

// LEADS autenticados
app.get("/api/leads", auth, async (req, res) => {
  const r = await pool.query("SELECT * FROM leads ORDER BY criado_em DESC");
  res.json(r.rows);
});

app.post("/api/leads", auth, async (req, res) => {
  const { nome, fone, imovel, etapa, observacoes } = req.body;
  const r = await pool.query(
    "INSERT INTO leads (nome,fone,imovel,etapa,observacoes) VALUES ($1,$2,$3,$4,$5) RETURNING *",
    [nome, fone, imovel, etapa || "novo", observacoes]);
  await pool.query("INSERT INTO historico (lead_id,texto) VALUES ($1,$2)",
    [r.rows[0].id, `Lead criado: ${nome}`]);
  res.json(r.rows[0]);
});

app.put("/api/leads/:id", auth, async (req, res) => {
  const { nome, fone, imovel, etapa, observacoes } = req.body;
  const anterior = await pool.query("SELECT etapa FROM leads WHERE id=$1", [req.params.id]);
  const etapaMudou = anterior.rows[0] && anterior.rows[0].etapa !== etapa;
  const r = await pool.query(
    "UPDATE leads SET nome=$1,fone=$2,imovel=$3,etapa=$4,observacoes=$5 WHERE id=$6 RETURNING *",
    [nome, fone, imovel, etapa, observacoes, req.params.id]);
  if (etapaMudou) {
    await pool.query("INSERT INTO historico (lead_id,texto) VALUES ($1,$2)",
      [req.params.id, `Etapa atualizada para: ${etapa}`]);
    // Lead mudou de etapa: limpa o controle de alerta para a etapa NOVA,
    // assim o relógio de "dias parado" reinicia e o lembrete pode disparar de novo se ele travar aqui.
    await pool.query("DELETE FROM lead_lembrete_enviado WHERE lead_id=$1 AND etapa=$2",
      [req.params.id, etapa]);
  }
  res.json(r.rows[0]);
});

app.delete("/api/leads/:id", auth, async (req, res) => {
  res.status(403).json({ error: "Exclusão de leads desabilitada. Leads só podem ser movidos entre etapas." });
});


app.get("/api/historico", auth, async (req, res) => {
  const r = await pool.query(
    "SELECT h.*, l.nome as lead_nome FROM historico h JOIN leads l ON h.lead_id=l.id ORDER BY h.criado_em DESC LIMIT 50");
  res.json(r.rows);
});

// ---- Lembrete de lead parado: configuração de prazo por etapa ----
app.get("/api/lembrete-config", auth, async (req, res) => {
  const r = await pool.query("SELECT etapa, dias FROM lead_lembrete_config ORDER BY etapa");
  res.json(r.rows);
});

app.put("/api/lembrete-config/:etapa", auth, async (req, res) => {
  const { dias } = req.body;
  const diasNum = parseInt(dias, 10);
  if (!diasNum || diasNum < 1) return res.status(400).json({ erro: "Dias deve ser um número maior que zero" });
  const r = await pool.query(
    `INSERT INTO lead_lembrete_config (etapa, dias) VALUES ($1,$2)
     ON CONFLICT (etapa) DO UPDATE SET dias=$2 RETURNING *`,
    [req.params.etapa, diasNum]);
  res.json(r.rows[0]);
});

initDB().then(() => {
  app.listen(process.env.PORT || 3000, () =>
    console.log("CRM rodando na porta", process.env.PORT || 3000));

  // Verifica leads parados a cada 1 hora (roda também ~1min após subir, pra não esperar a primeira hora)
  setTimeout(verificarLeadsParados, 60 * 1000);
  setInterval(verificarLeadsParados, 60 * 60 * 1000);
});





