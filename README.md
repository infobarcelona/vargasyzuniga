# Kit Legal — Back office Vargas y Zúñiga Abogados

Servicio que recibe la conversación del bot, califica al cliente con un
score de interés (0-100), y solo si supera el umbral mínimo agenda una
reunión real en Google Calendar y envía los dos correos de confirmación
(oficina + cliente). Por ahora NO está conectado a WhatsApp — se prueba
con la página web incluida en `public/index.html`.

## 1. Instalar dependencias

Este entorno donde escribí el código no tiene acceso a internet, así que
no pude correr `npm install` aquí. Hazlo tú en tu Mac:

```bash
cd vyz-backoffice
npm install
```

## 2. Completar las credenciales que faltan

El archivo `.env` ya viene con la mayoría de tus credenciales completadas
(Mongo, Gmail, Claude). Solo falta una cosa:

Abre el archivo JSON del Service Account que descargaste de Google Cloud
(`calendar-backoffice@vargas-zuniga-backoffice...`), copia TODO su
contenido como una sola línea, y pégalo como valor de la variable
`GOOGLE_SERVICE_ACCOUNT_JSON` dentro de `.env`, reemplazando el texto
`PEGA_AQUI_EL_JSON_COMPLETO_DEL_SERVICE_ACCOUNT`.

Tip para convertirlo a una sola línea desde la terminal de tu Mac:

```bash
cat /ruta/al/archivo-descargado.json | tr -d '\n'
```

Copia el resultado completo (empieza con `{"type": "service_account"...`)
y pégalo en el `.env`.

## 3. Probar en local (opcional, antes de Render)

```bash
npm start
```

Abre `http://localhost:3000` en el navegador y conversa con el bot como
si fueras un cliente. El panel de la derecha muestra el score en tiempo
real y te avisa cuando la cita queda agendada de verdad (vas a poder
verla aparecer en tu Google Calendar y vas a recibir los dos correos).

## 4. Desplegar en Render

1. Sube esta carpeta a un repositorio nuevo en GitHub (el `.gitignore`
   ya excluye `.env` y cualquier archivo `.json` del service account,
   así que no hay riesgo de subir las credenciales por error).
2. En Render: **New + → Web Service**, conecta el repo.
3. Build command: `npm install`
4. Start command: `npm start`
5. En la sección **Environment**, agrega cada variable del `.env`
   manualmente (Render no lee el archivo `.env` directamente, hay que
   pegarlas una por una en su panel).
6. Deploy. Cuando termine, vas a tener una URL tipo
   `https://kit-legal-vyz.onrender.com` — esa es la página de prueba
   que puedes compartir contigo mismo o con los abogados para probar
   el comportamiento del bot en un entorno real, sin tocar WhatsApp
   todavía.

## Cómo está armado (resumen rápido)

- `lib/prompt.js` — construye el system prompt dinámico (fecha, base de
  conocimiento, disponibilidad, score actual) que recibe Claude.
- `lib/anthropic.js` — llama a la API de Claude.
- `lib/dataExtractor.js` — extrae el bloque `###DATA###` de la respuesta
  y va acumulando los datos del cliente sin borrar lo ya capturado.
- `lib/scoring.js` — calcula el score 0-100 (urgencia, especificidad del
  caso, tipo de cliente, datos de contacto, cita propuesta).
- `lib/googleCalendar.js` — consulta disponibilidad y crea el evento real.
- `lib/mailer.js` — envía los dos correos (oficina y cliente).
- `lib/scheduler.js` — orquesta las 4 acciones cuando el lead califica,
  con manejo de fallos paso a paso (si falla Calendar, no se manda nada
  más; si falla el correo al cliente, no se aborta el resto).
- `server.js` — el endpoint `/api/chat` que une todo, con sesiones en
  memoria (suficiente para esta fase de pruebas).

## Pendiente para después

- Mover las sesiones de memoria a MongoDB (para que sobrevivan un
  reinicio del servidor en Render).
- Conectar un canal real (WhatsApp vía Baileys, o el widget embebido).

## Watcher del PJUD (audiencias)

Revisa la bandeja de `GMAIL_USER` por IMAP (usando la misma contraseña de
aplicación que ya configuraste), busca correos de `pjud.cl` que mencionen
una audiencia, descarga el Excel adjunto, busca en la tabla las filas
donde el rol sea "Defensor privado" y el nombre coincida con alguno de
los abogados configurados en `NOMBRES_ABOGADOS` (separados por `|` en el
`.env`), y crea el evento real en el Google Calendar con el RIT, tipo de
audiencia, fecha/hora, y los datos de Zoom extraídos del cuerpo del
correo.

Cada correo se marca como procesado en MongoDB (colección
`audiencias_procesadas`, por su `Message-ID`) para no crear el mismo
evento dos veces si el watcher corre de nuevo.

**Para probarlo manualmente** (sin esperar al ciclo automático), con el
servidor corriendo (`npm start`), en otra pestaña de terminal:

```bash
curl -X POST http://localhost:3000/api/pjud/run-once
```

Esto devuelve un resumen JSON: cuántos correos revisó, cuántos eventos
creó, y cualquier error encontrado en el camino.

**Ciclo automático:** mientras el servidor esté corriendo, revisa la
bandeja solo cada `PJUD_WATCHER_INTERVALO_MINUTOS` (10 por defecto). Si
despliegas en el plan gratuito de Render, ten en cuenta que el servicio
se "duerme" tras ~15 minutos sin tráfico — el watcher automático no corre
mientras está dormido. Para audiencias esto generalmente no es crítico
(se notifican con días de anticipación), pero si quieres que sea
inmediato, lo ideal a futuro es un plan de Render que no duerma, o un
Cron Job dedicado que llame al endpoint manual cada X minutos.
