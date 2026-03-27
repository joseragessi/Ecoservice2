# EcoService Bot — Incidencias WhatsApp

Bot de WhatsApp para registro y clasificación automática de incidencias de equipos.

## Stack
- Node.js + Express (Railway)
- Twilio WhatsApp API
- Supabase (PostgreSQL)

## Archivos
```
index.js          → servidor Express + webhook Twilio
conversacion.js   → motor de sesiones y flujo de 3 pasos
prioridad.js      → lógica de clasificación (crítico/alta/media/baja)
mecanico.js       → asignación automática por habilidades
supabase.js       → cliente Supabase
```

## Setup local

```bash
npm install
cp .env.example .env
# Completar variables en .env
npm run dev
```

## Variables de entorno (Railway)

| Variable                  | Descripción                              |
|---------------------------|------------------------------------------|
| `TWILIO_ACCOUNT_SID`      | Account SID de Twilio                    |
| `TWILIO_AUTH_TOKEN`       | Auth Token de Twilio                     |
| `TWILIO_WHATSAPP_NUMBER`  | Número sandbox: `whatsapp:+14155238886`  |
| `SUPABASE_URL`            | URL del proyecto Supabase                |
| `SUPABASE_SERVICE_KEY`    | Service role key (no la anon key)        |
| `PORT`                    | Railway lo inyecta automáticamente       |

## Deploy en Railway

1. Crear nuevo proyecto en Railway → Deploy from GitHub
2. Agregar las variables de entorno
3. Railway detecta `package.json` y corre `npm start`
4. Copiar la URL pública: `https://tu-proyecto.railway.app`

## Configurar webhook en Twilio

1. Twilio Console → Messaging → Sandbox settings
2. `When a message comes in`: `https://tu-proyecto.railway.app/webhook`
3. Método: `POST`

## Flujo de conversación

```
Capataz envía cualquier mensaje
  → Bot reconoce número → identifica capataz + objetivo
  → P1: ¿Qué equipo? (lista numerada)
  → P2: ¿Está parado? (1/2/3)
  → P3: Describí la falla (texto libre)
  → Clasificación automática de prioridad
  → Asignación de mecánico por habilidades
  → Incidencia creada en Supabase
  → Confirmación con ID al capataz
```

## Prioridades

| Prioridad | Condición                              | SLA         |
|-----------|----------------------------------------|-------------|
| Crítico   | Equipo completamente parado            | Inmediato   |
| Alta      | Operativo con falla importante         | 24-48 hs    |
| Media     | Falla menor, equipo funciona           | 2-4 días    |
| Baja      | Mantenimiento / desgaste               | +5 días     |
