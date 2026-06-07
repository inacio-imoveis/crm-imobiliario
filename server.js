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
      senha TEXT NOT NULL
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
  `);
  const existe = await pool.query("SELECT id FROM usuarios LIMIT 1");
  if (existe.rows.length === 0) {
    const senha = await bcrypt.hash("ricardo2026", 10);
    await pool.query("INSERT INTO usuarios (nome, email, senha) VALUES ($1,$2,$3)",
      ["Ricardo Inácio", "ricardo@inacio.com", senha]);
  }
  console.log("Banco iniciado!");
}

function auth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ erro: "Não autorizado" });
  try {
    req.usuario = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ erro: "Token inválido" }); }
}

// ─── LOGIN ────────────────────────────────────────────────────────────────────
app.post("/api/login", async (req, res) => {
  const { email, senha } = req.body;
  const r = await pool.query("SELECT * FROM usuarios WHERE email=$1", [email]);
  if (!r.rows[0] || !await bcrypt.compare(senha, r.rows[0].senha))
    return res.status(401).json({ erro: "Email ou senha incorretos" });
  const token = jwt.sign({ id: r.rows[0].id, nome: r.rows[0].nome }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, nome: r.rows[0].nome });
});

// ─── ROTA PÚBLICA — recebe leads do formulário do site (sem login) ─────────────
app.post("/api/leads/publico", async (req, res) => {
  try {
    const { nome, fone, imovel, renda, observacoes } = req.body;

    if (!nome || !fone) {
      return res.status(400).json({ erro: "Nome e telefone são obrigatórios" });
    }

    // Monta observação com renda se informada
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

    res.json({ ok: true, id: r.rows[0].id });
  } catch (err) {
    console.error("Erro ao salvar lead público:", err);
    res.status(500).json({ erro: "Erro interno" });
  }
});

// ─── LEADS (autenticados) ─────────────────────────────────────────────────────
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
  await pool.query("DELETE FROM leads WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

// ─── HISTÓRICO ────────────────────────────────────────────────────────────────
app.get("/api/historico", auth, async (req, res) => {
  const r = await pool.query(
    "SELECT h.*, l.nome as lead_nome FROM historico h JOIN leads l ON h.lead_id=l.id ORDER BY h.criado_em DESC LIMIT 50");
  res.json(r.rows);
});

initDB().then(() => {
  app.listen(process.env.PORT || 3000, () =>
    console.log("CRM rodando na porta", process.env.PORT || 3000));
});
