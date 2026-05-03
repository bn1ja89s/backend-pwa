# Backend PWA

Backend Node.js para autenticar usuarios y sincronizar datos offline-first de la PWA con PostgreSQL.

## Uso

1. Edita `.env` y reemplaza `TU_PASSWORD_DEL_SERVIDOR`.
2. Instala dependencias:

```bash
npm install
```

3. Inicia el servidor:

```bash
npm start
```

El servidor expone `https://backend-pwa-production.up.railway.app` y crea las tablas necesarias si no existen.
