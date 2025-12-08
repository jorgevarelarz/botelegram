import { describe, it, expect, beforeEach } from 'vitest';
import * as db from '../db.js';

describe('flujo de pedidos y cobro diferido', () => {
  beforeEach(async () => {
    process.env.DATABASE_PATH = ':memory:';
    db.resetDatabase();
  });

  it('no cobra al crear pedido y falla al aceptar sin saldo', () => {
    const client = db.findOrCreateUser({ telegramId: 'c1', username: 'cliente' });
    const creator = db.findOrCreateUser({ telegramId: 'cr1', username: 'creadora', role: 'creator' });
    db.updateUserRole(client.id, 'client');
    db.updateUserRole(creator.id, 'creator');
    const service = db.createService({
      creatorId: creator.id,
      name: 'Video 10m',
      description: null,
      type: 'call',
      priceCents: 2000,
      durationMin: 10,
    });

    const order = db.createOrder({
      clientId: client.id,
      amountCents: service.price_cents,
      description: service.name,
      type: service.type,
      etaMinutes: service.duration_min,
    });

    // Crear pedido no altera saldo del cliente
    const clientAfterOrder = db.getUserById(client.id);
    expect(clientAfterOrder.balance_cents).toBe(0);
    expect(order.status).toBe('pending');

    // Intentar cobrar sin saldo debe lanzar
    expect(() => db.changeBalance(client.id, -order.amount_cents)).toThrowError();
  });

  it('cobra al aceptar y libera a la creadora al completar', () => {
    const client = db.findOrCreateUser({ telegramId: 'c2', username: 'cliente2' });
    const creator = db.findOrCreateUser({ telegramId: 'cr2', username: 'creadora2', role: 'creator' });
    db.updateUserRole(client.id, 'client');
    db.updateUserRole(creator.id, 'creator');

    // Recarga previa del cliente
    db.changeBalance(client.id, 5000);
    const service = db.createService({
      creatorId: creator.id,
      name: 'Pack fotos',
      description: '5 fotos',
      type: 'content',
      priceCents: 3000,
      durationMin: null,
    });

    const order = db.createOrder({
      clientId: client.id,
      amountCents: service.price_cents,
      description: service.name,
      type: service.type,
    });

    // Cobro en aceptación (hold)
    db.changeBalance(client.id, -order.amount_cents);
    db.createTransaction({
      userId: client.id,
      type: 'hold',
      amountCents: order.amount_cents,
      relatedOrderId: order.id,
    });
    db.updateOrder(order.id, {
      creator_id: creator.id,
      status: 'accepted',
      updated_at: new Date().toISOString(),
    });

    const clientAfterAccept = db.getUserById(client.id);
    expect(clientAfterAccept.balance_cents).toBe(2000);

    // Completar pedido: liberar fondos a creadora
    db.updateOrder(order.id, { status: 'completed', updated_at: new Date().toISOString() });
    db.changeBalance(creator.id, order.amount_cents);
    db.createTransaction({
      userId: creator.id,
      type: 'release',
      amountCents: order.amount_cents,
      relatedOrderId: order.id,
    });

    const creatorAfter = db.getUserById(creator.id);
    expect(creatorAfter.balance_cents).toBe(order.amount_cents);
  });
});
