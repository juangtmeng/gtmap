// ============================================================
// GTM AUDIT PLATFORM — Google Apps Script Backend
// MVP: usa claude-haiku-4-5 (rápido, económico)
// Para producción: cambiar MODEL a 'claude-opus-4-7-20250514'
// ============================================================

const ANTHROPIC_API_KEY = 'REEMPLAZAR_CON_TU_API_KEY';
const SHEET_ID           = 'REEMPLAZAR_CON_ID_DE_SPREADSHEET';
const DRIVE_FOLDER_ID    = 'REEMPLAZAR_CON_ID_DE_CARPETA_DRIVE'; // opcional, usa raíz si se deja
const CALENDLY_URL       = 'REEMPLAZAR_CON_TU_CALENDLY_URL';     // opcional

const MODEL = 'claude-haiku-4-5-20251001'; // MVP — cambiar a claude-opus-4-7-20250514 para producción

// ============================================================
// ENTRY POINT
// ============================================================

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    if (data.type === 'entrada')      procesarEntrada(data);
    else if (data.type === 'cuestionario') procesarCuestionario(data);
    return ContentService.createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.TEXT);
  } catch (err) {
    Logger.log('Error en doPost: ' + err.message + '\n' + err.stack);
    return ContentService.createTextOutput(JSON.stringify({ error: err.message }))
      .setMimeType(ContentService.MimeType.TEXT);
  }
}

// ============================================================
// FORM 1 — ENTRADA
// ============================================================

function procesarEntrada(data) {
  const sid = data.sessionId;

  // 1. Guardar sesión inicial
  guardarSesion({
    session_id: sid,
    url:        data.url,
    vertical:   data.vertical,
    modelo:     data.modelo,
    nombre:     data.nombre,
    email:      data.email,
    rol:        data.rol || '',
    status:     'scraping',
    created_at: new Date().toISOString()
  });

  // 2. Scrapear el sitio
  const scraped = scrapearSitio(data.url);
  actualizarSesion(sid, { scraped_content: scraped.substring(0, 5000), status: 'auditando' });

  // 3. Auditoría con Claude
  const auditoria = llamarClaude(
    buildSystemPrompt1(data.vertical, data.modelo),
    buildUserPrompt1(data.url, data.vertical, data.modelo, scraped),
    2000
  );

  // 4. Guardar resultado
  actualizarSesion(sid, {
    auditoria_output:    auditoria,
    status:              'audit_ready',
    audit_completed_at:  new Date().toISOString()
  });
}

// ============================================================
// FORM 2 — CUESTIONARIO
// ============================================================

function procesarCuestionario(data) {
  const sid = data.sessionId;
  const respuestasJson = JSON.stringify(data.respuestas, null, 2);

  // 1. Guardar respuestas y esperar auditoría
  actualizarSesion(sid, { respuestas_json: respuestasJson, status: 'esperando_auditoria' });

  // 2. Esperar que la auditoría esté lista (máx 5 min)
  let sesion = null;
  for (let i = 0; i < 30; i++) {
    sesion = leerSesion(sid);
    if (sesion && sesion.status === 'audit_ready') break;
    Utilities.sleep(10000);
  }
  if (!sesion || sesion.status !== 'audit_ready') {
    Logger.log('Timeout esperando auditoría para sesión: ' + sid);
    // Continuamos igual — si hay algo de auditoría lo usamos
    sesion = leerSesion(sid) || {};
  }

  actualizarSesion(sid, { status: 'generando_framework' });

  // 3. ICPs
  const icps = llamarClaude(
    buildSystemPrompt2(),
    buildUserPrompt2(sesion.auditoria_output || '', respuestasJson, sesion.modelo || data.modelo),
    1500
  );
  actualizarSesion(sid, { icps_output: icps });

  // 4. Buyer Personas
  const personas = llamarClaude(
    buildSystemPrompt3(),
    buildUserPrompt3(icps, sesion.auditoria_output || '', respuestasJson),
    1500
  );
  actualizarSesion(sid, { personas_output: personas });

  // 5. Framework completo
  const framework = llamarClaude(
    buildSystemPrompt4(),
    buildUserPrompt4(
      sesion.auditoria_output || '', respuestasJson, icps, personas,
      sesion.vertical || data.vertical, sesion.modelo || data.modelo
    ),
    3000
  );
  actualizarSesion(sid, { framework_output: framework });

  // 6. Validación
  const validacion = llamarClaude(
    buildSystemPrompt5(),
    buildUserPrompt5(framework, sesion.auditoria_output || '', respuestasJson),
    500
  );
  actualizarSesion(sid, { validacion_result: validacion });

  // 7. Crear Google Doc + PDF
  const pdfUrl = crearDocYPdf(sesion, data, icps, personas, framework);
  actualizarSesion(sid, { pdf_url: pdfUrl });

  // 8. Enviar email
  const emailDest = sesion.email || data.email;
  const nombreDest = sesion.nombre || data.nombre;
  enviarEmail(emailDest, nombreDest, pdfUrl);

  // 9. Marcar entregado
  actualizarSesion(sid, { status: 'delivered', email_sent_at: new Date().toISOString() });
}

// ============================================================
// CLAUDE API
// ============================================================

function llamarClaude(systemPrompt, userPrompt, maxTokens) {
  const payload = {
    model:      MODEL,
    max_tokens: maxTokens,
    system:     systemPrompt,
    messages:   [{ role: 'user', content: userPrompt }]
  };
  const options = {
    method:           'post',
    headers: {
      'x-api-key':          ANTHROPIC_API_KEY,
      'anthropic-version':  '2023-06-01',
      'content-type':       'application/json'
    },
    payload:          JSON.stringify(payload),
    muteHttpExceptions: true
  };
  const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', options);
  const result   = JSON.parse(response.getContentText());
  if (result.error) throw new Error('Claude API: ' + result.error.message);
  return result.content[0].text;
}

// ============================================================
// SCRAPING
// ============================================================

function scrapearSitio(url) {
  try {
    const resp = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects:    true,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GTMAudit/1.0)' }
    });
    const html = resp.getContentText();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 30000);
  } catch (e) {
    return 'No se pudo scrapear el sitio: ' + e.message;
  }
}

// ============================================================
// GOOGLE SHEETS
// ============================================================

const COLUMNS = [
  'session_id','url','vertical','modelo','nombre','email','rol','status',
  'scraped_content','auditoria_output','respuestas_json','icps_output',
  'personas_output','framework_output','validacion_result','pdf_url',
  'created_at','audit_completed_at','email_sent_at'
];

function getSheet() {
  const ss    = SpreadsheetApp.openById(SHEET_ID);
  let   sheet = ss.getSheetByName('sessions');
  if (!sheet) {
    sheet = ss.insertSheet('sessions');
    sheet.appendRow(COLUMNS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function guardarSesion(data) {
  const sheet = getSheet();
  const row   = COLUMNS.map(col => data[col] || '');
  sheet.appendRow(row);
}

function actualizarSesion(sessionId, updates) {
  const sheet  = getSheet();
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === sessionId) {
      for (const [key, val] of Object.entries(updates)) {
        const col = COLUMNS.indexOf(key);
        if (col !== -1) sheet.getRange(i + 1, col + 1).setValue(val);
      }
      return;
    }
  }
}

function leerSesion(sessionId) {
  const sheet  = getSheet();
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === sessionId) {
      const obj = {};
      COLUMNS.forEach((col, j) => obj[col] = values[i][j]);
      return obj;
    }
  }
  return null;
}

// ============================================================
// GOOGLE DOCS + PDF
// ============================================================

function crearDocYPdf(sesion, formData, icps, personas, framework) {
  const nombre   = sesion.nombre   || formData.nombre   || 'Cliente';
  const vertical = sesion.vertical || formData.vertical || '';
  const modelo   = sesion.modelo   || formData.modelo   || '';
  const url      = sesion.url      || formData.url      || '';
  const fecha    = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const titulo   = `GTM Framework — ${nombre} — ${fecha}`;

  const doc  = DocumentApp.create(titulo);
  const body = doc.getBody();

  body.appendParagraph('AUDITORÍA DE GROWTH MARKETING + GTM FRAMEWORK')
      .setHeading(DocumentApp.ParagraphHeading.HEADING1);
  body.appendParagraph(`Empresa: ${url}  |  Vertical: ${vertical}  |  Modelo: ${modelo}  |  Fecha: ${fecha}`);
  body.appendHorizontalRule();

  body.appendParagraph('SECCIÓN 1 — AUDITORÍA DEL SITIO')
      .setHeading(DocumentApp.ParagraphHeading.HEADING2);
  body.appendParagraph(sesion.auditoria_output || 'En proceso...');
  body.appendHorizontalRule();

  body.appendParagraph('SECCIÓN 2 — ICPs (IDEAL CUSTOMER PROFILES)')
      .setHeading(DocumentApp.ParagraphHeading.HEADING2);
  body.appendParagraph(icps);
  body.appendHorizontalRule();

  body.appendParagraph('SECCIÓN 3 — BUYER PERSONAS')
      .setHeading(DocumentApp.ParagraphHeading.HEADING2);
  body.appendParagraph(personas);
  body.appendHorizontalRule();

  body.appendParagraph('SECCIÓN 4 — GTM FRAMEWORK COMPLETO')
      .setHeading(DocumentApp.ParagraphHeading.HEADING2);
  body.appendParagraph(framework);

  doc.saveAndClose();

  // Exportar como PDF
  const docFile = DriveApp.getFileById(doc.getId());
  const pdfBlob = docFile.getAs('application/pdf').setName(`GTM Framework — ${nombre}.pdf`);

  let folder;
  try   { folder = DriveApp.getFolderById(DRIVE_FOLDER_ID); }
  catch { folder = DriveApp.getRootFolder(); }

  const pdfFile = folder.createFile(pdfBlob);
  pdfFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  return pdfFile.getUrl();
}

// ============================================================
// EMAIL
// ============================================================

function enviarEmail(email, nombre, pdfUrl) {
  const asunto = `Tu auditoría + GTM Framework está lista, ${nombre.split(' ')[0]}`;
  const html = `
<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#1e293b">
  <h2 style="font-size:20px;margin-bottom:8px">Hola ${nombre.split(' ')[0]} 👋</h2>
  <p style="color:#64748b;margin-bottom:20px">Tu auditoría y GTM Framework están listos.</p>

  <p style="margin-bottom:16px">Lo que encontrás en el documento:</p>
  <ul style="color:#374151;padding-left:20px;margin-bottom:20px;line-height:1.8">
    <li>Auditoría completa de tu sitio y presencia digital</li>
    <li>ICPs definidos para tu modelo ${nombre ? '' : ''}</li>
    <li>Buyer Personas con quotes reales</li>
    <li>Customer Journey por etapa</li>
    <li>Plan de Acción 90/180/365 días con KPIs</li>
  </ul>

  <a href="${pdfUrl}" style="display:inline-block;background:#1e293b;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin-bottom:24px">
    → Ver el PDF completo
  </a>

  ${CALENDLY_URL && CALENDLY_URL !== 'REEMPLAZAR_CON_TU_CALENDLY_URL'
    ? `<p style="margin-bottom:8px">Si querés que lo repasemos juntos, <a href="${CALENDLY_URL}" style="color:#3b82f6">agendá 30 min acá</a>.</p>`
    : ''}

  <p style="color:#94a3b8;font-size:13px;margin-top:24px;border-top:1px solid #f1f5f9;padding-top:16px">
    Respondé este mail si tenés alguna duda.
  </p>
</div>`;

  MailApp.sendEmail({
    to:          email,
    subject:     asunto,
    htmlBody:    html,
    body:        `Hola ${nombre},\n\nTu auditoría + GTM Framework están listos.\n\nVer PDF: ${pdfUrl}\n\nSaludos.`
  });
}

// ============================================================
// PROMPTS
// ============================================================

function buildSystemPrompt1(vertical, modelo) {
  return `Sos un auditor senior de Growth Marketing especializado en empresas de ${vertical} con modelo ${modelo}. Producís auditorías rigurosas y accionables, sin fluff.

REGLAS:
- Solo hallazgos soportados por evidencia del input. Si no podés verificar algo, escribí "Sin confirmar".
- Diferenciá FORTALEZAS de GAPS. Asigná urgencia: CRÍTICO / ALTO / MEDIO.
- Idioma: español rioplatense, profesional, directo.
- Formato: Markdown con H2 por sección.`;
}

function buildUserPrompt1(url, vertical, modelo, scraped) {
  return `EMPRESA A AUDITAR
URL: ${url}
Vertical: ${vertical}
Modelo comercial: ${modelo}

CONTENIDO DEL SITIO:
${scraped.substring(0, 20000)}

PRODUCÍ una auditoría con estas secciones:
1. Resumen ejecutivo (hallazgos clave + tabla URGENCIA × HALLAZGO)
2. Perfil del negocio (lo reconstruido desde afuera)
3. Análisis web y comunicación (UX, propuesta de valor, tono)
4. Análisis de funnel (dónde está la fuga)
5. Stack tecnológico detectado (qué tienen / qué falta)
6. Hallazgos críticos (máx 5, ordenados por urgencia)

NO prescribas soluciones — el framework las trae.`;
}

function buildSystemPrompt2() {
  return `Sos estratega senior de Go-to-Market. Definís ICPs basándote ESTRICTAMENTE en los datos provistos. Los ICPs tienen que ser específicos, accionables y defendibles. No usás plantillas genéricas.`;
}

function buildUserPrompt2(auditoria, respuestas, modelo) {
  return `AUDITORÍA:
${auditoria}

RESPUESTAS DEL CUESTIONARIO:
${respuestas}

Modelo comercial: ${modelo}

Generá 1 a 2 ICPs. Por cada uno incluí:
- Nombre del segmento (específico, ej: "Agencias boutique 5-15 personas LATAM")
- Firmográficos (B2B) o arquetipo demográfico/psicográfico (B2C)
- Trigger de compra: qué situación los lleva a buscar esta solución
- Señales observables
- Canales donde están presentes (con nombres concretos)
- Mensaje ancla (una sola oración)
- Score 1-10 en volumen y en facilidad de cierre`;
}

function buildSystemPrompt3() {
  return `Creás buyer personas que se leen como personas reales, no como clichés de marketing. Las quotes tienen que sonar humanas — si arranca con "necesito una solución que..." está mal.`;
}

function buildUserPrompt3(icps, auditoria, respuestas) {
  return `ICPs DEFINIDOS:
${icps}

CONTEXTO (auditoría + cuestionario):
${auditoria.substring(0, 2000)}
${respuestas}

Para CADA ICP, creá UNA buyer persona con:
1. Nombre ficticio + edad + puesto o situación de vida
2. Un día en su vida (1 párrafo narrativo, concreto)
3. Frustraciones reales (3, específicas)
4. Objeciones de compra (3: por qué NO compraría)
5. 3 quotes literales que diría en voz alta en una conversación`;
}

function buildSystemPrompt4() {
  return `Consolidás el Growth Marketing Framework final. Es el entregable principal del servicio. Todo referencia datos REALES del cliente. Priorizás acción concreta sobre teoría.`;
}

function buildUserPrompt4(auditoria, respuestas, icps, personas, vertical, modelo) {
  const modeloInstr = modelo === 'B2B'
    ? 'Incluí Scoring Model (Firmográficos 40% + Behavioral 35% + Engagement 25%).'
    : modelo === 'B2C'
    ? 'Incluí Ciclo de Recompra y Advocacy en lugar de Scoring.'
    : 'Incluí ambos: Scoring B2B y Ciclo de Recompra B2C.';

  return `INPUTS:
Auditoría: ${auditoria}
Respuestas: ${respuestas}
ICPs: ${icps}
Buyer Personas: ${personas}
Vertical: ${vertical} | Modelo: ${modelo}

ESTRUCTURA DEL FRAMEWORK (5 secciones):

1. Business Goals
   Objetivo 12 meses + breakdown trimestral + KPIs macro

2. Customer Journey
   Por etapa (Awareness → Consideration → Decision → Retention → Advocacy):
   - Touchpoints concretos (con nombres de plataformas)
   - Pieza de contenido necesaria por etapa
   - Métrica de paso a la siguiente etapa

3. Funnel + KPIs
   Por etapa: métrica + benchmark del vertical + tasa objetivo

4. Content Strategy
   4 líneas editoriales con descripción, ejemplo y canal por ICP

5. Plan de Acción 90 días
   3-5 iniciativas concretas + responsable sugerido + KPI cuantificado

${modeloInstr}
Nada de "contenido de valor" o touchpoints genéricos — todo tiene que tener nombre específico.`;
}

function buildSystemPrompt5() {
  return `Sos editor crítico del framework. Detectás problemas antes de que llegue al cliente. NO reescribís — solo identificás gaps.`;
}

function buildUserPrompt5(framework, auditoria, respuestas) {
  return `FRAMEWORK GENERADO:
${framework}

INPUTS PARA COTEJAR:
Auditoría: ${auditoria.substring(0, 1500)}
Cuestionario: ${respuestas}

Evaluá:
1. ¿Hay datos inventados no presentes en los inputs?
2. ¿Faltan secciones obligatorias?
3. ¿El plan de acción tiene KPIs cuantificados?
4. ¿Los ICPs están conectados con el journey?

Si está OK: respondé exactamente "FRAMEWORK_OK" en la primera línea.
Si hay problemas: listá cada uno con severidad BLOQUEANTE o AJUSTE MENOR.`;
}
