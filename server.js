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

    const r = await pool.query(
      "INSERT INTO leads (nome,fone,imovel,etapa,observacoes) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [nome, fone, imovel || "Não informado", "novo", obs || null]
    );
    await pool.query(
      "INSERT INTO historico (lead_id,texto) VALUES ($1,$2)",
      [r.rows[0].id, `Lead recebido pelo site: ${nome} (${fone})`]
    );
    console.log(`Novo lead pelo site: ${nome} - ${fone}`);
    dispararEventoMeta(nome, fone);
    // Não disparar o bot se o lead já veio do WhatsApp (evita loop)
    const veioDoBotAna = (obs || "").includes("WhatsApp Bot Ana");
    if (!veioDoBotAna) dispararBotAna(nome, fone, imovel).catch(e => console.error('Bot Ana:', e.message));
    res.json({ ok: true, id: r.rows[0].id });
  } catch (err) {
    console.error("Erro ao salvar lead público:", err);
    res.status(500).json({ erro: "Erro interno" });
  }
});

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
  const r = await pool.query(
    "UPDATE leads SET nome=$1,fone=$2,imovel=$3,etapa=$4,observacoes=$5 WHERE id=$6 RETURNING *",
    [nome, fone, imovel, etapa, observacoes, req.params.id]);
  await pool.query("INSERT INTO historico (lead_id,texto) VALUES ($1,$2)",
    [req.params.id, `Etapa atualizada para: ${etapa}`]);
  res.json(r.rows[0]);
});

app.delete("/api/leads/:id", auth, async (req, res) => {
  res.status(403).json({ error: "Exclusão de leads desabilitada. Leads só podem ser movidos entre etapas." });
});

// ============ OBRAS ============
const ETAPAS_OBRA = ["fundacao","alvenaria","laje","cobertura","acabamento","entrega"];

app.get("/api/obras", auth, async (req, res) => {
  const r = await pool.query("SELECT * FROM obras ORDER BY criado_em DESC");
  res.json(r.rows);
});

app.get("/api/obras/:id", auth, async (req, res) => {
  const obra = await pool.query("SELECT * FROM obras WHERE id=$1", [req.params.id]);
  if (!obra.rows[0]) return res.status(404).json({ erro: "Obra não encontrada" });
  const diario = await pool.query("SELECT * FROM obra_diario WHERE obra_id=$1 ORDER BY criado_em DESC", [req.params.id]);
  const ocorrencias = await pool.query("SELECT * FROM obra_ocorrencias WHERE obra_id=$1 ORDER BY criado_em DESC", [req.params.id]);
  res.json({ ...obra.rows[0], diario: diario.rows, ocorrencias: ocorrencias.rows });
});

app.post("/api/obras", auth, async (req, res) => {
  const { nome, endereco, etapa, data_inicio, previsao_fim, responsavel, observacoes } = req.body;
  if (!nome) return res.status(400).json({ erro: "Nome é obrigatório" });
  const r = await pool.query(
    `INSERT INTO obras (nome,endereco,etapa,data_inicio,previsao_fim,responsavel,observacoes)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [nome, endereco || null, etapa || "fundacao", data_inicio || null, previsao_fim || null, responsavel || null, observacoes || null]);
  res.json(r.rows[0]);
});

app.put("/api/obras/:id", auth, async (req, res) => {
  const { nome, endereco, etapa, data_inicio, previsao_fim, responsavel, status, observacoes } = req.body;
  const r = await pool.query(
    `UPDATE obras SET nome=$1,endereco=$2,etapa=$3,data_inicio=$4,previsao_fim=$5,responsavel=$6,status=$7,observacoes=$8
     WHERE id=$9 RETURNING *`,
    [nome, endereco, etapa, data_inicio || null, previsao_fim || null, responsavel, status || "em_andamento", observacoes, req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ erro: "Obra não encontrada" });
  res.json(r.rows[0]);
});

app.delete("/api/obras/:id", auth, somenteAdmin, async (req, res) => {
  await pool.query("DELETE FROM obras WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

// ---- Diário de obra ----
app.get("/api/obras/:id/diario", auth, async (req, res) => {
  const r = await pool.query("SELECT * FROM obra_diario WHERE obra_id=$1 ORDER BY criado_em DESC", [req.params.id]);
  res.json(r.rows);
});

app.post("/api/obras/:id/diario", auth, async (req, res) => {
  const { texto, foto_url } = req.body;
  const r = await pool.query(
    "INSERT INTO obra_diario (obra_id,texto,foto_url) VALUES ($1,$2,$3) RETURNING *",
    [req.params.id, texto || null, foto_url || null]);
  res.json(r.rows[0]);
});

app.delete("/api/obras/diario/:id", auth, somenteAdmin, async (req, res) => {
  await pool.query("DELETE FROM obra_diario WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

// ---- Ocorrências / patologias ----
app.get("/api/obras/:id/ocorrencias", auth, async (req, res) => {
  const r = await pool.query("SELECT * FROM obra_ocorrencias WHERE obra_id=$1 ORDER BY criado_em DESC", [req.params.id]);
  res.json(r.rows);
});

app.get("/api/ocorrencias", auth, async (req, res) => {
  const r = await pool.query(
    `SELECT o.*, ob.nome as obra_nome FROM obra_ocorrencias o
     JOIN obras ob ON o.obra_id=ob.id ORDER BY o.criado_em DESC`);
  res.json(r.rows);
});

app.post("/api/obras/:id/ocorrencias", auth, async (req, res) => {
  const { tipo, etapa, descricao, causa, acao_corretiva, gravidade, foto_url, responsavel } = req.body;
  if (!descricao) return res.status(400).json({ erro: "Descrição é obrigatória" });
  const r = await pool.query(
    `INSERT INTO obra_ocorrencias (obra_id,tipo,etapa,descricao,causa,acao_corretiva,gravidade,foto_url,responsavel)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [req.params.id, tipo || "patologia", etapa || null, descricao, causa || null, acao_corretiva || null, gravidade || "media", foto_url || null, responsavel || null]);
  res.json(r.rows[0]);
});

app.put("/api/obras/ocorrencias/:id", auth, async (req, res) => {
  const { tipo, etapa, descricao, causa, acao_corretiva, gravidade, foto_url, responsavel, status } = req.body;
  const r = await pool.query(
    `UPDATE obra_ocorrencias SET tipo=$1,etapa=$2,descricao=$3,causa=$4,acao_corretiva=$5,gravidade=$6,foto_url=$7,responsavel=$8,status=$9
     WHERE id=$10 RETURNING *`,
    [tipo, etapa, descricao, causa, acao_corretiva, gravidade, foto_url, responsavel, status || "aberta", req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ erro: "Ocorrência não encontrada" });
  res.json(r.rows[0]);
});

app.delete("/api/obras/ocorrencias/:id", auth, somenteAdmin, async (req, res) => {
  await pool.query("DELETE FROM obra_ocorrencias WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

// ---- Checklists (modelos) ----
app.get("/api/checklist-itens", auth, async (req, res) => {
  const { etapa } = req.query;
  const r = etapa
    ? await pool.query("SELECT * FROM obra_checklist_itens WHERE etapa=$1 ORDER BY ordem", [etapa])
    : await pool.query("SELECT * FROM obra_checklist_itens ORDER BY etapa, ordem");
  res.json(r.rows);
});

app.post("/api/checklist-itens", auth, async (req, res) => {
  const { etapa, descricao, ordem } = req.body;
  if (!etapa || !descricao) return res.status(400).json({ erro: "Etapa e descrição são obrigatórios" });
  const r = await pool.query(
    "INSERT INTO obra_checklist_itens (etapa,descricao,ordem) VALUES ($1,$2,$3) RETURNING *",
    [etapa, descricao, ordem || 0]);
  res.json(r.rows[0]);
});

app.delete("/api/checklist-itens/:id", auth, somenteAdmin, async (req, res) => {
  await pool.query("DELETE FROM obra_checklist_itens WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

// ---- Checklist execuções (por obra) ----
app.get("/api/obras/:id/checklist/:etapa", auth, async (req, res) => {
  const itens = await pool.query("SELECT * FROM obra_checklist_itens WHERE etapa=$1 ORDER BY ordem", [req.params.etapa]);
  const exec = await pool.query("SELECT * FROM obra_checklist_execucoes WHERE obra_id=$1", [req.params.id]);
  const execMap = {};
  exec.rows.forEach(e => execMap[e.item_id] = e);
  const resultado = itens.rows.map(item => ({
    ...item,
    execucao: execMap[item.id] || null
  }));
  res.json(resultado);
});

app.post("/api/obras/:id/checklist/:itemId", auth, async (req, res) => {
  const { ok, foto_url, observacao, executado_por } = req.body;
  const existente = await pool.query(
    "SELECT * FROM obra_checklist_execucoes WHERE obra_id=$1 AND item_id=$2",
    [req.params.id, req.params.itemId]);
  let r;
  if (existente.rows[0]) {
    r = await pool.query(
      `UPDATE obra_checklist_execucoes SET ok=$1,foto_url=$2,observacao=$3,executado_em=NOW(),executado_por=$4
       WHERE obra_id=$5 AND item_id=$6 RETURNING *`,
      [ok, foto_url || null, observacao || null, executado_por || null, req.params.id, req.params.itemId]);
  } else {
    r = await pool.query(
      `INSERT INTO obra_checklist_execucoes (obra_id,item_id,ok,foto_url,observacao,executado_em,executado_por)
       VALUES ($1,$2,$3,$4,$5,NOW(),$6) RETURNING *`,
      [req.params.id, req.params.itemId, ok, foto_url || null, observacao || null, executado_por || null]);
  }
  res.json(r.rows[0]);
});


app.get("/api/historico", auth, async (req, res) => {
  const r = await pool.query(
    "SELECT h.*, l.nome as lead_nome FROM historico h JOIN leads l ON h.lead_id=l.id ORDER BY h.criado_em DESC LIMIT 50");
  res.json(r.rows);
});

initDB().then(() => {
  app.listen(process.env.PORT || 3000, () =>
    console.log("CRM rodando na porta", process.env.PORT || 3000));
});




