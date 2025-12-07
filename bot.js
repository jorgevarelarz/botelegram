import { Telegraf, session, Markup } from 'telegraf';
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
  const user = getOrInitUser(ctx);
  return ctx.reply(`Tu saldo actual es: *${formatCents(user.balance_cents)}*`, {
    parse_mode: 'Markdown',
  });
}

async function handleNuevoPedido(ctx) {
  const user = getOrInitUser(ctx);
  if (user.role !== 'client') {
    return ctx.reply('Este comando es solo para clientes.');
  }

  await sendCreatorCards(ctx);
  return startCreatorSelection(ctx);
}

function startNuevoServicio(ctx) {
  const user = getOrInitUser(ctx);
  if (user.role !== 'creator') {
    return ctx.reply('Este comando es solo para creadoras.');
  }

  ctx.session.newService = { step: 1 };
  return ctx.reply(
    "Vamos a crear un nuevo servicio.\nDime primero el nombre del servicio (ej: 'Videollamada 15 min', 'Pack 10 fotos')."
  );
}

function startPerfil(ctx) {
  const user = getOrInitUser(ctx);
  if (user.role !== 'creator') {
    return ctx.reply('Este comando es solo para creadoras.');
  }
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

  try {
    // Bloquear saldo del cliente (escrow)
    const newBalance = changeBalance(user.id, -amountCents);
    createTransaction({
      userId: user.id,
      type: 'hold',
      amountCents,
      relatedOrderId: null,
    });

    const order = createOrder({
      clientId: user.id,
      amountCents,
      description: fullDescription,
      type: flow.serviceType || null,
    });
    createTransaction({
      userId: user.id,
      type: 'hold',
      amountCents,
      relatedOrderId: order.id,
    });

    ctx.session.newOrder = null;

    await ctx.reply(
      `Pedido creado ✅\n\nID: #${order.id}\nCreadora: ${flow.creatorLabel}\nServicio: ${flow.serviceName}\nImporte bloqueado: ${formatCents(
        order.amount_cents
      )}\n\nTu nuevo saldo es: ${formatCents(newBalance)}`
    );

    // Avisar solo a la creadora elegida
    const creator = getUserById(flow.creatorId);
    if (creator) {
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
  } catch (err) {
    console.error(err);
    return ctx.reply(
      'No tienes saldo suficiente para bloquear ese importe. Recarga saldo o usa un importe menor.'
    );
  }
}

function handleMisPedidos(ctx) {
  const user = getOrInitUser(ctx);
  if (user.role !== 'client') {
    return ctx.reply('Este comando es solo para clientes.');
  }

  const orders = listUserOrders(user.id, 'client', 10);
  if (!orders.length) return ctx.reply('No tienes pedidos aún.');

  let text = 'Tus últimos pedidos:\n\n';
  for (const o of orders) {
    text += `#${o.id} – ${formatCents(o.amount_cents)} – ${o.status}\n`;
    if (o.description) text += `   ${o.description}\n`;
  }
  ctx.reply(text);
}

function handleTrabajos(ctx) {
  const user = getOrInitUser(ctx);
  if (user.role !== 'creator') {
    return ctx.reply('Este comando es solo para creadoras.');
  }

  const orders = listUserOrders(user.id, 'creator', 10);
  if (!orders.length) return ctx.reply('Aún no tienes trabajos asignados.');

  let text = 'Tus últimos trabajos:\n\n';
  for (const o of orders) {
    text += `#${o.id} – ${formatCents(o.amount_cents)} – ${o.status}\n`;
    if (o.description) text += `   ${o.description}\n`;
  }
  ctx.reply(text);
}

function handleMisServicios(ctx) {
  const user = getOrInitUser(ctx);
  if (user.role !== 'creator') {
    return ctx.reply('Este comando es solo para creadoras.');
  }

  const services = listServicesByCreator(user.id, true);
  if (!services.length) {
    return ctx.reply(
      'No tienes servicios definidos todavía. Usa /nuevo_servicio para crear uno.'
    );
  }

  const { text, keyboard } = buildServicesMessage(services);
  return ctx.reply(text, keyboard ? keyboard : undefined);
}

function handleRetirar(ctx) {
  const user = getOrInitUser(ctx);
  if (user.role !== 'creator') {
    return ctx.reply('Este comando solo es para creadoras.');
  }

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
  return findOrCreateUser({
    telegramId: ctx.from.id,
    username: ctx.from.username,
  });
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
      console.error('No pude obtener foto de perfil para', creator.telegram_id, err.message);
    }

    const name = creatorLabel(creator);
    const caption = name;

    if (fileId) {
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

  // Si es admin por ID, fúrzalo como admin
  if (isAdmin(ctx) && user.role !== 'admin') {
    updateUserRole(user.id, 'admin');
    user.role = 'admin';
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
bot.hears('🧑‍💻 Soy cliente', ctx => {
  const user = getOrInitUser(ctx);
  updateUserRole(user.id, 'client');
  ctx.reply(
    'Perfecto. Eres cliente.\n\nComandos útiles:\n' +
      '/saldo – ver tu saldo\n' +
      '/nuevo_pedido – crear un nuevo pedido\n' +
      '/mis_pedidos – ver tus pedidos\n'
  );
});

bot.hears('💃 Soy creadora', ctx => {
  const user = getOrInitUser(ctx);
  updateUserRole(user.id, 'creator');
  ctx.reply(
    'Genial, te registro como creadora.\n\nComandos útiles:\n' +
      '/saldo – ver tu saldo\n' +
      '/trabajos – ver trabajos asignados\n' +
      '/mis_servicios – listar tus servicios\n' +
      '/nuevo_servicio – crear un servicio\n' +
      '/mi_perfil – configurar nombre y foto\n' +
      '/retirar – solicitar retirada de saldo\n'
  );
});

// ---------- /saldo ----------

bot.command('saldo', ctx => handleSaldo(ctx));

// ---------- /menu ----------

bot.command('menu', ctx => {
  const user = getOrInitUser(ctx);
  // Cancelar flujos abiertos (p.ej., nuevo pedido)
  if (ctx.session?.newOrder) ctx.session.newOrder = null;
  if (ctx.session?.newService) ctx.session.newService = null;
  if (ctx.session?.editProfile) ctx.session.editProfile = null;
  return sendMainMenu(ctx, user);
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

// ---------- /nuevo_servicio (creadora) ----------

bot.command('nuevo_servicio', ctx => {
  startNuevoServicio(ctx);
});

// ---------- /mi_perfil (creadora) ----------

bot.command('mi_perfil', ctx => {
  startPerfil(ctx);
});

bot.on('text', async (ctx, next) => {
  const user = getOrInitUser(ctx);

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
        'Envía una foto para tu perfil (o responde "-" si no quieres cambiarla).',
        Markup.removeKeyboard()
      );
    }

    if (flow.step === 2) {
      const text = ctx.message.text?.trim();
      if (text === '-') {
        updateUserProfile(user.id, { displayName: flow.displayName });
        ctx.session.editProfile = null;
        return ctx.reply('Perfil actualizado ✅ (nombre cambiado, sin foto nueva).');
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

  const order = getOrderById(orderId);
  if (!order) {
    return ctx.answerCbQuery('Este pedido ya no existe.');
  }
  if (order.status !== 'pending') {
    return ctx.answerCbQuery('Este pedido ya fue aceptado por otra creadora.');
  }

  updateOrder(order.id, {
    creator_id: user.id,
    status: 'accepted',
    updated_at: new Date().toISOString(),
  });

  ctx.answerCbQuery('Pedido aceptado ✅');

  // Avisar a la creadora
  if (order.type === 'call') {
    await ctx.editMessageText(
      `Has aceptado la videollamada del pedido #${order.id}.\n\nDescripción: ${order.description}\nImporte: ${formatCents(
        order.amount_cents
      )}\n\nCuando estés lista, pulsa "Iniciar videollamada".`,
      Markup.inlineKeyboard([
        [Markup.button.callback('▶ Iniciar videollamada', `start_call:${order.id}`)],
      ])
    );
  } else {
    await ctx.editMessageText(
      `Has aceptado el pedido #${order.id}.\n\nDescripción: ${order.description}\nImporte: ${formatCents(
        order.amount_cents
      )}\n\nCuando termines, usa /completar_${order.id}`
    );
  }

  // Avisar al cliente
  const client = getUserById(order.client_id);
  if (client) {
    try {
      const text =
        order.type === 'call'
          ? `Tu videollamada del pedido #${order.id} ha sido aceptada. Recibirás el enlace cuando la creadora la inicie.`
          : `Tu pedido #${order.id} ha sido aceptado por una creadora.`;
      await ctx.telegram.sendMessage(client.telegram_id, text);
    } catch (err) {
      console.error('Error avisando al cliente', err.message);
    }
  }
});

// ---------- CREADORA: iniciar videollamada ----------

bot.action(/start_call:(\d+)/, async ctx => {
  const orderId = parseInt(ctx.match[1], 10);
  const user = getOrInitUser(ctx);

  if (user.role !== 'creator') {
    return ctx.answerCbQuery('Solo las creadoras pueden iniciar la llamada.');
  }

  const order = getOrderById(orderId);
  if (!order) return ctx.answerCbQuery('Pedido no encontrado.');
  if (order.creator_id !== user.id) return ctx.answerCbQuery('No es tu pedido.');
  if (order.type !== 'call') return ctx.answerCbQuery('Este pedido no es de videollamada.');

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
  if (client) {
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

  const order = getOrderById(orderId);
  if (!order) return ctx.reply('Pedido no encontrado.');
  if (order.creator_id !== user.id) return ctx.reply('Este pedido no está asignado a ti.');
  if (order.status !== 'accepted' && order.status !== 'in_call') {
    return ctx.reply('El pedido no está en estado aceptado.');
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
  if (client) {
    try {
      await ctx.telegram.sendMessage(
        client.telegram_id,
        `Tu pedido #${order.id} ha sido marcado como completado.`
      );
    } catch (err) {
      console.error('Error avisando al cliente', err.message);
    }
  }
});

// ---------- /mis_pedidos (cliente) ----------

bot.command('mis_pedidos', ctx => {
  handleMisPedidos(ctx);
});

// ---------- /trabajos (creadora) ----------

bot.command('trabajos', ctx => {
  handleTrabajos(ctx);
});

// ---------- /mis_servicios (creadora) ----------

bot.command('mis_servicios', ctx => {
  handleMisServicios(ctx);
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
  } else {
    return ctx.reply('Este comando es solo para clientes o creadoras.');
  }

  ctx.session.chatOrderId = orderId;
  ctx.reply(
    `Chat activado para el pedido #${orderId}.\nTodo lo que envíes (texto, fotos, vídeos, audios, documentos) se reenviará de forma anónima.\nUsa /stop_chat para dejar de chatear.`
  );
});

bot.command('stop_chat', ctx => {
  if (ctx.session?.chatOrderId) {
    ctx.session.chatOrderId = null;
    return ctx.reply('Chat desactivado.');
  }
  return ctx.reply('No hay chat activo.');
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

  let user = null;
  if (identifier.startsWith('@')) {
    identifier = identifier.slice(1);
    user = bot.context.dbUserByUsername
      ? bot.context.dbUserByUsername(identifier)
      : null;
  }

  // Si no tenemos helper para username, usamos solo telegram_id numérico
  if (!user) {
    user = getUserByTelegramId(identifier);
  }

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
  if (ctx.session?.editProfile?.step === 2 && ctx.message.photo) {
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
      photoFileId: fileId,
    });
    ctx.session.editProfile = null;
    return ctx.reply('Perfil actualizado ✅ (nombre y foto).');
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

// ---------- Lanzar bot ----------

bot.launch().then(() => {
  console.log('Bot iniciado');
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
