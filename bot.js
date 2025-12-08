import { Telegraf, session, Markup } from 'telegraf';
import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

// Config obligatoria
const { BOT_TOKEN, ADMIN_IDS: adminIdsRaw } = process.env;
if (!BOT_TOKEN) {
  console.error('Falta BOT_TOKEN en el entorno. Define BOT_TOKEN antes de lanzar el bot.');
  process.exit(1);
}

import {
  findOrCreateUser,
  updateUserRole,
  getUserByTelegramId,
  getUserById,
  getCreators,
  formatCents,
  changeBalance,
  createOrder,
  getOrderById,
  updateOrder,
  listUserOrders,
  createTransaction,
  createWithdrawalRequest,
  listPendingWithdrawals,
  markWithdrawalProcessed,
  updateUserProfile,
  createService,
  listServicesByCreator,
  setServiceActive,
  deleteService,
  getServiceById,
  touchLastSeen,
  listActiveOrdersByCreator,
  listStalePendingOrders,
  markOrderReminderSent,
  listUsers,
  findUserByUsername,
  setUserAvailability,
  setCreatorStatus,
  listPendingCreators,
  listTransactions,
  listTransactionsByUser,
  markUserAcceptedTerms,
  listExpiredPendingOrders,
  expirePendingOrder,
  setOrderRating,
  setOrderProblem,
} from './db.js';

const bot = new Telegraf(BOT_TOKEN);
const ADMIN_IDS = (adminIdsRaw || '')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean);

// Ignorar grupos/canales: solo chats privados
bot.use((ctx, next) => {
  if (ctx.chat && ctx.chat.type !== 'private') return;
  return next();
});

// Simple session
bot.use(session());
// Fallback por si la sesión no se inicializa
bot.use((ctx, next) => {
  if (!ctx.session) ctx.session = {};
  return next();
});

// Bloqueo por términos no aceptados
bot.use(async (ctx, next) => {
  const data = ctx.callbackQuery?.data;
  const isTermsAction = data === 'terms_full' || data === 'terms_accept';
  // Permitir la acción de términos aunque no estén aceptados
  if (isTermsAction) {
    return next();
  }

  const user = getOrInitUser(ctx);
  if (!user.accepted_terms_at) {
    await sendTerms(ctx);
    return;
  }
  return next();
});

// Link de videollamada
function generateCallLink(orderId) {
  const random = Math.random().toString(36).substring(2, 8);
  return `https://meet.jit.si/SafeCall_${orderId}_${random}`;
}

// Helper: es admin
function isAdmin(ctx) {
  return ADMIN_IDS.includes(String(ctx.from.id));
}

async function handleSaldo(ctx) {
  if (!(await requireTermsAccepted(ctx))) return;
  const user = getOrInitUser(ctx);
  return ctx.reply(`Tu saldo actual es: *${formatCents(user.balance_cents)}*`, {
    parse_mode: 'Markdown',
  });
}

async function handleNuevoPedido(ctx) {
  if (!(await requireTermsAccepted(ctx))) return;
  const user = getOrInitUser(ctx);
  if (user.role !== 'client') {
    return ctx.reply('Este comando es solo para clientes.');
  }

  await sendCreatorCards(ctx);
  return startCreatorSelection(ctx);
}

async function startNuevoServicio(ctx) {
  if (!(await requireTermsAccepted(ctx))) return;
  const user = getOrInitUser(ctx);
  if (user.role !== 'creator') {
    return ctx.reply('Este comando es solo para creadoras.');
  }
  if (!requireApprovedCreator(ctx, user)) return;

  ctx.session.newService = { step: 1 };
  return ctx.reply(
    "Vamos a crear un nuevo servicio.\nDime primero el nombre del servicio (ej: 'Videollamada 15 min', 'Pack 10 fotos')."
  );
}

async function startPerfil(ctx) {
  if (!(await requireTermsAccepted(ctx))) return;
  const user = getOrInitUser(ctx);
  if (user.role !== 'creator') {
    return ctx.reply('Este comando es solo para creadoras.');
  }
  if (!requireApprovedCreator(ctx, user)) return;
  ctx.session.editProfile = { step: 1 };
  return ctx.reply('Escribe el nombre que quieres mostrar en tu perfil:');
}

function startCreatorSelection(ctx) {
  const user = getOrInitUser(ctx);
  if (user.role !== 'client') return;

  const creators = getCreators();
  if (!creators.length) {
    return ctx.reply('No hay creadoras disponibles aún.');
  }

  ctx.session.newOrder = { step: 'choose_creator' };
  const buttons = creators.map(c => [
    Markup.button.callback(creatorLabel(c), `select_creator:${c.id}`),
  ]);
  buttons.push([Markup.button.callback('⬅️ Atrás', 'back:main')]);
  return ctx.reply('Elige la creadora para tu pedido:', Markup.inlineKeyboard(buttons));
}

function startServiceSelection(ctx, creator) {
  if (!creator) return;
  const services = listServicesByCreator(creator.id);
  if (!services.length) {
    return ctx.reply('Esta creadora aún no tiene servicios disponibles. Elige otra.');
  }
  ctx.session.newOrder = {
    step: 'choose_service',
    creatorId: creator.id,
    creatorLabel: creatorLabel(creator),
  };
  const buttons = services.map(s => [
    Markup.button.callback(
      `${s.name} – ${formatCents(s.price_cents)}`,
      `select_service:${s.id}`
    ),
  ]);
  buttons.push([Markup.button.callback('⬅️ Atrás', 'back:creators')]);
  buttons.push([Markup.button.callback('🏠 Menú', 'back:main')]);
  return ctx.reply(
    `Has elegido a ${ctx.session.newOrder.creatorLabel}. Elige el servicio:`,
    Markup.inlineKeyboard(buttons)
  );
}

async function promptOrderDetails(ctx, service, flow) {
  ctx.session.newOrder = {
    step: 'details',
    creatorId: flow.creatorId,
    creatorLabel: flow.creatorLabel,
    serviceId: service.id,
    serviceName: service.name,
    serviceType: service.type,
    amountCents: service.price_cents,
  };

  const buttons = [
    [Markup.button.callback('Omitir descripción', 'skip_description')],
    [Markup.button.callback('⬅️ Atrás', 'back:services')],
    [Markup.button.callback('🏠 Menú', 'back:main')],
  ];

  await ctx.reply(
    `Servicio seleccionado: ${service.name} – ${formatCents(
      service.price_cents
    )}\nAñade detalles opcionales para la creadora (o pulsa \"Omitir descripción\").`,
    Markup.inlineKeyboard(buttons)
  );
}

async function finalizeOrder(ctx, descriptionText) {
  const user = getOrInitUser(ctx);
  const flow = ctx.session?.newOrder;
  if (!flow || flow.step !== 'details') return;

  const extra = descriptionText === '-' || !descriptionText ? '' : ` – ${descriptionText}`;
  const fullDescription = `${flow.serviceName}${extra}`;
  const amountCents = flow.amountCents;
  const expiresAt = new Date(Date.now() + PENDING_EXPIRATION_MINUTES * 60 * 1000).toISOString();
  const feeCents = Math.round(amountCents * FEE_PERCENT) + FEE_FLAT_CENTS;
  const totalCents = amountCents + feeCents;
  const currency = DEFAULT_CURRENCY;

  const order = createOrder({
    clientId: user.id,
    amountCents,
    description: fullDescription,
    type: flow.serviceType || null,
    etaMinutes: flow.durationMin || null,
    expiresAt,
    currency,
    feeCents,
    totalCents,
  });

  ctx.session.newOrder = null;

  const etaText = order.eta_minutes ? `\nETA aprox: ${order.eta_minutes} min` : '';
  await ctx.reply(
    `Pedido creado ✅\n\nID: #${order.id}\nCreadora: ${flow.creatorLabel}\nServicio: ${flow.serviceName}\nImporte a pagar: ${formatCents(
      order.amount_cents
    )}${etaText}\n\nSe cobrará solo si la creadora acepta. Puedes cancelarlo mientras esté pendiente.`,
    Markup.inlineKeyboard([[Markup.button.callback('❌ Cancelar pedido', `cancel_order:${order.id}`)]])
  );

  // Avisar solo a la creadora elegida
  const creator = getUserById(flow.creatorId);
  if (creator && hasValidTelegramId(creator)) {
    const text =
      `Nuevo pedido asignado 🔔\n\n` +
      `ID: #${order.id}\n` +
      `Servicio: ${flow.serviceName}\n` +
      `Descripción: ${fullDescription}\n` +
      `Importe: ${formatCents(order.amount_cents)}\n\n` +
      `Pulsa el botón para aceptar.`;
    try {
      await ctx.telegram.sendMessage(
        creator.telegram_id,
        text,
        Markup.inlineKeyboard([[Markup.button.callback('✅ Aceptar', `accept_order:${order.id}`)]])
      );
    } catch (err) {
      console.error('Error avisando a creadora', creator.telegram_id, err.message);
    }
  }
}

async function handleMisPedidos(ctx) {
  if (!(await requireTermsAccepted(ctx))) return;
  const user = getOrInitUser(ctx);
  if (user.role !== 'client') {
    return ctx.reply('Este comando es solo para clientes.');
  }

  const orders = listUserOrders(user.id, 'client', 10);
  if (!orders.length) return ctx.reply('No tienes pedidos aún.');

  let text = 'Tus últimos pedidos:\n\n';
  for (const o of orders) {
    const eta = o.eta_minutes ? ` – ETA aprox: ${o.eta_minutes} min` : '';
    text += `#${o.id} – ${formatCents(o.amount_cents)} – ${statusLabel(o.status)}${eta}\n`;
    if (o.description) text += `   ${o.description}\n`;
  }
  ctx.reply(text);
}

async function handleTrabajos(ctx) {
  if (!(await requireTermsAccepted(ctx))) return;
  const user = getOrInitUser(ctx);
  if (user.role !== 'creator') {
    return ctx.reply('Este comando es solo para creadoras.');
  }
  if (!requireApprovedCreator(ctx, user)) return;

  const orders = listUserOrders(user.id, 'creator', 10);
  if (!orders.length) return ctx.reply('Aún no tienes trabajos asignados.');

  let text = 'Tus últimos trabajos:\n\n';
  for (const o of orders) {
    text += `#${o.id} – ${formatCents(o.amount_cents)} – ${o.status}\n`;
    if (o.description) text += `   ${o.description}\n`;
  }
  ctx.reply(text);
}

function cancelPendingOrder(ctx, order, user) {
  if (!order || (order.status !== 'pending' && order.status !== 'pending_payment')) {
    return ctx.reply('Ese pedido ya no se puede cancelar.');
  }
  if (order.client_id !== user.id) {
    return ctx.reply('No puedes cancelar este pedido.');
  }
  updateOrder(order.id, {
    status: 'cancelled',
    updated_at: new Date().toISOString(),
  });
  ctx.reply(`Pedido #${order.id} cancelado.`);
}

async function handleMisServicios(ctx) {
  if (!(await requireTermsAccepted(ctx))) return;
  const user = getOrInitUser(ctx);
  if (user.role !== 'creator') {
    return ctx.reply('Este comando es solo para creadoras.');
  }
  if (!requireApprovedCreator(ctx, user)) return;

  const services = listServicesByCreator(user.id, true);
  if (!services.length) {
    return ctx.reply(
      'No tienes servicios definidos todavía. Usa /nuevo_servicio para crear uno.'
    );
  }

  const { text, keyboard } = buildServicesMessage(services);
  return ctx.reply(text, keyboard ? keyboard : undefined);
}

async function handleRetirar(ctx) {
  if (!(await requireTermsAccepted(ctx))) return;
  const user = getOrInitUser(ctx);
  if (user.role !== 'creator') {
    return ctx.reply('Este comando solo es para creadoras.');
  }
  if (!requireApprovedCreator(ctx, user)) return;

  if (user.balance_cents <= 0) {
    return ctx.reply('No tienes saldo disponible para retirar.');
  }

  const withdrawal = createWithdrawalRequest(user.id, user.balance_cents);
  createTransaction({
    userId: user.id,
    type: 'withdraw',
    amountCents: user.balance_cents,
    relatedOrderId: null,
  });

  // Dejamos el saldo en 0
  changeBalance(user.id, -user.balance_cents);

  ctx.reply(
    `Has solicitado retirar ${formatCents(
      withdrawal.amount_cents
    )} 💸\n\nUn administrador procesará el pago manualmente (Wise, Revolut, etc.).`
  );

  // Avisar admins
  for (const adminId of ADMIN_IDS) {
    ctx.telegram.sendMessage(
      adminId,
      `Nueva retirada solicitada #${withdrawal.id}\nUsuario: @${user.username || user.telegram_id}\nImporte: ${formatCents(
        withdrawal.amount_cents
      )}`
    );
  }
}

// Helper: obtener usuario + asegurar existencia
function getOrInitUser(ctx) {
  const user = findOrCreateUser({
    telegramId: ctx.from.id,
    username: ctx.from.username,
  });
  // Guarda last_seen y devuelve el valor previo para poder detectar reconexiones
  const previousLastSeen = user.last_seen;
  touchLastSeen(user.id);
  return { ...user, last_seen: previousLastSeen };
}

// Helper: enviar cards con foto de perfil de creadoras disponibles
async function sendCreatorCards(ctx) {
  const creators = getCreators();
  if (!creators.length) {
    await ctx.reply('No hay creadoras registradas todavía.');
    return;
  }

  await ctx.reply('Creadoras disponibles:');

  for (const creator of creators) {
    let fileId = null;
    if (creator.photo_file_id) {
      fileId = creator.photo_file_id;
    }
    try {
      if (!fileId) {
        const photos = await ctx.telegram.getUserProfilePhotos(creator.telegram_id, {
          limit: 1,
        });
        fileId = photos?.photos?.[0]?.[0]?.file_id || null;
      }
    } catch (err) {
      if (hasValidTelegramId(creator)) {
        console.error('No pude obtener foto de perfil para', creator.telegram_id, err.message);
      }
    }

    const name = creatorLabel(creator);
    let caption = name;
    if (creator.languages) caption += `\nIdiomas: ${creator.languages}`;
    if (creator.bio) caption += `\n${creator.bio}`;

    if (fileId && hasValidTelegramId(creator)) {
      await ctx.telegram.sendPhoto(ctx.chat.id, fileId, {
        caption,
      });
    } else {
      await ctx.reply(name);
    }
  }
}

function serviceTypeLabel(type) {
  if (type === 'call') return 'Videollamada';
  if (type === 'content') return 'Contenido';
  return 'Otro';
}

function creatorLabel(c) {
  return c.display_name || `Creadora #${c.id}`;
}

function findUserByRef(ref) {
  if (!ref) return null;
  if (/^\d+$/.test(ref)) return getUserByTelegramId(ref);
  return findUserByUsername(ref);
}

function hasValidTelegramId(u) {
  return !!(u?.telegram_id && /^\d+$/.test(String(u.telegram_id)));
}

function statusLabel(status) {
  if (status === 'pending') return 'Pendiente';
  if (status === 'accepted') return 'Aceptado';
  if (status === 'in_call') return 'En llamada';
  if (status === 'completed') return 'Completado';
  if (status === 'cancelled') return 'Cancelado';
  return status;
}

const CREATOR_ONLINE_COOLDOWN_MINUTES = 10;
const PENDING_REMINDER_THRESHOLD_MINUTES = 30;
const REMINDER_INTERVAL_MS = 5 * 60 * 1000;
const PENDING_EXPIRATION_MINUTES = 15;
const DB_FILE_PATH = process.env.DATABASE_PATH || './database.db';
const FEE_PERCENT = parseFloat(process.env.FEE_PERCENT || '0.08');
const FEE_FLAT_CENTS = parseInt(process.env.FEE_FLAT_CENTS || '30', 10);
const DEFAULT_CURRENCY = process.env.DEFAULT_CURRENCY || 'EUR';
const PAYMENT_PROVIDER_TOKEN_EUR = process.env.PAYMENT_PROVIDER_TOKEN_EUR || '';
const PAYMENT_PROVIDER_TOKEN_USD = process.env.PAYMENT_PROVIDER_TOKEN_USD || '';
const USE_WEBHOOK = process.env.USE_WEBHOOK === 'true';
const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN || '';
const PORT = process.env.PORT || 3000;
const WEBHOOK_PATH = `/bot${process.env.BOT_TOKEN}`;
const WEBHOOK_URL = WEBHOOK_DOMAIN ? `${WEBHOOK_DOMAIN}${WEBHOOK_PATH}` : null;
const fullTermsText = `
TÉRMINOS DE USO DE LA PLATAFORMA

1. OBJETO DEL SERVICIO
El presente bot de Telegram (en adelante, el “Bot” o la “Plataforma”) ofrece un servicio de intermediación técnica entre personas adultas que desean ofrecer servicios digitales personalizados (en adelante, “Creadoras”) y personas adultas que desean contratar dichos servicios (en adelante, “Clientes”). 
La Plataforma se limita a facilitar el contacto anónimo y la gestión técnica de pagos entre las partes, sin participar, supervisar ni controlar el contenido de las interacciones ni los servicios que las Creadoras decidan ofrecer a los Clientes.

2. CONDICIONES DE ACCESO Y EDAD MÍNIMA
El uso de la Plataforma está estrictamente limitado a personas mayores de 18 años. 
Al utilizar el Bot, el Usuario declara y garantiza que:
a) Es mayor de edad según la legislación aplicable.
b) Tiene plena capacidad jurídica para aceptar estos Términos de Uso.
c) No utilizará la Plataforma con fines ilegales o contrarios a estos Términos.

La Plataforma se reserva el derecho a bloquear o eliminar el acceso de cualquier Usuario del que existan indicios razonables de que es menor de edad o utiliza la Plataforma en nombre de un menor.

3. TIPOLOGÍA DE USUARIOS
A efectos de estos Términos, se distinguen dos tipos de Usuarios:
a) “Creadoras”: personas adultas que utilizan la Plataforma para ofrecer servicios digitales personalizados (por ejemplo, videollamadas privadas o envío de contenidos digitales), con plena autonomía para decidir qué ofrecen, a qué precio y en qué condiciones, dentro de los límites legales y de estas normas.
b) “Clientes”: personas adultas que utilizan la Plataforma para contratar servicios a las Creadoras.

Ambos, Creadoras y Clientes, se denominan conjuntamente los “Usuarios”.

4. PAPEL DE LA PLATAFORMA
La Plataforma actúa exclusivamente como:
a) Proveedor de una herramienta técnica de comunicación anónima entre Usuarios.
b) Gestor técnico de ciertos pagos y pedidos entre Clientes y Creadoras, según los flujos establecidos en el Bot.
La Plataforma:
- No es parte de los contratos de servicios celebrados entre Creadoras y Clientes.
- No diseña, dirige, controla ni supervisa el contenido de las comunicaciones, videollamadas o materiales digitales intercambiados entre las partes.
- No garantiza la calidad, adecuación, legalidad o resultado de los servicios ofrecidos por las Creadoras.
Cada Usuario es el único responsable de sus decisiones, acciones y contenidos.

5. CONTENIDO PERMITIDO Y PROHIBIDO
Está terminantemente prohibido utilizar la Plataforma para:
a) Involucrar, mostrar o representar a menores de edad, en cualquier forma.
b) Compartir, solicitar o distribuir contenido ilegal según la legislación vigente (incluyendo, entre otros, violencia extrema, explotación, amenazas, incitación al odio, etc.).
c) Realizar actividades delictivas, fraudulentas o que vulneren derechos de terceros.
d) Enviar spam, acoso reiterado o cualquier conducta que pueda considerarse abusiva, intimidatoria o no consentida.
e) Compartir datos personales sensibles de terceros sin su consentimiento.

Los Usuarios son los únicos responsables del contenido que generen, envíen o reciban mediante la Plataforma. La Plataforma se reserva el derecho a suspender o bloquear cualquier cuenta ante indicios razonables de infracción de estas normas o de la ley.

6. ANONIMATO Y PROHIBICIÓN DE INTERCAMBIO DE DATOS PERSONALES
La Plataforma ha sido diseñada para proteger el anonimato de las Creadoras y reducir riesgos para todos los Usuarios. En consecuencia, se establece expresamente que:
a) Está prohibido compartir números de teléfono, correos electrónicos, perfiles personales, direcciones físicas u otros datos que permitan identificar directamente a un Usuario fuera de la Plataforma.
b) Las Creadoras no deben mostrar ni compartir sus cuentas personales de mensajería o redes sociales, salvo bajo su propia responsabilidad y siempre fuera de los canales proporcionados por el Bot.
c) El Cliente debe respetar el anonimato de la Creadora y no intentar identificarla, localizarla o contactar con ella fuera del entorno del Bot.

El incumplimiento de esta cláusula podrá implicar la suspensión o bloqueo inmediato de la cuenta, sin derecho a reembolso.

7. GESTIÓN DE PAGOS, COMISIONES Y DISPUTAS
La Plataforma puede ofrecer funciones de gestión técnica de pagos entre Clientes y Creadoras. En ese contexto:
a) El Cliente acepta que los pagos se realicen a través de los métodos habilitados por la Plataforma.
b) Las cantidades abonadas se gestionan como garantía técnica, de acuerdo con los flujos definidos en el Bot (por ejemplo, pedidos pendientes, aceptados, completados, etc.).
c) La Plataforma puede retener temporalmente fondos mientras se verifica el estado de un servicio (por ejemplo, hasta que la Creadora marque el pedido como completado).
d) La Plataforma podrá percibir una comisión por la intermediación técnica, cuyo importe y forma se indicarán en el propio Bot o en las comunicaciones correspondientes.

En caso de disputa sobre un servicio (por ejemplo, si el Cliente alega que no se ha prestado el servicio), la Plataforma se limitará a:
- Revisar la información técnica disponible (estados del pedido, mensajes, tiempos).
- Tomar una decisión razonable sobre la liberación, retención o devolución del pago, únicamente respecto al importe económico.

La Plataforma no juzga el contenido, la calidad subjetiva del servicio ni interviene en valoraciones personales entre Cliente y Creadora.

8. RESPONSABILIDAD DE LOS USUARIOS
Cada Usuario es plenamente responsable de:
a) La veracidad de los datos que facilite.
b) Las comunicaciones que mantenga a través del Bot.
c) Los servicios que ofrezca (en el caso de Creadoras) o contrate (en el caso de Clientes).
d) El cumplimiento de la legislación aplicable en materia de contenido, derechos de imagen, propiedad intelectual e integridad de las personas.

La Plataforma no será responsable de:
- Daños, perjuicios o conflictos derivados de las interacciones entre Usuarios.
- Contenidos, actos u omisiones imputables a los Usuarios.
- Cualquier uso indebido o ilícito que los Usuarios realicen del Bot.

9. LIMITACIÓN DE RESPONSABILIDAD DE LA PLATAFORMA
En la máxima medida permitida por la ley, la Plataforma no garantiza:
a) La disponibilidad continua y sin interrupciones del Bot.
b) La ausencia de errores técnicos, caídas de servicio o pérdida puntual de datos.
c) La idoneidad del Bot para un propósito concreto.

La responsabilidad de la Plataforma, en caso de ser declarada, quedará limitada, como máximo, a las comisiones efectivamente percibidas por la Plataforma del Usuario concreto en los últimos 6 meses.

10. PROTECCIÓN DE DATOS Y PRIVACIDAD
La Plataforma tratará únicamente los datos mínimos necesarios para prestar el servicio (por ejemplo, identificadores de Telegram, registros de pedidos y estados técnicos). 
No se almacenan de forma intencionada contenidos audiovisuales de las interacciones entre Usuarios más allá de lo que resulte inevitable por el funcionamiento normal de Telegram.
El Usuario acepta que:
a) Los datos pueden ser tratados con fines de mantenimiento del servicio, mejora de la experiencia de uso, prevención de fraude y cumplimiento de obligaciones legales.
b) En caso de requerimiento legal válido, la Plataforma podrá colaborar con las autoridades competentes.

11. MEDIDAS DE SEGURIDAD, BLOQUEO Y SUSPENSIÓN
La Plataforma podrá bloquear, suspender o limitar el acceso de cualquier Usuario cuando:
a) Existan indicios razonables de uso ilícito o contrario a estos Términos.
b) Se reciba una denuncia fundamentada sobre la conducta de dicho Usuario.
c) Se detecten intentos de vulnerar la seguridad del sistema, manipular pagos o suplantar identidades.

Estas medidas podrán adoptarse de forma preventiva y sin obligación de preaviso, para proteger a otros Usuarios y a la propia Plataforma.

12. MODIFICACIÓN DE LOS TÉRMINOS
La Plataforma podrá actualizar o modificar los presentes Términos de Uso en cualquier momento. 
Cuando ello ocurra, se podrá requerir una nueva aceptación por parte de los Usuarios. El uso continuado de la Plataforma tras la notificación de cambios supondrá la aceptación de los nuevos Términos.

13. LEY APLICABLE Y JURISDICCIÓN
Estos Términos se rigen por la legislación española. 
Para cualquier controversia que pudiera derivarse del uso de la Plataforma, y siempre que la normativa de consumo no establezca otra cosa, las partes se someten a los Juzgados y Tribunales del domicilio del titular de la Plataforma.

Al pulsar “Aceptar” en el Bot, el Usuario declara haber leído, comprendido y aceptado íntegramente los presentes Términos de Uso.
`;

async function sendTerms(ctx) {
  const shortTerms = `TÉRMINOS DE USO

1. Este bot funciona solo como plataforma técnica de intermediación.
2. Está prohibido solicitar u ofrecer contenido ilegal o involucrar menores.
3. La plataforma no participa, supervisa ni almacena ningún contenido generado entre usuarios.
4. Todas las interacciones son responsabilidad de adultos mayores de edad.
5. El intercambio de datos personales está prohibido.
6. Los pagos se gestionan únicamente como garantía técnica y no implican responsabilidad sobre el contenido.

Pulsa ACEPTAR para continuar.`;

  return ctx.reply(
    shortTerms,
    Markup.inlineKeyboard([
      [Markup.button.callback('📄 Leer términos completos', 'terms_full')],
      [Markup.button.callback('✅ Acepto los términos', 'terms_accept')],
    ])
  );
}

async function requireTermsAccepted(ctx) {
  const user = getOrInitUser(ctx);
  if (!user.accepted_terms_at) {
    await sendTerms(ctx);
    return false;
  }
  return true;
}

function requireApprovedCreator(ctx, user) {
  if (!user || user.role !== 'creator') {
    ctx.reply('Este comando es solo para creadoras.');
    return false;
  }
  if (user.creator_status && user.creator_status !== 'approved') {
    ctx.reply('Tu cuenta de creadora está pendiente de aprobación. Espera a que un admin la revise.');
    return false;
  }
  return true;
}

function shouldNotifyCreatorOnline(user) {
  if (user.creator_status && user.creator_status !== 'approved') return false;
  if (!user.last_seen) return true;
  const diffMinutes = (Date.now() - new Date(user.last_seen).getTime()) / 60000;
  return diffMinutes >= CREATOR_ONLINE_COOLDOWN_MINUTES;
}

async function notifyClientsCreatorOnline(creator) {
  const orders = listActiveOrdersByCreator(creator.id);
  if (!orders.length) return;
  const notifiedClients = new Set();

  for (const order of orders) {
    if (notifiedClients.has(order.client_id)) continue;
    const client = getUserById(order.client_id);
    if (!client?.telegram_id) continue;
    notifiedClients.add(order.client_id);
    const text = `Tu creadora ${creatorLabel(
      creator
    )} está conectada. Pedido #${order.id} en estado ${order.status}.`;
    try {
      await bot.telegram.sendMessage(
        client.telegram_id,
        text,
        Markup.inlineKeyboard([[Markup.button.callback('Abrir pedido', `noop:${order.id}`)]])
      );
    } catch (err) {
      console.error('No pude notificar al cliente sobre conexión de creadora', err.message);
    }
  }
}

async function remindStalePendingOrders() {
  const stale = listStalePendingOrders(PENDING_REMINDER_THRESHOLD_MINUTES);
  if (!stale.length) return;
  for (const order of stale) {
    const client = getUserById(order.client_id);
    if (!client?.telegram_id) {
      markOrderReminderSent(order.id);
      continue;
    }
    const text =
      `Recordatorio: tu pedido #${order.id} sigue pendiente y tenemos saldo bloqueado para él.\n` +
      'Si ya no lo necesitas, puedes cancelar desde el menú.';
    try {
      await bot.telegram.sendMessage(
        client.telegram_id,
        text,
        Markup.inlineKeyboard([[Markup.button.callback('Abrir pedido', `noop:${order.id}`)]])
      );
    } catch (err) {
      console.error('No pude enviar recordatorio de pending', err.message);
    } finally {
      markOrderReminderSent(order.id);
    }
  }
}

function buildServicesMessage(services) {
  if (!services.length) return { text: 'No tienes servicios definidos todavía.', keyboard: null };

  let text = 'Tus servicios:\n\n';
  const buttons = [];

  for (const s of services) {
    const status = s.is_active ? 'ACTIVO' : 'INACTIVO';
    const typeLabel = serviceTypeLabel(s.type);
    const duration = s.duration_min ? ` – ${s.duration_min} min` : '';
    text += `#${s.id} ${s.name} – ${typeLabel}${duration} – ${formatCents(
      s.price_cents
    )} – ${status}\n`;
    if (s.description) text += `   ${s.description}\n`;

    buttons.push([
      Markup.button.callback(
        s.is_active ? 'Desactivar' : 'Activar',
        `toggle_service:${s.id}`
      ),
      Markup.button.callback('Borrar', `delete_service:${s.id}`),
    ]);
  }

  return {
    text,
    keyboard: Markup.inlineKeyboard(buttons),
  };
}

// Helper: enviar menú según rol
function sendMainMenu(ctx, user) {
  if (user.role === 'creator' && user.creator_status && user.creator_status !== 'approved') {
    return ctx.reply(
      'Tu solicitud para ser creadora está pendiente de aprobación por un admin. Te avisaremos cuando se active.'
    );
  }
  if (user.role === 'client') {
    return ctx.reply('Menú de cliente 👤\nPulsa un botón:', Markup.inlineKeyboard([
      [Markup.button.callback('💰 Saldo', 'menu:saldo')],
      [Markup.button.callback('📝 Nuevo pedido', 'menu:nuevo_pedido')],
      [Markup.button.callback('📦 Mis pedidos', 'menu:mis_pedidos')],
    ]));
  }

  if (user.role === 'creator') {
    return ctx.reply('Menú de creadora 💃\nPulsa un botón:', Markup.inlineKeyboard([
      [Markup.button.callback('💰 Saldo', 'menu:saldo')],
      [Markup.button.callback('📂 Mis servicios', 'menu:mis_servicios')],
      [Markup.button.callback('➕ Nuevo servicio', 'menu:nuevo_servicio')],
      [Markup.button.callback('📋 Trabajos', 'menu:trabajos')],
      [Markup.button.callback('👤 Mi perfil', 'menu:mi_perfil')],
      [Markup.button.callback('💸 Retirar', 'menu:retirar')],
    ]));
  }

  if (user.role === 'admin') {
    return ctx.reply('Menú de admin 🛠️\nPulsa un botón:', Markup.inlineKeyboard([
      [Markup.button.callback('💰 Saldo', 'menu:saldo')],
      [Markup.button.callback('📑 Retiradas', 'menu:admin_retiradas')],
    ]));
  }

  // Rol desconocido → usar menú inicial
  return ctx.reply(
    'Elige tu rol:',
    Markup.keyboard([['🧑‍💻 Soy cliente', '💃 Soy creadora']]).resize()
  );
}

// ---------- /start ----------

bot.start(async ctx => {
  const user = getOrInitUser(ctx);
  if (!(await requireTermsAccepted(ctx))) return;

  // Si es admin por ID, fúrzalo como admin
  if (isAdmin(ctx) && user.role !== 'admin') {
    updateUserRole(user.id, 'admin');
    user.role = 'admin';
  }

  // Si ya tenía rol guardado, entra directo al menú y evita repetir registro tras reinicios
  const shouldNotify = user.role === 'creator' && shouldNotifyCreatorOnline(user);

  if ((user.role === 'client' || user.role === 'creator' || user.role === 'admin') && user.role_confirmed) {
    if (shouldNotify) {
      await notifyClientsCreatorOnline(user);
    }
    return sendMainMenu(ctx, user);
  }

  let text = `Hola, ${ctx.from.first_name || ''}.\n\n`;
  text += `Este bot funciona como intermediario de pagos seguros.\n`;
  text += `Primero necesito saber qué eres:\n\n`;

  await ctx.reply(
    text,
    Markup.keyboard([
      ['🧑‍💻 Soy cliente', '💃 Soy creadora'],
    ])
      .oneTime()
      .resize()
  );
});

// Elegir rol
bot.hears('🧑‍💻 Soy cliente', async ctx => {
  const user = getOrInitUser(ctx);
  if (!(await requireTermsAccepted(ctx))) return;
  updateUserRole(user.id, 'client');
  ctx.reply(
    'Perfecto. Eres cliente.\n\nComandos útiles:\n' +
      '/saldo – ver tu saldo\n' +
      '/nuevo_pedido – crear un nuevo pedido\n' +
      '/mis_pedidos – ver tus pedidos\n' +
      '/topup <importe> – recarga de prueba (sandbox)\n'
  );
});

async function handleCreatorRequest(ctx) {
  const user = getOrInitUser(ctx);
  if (!(await requireTermsAccepted(ctx))) return;
  if (user.creator_status === 'approved') {
    if (user.role !== 'creator') {
      updateUserRole(user.id, 'creator');
      user.role = 'creator';
    }
    user.role_confirmed = 1;
    return sendMainMenu(ctx, user);
  }
  if (user.creator_status === 'pending') {
    return ctx.reply('Tu solicitud ya está pendiente de aprobación. Te avisaremos al aprobarla.');
  }
  if (user.creator_status === 'rejected') {
    return ctx.reply('Tu solicitud anterior fue rechazada. Contacta con un admin si crees que es un error.');
  }
  if (user.role !== 'creator') {
    updateUserRole(user.id, 'creator');
  }
  // Marcar rol como confirmado aunque esté pendiente de aprobación
  if (!user.role_confirmed) {
    user.role_confirmed = 1;
  }
  setCreatorStatus(user.id, 'pending');
  user.creator_status = 'pending';
  const anonId = `C${Math.floor(1000 + Math.random() * 9000)}`;
  if (!user.display_name) {
    updateUserProfile(user.id, { displayName: user.username || anonId });
  }
  await ctx.reply(
    'Solicitud recibida. Tu cuenta de creadora está pendiente de aprobación por un admin. Te avisaremos cuando se apruebe.'
  );

  const textAdmin =
    `📥 Nueva solicitud de creadora\n` +
    `ID interna: ${user.id}\n` +
    `TG ID: ${user.telegram_id}\n` +
    `Usuario: @${ctx.from.username || '-'}\n` +
    `Nombre: ${ctx.from.first_name || ''} ${ctx.from.last_name || ''}\n`;

  for (const adminId of ADMIN_IDS) {
    try {
      await ctx.telegram.sendMessage(
        adminId,
        textAdmin,
        Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Aprobar', `approve_creator:${user.id}`),
            Markup.button.callback('❌ Rechazar', `reject_creator:${user.id}`),
          ],
        ])
      );
    } catch (err) {
      console.error('No pude avisar al admin', err.message);
    }
  }
}

bot.hears('💃 Soy creadora', ctx => {
  handleCreatorRequest(ctx);
});

bot.command('soy_creadora', ctx => {
  handleCreatorRequest(ctx);
});

// ---------- /saldo ----------

bot.command('saldo', ctx => handleSaldo(ctx));

// ---------- /movimientos ----------
bot.command('movimientos', ctx => {
  const user = getOrInitUser(ctx);
  const txs = listTransactionsByUser(user.id, 5);
  if (!txs.length) return ctx.reply('Aún no tienes movimientos.');
  let text = 'Últimos movimientos:\n\n';
  for (const t of txs) {
    text += `${t.created_at} – ${t.type} – ${formatCents(t.amount_cents)}`;
    if (t.related_order_id) text += ` (pedido #${t.related_order_id})`;
    text += '\n';
  }
  ctx.reply(text);
});

// Alias de recarga (futura pasarela)
bot.command('recargar', ctx => {
  ctx.reply('Recarga rápida aún no está conectada a pasarela. Usa /topup <importe> para simular o contacta con un admin para pago real.');
});

// ---------- /menu ----------

bot.command('menu', ctx => {
  const user = getOrInitUser(ctx);
  // Cancelar flujos abiertos (p.ej., nuevo pedido)
  if (ctx.session?.newOrder) ctx.session.newOrder = null;
  if (ctx.session?.newService) ctx.session.newService = null;
  if (ctx.session?.editProfile) ctx.session.editProfile = null;
  return sendMainMenu(ctx, user);
});

// ---------- Ayuda / disputa ----------
bot.command('ayuda', ctx => {
  const user = getOrInitUser(ctx);
  const message = ctx.message.text.replace('/ayuda', '').trim();
  if (!message) {
    return ctx.reply('Cuéntame qué necesitas: /ayuda <mensaje>');
  }
  const text =
    `📣 Soporte\nUsuario: @${user.username || user.telegram_id}\nRol: ${user.role}\nMensaje: ${message}`;
  for (const adminId of ADMIN_IDS) {
    ctx.telegram.sendMessage(adminId, text).catch(() => {});
  }
  ctx.reply('Hemos enviado tu mensaje al soporte. Te responderemos aquí.');
});

bot.command('disputa', ctx => {
  const user = getOrInitUser(ctx);
  const [, ...rest] = ctx.message.text.split(/\s+/);
  if (rest.length < 2) {
    return ctx.reply('Uso: /disputa <id_pedido> <motivo>');
  }
  const orderId = parseInt(rest[0], 10);
  const reason = rest.slice(1).join(' ');
  if (Number.isNaN(orderId)) return ctx.reply('ID de pedido no válido.');
  const order = getOrderById(orderId);
  if (!order || order.client_id !== user.id) {
    return ctx.reply('No he encontrado ese pedido en tu cuenta.');
  }
  const text =
    `⚠️ Disputa\nPedido #${order.id}\nCliente: @${user.username || user.telegram_id}\nMotivo: ${reason}`;
  for (const adminId of ADMIN_IDS) {
    ctx.telegram.sendMessage(adminId, text).catch(() => {});
  }
  ctx.reply('Hemos abierto una incidencia. Un admin lo revisará y te responderá por aquí.');
});

// Menú botones (inline callbacks)
bot.action('menu:saldo', async ctx => {
  await ctx.answerCbQuery();
  return handleSaldo(ctx);
});
bot.action('menu:nuevo_pedido', async ctx => {
  await ctx.answerCbQuery();
  return handleNuevoPedido(ctx);
});
bot.action('menu:mis_pedidos', async ctx => {
  await ctx.answerCbQuery();
  return handleMisPedidos(ctx);
});
bot.action('menu:trabajos', async ctx => {
  await ctx.answerCbQuery();
  return handleTrabajos(ctx);
});
bot.action('menu:mis_servicios', async ctx => {
  await ctx.answerCbQuery();
  return handleMisServicios(ctx);
});
bot.action('menu:nuevo_servicio', async ctx => {
  await ctx.answerCbQuery();
  return startNuevoServicio(ctx);
});
bot.action('menu:mi_perfil', async ctx => {
  await ctx.answerCbQuery();
  return startPerfil(ctx);
});
bot.action('menu:retirar', async ctx => {
  await ctx.answerCbQuery();
  return handleRetirar(ctx);
});

// ---------- Panel admin ----------

bot.command('admin_panel', ctx => {
  if (!isAdmin(ctx)) return;
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('👥 Usuarios', 'admin:users')],
    [Markup.button.callback('💸 Retiradas', 'menu:admin_retiradas')],
    [Markup.button.callback('🪙 Logs', 'admin:logs')],
    [Markup.button.callback('📦 Export DB', 'admin:export_db')],
    [Markup.button.callback('🧑‍💻 Creadoras pendientes', 'admin:pending_creators')],
  ]);
  ctx.reply('Panel de admin 🛠️', keyboard);
});

bot.action('admin:users', async ctx => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Solo admin', { show_alert: true });
  await ctx.answerCbQuery();
  const users = listUsers(20);
  if (!users.length) return ctx.reply('No hay usuarios.');
  let text = `Usuarios recientes (${users.length}):\n\n`;
  for (const u of users) {
    const avail = u.is_available ? '✅' : '❌';
    text += `#${u.id} @${u.username || u.telegram_id} – ${u.role} ${avail} – saldo ${formatCents(
      u.balance_cents
    )}\n`;
  }
  ctx.reply(text);
});

bot.action('admin:logs', async ctx => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Solo admin', { show_alert: true });
  await ctx.answerCbQuery();
  const txs = listTransactions(20);
  if (!txs.length) return ctx.reply('Sin transacciones.');
  let text = 'Últimas transacciones:\n\n';
  for (const t of txs) {
    text += `${t.created_at} – @${t.username || t.telegram_id} – ${t.type} – ${formatCents(
      t.amount_cents
    )}`;
    if (t.related_order_id) text += ` (pedido #${t.related_order_id})`;
    text += '\n';
  }
  ctx.reply(text);
});

bot.action('admin:export_db', async ctx => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Solo admin', { show_alert: true });
  await ctx.answerCbQuery();
  try {
    await ctx.replyWithDocument({ source: DB_FILE_PATH });
  } catch (err) {
    console.error('No pude enviar la base de datos', err.message);
    ctx.reply('No pude enviar la base de datos.');
  }
});

bot.action('admin:pending_creators', async ctx => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Solo admin', { show_alert: true });
  await ctx.answerCbQuery();
  const pending = listPendingCreators();
  if (!pending.length) return ctx.reply('No hay creadoras pendientes.');
  let text = 'Creadoras pendientes:\n\n';
  for (const c of pending) {
    text += `ID ${c.id} – @${c.username || c.telegram_id}\n`;
  }
  ctx.reply(text);
});

// Términos
bot.action('terms_full', async ctx => {
  await ctx.answerCbQuery();
  await ctx.reply(fullTermsText, { parse_mode: 'HTML' });
});

bot.action('terms_accept', async ctx => {
  await ctx.answerCbQuery();
  const user = getOrInitUser(ctx);
  markUserAcceptedTerms(user.id);
  try {
    await ctx.editMessageText('Has aceptado los términos. Ya puedes usar la plataforma.');
  } catch {
    await ctx.reply('Has aceptado los términos. Ya puedes usar la plataforma.');
  }
});

bot.action(/cancel_order:(\d+)/, async ctx => {
  await ctx.answerCbQuery();
  const user = getOrInitUser(ctx);
  if (user.role !== 'client') return;
  const orderId = parseInt(ctx.match[1], 10);
  const order = getOrderById(orderId);
  cancelPendingOrder(ctx, order, user);
});

// Botones de navegación atrás/omitir
bot.action('back:main', async ctx => {
  await ctx.answerCbQuery();
  const user = getOrInitUser(ctx);
  ctx.session.newOrder = null;
  return sendMainMenu(ctx, user);
});

bot.action('back:creators', async ctx => {
  await ctx.answerCbQuery();
  return startCreatorSelection(ctx);
});

bot.action('back:services', async ctx => {
  await ctx.answerCbQuery();
  const flow = ctx.session?.newOrder;
  if (!flow?.creatorId) return;
  const creator = getUserById(flow.creatorId);
  return startServiceSelection(ctx, creator);
});

bot.action('skip_description', async ctx => {
  await ctx.answerCbQuery();
  await finalizeOrder(ctx, '-');
});

// ---------- Selección de creadora y servicio en pedidos ----------

bot.action(/select_creator:(\d+)/, async ctx => {
  await ctx.answerCbQuery();
  const user = getOrInitUser(ctx);
  if (user.role !== 'client') return;
  if (!ctx.session?.newOrder || ctx.session.newOrder.step !== 'choose_creator') return;

  const creatorId = parseInt(ctx.match[1], 10);
  const creator = getUserById(creatorId);
  if (!creator || creator.role !== 'creator') {
    return ctx.reply('Creadora no disponible.');
  }

  return startServiceSelection(ctx, creator);
});

bot.action(/select_service:(\d+)/, async ctx => {
  await ctx.answerCbQuery();
  const user = getOrInitUser(ctx);
  if (user.role !== 'client') return;
  const flow = ctx.session?.newOrder;
  if (!flow || flow.step !== 'choose_service') return;

  const serviceId = parseInt(ctx.match[1], 10);
  const service = getServiceById(serviceId);
  if (!service || service.creator_id !== flow.creatorId) {
    return ctx.reply('Servicio no disponible.');
  }

  await promptOrderDetails(ctx, service, flow);
});

// ---------- CLIENTE: nuevo pedido ----------

bot.command('nuevo_pedido', ctx => handleNuevoPedido(ctx));

bot.hears(/\/cancelar_(\d+)/, ctx => {
  const orderId = parseInt(ctx.match[1], 10);
  const user = getOrInitUser(ctx);
  const order = getOrderById(orderId);
  cancelPendingOrder(ctx, order, user);
});

// ---------- /nuevo_servicio (creadora) ----------

bot.command('nuevo_servicio', async ctx => {
  await startNuevoServicio(ctx);
});

// ---------- /topup (sandbox recarga) ----------
bot.command('topup', async ctx => {
  if (!(await requireTermsAccepted(ctx))) return;
  const user = getOrInitUser(ctx);
  const parts = ctx.message.text.trim().split(/\s+/);
  const amountStr = parts[1];
  if (!amountStr) return ctx.reply('Usa: /topup <euros>. Ej: /topup 10.50');
  const euros = parseFloat(amountStr.replace(',', '.'));
  if (Number.isNaN(euros) || euros <= 0) return ctx.reply('Importe no válido. Ej: 10.50');
  const cents = Math.round(euros * 100);
  changeBalance(user.id, cents);
  createTransaction({ userId: user.id, type: 'topup', amountCents: cents, relatedOrderId: null });
  return ctx.reply(`Saldo recargado en ${formatCents(cents)} (modo sandbox).`);
});

// ---------- /mi_perfil (creadora) ----------

bot.command('mi_perfil', async ctx => {
  await startPerfil(ctx);
});

// Disponibilidad creadora
bot.command('disponible', async ctx => {
  if (!(await requireTermsAccepted(ctx))) return;
  const user = getOrInitUser(ctx);
  if (user.role !== 'creator') return ctx.reply('Solo para creadoras.');
  if (!requireApprovedCreator(ctx, user)) return;
  setUserAvailability(user.id, true);
  return ctx.reply('Marcada como disponible ✅', Markup.removeKeyboard());
});

bot.command('ocupado', async ctx => {
  if (!(await requireTermsAccepted(ctx))) return;
  const user = getOrInitUser(ctx);
  if (user.role !== 'creator') return ctx.reply('Solo para creadoras.');
  if (!requireApprovedCreator(ctx, user)) return;
  setUserAvailability(user.id, false);
  return ctx.reply('Marcada como ocupada ❌ (no recibirás nuevos pedidos)', Markup.removeKeyboard());
});

bot.on('text', async (ctx, next) => {
  const user = getOrInitUser(ctx);

  // Reporte de problema tras completar pedido
  if (ctx.session?.reportOrderId) {
    const orderId = ctx.session.reportOrderId;
    const order = getOrderById(orderId);
  if (!order || order.client_id !== user.id) {
    ctx.session.reportOrderId = null;
    return ctx.reply('Pedido no válido para reporte.');
  }
  setOrderProblem(orderId, ctx.message.text);
  ctx.session.reportOrderId = null;
  await ctx.reply(
    'Disculpas por el inconveniente, revisaremos el problema y te contactaremos en 24-48h.'
  );
  const text =
    `🚩 Reporte de pedido\n` +
    `Pedido #${orderId}\n` +
    `Cliente: @${user.username || user.telegram_id}\n` +
    `Mensaje: ${ctx.message.text}`;
  for (const adminId of ADMIN_IDS) {
    ctx.telegram.sendMessage(adminId, text).catch(() => {});
  }
  return sendMainMenu(ctx, user);
  }

  // Flujo creación de servicio (creadora)
  if (ctx.session?.newService?.step) {
    const flow = ctx.session.newService;

    if (flow.step === 1) {
      flow.name = ctx.message.text.trim();
      flow.step = 2;
      return ctx.reply(
        '¿Qué tipo de servicio es?',
        Markup.keyboard([['Videollamada', 'Contenido', 'Otro']]).oneTime().resize()
      );
    }

    if (flow.step === 2) {
      const choice = ctx.message.text.trim().toLowerCase();
      if (choice === 'videollamada') {
        flow.type = 'call';
      } else if (choice === 'contenido') {
        flow.type = 'content';
      } else if (choice === 'otro') {
        flow.type = 'other';
      } else {
        return ctx.reply('Elige una opción válida: Videollamada, Contenido u Otro.');
      }
      flow.step = 3;
      return ctx.reply('¿Cuál es el precio en euros? (ej: 25.00)');
    }

    if (flow.step === 3) {
      const amountStr = ctx.message.text.replace(',', '.').trim();
      const amount = parseFloat(amountStr);
      if (Number.isNaN(amount) || amount <= 0) {
        return ctx.reply('Importe no válido. Ejemplo: 25.00');
      }
      flow.priceCents = Math.round(amount * 100);
      if (flow.type === 'call') {
        flow.step = 4;
        return ctx.reply('¿Duración en minutos? (ej: 10, 15, 30)');
      }
      flow.step = 5;
      return ctx.reply(
        'Escribe una descripción breve (opcional). Si no quieres, responde con "-"'
      );
    }

    if (flow.step === 4) {
      const duration = parseInt(ctx.message.text.trim(), 10);
      if (Number.isNaN(duration) || duration <= 0) {
        return ctx.reply('Duración no válida. Ejemplo: 15');
      }
      flow.durationMin = duration;
      flow.step = 5;
      return ctx.reply(
        'Escribe una descripción breve (opcional). Si no quieres, responde con "-"'
      );
    }

    if (flow.step === 5) {
      const descriptionRaw = ctx.message.text.trim();
      const description = descriptionRaw === '-' ? null : descriptionRaw;

      const service = createService({
        creatorId: user.id,
        name: flow.name,
        description,
        type: flow.type,
        priceCents: flow.priceCents,
        durationMin: flow.durationMin,
      });

      ctx.session.newService = null;

      const typeLabel = serviceTypeLabel(service.type);
      let confirmation =
        'Servicio creado ✅\n' +
        `Nombre: ${service.name}\n` +
        `Tipo: ${typeLabel}\n` +
        `Precio: ${formatCents(service.price_cents)}`;

      if (service.duration_min) confirmation += `\nDuración: ${service.duration_min} min`;
      if (service.description) confirmation += `\nDescripción: ${service.description}`;

      return ctx.reply(confirmation, Markup.removeKeyboard());
    }
  }

  // Flujo edición de perfil (creadora)
  if (ctx.session?.editProfile?.step) {
    const flow = ctx.session.editProfile;
    if (flow.step === 1) {
      flow.displayName = ctx.message.text.trim();
      flow.step = 2;
      return ctx.reply(
        'Escribe una bio breve (o responde "-" para saltar).'
      );
    }

    if (flow.step === 2) {
      const text = ctx.message.text?.trim();
      flow.bio = text === '-' ? null : text;
      flow.step = 3;
      return ctx.reply('Idiomas (ej: es,en) o responde "-" si no quieres indicar.', Markup.removeKeyboard());
    }

    if (flow.step === 3) {
      const text = ctx.message.text?.trim();
      flow.languages = text === '-' ? null : text;
      flow.step = 4;
      return ctx.reply('Envía una foto para tu perfil (o responde "-" si no quieres cambiarla).');
    }

    if (flow.step === 4) {
      const text = ctx.message.text?.trim();
      if (text === '-') {
        updateUserProfile(user.id, {
          displayName: flow.displayName,
          bio: flow.bio,
          languages: flow.languages,
        });
        ctx.session.editProfile = null;
        await ctx.reply('Perfil actualizado ✅ (nombre/bio/idiomas).');
        return sendMainMenu(ctx, user);
      }
      return ctx.reply('Por favor, envía una foto o responde "-" si no quieres cambiarla.');
    }
  }

  // Flujo de creación de pedido
  if (ctx.session?.newOrder?.step === 'details' && user.role === 'client') {
    await finalizeOrder(ctx, ctx.message.text.trim());
    return;
  }

  // Otros textos que no formen parte de flujo
  return next();
});

// ---------- CREADORA: aceptar pedido ----------

bot.action(/accept_order:(\d+)/, async ctx => {
  const orderId = parseInt(ctx.match[1], 10);
  const TgUser = ctx.from;
  const user = getOrInitUser({ from: TgUser, ...ctx });

  if (user.role !== 'creator') {
    return ctx.answerCbQuery('Solo las creadoras pueden aceptar pedidos.');
  }
  if (!requireApprovedCreator(ctx, user)) return;

  const order = getOrderById(orderId);
  if (!order) {
    return ctx.answerCbQuery('Este pedido ya no existe.');
  }
  if (order.status !== 'pending') {
    return ctx.answerCbQuery('Este pedido ya fue aceptado por otra creadora.');
  }

  // Intentar cobrar al cliente en el momento de la aceptación
  const client = getUserById(order.client_id);
  if (!client) return ctx.answerCbQuery('Cliente no encontrado.');
  const prices = [];
  prices.push({ label: 'Servicio', amount: order.amount_cents });
  if (order.fee_cents) prices.push({ label: 'Fees', amount: order.fee_cents });
  const total = order.total_cents || order.amount_cents + (order.fee_cents || 0);
  const currency = order.currency || DEFAULT_CURRENCY;
  const providerToken =
    currency.toUpperCase() === 'USD' ? PAYMENT_PROVIDER_TOKEN_USD : PAYMENT_PROVIDER_TOKEN_EUR;
  if (!providerToken) {
    return ctx.answerCbQuery('Pasarela no configurada.');
  }

  updateOrder(order.id, {
    creator_id: user.id,
    status: 'pending_payment',
    updated_at: new Date().toISOString(),
  });

  updateOrder(order.id, {
    creator_id: user.id,
    status: 'pending_payment',
    updated_at: new Date().toISOString(),
  });

  ctx.answerCbQuery('Pedido aceptado, esperando pago del cliente.');
  if (hasValidTelegramId(client)) {
    try {
      await ctx.telegram.sendInvoice(client.telegram_id, {
        title: `Pedido #${order.id}`,
        description: order.description || 'Servicio personalizado',
        payload: `order_${order.id}`,
        currency,
        prices,
        provider_token: providerToken,
      });
    } catch (err) {
      console.error('No pude enviar invoice', err.message);
    }
  }

  // Informar a la creadora que está a la espera de pago
  await ctx.editMessageText(
    `Has aceptado el pedido #${order.id}.\n\nDescripción: ${order.description}\nImporte: ${formatCents(
      order.amount_cents
    )} + fees ${formatCents(order.fee_cents || 0)} (total ${formatCents(
      order.total_cents || order.amount_cents
    )}).\n\nEsperando pago del cliente.`
  );
});

// ---------- CREADORA: iniciar videollamada ----------

bot.action(/start_call:(\d+)/, async ctx => {
  const orderId = parseInt(ctx.match[1], 10);
  const user = getOrInitUser(ctx);

  if (user.role !== 'creator') {
    return ctx.answerCbQuery('Solo las creadoras pueden iniciar la llamada.');
  }
  if (!requireApprovedCreator(ctx, user)) return;

  const order = getOrderById(orderId);
  if (!order) return ctx.answerCbQuery('Pedido no encontrado.');
  if (order.creator_id !== user.id) return ctx.answerCbQuery('No es tu pedido.');
  if (order.type !== 'call') return ctx.answerCbQuery('Este pedido no es de videollamada.');
  if (order.status === 'pending_payment') return ctx.answerCbQuery('Aún no está pagado.');

  let callUrl = order.call_url;
  if (!callUrl) {
    callUrl = generateCallLink(order.id);
    updateOrder(order.id, {
      call_url: callUrl,
      status: 'in_call',
      updated_at: new Date().toISOString(),
    });
  } else if (order.status !== 'in_call') {
    updateOrder(order.id, {
      status: 'in_call',
      updated_at: new Date().toISOString(),
    });
  }

  ctx.answerCbQuery('Videollamada iniciada ✅');

  await ctx.editMessageText(
    `Videollamada del pedido #${order.id} iniciada.\nEntra aquí:\n${callUrl}\n\nCuando termines, usa /completar_${order.id}`,
    Markup.inlineKeyboard([[Markup.button.callback('Abrir pedido', `noop:${order.id}`)]])
  );

  const client = getUserById(order.client_id);
  if (client && hasValidTelegramId(client)) {
    try {
      await ctx.telegram.sendMessage(
        client.telegram_id,
        `Tu videollamada del pedido #${order.id} está lista. Entra aquí:\n${callUrl}\n\nCuando termine la sesión, la creadora marcará el pedido como completado.`,
        Markup.inlineKeyboard([[Markup.button.callback('Abrir pedido', `noop:${order.id}`)]])
      );
    } catch (err) {
      console.error('Error avisando al cliente', err.message);
    }
  }
});

// ---------- CREADORA: completar pedido ----------

// comando dinámico: /completar_123
bot.hears(/\/completar_(\d+)/, async ctx => {
  const orderId = parseInt(ctx.match[1], 10);
  const user = getOrInitUser(ctx);

  if (user.role !== 'creator') {
    return ctx.reply('Este comando solo es para creadoras.');
  }
  if (!requireApprovedCreator(ctx, user)) return;

  const order = getOrderById(orderId);
  if (!order) return ctx.reply('Pedido no encontrado.');
  if (order.creator_id !== user.id) return ctx.reply('Este pedido no está asignado a ti.');
  if (order.status !== 'accepted' && order.status !== 'in_call') {
    return ctx.reply('El pedido no está en estado aceptado.');
  }
  if (order.status === 'pending_payment') {
    return ctx.reply('El pedido aún no está pagado.');
  }

  // Liberar el dinero al saldo de la creadora
  updateOrder(order.id, {
    status: 'completed',
    updated_at: new Date().toISOString(),
  });

  changeBalance(user.id, order.amount_cents);
  createTransaction({
    userId: user.id,
    type: 'release',
    amountCents: order.amount_cents,
    relatedOrderId: order.id,
  });

  await ctx.reply(
    `Has marcado como completado el pedido #${order.id} ✅\nSe han añadido ${formatCents(
      order.amount_cents
    )} a tu saldo.`
  );

  const client = getUserById(order.client_id);
  if (client && hasValidTelegramId(client)) {
    try {
      await ctx.telegram.sendMessage(
        client.telegram_id,
        `Tu pedido #${order.id} ha sido marcado como completado.\nValora la experiencia o informa de un problema.`,
        Markup.inlineKeyboard([
          [
            Markup.button.callback('⭐️ 1', `rate_order:${order.id}:1`),
            Markup.button.callback('⭐️ 2', `rate_order:${order.id}:2`),
            Markup.button.callback('⭐️ 3', `rate_order:${order.id}:3`),
            Markup.button.callback('⭐️ 4', `rate_order:${order.id}:4`),
            Markup.button.callback('⭐️ 5', `rate_order:${order.id}:5`),
          ],
          [Markup.button.callback('🚩 Informar problema', `report_order:${order.id}`)],
        ])
      );
    } catch (err) {
      console.error('Error avisando al cliente', err.message);
    }
  }
});

// ---------- /mis_pedidos (cliente) ----------

bot.command('mis_pedidos', async ctx => {
  await handleMisPedidos(ctx);
});

// ---------- /trabajos (creadora) ----------

bot.command('trabajos', async ctx => {
  await handleTrabajos(ctx);
});

// ---------- /mis_servicios (creadora) ----------

bot.command('mis_servicios', async ctx => {
  await handleMisServicios(ctx);
});

bot.action(/toggle_service:(\d+)/, ctx => {
  const serviceId = parseInt(ctx.match[1], 10);
  const user = getOrInitUser(ctx);
  const service = getServiceById(serviceId);
  if (!service) return ctx.answerCbQuery('Servicio no encontrado.');
  if (service.creator_id !== user.id) return ctx.answerCbQuery('No es tu servicio.');

  setServiceActive(serviceId, service.is_active ? 0 : 1);
  const services = listServicesByCreator(user.id, true);
  const { text, keyboard } = buildServicesMessage(services);
  const opts = keyboard ? { reply_markup: keyboard.reply_markup } : undefined;
  return ctx.editMessageText(text, opts);
});

bot.action(/delete_service:(\d+)/, ctx => {
  const serviceId = parseInt(ctx.match[1], 10);
  const user = getOrInitUser(ctx);
  const service = getServiceById(serviceId);
  if (!service) return ctx.answerCbQuery('Servicio no encontrado.');
  if (service.creator_id !== user.id) return ctx.answerCbQuery('No es tu servicio.');

  deleteService(serviceId);
  const services = listServicesByCreator(user.id, true);
  const { text, keyboard } = buildServicesMessage(services);
  const opts = keyboard ? { reply_markup: keyboard.reply_markup } : undefined;
  return ctx.editMessageText(text, opts);
});

// ---------- /retirar (creadora) ----------

bot.command('retirar', ctx => handleRetirar(ctx));

// ---------- Chat anónimo por pedido ----------

bot.hears(/\/chat_(\d+)/, ctx => {
  const orderId = parseInt(ctx.match[1], 10);
  const user = getOrInitUser(ctx);
  const order = getOrderById(orderId);
  if (!order) return ctx.reply('Pedido no encontrado.');

  if (user.role === 'client') {
    if (order.client_id !== user.id) return ctx.reply('Este pedido no es tuyo.');
    if (!order.creator_id) return ctx.reply('Aún no hay creadora asignada.');
  } else if (user.role === 'creator') {
    if (order.creator_id !== user.id) return ctx.reply('Este pedido no está asignado a ti.');
    if (!requireApprovedCreator(ctx, user)) return;
  } else {
    return ctx.reply('Este comando es solo para clientes o creadoras.');
  }

  ctx.session.chatOrderId = orderId;
  ctx.session.lastChatOrderId = orderId;
  ctx.reply(
    `Chat activado para el pedido #${orderId}.\nTodo lo que envíes (texto, fotos, vídeos, audios, documentos) se reenviará de forma anónima.\nUsa /stop_chat para dejar de chatear.`,
    Markup.inlineKeyboard([[Markup.button.callback('❌ Cerrar chat', `close_chat:${orderId}`)]])
  );
});

bot.command('stop_chat', ctx => {
  if (ctx.session?.chatOrderId) {
    ctx.session.chatOrderId = null;
    const last = ctx.session.lastChatOrderId;
    const hint =
      last && last !== ctx.session.chatOrderId
        ? `\nPara reabrir: /chat_${last}`
        : '';
    return ctx.reply(`Chat desactivado.${hint}`);
  }
  return ctx.reply('No hay chat activo.');
});

bot.action(/close_chat:(\d+)/, async ctx => {
  await ctx.answerCbQuery();
  ctx.session.chatOrderId = null;
  ctx.reply('Chat desactivado.');
});

// ---------- Valoraciones y reportes ----------

bot.action(/rate_order:(\d+):([1-5])/, async ctx => {
  await ctx.answerCbQuery();
  const orderId = parseInt(ctx.match[1], 10);
  const rating = parseInt(ctx.match[2], 10);
  const user = getOrInitUser(ctx);
  const order = getOrderById(orderId);
  if (!order) return ctx.reply('Pedido no encontrado.');
  if (order.client_id !== user.id) return ctx.reply('Este pedido no es tuyo.');
  if (order.status !== 'completed') return ctx.reply('Solo puedes valorar pedidos completados.');
  if (order.rating) return ctx.reply('Ya valoraste este pedido.');
  setOrderRating(order.id, rating);
  try {
    await ctx.editMessageReplyMarkup();
  } catch {}
  await ctx.reply(`Gracias por tu valoración: ${rating} ⭐️`);
  return sendMainMenu(ctx, user);
});

bot.action(/report_order:(\d+)/, async ctx => {
  await ctx.answerCbQuery();
  const orderId = parseInt(ctx.match[1], 10);
  const user = getOrInitUser(ctx);
  const order = getOrderById(orderId);
  if (!order) return ctx.reply('Pedido no encontrado.');
  if (order.client_id !== user.id) return ctx.reply('Este pedido no es tuyo.');
  if (order.status !== 'completed') return ctx.reply('Solo puedes reportar pedidos completados.');
  ctx.session.reportOrderId = orderId;
  ctx.reply('Describe el problema (se enviará a soporte).');
});

// ---------- ADMIN: recargar saldo manual ----------
// /admin_topup <telegramId|@username> <importe_en_euros>

bot.command('admin_topup', ctx => {
  if (!isAdmin(ctx)) return;

  const parts = ctx.message.text.split(' ').slice(1);
  if (parts.length < 2) {
    return ctx.reply('Uso: /admin_topup <telegramId|@username> <importe_en_euros>');
  }

  let identifier = parts[0];
  const amountStr = parts[1].replace(',', '.');
  const amount = parseFloat(amountStr);
  if (Number.isNaN(amount) || amount <= 0) {
    return ctx.reply('Importe no válido.');
  }
  const amountCents = Math.round(amount * 100);
  const user = findUserByRef(identifier);

  if (!user) {
    return ctx.reply('Usuario no encontrado en la base de datos.');
  }

  changeBalance(user.id, amountCents);
  createTransaction({
    userId: user.id,
    type: 'topup',
    amountCents,
    relatedOrderId: null,
  });

  ctx.reply(
    `Saldo recargado ✅\nUsuario: @${user.username || user.telegram_id}\nImporte: ${formatCents(
      amountCents
    )}`
  );
});

// ---------- ADMIN: listar retiradas ----------

bot.command('admin_retiradas', ctx => {
  if (!isAdmin(ctx)) return;
  const list = listPendingWithdrawals();
  if (!list.length) return ctx.reply('No hay retiradas pendientes.');

  let text = 'Retiradas pendientes:\n\n';
  for (const w of list) {
    text += `#${w.id} – @${w.username || w.telegram_id} – ${formatCents(
      w.amount_cents
    )}\n`;
  }
  ctx.reply(text);
});

// ---------- ADMIN: listar usuarios ----------
// /admin_users [limite]
bot.command('admin_users', ctx => {
  if (!isAdmin(ctx)) return;
  const parts = ctx.message.text.trim().split(/\s+/).slice(1);
  const limit = parts[0] ? Math.min(parseInt(parts[0], 10) || 20, 100) : 20;
  const users = listUsers(limit);
  if (!users.length) return ctx.reply('No hay usuarios aún.');
  let text = `Últimos ${users.length} usuarios:\n\n`;
  for (const u of users) {
    const avail = u.is_available ? '✅' : '❌';
    text += `#${u.id} @${u.username || u.telegram_id} – ${u.role} ${avail} – saldo ${formatCents(
      u.balance_cents
    )}\n`;
  }
  ctx.reply(text);
});

// ---------- ADMIN: cambiar rol ----------
// /admin_setrole <telegramId|@username> <client|creator|admin>
bot.command('admin_setrole', ctx => {
  if (!isAdmin(ctx)) return;
  const parts = ctx.message.text.trim().split(/\s+/).slice(1);
  if (parts.length < 2) {
    return ctx.reply('Uso: /admin_setrole <telegramId|@username> <client|creator|admin>');
  }
  const targetRef = parts[0];
  const role = parts[1];
  if (!['client', 'creator', 'admin'].includes(role)) {
    return ctx.reply('Rol no válido (client|creator|admin).');
  }
  const user = findUserByRef(targetRef);
  if (!user) return ctx.reply('Usuario no encontrado.');
  updateUserRole(user.id, role);
  if (role === 'creator') {
    setCreatorStatus(user.id, 'approved');
  }
  ctx.reply(`Rol actualizado ✅ @${user.username || user.telegram_id} ahora es ${role}`);
});

// ---------- ADMIN: logs rápidos ----------
bot.command('admin_logs', ctx => {
  if (!isAdmin(ctx)) return;
  const txs = listTransactions(20);
  if (!txs.length) return ctx.reply('Sin transacciones.');
  let text = 'Últimas transacciones:\n\n';
  for (const t of txs) {
    text += `${t.created_at} – @${t.username || t.telegram_id} – ${t.type} – ${formatCents(
      t.amount_cents
    )}`;
    if (t.related_order_id) text += ` (order #${t.related_order_id})`;
    text += '\n';
  }
  ctx.reply(text);
});

// ---------- ADMIN: exportar base de datos ----------
bot.command('admin_export_db', async ctx => {
  if (!isAdmin(ctx)) return;
  try {
    await ctx.replyWithDocument({ source: DB_FILE_PATH });
  } catch (err) {
    console.error('No pude enviar la base de datos', err.message);
    ctx.reply('No pude enviar la base de datos.');
  }
});

// ---------- ADMIN: creadoras pendientes ----------
bot.command('admin_creadoras_pendientes', ctx => {
  if (!isAdmin(ctx)) return;
  const pending = listPendingCreators();
  if (!pending.length) return ctx.reply('No hay creadoras pendientes.');
  let text = 'Creadoras pendientes:\n\n';
  for (const c of pending) {
    text += `ID ${c.id} – @${c.username || c.telegram_id}\n`;
  }
  ctx.reply(text);
});

bot.action(/approve_creator:(\d+)/, async ctx => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Sin permisos', { show_alert: true });
  const creatorId = parseInt(ctx.match[1], 10);
  const creator = getUserById(creatorId);
  if (!creator) return ctx.answerCbQuery('No encontrado');
  setCreatorStatus(creator.id, 'approved');
  setUserAvailability(creator.id, true);
  await ctx.answerCbQuery('Creadora aprobada');
  try {
    await ctx.editMessageReplyMarkup();
  } catch {}
  try {
    await ctx.telegram.sendMessage(
      creator.telegram_id,
      'Tu cuenta de creadora ha sido aprobada. Ya puedes usar el panel y aparecer en los listados.'
    );
  } catch (err) {
    console.error('No pude notificar aprobación', err.message);
  }
});

bot.action(/reject_creator:(\d+)/, async ctx => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Sin permisos', { show_alert: true });
  const creatorId = parseInt(ctx.match[1], 10);
  const creator = getUserById(creatorId);
  if (!creator) return ctx.answerCbQuery('No encontrado');
  setCreatorStatus(creator.id, 'rejected');
  setUserAvailability(creator.id, false);
  await ctx.answerCbQuery('Creadora rechazada');
  try {
    await ctx.editMessageReplyMarkup();
  } catch {}
  try {
    await ctx.telegram.sendMessage(
      creator.telegram_id,
      'Tu solicitud de creadora fue rechazada. Si crees que es un error, contacta con un admin.'
    );
  } catch (err) {
    console.error('No pude notificar rechazo', err.message);
  }
});

// ---------- ADMIN: marcar retirada procesada ----------
// /admin_retirada_ok <id>

bot.command('admin_retirada_ok', ctx => {
  if (!isAdmin(ctx)) return;
  const parts = ctx.message.text.split(' ').slice(1);
  if (!parts.length) return ctx.reply('Uso: /admin_retirada_ok <id>');

  const id = parseInt(parts[0], 10);
  if (Number.isNaN(id)) return ctx.reply('ID no válido.');

  markWithdrawalProcessed(id);
  ctx.reply(`Retirada #${id} marcada como procesada ✅`);
});

// ---------- Callbacks neutros ----------

bot.action(/noop:(\d+)/, ctx => ctx.answerCbQuery());

// ---------- Chat forwarding anónimo ----------

bot.on(['text', 'photo', 'video', 'voice', 'audio', 'document', 'video_note', 'sticker'], async ctx => {
  // Foto para perfil (creadora)
  if (ctx.session?.editProfile?.step === 4 && ctx.message.photo) {
    const user = getOrInitUser(ctx);
    if (user.role !== 'creator') {
      ctx.session.editProfile = null;
      return;
    }
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];
    const fileId = largest.file_id;
    updateUserProfile(user.id, {
      displayName: ctx.session.editProfile.displayName,
      bio: ctx.session.editProfile.bio,
      languages: ctx.session.editProfile.languages,
      photoFileId: fileId,
    });
    ctx.session.editProfile = null;
    await ctx.reply('Perfil actualizado ✅ (nombre/bio/idiomas y foto).');
    return sendMainMenu(ctx, user);
  }

  const orderId = ctx.session?.chatOrderId;
  if (!orderId) return;

  const user = getOrInitUser(ctx);
  const order = getOrderById(orderId);

  if (!order) {
    ctx.session.chatOrderId = null;
    return ctx.reply('Pedido no encontrado. Chat desactivado.');
  }

  let targetTelegramId = null;

  if (user.role === 'client') {
    if (order.client_id !== user.id) return ctx.reply('Este pedido no es tuyo.');
    if (!order.creator_id) return ctx.reply('Aún no hay creadora asignada.');
    const creator = getUserById(order.creator_id);
    targetTelegramId = creator?.telegram_id;
  } else if (user.role === 'creator') {
    if (order.creator_id !== user.id) return ctx.reply('Este pedido no está asignado a ti.');
    const client = getUserById(order.client_id);
    targetTelegramId = client?.telegram_id;
  } else {
    return;
  }

  if (!targetTelegramId) {
    return ctx.reply('No se pudo enviar el mensaje al destinatario.');
  }

  try {
    await ctx.telegram.copyMessage(targetTelegramId, ctx.chat.id, ctx.message.message_id, {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback(`Pedido #${order.id}`, `noop:${order.id}`)],
      ]),
    });
  } catch (err) {
    console.error('Error reenviando mensaje anónimo', err.message);
    await ctx.reply('No se pudo reenviar el mensaje.');
  }
});

// ---------- Pagos (Telegram Payments) ----------

bot.on('pre_checkout_query', ctx => ctx.answerPreCheckoutQuery(true));

bot.on('successful_payment', async ctx => {
  const payment = ctx.message.successful_payment;
  const payload = payment.invoice_payload;
  const match = payload && payload.match(/^order_(\d+)$/);
  if (!match) return;
  const orderId = parseInt(match[1], 10);
  const order = getOrderById(orderId);
  if (!order) return;
  const user = getOrInitUser(ctx);
  if (order.client_id !== user.id) return;

  const total = order.total_cents || order.amount_cents + (order.fee_cents || 0);
  if (
    payment.total_amount !== total ||
    payment.currency.toUpperCase() !== (order.currency || DEFAULT_CURRENCY).toUpperCase()
  ) {
    return ctx.reply('El pago no coincide con el pedido. Contacta con soporte.');
  }

  updateOrder(order.id, {
    payment_status: 'paid',
    status: order.status === 'pending_payment' ? 'accepted' : order.status,
    updated_at: new Date().toISOString(),
  });

  // Avisar a la creadora que ya está pagado
  if (order.creator_id) {
    const creator = getUserById(order.creator_id);
    if (creator && hasValidTelegramId(creator)) {
      try {
        await ctx.telegram.sendMessage(
          creator.telegram_id,
          `El pedido #${order.id} ya está pagado. Puedes iniciar o completar cuando corresponda.`
        );
      } catch (err) {
        console.error('No pude avisar a creadora sobre pago', err.message);
      }
    }
  }

  // Confirmar al cliente
  await ctx.reply(
    `Pago recibido para el pedido #${order.id} ✅\nImporte total: ${formatCents(total)}`
  );
});

// ---------- Lanzar bot / servidor ----------

// Recordatorios periódicos de pedidos pendientes con saldo bloqueado
setInterval(() => {
  remindStalePendingOrders().catch(err =>
    console.error('Error en recordatorio de pedidos pendientes', err)
  );
  const expired = listExpiredPendingOrders();
  if (expired.length) {
    for (const order of expired) {
      expirePendingOrder(order.id);
      const client = getUserById(order.client_id);
      if (client && hasValidTelegramId(client)) {
        bot.telegram
          .sendMessage(
            client.telegram_id,
            `Tu pedido #${order.id} ha caducado tras ${PENDING_EXPIRATION_MINUTES} minutos sin ser aceptado/pagado.`
          )
          .catch(() => {});
      }
    }
  }
}, REMINDER_INTERVAL_MS);

async function startBot() {
  if (USE_WEBHOOK && WEBHOOK_URL) {
    try {
      await bot.telegram.setWebhook(WEBHOOK_URL);
      console.log('Webhook configurado en', WEBHOOK_URL);
    } catch (err) {
      console.error('No pude configurar webhook', err.message);
    }
  } else {
    bot.launch().then(() => {
      console.log('Bot iniciado en modo long polling');
      remindStalePendingOrders().catch(err =>
        console.error('Error en recordatorio inicial de pedidos pendientes', err)
      );
      const expired = listExpiredPendingOrders();
      if (expired.length) {
        for (const order of expired) {
          expirePendingOrder(order.id);
          const client = getUserById(order.client_id);
          if (client && hasValidTelegramId(client)) {
            bot.telegram
              .sendMessage(
                client.telegram_id,
                `Tu pedido #${order.id} ha caducado tras ${PENDING_EXPIRATION_MINUTES} minutos sin ser aceptado/pagado.`
              )
              .catch(() => {});
          }
        }
      }
    });
  }
}

const app = express();
app.use(express.json());
app.use('/webapp', express.static(path.join(process.cwd(), 'webapp')));
app.get('/health', (_req, res) =>
  res.json({ ok: true, mode: USE_WEBHOOK ? 'webhook' : 'polling' })
);

if (USE_WEBHOOK && WEBHOOK_PATH) {
  app.post(WEBHOOK_PATH, bot.webhookCallback(WEBHOOK_PATH));
}

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

startBot();

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
