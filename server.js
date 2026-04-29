require('dotenv').config();

const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const app = express();
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: false  // cambiar a false
});

const TABLAS = ['proyectos', 'collars', 'surveys', 'assays', 'laboratorios', 'guardado'];
const PRIMARY_KEY_CONSTRAINTS = {
  proyectos: 'proyectos_pkey',
  collars: 'collars_pkey',
  surveys: 'surveys_pkey',
  assays: 'assays_pkey',
  laboratorios: 'laboratorios_pkey',
  guardado: 'guardado_pkey',
};

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Sin token' });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

async function ensureSchema() {
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto;');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      nombre TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  for (const tabla of TABLAS) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${tabla} (
        id TEXT NOT NULL,
        usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        datos JSONB NOT NULL DEFAULT '{}'::jsonb,
        actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (id, usuario_id)
      );
      CREATE INDEX IF NOT EXISTS idx_${tabla}_usuario_actualizado
        ON ${tabla} (usuario_id, actualizado_en DESC);
    `);
  }
}

function toClientRow(row) {
  return {
    id: row.id,
    ...row.datos,
    _syncTime: row.actualizado_en,
  };
}

function signUser(user) {
  return jwt.sign(
    { id: user.id, email: user.email, nombre: user.nombre },
    process.env.JWT_SECRET,
    { expiresIn: '30d' },
  );
}

async function upsertRegistro(tabla, usuarioId, item) {
  const { id, ...datos } = item;
  if (!id) return false;
  const constraint = PRIMARY_KEY_CONSTRAINTS[tabla];
  if (!constraint) throw new Error(`Tabla no soportada: ${tabla}`);

  await pool.query(
    `INSERT INTO ${tabla} (id, usuario_id, datos, actualizado_en)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT ON CONSTRAINT ${constraint} DO UPDATE
     SET datos = EXCLUDED.datos, actualizado_en = NOW()`,
    [String(id), usuarioId, datos],
  );
  return true;
}

pool.connect((err, client) => {
  if (err) {
    console.error('Error conectando a PostgreSQL:', err);
    return;
  }

  client.release();
  console.log('Conectado a PostgreSQL en 34.237.136.123');
});

ensureSchema().catch((err) => {
  console.error('No se pudo preparar el esquema de PostgreSQL:', err);
});

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/auth/registro', async (req, res) => {
  const { nombre, email, password } = req.body;
  if (!nombre || !email || !password) {
    return res.status(400).json({ error: 'Nombre, email y contraseña son requeridos' });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      `INSERT INTO usuarios (nombre, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, nombre, email, creado_en`,
      [nombre, String(email).toLowerCase(), hash],
    );
    const user = r.rows[0];
    const token = signUser(user);
    res.json({ token, user });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Este correo ya está registrado' });
    }
    console.error(err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email y contraseña requeridos' });
  }

  try {
    const r = await pool.query('SELECT * FROM usuarios WHERE email = $1', [String(email).toLowerCase()]);
    const user = r.rows[0];
    if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Contraseña incorrecta' });

    const token = signUser(user);
    res.json({
      token,
      user: { id: user.id, nombre: user.nombre, email: user.email },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.get('/auth/verificar', auth, (req, res) => {
  res.json({ valido: true, user: req.user });
});

app.post('/auth/logout', auth, (_req, res) => {
  res.json({ ok: true });
});

TABLAS.forEach((tabla) => {
  app.get(`/${tabla}`, auth, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT id, datos, actualizado_en FROM ${tabla}
         WHERE usuario_id = $1
         ORDER BY actualizado_en DESC`,
        [req.user.id],
      );
      res.json(r.rows.map(toClientRow));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post(`/${tabla}`, auth, async (req, res) => {
    const { id, ...datos } = req.body;
    if (!id) return res.status(400).json({ error: 'ID requerido' });

    try {
      await upsertRegistro(tabla, req.user.id, { id, ...datos });
      res.json({ ok: true, id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post(`/${tabla}/sync`, auth, async (req, res) => {
    const registros = req.body;
    if (!Array.isArray(registros)) {
      return res.status(400).json({ error: 'Se esperaba un array' });
    }

    try {
      let sincronizados = 0;
      for (const item of registros) {
        if (await upsertRegistro(tabla, req.user.id, item)) sincronizados++;
      }
      res.json({ ok: true, sincronizados });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete(`/${tabla}/:id`, auth, async (req, res) => {
    try {
      await pool.query(`DELETE FROM ${tabla} WHERE id = $1 AND usuario_id = $2`, [req.params.id, req.user.id]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
});

app.post('/sync/completa', auth, async (req, res) => {
  const payload = {
    proyectos: req.body.proyectos,
    collars: req.body.collars,
    surveys: req.body.surveys,
    assays: req.body.assays,
    laboratorios: req.body.laboratorios,
    guardado: req.body.guardado,
  };

  let total = 0;
  try {
    for (const [tabla, items] of Object.entries(payload)) {
      if (!Array.isArray(items) || !TABLAS.includes(tabla)) continue;
      for (const item of items) {
        if (await upsertRegistro(tabla, req.user.id, item)) total++;
      }
    }
    res.json({ ok: true, total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`Backend en http://localhost:${port}`));
