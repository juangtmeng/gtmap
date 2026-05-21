// ============================================================
// GTM AUDIT PLATFORM — Google Apps Script Backend v2
// Usa triggers para evitar el límite de 6 minutos
// ============================================================

const ANTHROPIC_API_KEY = 'REEMPLAZAR_CON_TU_API_KEY';
const SHEET_ID           = '13Au6x0O_e86MprkMc_3CJoqOm7K2re7hPT8RnFdBNng';
const DRIVE_FOLDER_ID    = 'REEMPLAZAR_CON_ID_DE_CARPETA_DRIVE';
const CALENDLY_URL       = 'REEMPLAZAR_CON_TU_CALENDLY_URL';

// Modelo híbrido: Haiku (rápido/económico) para auditoría, ICPs, personas y validación.
// Opus (premium) solo para el Framework, que es la pieza que el cliente percibe como "inteligente".
const MODEL_RAPIDO  = 'claude-haiku-4-5-20251001';
const MODEL_PREMIUM = 'claude-opus-4-7';

// ============================================================
// ENTRY POINT
// ============================================================

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    if (data.type === 'entrada')           procesarEntrada(data);
    else if (data.type === 'cuestionario') encolarCuestionario(data);
    return ContentService.createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.TEXT);
  } catch (err) {
    Logger.log('Error doPost: ' + err.message);
    return ContentService.createTextOutput(JSON.stringify({ error: err.message }))
      .setMimeType(ContentService.MimeType.TEXT);
  }
}

// doGet — usado por el configurador white-label para el "preview real":
// corre la auditoría (Haiku) sobre el cliente de prueba y devuelve JSON legible
// cross-origin para mostrarlo en pantalla con la marca de la consultora.
function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    if (p.action === 'preview') {
      const url      = p.url || '';
      const vertical = p.vertical || 'SaaS / Software';
      const ciudad   = p.ciudad || '';
      if (!url) return jsonOut({ error: 'Falta la URL del cliente.' }, p.callback);

      const scraped = scrapearSitio(url);
      // Auditoría con Haiku (rápido/económico), recortada para que el preview salga ágil
      const auditoria = llamarClaude(
        buildSystemPrompt1(vertical, 'Mixto'),
        buildUserPrompt1(url, vertical, 'Mixto', scraped, ciudad),
        1600
      );
      return jsonOut({ auditoria: auditoria }, p.callback);
    }
    return jsonOut({ ok: true, msg: 'GTM platform endpoint activo.' }, p.callback);
  } catch (err) {
    Logger.log('Error doGet: ' + err.message);
    return jsonOut({ error: err.message }, p.callback);
  }
}

// Devuelve JSONP si viene ?callback (evita CORS al leer desde el navegador), o JSON normal.
function jsonOut(obj, callback) {
  const json = JSON.stringify(obj);
  if (callback) {
    return ContentService.createTextOutput(callback + '(' + json + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// FORM 1 — corre síncronamente en doPost (~2-3 min, ok)
// ============================================================

function procesarEntrada(data) {
  const sid = data.sessionId;

  guardarSesion({
    session_id: sid, url: data.url, vertical: data.vertical,
    modelo: data.modelo, nombre: data.nombre, email: data.email,
    rol: data.rol || '', ciudad: data.ciudad || '', status: 'scraping',
    created_at: new Date().toISOString()
  });

  const scraped = scrapearSitio(data.url);
  actualizarSesion(sid, { scraped_content: scraped.substring(0, 5000), status: 'auditando' });

  const auditoria = llamarClaude(
    buildSystemPrompt1(data.vertical, data.modelo),
    buildUserPrompt1(data.url, data.vertical, data.modelo, scraped, data.ciudad),
    2000
  );

  actualizarSesion(sid, {
    auditoria_output: auditoria,
    status: 'audit_ready',
    audit_completed_at: new Date().toISOString()
  });
}

// ============================================================
// FORM 2 — guarda datos y crea un trigger (retorna en <1 seg)
// ============================================================

function encolarCuestionario(data) {
  const sid = data.sessionId;

  const actual = leerSesion(sid);
  const nuevoStatus = (actual && actual.status === 'audit_ready') ? 'audit_ready' : 'esperando_auditoria';
  if (actual) {
    actualizarSesion(sid, {
      respuestas_json: JSON.stringify(data.respuestas, null, 2),
      status: nuevoStatus
    });
  }

  // Guardar TODO en PropertiesService (respaldo por si la fila aún no existe)
  PropertiesService.getScriptProperties().setProperty(
    'session_' + sid,
    JSON.stringify({
      sessionId: sid, email: data.email, nombre: data.nombre,
      respuestas_json: JSON.stringify(data.respuestas, null, 2), intento: 0
    })
  );
  PropertiesService.getScriptProperties().setProperty('ultimo_sid', sid);

  // Disparar trigger en 30 segundos
  crearTrigger('triggerICPsPersonas', 30);
}

// ============================================================
// TRIGGER 1 — ICPs + Personas (se ejecuta con su propio límite de 6 min)
// ============================================================

function triggerICPsPersonas() {
  const props = PropertiesService.getScriptProperties();
  const sid   = props.getProperty('ultimo_sid');
  if (!sid) return;

  const meta  = JSON.parse(props.getProperty('session_' + sid) || '{}');
  const sesion = leerSesion(sid);
  const intento = (meta.intento || 0) + 1;

  // Si la fila aún no existe o la auditoría no terminó → re-agendar
  if (!sesion || (!sesion.auditoria_output && sesion.status !== 'audit_ready')) {
    if (intento > 10) {
      Logger.log('Timeout esperando auditoría para ' + sid);
      if (sesion) actualizarSesion(sid, { status: 'error_timeout_auditoria' });
      props.deleteProperty('session_' + sid);
      return;
    }
    meta.intento = intento;
    props.setProperty('session_' + sid, JSON.stringify(meta));
    crearTrigger('triggerICPsPersonas', 60);
    return;
  }

  // Guardar respuestas desde PropertiesService si la fila las tiene vacías
  if (!sesion.respuestas_json && meta.respuestas_json) {
    actualizarSesion(sid, { respuestas_json: meta.respuestas_json, status: 'audit_ready' });
    sesion.respuestas_json = meta.respuestas_json;
  }

  actualizarSesion(sid, { status: 'generando_icps' });

  const icps = llamarClaude(
    buildSystemPrompt2(sesion.vertical),
    buildUserPrompt2(sesion.auditoria_output, sesion.respuestas_json, sesion.modelo, sesion.vertical),
    1500
  );
  actualizarSesion(sid, { icps_output: icps });

  const personas = llamarClaude(
    buildSystemPrompt3(sesion.vertical),
    buildUserPrompt3(icps, sesion.auditoria_output, sesion.respuestas_json, sesion.vertical),
    1500
  );
  actualizarSesion(sid, { personas_output: personas, status: 'generando_framework' });

  // Disparar Trigger 2 en 5 segundos
  crearTrigger('triggerFrameworkEmail', 5);
}

// ============================================================
// TRIGGER 2 — Framework + Validación + PDF + Email
// ============================================================

function triggerFrameworkEmail() {
  const props  = PropertiesService.getScriptProperties();
  const sid    = props.getProperty('ultimo_sid');
  if (!sid) return;

  const sesion = leerSesion(sid);
  if (!sesion) return;

  const framework = llamarClaude(
    buildSystemPrompt4(sesion.vertical),
    buildUserPrompt4(
      sesion.auditoria_output, sesion.respuestas_json,
      sesion.icps_output, sesion.personas_output,
      sesion.vertical, sesion.modelo
    ),
    5000,
    MODEL_PREMIUM
  );
  actualizarSesion(sid, { framework_output: framework });

  const validacion = llamarClaude(
    buildSystemPrompt5(),
    buildUserPrompt5(framework, sesion.auditoria_output, sesion.respuestas_json),
    500
  );
  actualizarSesion(sid, { validacion_result: validacion });

  const pdfUrl = crearDocYPdf(sesion, sesion.icps_output, sesion.personas_output, framework);
  actualizarSesion(sid, { pdf_url: pdfUrl });

  enviarEmail(sesion.email, sesion.nombre, pdfUrl);

  actualizarSesion(sid, { status: 'delivered', email_sent_at: new Date().toISOString() });

  // Limpiar
  props.deleteProperty('session_' + sid);
  props.deleteProperty('ultimo_sid');
}

// ============================================================
// HELPERS — Triggers
// ============================================================

function crearTrigger(fnName, delaySeconds) {
  // Eliminar triggers previos con el mismo nombre
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === fnName) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger(fnName).timeBased().after(delaySeconds * 1000).create();
}

// ============================================================
// CLAUDE API
// ============================================================

function llamarClaude(systemPrompt, userPrompt, maxTokens, model) {
  const options = {
    method: 'post',
    headers: {
      'x-api-key':         ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json'
    },
    payload: JSON.stringify({
      model: model || MODEL_RAPIDO, max_tokens: maxTokens, system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    }),
    muteHttpExceptions: true
  };
  const resp   = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', options);
  const result = JSON.parse(resp.getContentText());
  if (result.error) throw new Error('Claude: ' + result.error.message);
  return result.content[0].text;
}

// ============================================================
// SCRAPING
// ============================================================

function scrapearSitio(url) {
  try {
    const resp = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true, followRedirects: true,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GTMAudit/1.0)' }
    });
    return resp.getContentText()
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ').trim()
      .substring(0, 30000);
  } catch (e) { return 'No se pudo scrapear: ' + e.message; }
}

// ============================================================
// GOOGLE SHEETS
// ============================================================

const COLUMNS = [
  'session_id','url','vertical','modelo','nombre','email','rol','status',
  'scraped_content','auditoria_output','respuestas_json','icps_output',
  'personas_output','framework_output','validacion_result','pdf_url',
  'created_at','audit_completed_at','email_sent_at','ciudad'
];

function getSheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName('sessions');
  if (!sheet) {
    sheet = ss.insertSheet('sessions');
    sheet.appendRow(COLUMNS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function guardarSesion(data) {
  getSheet().appendRow(COLUMNS.map(c => data[c] || ''));
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
      COLUMNS.forEach((c, j) => obj[c] = values[i][j]);
      return obj;
    }
  }
  return null;
}

// ============================================================
// GOOGLE DOCS + PDF
// ============================================================

function crearDocYPdf(sesion, icps, personas, framework) {
  const nombre = sesion.nombre || 'Cliente';
  const fecha  = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const doc    = DocumentApp.create(`GTM Framework — ${nombre} — ${fecha}`);
  const body   = doc.getBody();

  body.appendParagraph('AUDITORÍA DE GROWTH MARKETING + GTM FRAMEWORK')
      .setHeading(DocumentApp.ParagraphHeading.HEADING1);
  body.appendParagraph(`${sesion.url}  |  ${sesion.vertical}  |  ${sesion.modelo}  |  ${fecha}`);
  body.appendHorizontalRule();

  body.appendParagraph('AUDITORÍA').setHeading(DocumentApp.ParagraphHeading.HEADING2);
  body.appendParagraph(sesion.auditoria_output || '');
  body.appendHorizontalRule();

  body.appendParagraph('ICPs').setHeading(DocumentApp.ParagraphHeading.HEADING2);
  body.appendParagraph(icps || sesion.icps_output || '');
  body.appendHorizontalRule();

  body.appendParagraph('BUYER PERSONAS').setHeading(DocumentApp.ParagraphHeading.HEADING2);
  body.appendParagraph(personas || sesion.personas_output || '');
  body.appendHorizontalRule();

  body.appendParagraph('GTM FRAMEWORK').setHeading(DocumentApp.ParagraphHeading.HEADING2);
  body.appendParagraph(framework);
  doc.saveAndClose();

  const docFile = DriveApp.getFileById(doc.getId());
  const pdf     = docFile.getAs('application/pdf').setName(`GTM Framework — ${nombre}.pdf`);

  let folder;
  try   { folder = DriveApp.getFolderById(DRIVE_FOLDER_ID); }
  catch { folder = DriveApp.getRootFolder(); }

  const pdfFile = folder.createFile(pdf);
  pdfFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return pdfFile.getUrl();
}

// ============================================================
// EMAIL
// ============================================================

function enviarEmail(email, nombre, pdfUrl) {
  const n = (nombre || 'ahí').split(' ')[0];
  MailApp.sendEmail({
    to: email,
    subject: `Tu auditoría + GTM Framework está lista, ${n}`,
    htmlBody: `
<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#1e293b">
  <h2>Hola ${n} 👋</h2>
  <p style="color:#64748b">Tu auditoría y GTM Framework están listos.</p>
  <ul style="line-height:1.9;margin:16px 0">
    <li>Auditoría de tu sitio y presencia digital</li>
    <li>ICPs definidos para tu modelo</li>
    <li>Buyer Personas con quotes reales</li>
    <li>Customer Journey + Funnel + KPIs</li>
    <li>Plan de Acción 90 días</li>
  </ul>
  <a href="${pdfUrl}" style="display:inline-block;background:#1e293b;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">→ Ver el PDF completo</a>
  <p style="margin-top:24px;color:#94a3b8;font-size:13px">Respondé este mail si tenés dudas.</p>
</div>`,
    body: `Hola ${n},\n\nTu GTM Framework está listo.\n\nVer PDF: ${pdfUrl}`
  });
}

// ============================================================
// PROMPTS — sistema ramificado por vertical + regla anti-KPI
// ============================================================

// Regla dura inyectada en todos los prompts que producen números.
// Resuelve el miedo #1 de los buyer personas: KPIs inventados.
const REGLA_KPI = `REGLA INNEGOCIABLE SOBRE NÚMEROS:
- NUNCA inventes cifras precisas (prohibido "subir conversión 30%", "generar 50 leads/mes").
- Cada número lleva su SUPUESTO visible entre paréntesis. Ej: "+25-35% (asumiendo tu tráfico actual y benchmark de tu categoría)".
- Si el dato depende de info que el cliente NO aportó, escribí el placeholder [TU DATO: ___] y aclará "completá con tu número real".
- Usá RANGOS con banda, no valores redondos. Citá la fuente del benchmark ("benchmark de e-commerce LATAM", etc.).
- Todo número tiene que ser DEFENDIBLE: si no podés justificar de dónde sale, no lo pongas.`;

// Regla anti-alucinación de HECHOS (no solo números). Nació de un bug real:
// el modelo presumió que una empresa de Tucumán operaba en CABA por el nombre de una calle.
const REGLA_HECHOS = `REGLA INNEGOCIABLE SOBRE HECHOS NO VERIFICABLES:
- NUNCA infieras ni "presumas" datos que no estén EXPLÍCITOS en el contenido provisto: ubicación/ciudad, antigüedad, tamaño, facturación, cantidad de clientes, sucursales, etc.
- PROHIBIDO deducir la ubicación a partir de nombres de calles, códigos postales o señales ambiguas. Ej: "Chacabuco 27" NO implica CABA — esa misma calle existe en decenas de ciudades argentinas.
- La UBICACIÓN de la empresa la provee el cliente (dato "Ciudad/zona de operación"). Usá EXCLUSIVAMENTE ese dato. Si no está, escribí "Ubicación no provista" y NO la inventes.
- Si cualquier hecho no está confirmado en los inputs, escribí "No detectado" y NO construyas análisis sobre él. Jamás uses la palabra "presumible" como excusa para tratar una suposición como dato.`;

// Configuración por vertical: vocabulario, funnel, métricas y tácticas
// propias de cada negocio. El e-commerce deja de recibir funnel B2B renombrado.
function configVertical(vertical) {
  const v = (vertical || '').toLowerCase();

  if (v.indexOf('ecommerce') !== -1 || v.indexOf('e-commerce') !== -1 || v.indexOf('producto') !== -1) {
    return {
      tipo: 'ecommerce',
      perfilAuditor: 'auditor senior de growth para e-commerce y marcas DTC, obsesionado con ROAS, AOV, recompra y CAC',
      funnel: 'Visita → Add-to-cart → Checkout → Compra → Recompra → Advocacy (NO uses funnel B2B IQL/MQL/SQL)',
      metricas: 'tasa de conversión, AOV (ticket promedio), ROAS, CAC, LTV, tasa de recompra, tasa de abandono de carrito, frecuencia de compra',
      segmentos: 'segmentos de cliente + cohortes por LTV + análisis RFM (recencia/frecuencia/monto). NADA de "ICP firmográfico" ni "comité de compra".',
      tacticas: 'estructura de campañas Meta (ASC vs manual, ángulos de creativo), Google Shopping/PMax, flujos de email/Klaviyo (bienvenida, carrito abandonado, post-compra, win-back), bundles y order-bumps para subir AOV, programa de fidelización/recompra, reviews y UGC',
      stack: 'Shopify/Tienda Nube, Klaviyo o email marketing, Meta Ads, Google Ads/Shopping, apps de reviews/upsell, GA4, pixel',
      tono: 'directo, de plata sobre la mesa. El dueño de e-commerce odia la teoría: hablá de qué campaña, qué creativo, qué flujo, qué bundle, con qué impacto estimado.',
      benchmarks: `BENCHMARKS REALES DE E-COMMERCE (usá estos como referencia, citá la banda, ajustá por categoría):
- Tasa de conversión: promedio global 1.9-2% (Shopify 2.5-3%); rango sano 2-5%. Por categoría: Lujo/Joyería ~0.9%, Food & Beverage ~6.2%, Belleza ~4.9%. Desktop ~3.9% vs Mobile ~1.8%.
- AOV: global ~$150-180 USD; rango $68 (pet care) a $350+ (lujo). Mobile (~$137) suele ser menor que desktop ($146-204).
- Flujos de email (RPR = revenue per recipient): carrito abandonado ~$3.65 promedio (top 10% ~$28.89), conversión ~3.33%; bienvenida ~$2.65; post-compra el de mayor open rate (~60%). Un email de campaña común rinde ~$0.11 RPR → los flujos automatizados rinden 30x+.
- LTV:CAC: mínimo sano 3:1 para adquisición paga sostenible; categorías de reposición/suscripción 3.5:1 a 5:1.
- Recompra: objetivo 20-40% según vertical. Bain: +5% en tasa de recompra = +25-95% de rentabilidad. "La segunda compra es la batalla". CLV típico $100-300 (suscripción 2-3x más).`
    };
  }

  if (v.indexOf('pyme') !== -1 || v.indexOf('negocio local') !== -1) {
    return {
      tipo: 'pyme',
      perfilAuditor: 'auditor senior de marketing para PYMEs y negocios locales, enfocado en demanda local, presencia en Google/Maps, reputación y cierre de consultas',
      funnel: 'Descubrimiento local → Contacto/Consulta → Visita o Cotización → Cierre → Recompra/Referido',
      metricas: 'consultas/leads locales por mes, costo por consulta, tasa de cierre de presupuestos, ticket promedio, tasa de recompra/referidos, reseñas y calificación, posición en Google Maps',
      segmentos: 'segmentos de cliente de la zona (ej: hogares vs. comercios; por barrio/zona de cobertura). NADA de "ICP firmográfico B2B" ni "comité de compra".',
      tacticas: 'Google Business Profile optimizado (fotos, reseñas, posteos), SEO local ("servicio + ciudad"), Google Ads de búsqueda local ("X cerca de mí"), Meta Ads geo-segmentado por radio, WhatsApp Business + catálogo, sistema de pedido de reseñas, programa de referidos, alianzas con negocios locales complementarios',
      stack: 'Google Business Profile, Google Ads (local), Meta Ads (geo), WhatsApp Business, CRM liviano / planilla, app de reseñas, GA4',
      tono: 'práctico y concreto, de dueño de negocio local. Foco en: que te encuentren en la zona, convertir consultas en ventas, y reputación. Nada de jerga corporativa.',
      benchmarks: `BENCHMARKS DE NEGOCIO LOCAL (datos globales/US — mejor proxy disponible; no hay benchmarks públicos LATAM robustos. Citá la banda y aclará el supuesto):
- Intención local: ~46% de TODAS las búsquedas de Google tienen intención local. El Local Pack (3-pack de Maps) aparece en ~93% de las búsquedas con intención local → Google Business Profile (GBP) es el principal punto de conversión, no "un canal más".
- Velocidad de conversión: ~76% de las búsquedas locales en mobile derivan en visita al negocio dentro de 24h; ~88% dentro de la semana; ~28% de esas visitas terminan en compra.
- Conversión de la ficha GBP: una ficha promedio convierte ~4,2% de las impresiones de búsqueda (llamada / indicaciones / visita al sitio).
- Reseñas (palanca clave): +2,8% de conversión por cada 10 reseñas nuevas; +4,4% por cada +0,1 estrella; responder el 100% de las reseñas vs no responder mejora la conversión ~16,4%. Las reseñas pesan ~16-20% en el ranking local.
- Costo por lead (CPL) — benchmarks 2025-2026 (globales/US; en LATAM varía mucho por país/competencia, no hay CPL regional confiable público):
  · Google Ads búsqueda local (home services): CPL ~USD 90 (CPC ~USD 7,85; CVR ~7,3%).
  · Google Local Services Ads: CPL ~USD 53-60 (más barato que Search).
  · Meta Lead Ads: CPL ~USD 28 general; en servicios (hogar, salud, profesionales) ~USD 30-50+; bien optimizado USD 15-60.
  · Regla de viabilidad: el CPL debería ser <10-20% del valor bruto esperado por venta (según margen y cierre). Google suele dar leads más caros pero más calificados; Meta baja el CPL con cierre más variable.
  · Regla operativa de canal: Google/Maps para captar demanda inmediata (intención alta); Meta para generar demanda/branding y remarketing (lead más frío); WhatsApp Business como capa de CIERRE (el lead entra por Google/Meta y cierra por chat); referidos como canal premium de mejor calidad y recompra.
  · Selección de canal por rubro: urgencias (plomería, cerrajería, clínica, reparación) → Google/Maps + WhatsApp; servicios visuales/descubrimiento (estética, gastronomía, decoración) → Meta + WhatsApp; confianza/recurrencia (salud, seguridad, mantenimiento, seguros) → Google + WhatsApp + referidos; comercio de barrio → cartelería + WhatsApp + referidos + Maps.
- Tasa de cierre (consulta → venta) en servicios: típica 13-25%; saludable 20-30%; servicios profesionales pueden llegar 20-40%. Tickets bajos cierran mejor; tickets altos / ciclos largos, peor.
- Definí "consulta calificada" con criterios claros (sin eso el CPL real se infla ~2.5x).
- Recompra y referidos = motor de rentabilidad local (datos globales):
  · Clientes referidos: +37% de retención y +16% de LTV vs no referidos. Programas de referidos: ROI ~60% en 6 años; empresas con programa crecieron +86% en ingresos vs sin programa.
  · El referido trae leads más baratos Y de mejor calidad/permanencia. Hacé el programa simple, transparente y con recompensa atractiva.
  · En servicios recurrentes/alta frecuencia (mantenimiento, salud, seguridad, limpieza, soporte) la facturación depende más de recurrentes; en compra puntual / alta urgencia / gastronomía pesa más la captación continua de nuevos.
- Reseñas: pedilas EN EL MOMENTO de máxima satisfacción, respondé todas, y facilitá el camino. Seguí las negativas para proteger reputación.
- Prioridades operativas (en orden): ficha GBP completa y verificada → fotos → reseñas nuevas constantes → responder reseñas → web geolocalizada.
- La UBICACIÓN/zona la provee el cliente y es central: anclá demanda, competencia y canales a esa zona. Aclarar que las distribuciones de reseñas varían mucho por rubro y ciudad.`
    };
  }

  if (v.indexOf('consult') !== -1 || v.indexOf('servicio') !== -1) {
    return {
      tipo: 'consultoria',
      perfilAuditor: 'auditor senior de growth para consultoras y servicios profesionales, enfocado en autoridad, posicionamiento y dependencia del founder',
      funnel: 'Awareness → Autoridad/Confianza → Lead → Discovery → Propuesta → Cierre → Referido',
      metricas: 'leads cualificados/mes, ciclo de venta, ticket promedio por proyecto/retainer, win rate, % de ventas dependientes del founder, tasa de referidos',
      segmentos: 'ICP por industria o por problema resuelto + nivel de especialización/posicionamiento (generalista vs nicho)',
      tacticas: 'contenido personal de autoridad (LinkedIn, newsletter, podcast), casos de éxito cuantificados, lead magnets de diagnóstico, sistema de referidos, productización de la oferta',
      stack: 'LinkedIn (Sales Navigator), CRM liviano (Pipedrive/HubSpot), email, calendario (Calendly), herramienta de propuestas',
      tono: 'estratégico pero accionable. Foco en escapar de la dependencia del founder y construir un motor de demanda predecible.',
      benchmarks: `REFERENCIAS GTM PARA SERVICIOS/PYME (citá la banda, ajustá al caso):
- CPL objetivo: 5-15% del LTV del cliente. Para tickets de ~$5K, CPL <$100.
- CAC payback: dentro de 12 meses para motions de PYME.
- Definición de lead floja infla el CPL: si ventas solo acepta el 40% de los leads de marketing, el CPL real es 2.5x el reportado. Definí MQL/SQL con criterios claros.
- Plan de 90 días enfocado > plan anual difuso: validar ICP (fit + triggers), testear posicionamiento con compradores reales, elegir las 2 primeras jugadas prioritarias.`
    };
  }

  // default: SaaS / Software (B2B tech)
  return {
    tipo: 'saas',
    perfilAuditor: 'auditor senior de growth para SaaS/software B2B, enfocado en activación, pricing, funnel de demanda y retención',
    funnel: 'Visitante → Lead → MQL → SQL → Oportunidad → Cliente → Renovación/Expansión',
    metricas: 'CPL, tasa Lead→MQL→SQL, CAC, LTV, churn, MRR/ARR, tasa de activación, NRR (net revenue retention)',
    segmentos: 'ICPs firmográficos por segmento + buyer personas + mapa del comité de compra (decisor/influenciador/usuario/bloqueador)',
    tacticas: 'lead scoring (firmográfico/conductual/engagement), nurturing por etapa, ABM, contenido por etapa del funnel, optimización de demo/trial, motion PLG vs sales-led',
    stack: 'CRM (HubSpot/Salesforce), automatización de marketing, enriquecimiento (Clay/Apollo), intent data, analytics de producto',
    tono: 'riguroso y orientado a pipeline. Conectá cada recomendación con su impacto en el funnel y en MRR.',
    benchmarks: `REFERENCIAS GTM SaaS B2B (citá la banda, ajustá al caso):
- CPL objetivo: 5-15% del LTV. Para deals ~$5K, CPL <$100.
- CAC payback: <12 meses (motion PYME); más largo en enterprise.
- LTV:CAC sano ≥ 3:1. NRR sano ≥ 100% (idealmente 110%+).
- Definición de lead floja infla el CPL: si ventas acepta solo el 40% de los MQLs, el CPL real es 2.5x. Criterios MQL/SQL explícitos.
- 90 días enfocados > plan anual difuso: validar ICP (fit + triggers), testear posicionamiento con compradores reales, elegir 2 jugadas prioritarias.`
  };
}

function buildSystemPrompt1(vertical, modelo) {
  const c = configVertical(vertical);
  return `Sos ${c.perfilAuditor}. Modelo comercial del cliente: ${modelo}. Producís auditorías rigurosas y accionables, sin fluff.

REGLAS:
- Solo hallazgos con evidencia observable en el input. Si no podés verificar algo, escribí "Sin confirmar".
- Diferenciá FORTALEZAS de GAPS. Urgencia por gap: CRÍTICO/ALTO/MEDIO.
- Vocabulario y métricas del vertical: usá ${c.metricas}. Funnel de referencia: ${c.funnel}.
- Tono: ${c.tono}
- Español rioplatense, profesional. Markdown con H2 por sección.

${c.benchmarks}

${REGLA_KPI}

${REGLA_HECHOS}`;
}

function buildUserPrompt1(url, vertical, modelo, scraped, ciudad) {
  const c = configVertical(vertical);
  const deteccionUDN = c.tipo === 'saas'
    ? `\n7. Estructura de unidades de negocio (UDN): a partir del sitio, determiná si la empresa tiene UNA sola plataforma/producto (single-UDN) o VARIAS unidades de negocio/líneas de producto (multi-UDN). Si es multi-UDN, listá las UDN detectadas con una línea de qué hace cada una. Encabezá esta sección con la etiqueta exacta "DETECCIÓN UDN: single" o "DETECCIÓN UDN: multi".`
    : '';
  return `URL: ${url} | Vertical: ${vertical} | Modelo: ${modelo}
UBICACIÓN/ZONA DE OPERACIÓN (provista por el cliente, usá EXACTAMENTE esto, no infieras otra): ${ciudad || 'No provista'}

CONTENIDO DEL SITIO:
${scraped.substring(0, 20000)}

PRODUCÍ una auditoría con:
1. Resumen ejecutivo (hallazgos clave + tabla URGENCIA × HALLAZGO)
2. Perfil del negocio (lo reconstruido desde afuera)
3. Análisis web y comunicación (propuesta de valor, claridad, UX)
4. Análisis de funnel — usá las etapas: ${c.funnel}. Señalá dónde está la fuga.
5. Stack tecnológico detectado vs recomendado para este vertical (${c.stack})
6. Hallazgos críticos (máx 5, ordenados por urgencia, cada uno con la evidencia del sitio que lo origina)${deteccionUDN}

NO prescribas soluciones todavía — el framework las trae. Cada hallazgo debe citar QUÉ del sitio lo origina.`;
}

function buildSystemPrompt2(vertical) {
  const c = configVertical(vertical);
  if (c.tipo === 'ecommerce') {
    return `Sos estratega de growth para e-commerce. En vez de "ICPs firmográficos", definís ${c.segmentos}. Basate ESTRICTAMENTE en los datos provistos. Específico y accionable, sin plantillas. ${REGLA_KPI}`;
  }
  return `Sos estratega senior de GTM para ${c.tipo}. Definís ${c.segmentos} basándote ESTRICTAMENTE en datos provistos. Específicos, accionables, sin plantillas genéricas. ${REGLA_KPI}`;
}

function buildUserPrompt2(auditoria, respuestas, modelo, vertical) {
  const c = configVertical(vertical);
  if (c.tipo === 'ecommerce') {
    return `AUDITORÍA:\n${auditoria}\n\nCUESTIONARIO:\n${respuestas}\n\nModelo: ${modelo}

Generá 1-2 SEGMENTOS DE CLIENTE (no ICPs B2B). Por cada uno:
- Nombre del segmento (ej: "Compradores recurrentes premium", "Cazadores de oferta primera compra")
- Arquetipo (demografía + comportamiento de compra + qué los moviliza)
- Trigger de compra y momento (estacionalidad, ocasión, dolor)
- Canales donde están y cómo descubren la marca (con nombres concretos)
- Valor estimado: ticket y potencial de recompra/LTV (con supuesto visible)
- Mensaje ancla (una oración que les resuena)`;
  }
  if (c.tipo === 'pyme') {
    return `AUDITORÍA:\n${auditoria}\n\nCUESTIONARIO:\n${respuestas}\n\nModelo: ${modelo}

Generá 1-2 SEGMENTOS DE CLIENTE LOCAL (no ICPs B2B genéricos). Por cada uno:
- Nombre del segmento (ej: "Hogares de la zona que buscan seguridad", "Comercios del centro que necesitan X")
- Arquetipo + necesidad concreta + qué los moviliza a contratar
- Trigger y momento (qué situación los lleva a buscar el servicio)
- Cómo buscan/descubren en la zona (Google "servicio + ciudad", Maps, referidos, redes locales)
- Valor estimado: ticket y potencial de recompra/referido (con supuesto)
- Mensaje ancla local (una oración que les resuena)`;
  }
  return `AUDITORÍA:\n${auditoria}\n\nCUESTIONARIO:\n${respuestas}\n\nModelo: ${modelo}\nVertical: ${vertical}

Generá 1-2 ICPs. Por cada uno:
- Nombre del segmento (específico)
- Firmográficos o arquetipo
- Trigger de compra
- Canales concretos
- Mensaje ancla (una oración)
- Score 1-10 en volumen y facilidad de cierre`;
}

function buildSystemPrompt3(vertical) {
  const c = configVertical(vertical);
  return `Creás perfiles de cliente que se leen como personas reales, no como clichés de marketing. Contexto: negocio de tipo ${c.tipo}. Las quotes suenan humanas — si arranca con "necesito una solución que..." está mal. Nada de "Pedro, 35 años, busca eficiencia": eso grita plantilla.`;
}

function buildUserPrompt3(icps, auditoria, respuestas, vertical) {
  const c = configVertical(vertical);
  const extra = c.tipo === 'ecommerce'
    ? '6. Su ciclo emocional de compra (descubrimiento → consideración → compra → post-compra → recompra) y quién más influye en la decisión'
    : '6. Su rol en la decisión de compra (decisor/influenciador/usuario) y a quién tiene que convencer internamente';
  return `SEGMENTOS/ICPs:\n${icps}\n\nCONTEXTO:\n${(auditoria||'').substring(0,2000)}\n${respuestas}

Para CADA segmento, un perfil de cliente con:
1. Nombre + edad + situación (rol si es B2B, momento de vida si es consumidor)
2. Un día en su vida (1 párrafo concreto)
3. 3 frustraciones reales y específicas
4. 3 objeciones de compra (por qué NO compraría)
5. 3 quotes literales que diría en voz alta
${extra}`;
}

function buildSystemPrompt4(vertical) {
  const c = configVertical(vertical);
  return `Consolidás el plan de growth final — el entregable principal del servicio. Negocio de tipo ${c.tipo}. Todo referencia datos REALES del cliente. Priorizás acción concreta sobre teoría. Tono: ${c.tono}

${c.benchmarks}

${REGLA_KPI}`;
}

function buildUserPrompt4(auditoria, respuestas, icps, personas, vertical, modelo) {
  const c = configVertical(vertical);

  if (c.tipo === 'ecommerce') {
    return `Auditoría: ${auditoria}
Respuestas: ${respuestas}
Segmentos: ${icps}
Perfiles de cliente: ${personas}
Vertical: e-commerce | Modelo: ${modelo}

ARMÁ EL PLAN DE GROWTH E-COMMERCE (5 secciones, todo concreto y táctico):
1. Objetivos a 12 meses (facturación, AOV, ROAS, tasa de recompra) con su supuesto
2. Customer Journey por etapa: ${c.funnel}. Para cada etapa: touchpoint concreto + acción + métrica
3. Funnel + métricas: ${c.metricas}. Por etapa: métrica + benchmark del vertical + objetivo (con supuesto)
4. Plan de adquisición + retención TÁCTICO: estructura de campañas Meta (ASC/manual + ángulos de creativo), Google Shopping/PMax, flujos de email/Klaviyo (bienvenida, carrito abandonado, post-compra, win-back), bundles/order-bumps para subir AOV. NADA genérico: nombre del flujo, qué dispara, qué impacto estimado.
5. Plan de Acción 90 días: quick wins primero (semana 1, mes 1), iniciativa + responsable + KPI con supuesto + esfuerzo×impacto

Incluí "Ciclo de Recompra y Advocacy" (no Scoring Model B2B).`;
  }

  // RAMA SaaS B2B — método propio (estructura Kunan) con sub-ramificación single/multi-UDN
  if (c.tipo === 'saas') {
    return `Auditoría: ${auditoria}
Respuestas del cuestionario: ${respuestas}
ICPs: ${icps}
Buyer Personas: ${personas}
Vertical: SaaS/Software B2B | Modelo: ${modelo}

PASO 0 — DETERMINAR ESTRUCTURA DE UNIDADES DE NEGOCIO (UDN):
Combiná dos fuentes: (a) lo que detectaste en la auditoría sobre los productos/líneas del negocio, y (b) la declaración del usuario en el cuestionario (campo "saas_udn" y "saas_udn_lista" si existe).
- Si es SINGLE-UDN (una sola plataforma/producto): armá UN sistema GTM cohesivo.
- Si es MULTI-UDN (varias unidades de negocio): armá el análisis EXPANDIDO por cada UDN (objetivos, ICP, funnel y señales propios de cada una) y agregá una sección final "Estrategias combinadas entre UDNs" donde identifiques dónde las unidades son COMPLEMENTARIAS (cross-sell, upsell, leads compartidos, contenido reutilizable) y cómo coordinarlas.
- Si la declaración del usuario y tu detección difieren, priorizá la declaración del usuario y aclaralo.

ARMÁ EL GTM FRAMEWORK con esta estructura (mi método):

1. OBJETIVOS DEL SISTEMA GTM (${modelo === 'Mixto' ? 'por cada UDN si aplica' : 'por UDN si es multi-UDN; uno solo si es single'})
   - Objetivo Comercial (leads/mes, MQLs/mes, nuevos clientes/mes, churn) con supuesto
   - Objetivo Marketing (CPL objetivo por UDN, % pipeline generado por marketing)
   - Objetivo Sistema (qué debe detectar/automatizar el sistema de demanda)
   - Objetivo Ventas (win rate, ciclo de venta, upsell/cross-sell)

2. FRAMEWORK DE DEMANDA Y PIPELINE — funnel ${c.funnel}
   Tabla con una columna por etapa (IQL → MQL → SQL) y estas filas:
   - Etapa del comprador (qué reconoce/busca/decide)
   - Horizonte temporal (días)
   - KPIs clave (con supuesto; usá los benchmarks que tenés)
   - Responsabilidad (qué área)
   - Fuentes de leads (canales concretos con nombre)
   - Stack tecnológico de la etapa
   - Qué debe hacer el sistema en esa etapa

3. ICPs CONSOLIDADOS (${modelo}; por UDN si es multi) — pegá y enriquecé los ICPs con: deal size/ticket, ciclo de venta, señales de intención clave y mensaje central por ICP.

4. BUYER PERSONAS — por cada persona: rol en el comité de compra, objetivo, pain points, cómo lo ayuda el producto, objeciones con su respuesta de venta, contenido que resuena.

5. SEÑALES & TRIGGERS DE INTENCIÓN (tabla): tipo de señal | descripción | FUENTE DE DATOS concreta (LinkedIn Jobs, Clay, RB2B, Google Ads, prensa, etc.) | peso (alto/medio) | acción disparadora | pregunta de calificación. Mínimo 5 señales.

6. SCORING MODEL DE LEADS: Firmográficos (peso 40%) + Conductual/señales (35%) + Engagement (25%). Tabla con atributo | criterio | puntos. Incluí señales negativas (decaimiento) con puntaje negativo.

7. STACK TECNOLÓGICO recomendado: herramienta | propósito | prioridad (P1/P2/P3) | costo estimado/mes. Basado en el gap de la auditoría.

8. PLAN DE ACCIÓN 90 DÍAS (quick wins primero): iniciativa | responsable sugerido | KPI con supuesto | esfuerzo×impacto.

REGLAS DEL MÉTODO: medí antes de actuar (validar ICP/persona contra datos reales antes de escalar inversión), sostené lo que aporta a pipeline, descartá lo que no. Todo número con su supuesto.`;
  }

  // RAMA PYME / NEGOCIO LOCAL — plan de growth anclado a la zona de operación
  if (c.tipo === 'pyme') {
    return `Auditoría: ${auditoria}
Respuestas del cuestionario: ${respuestas}
Segmentos de cliente local: ${icps}
Perfiles de cliente: ${personas}
Vertical: PYME / Negocio local | Modelo: ${modelo}

IMPORTANTE: la ZONA DE OPERACIÓN es la que el cliente declaró y figura en la auditoría. Anclá TODO el análisis (demanda, competencia, canales) a esa zona. No inventes otra ubicación.

ARMÁ EL PLAN DE GROWTH LOCAL (5 secciones, concreto y accionable para un dueño de negocio):
1. Objetivos a 12 meses (consultas/mes, tasa de cierre, ticket promedio, recompra/referidos) — cada uno con su supuesto.
2. Customer Journey local por etapa: ${c.funnel}. Por etapa: touchpoint concreto + acción + métrica de paso.
3. Presencia y demanda local — diagnóstico + plan: Google Business Profile (reseñas, fotos, posteos), SEO local (keywords "servicio + ciudad de operación"), Google Ads de búsqueda local, Meta Ads geo-segmentado por radio, WhatsApp Business. Para cada palanca: qué hacer concreto + impacto estimado (con supuesto).
4. Reputación y recompra: sistema de pedido de reseñas, programa de referidos, reactivación de clientes. Es el motor de rentabilidad local.
5. Plan de Acción 90 días (quick wins primero): iniciativa | responsable | KPI con supuesto | esfuerzo×impacto.

Nada de jerga corporativa ni funnel B2B. Hablale a un dueño de PYME que quiere más consultas y más cierres en su zona.`;
  }

  const modeloInstr = c.tipo === 'consultoria'
    ? 'Enfocá en construir autoridad y reducir la dependencia del founder. Incluí sistema de referidos y productización.'
    : modelo === 'B2B' ? 'Incluí un Scoring Model de leads (firmográfico/conductual/engagement con criterios y puntajes).'
    : modelo === 'B2C' ? 'Incluí Ciclo de Recompra y Advocacy.'
    : 'Incluí Scoring Model B2B y Ciclo de Recompra B2C, claramente separados.';

  return `Auditoría: ${auditoria}
Respuestas: ${respuestas}
ICPs: ${icps}
Personas: ${personas}
Vertical: ${vertical} | Modelo: ${modelo}

ARMÁ EL GTM FRAMEWORK (5 secciones):
1. Business Goals (objetivo 12 meses + KPIs macro, cada uno con supuesto)
2. Customer Journey por etapa: ${c.funnel}. Touchpoints concretos + pieza de contenido + métrica de paso.
3. Funnel + KPIs: ${c.metricas}. Por etapa: métrica + benchmark + objetivo (con supuesto).
4. Content Strategy (4 líneas editoriales con canal por segmento; tácticas del vertical: ${c.tacticas})
5. Plan de Acción 90 días (iniciativas + responsable sugerido + KPI con supuesto)
${modeloInstr}`;
}

function buildSystemPrompt5() {
  return `Editor crítico del entregable. Detectás problemas antes de que llegue al cliente. NO reescribís — solo identificás gaps.`;
}

function buildUserPrompt5(framework, auditoria, respuestas) {
  return `ENTREGABLE:\n${framework}\n\nAUDITORÍA:\n${(auditoria||'').substring(0,1500)}\n\nCUESTIONARIO:\n${respuestas}

Evaluá item por item:
1. ¿Hay HECHOS inferidos o "presumidos" que NO están explícitos en los inputs? En especial ubicación/ciudad, antigüedad, tamaño, facturación. Si la ubicación no coincide con la provista por el cliente o fue deducida de un nombre de calle → BLOQUEANTE.
2. ¿Hay números inventados SIN supuesto visible o sin placeholder [TU DATO]? Listalos — BLOQUEANTE.
3. ¿Datos inventados no presentes en los inputs?
4. ¿Faltan secciones obligatorias?
5. ¿El plan de acción tiene KPIs con supuesto en todos los horizontes?
6. ¿Los segmentos/ICPs están conectados con el journey (no son islas)?

Si está OK: respondé exactamente "FRAMEWORK_OK" en la primera línea.
Si hay problemas: listá cada uno con severidad BLOQUEANTE o AJUSTE MENOR y la corrección puntual.`;
}
