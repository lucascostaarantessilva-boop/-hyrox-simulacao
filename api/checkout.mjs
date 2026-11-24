const database = 'https://htillbyodkqbwaljnkpn.supabase.co';
const publishableKey = 'sb_publishable_uLKimNEVOk8YfPwz0u9ucg_HX3CWmN1';
const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;

async function rpc(op, args = {}) {
  if (!process.env.HYROX_CHECKOUT_KEY) throw new Error('Missing database configuration');
  const response = await fetch(database + '/rest/v1/rpc/hyrox_december_checkout', {
    method: 'POST',
    headers: { apikey: publishableKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ op, args, checkout_key: process.env.HYROX_CHECKOUT_KEY }),
  });
  if (!response.ok) throw new Error('Database request failed');
  return response.json();
}

function previewToken() {
  const token = process.env.MP_ACCESS_TOKEN;
  if (process.env.VERCEL_ENV !== 'preview' || !token || !/^(APP_USR|TEST)-/.test(token)) {
    throw new Error('Missing Mercado Pago preview credential');
  }
  return token;
}

async function mercadoPago(path, body) {
  const response = await fetch('https://api.mercadopago.com' + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: 'Bearer ' + previewToken(),
      'Content-Type': 'application/json',
    },
    body: body && JSON.stringify(body),
  });
  if (!response.ok) throw new Error('Mercado Pago responded with ' + response.status);
  return response.json();
}

async function reconcile(payment, expectedId) {
  const id = payment.external_reference;
  if (!uuid.test(id) || (expectedId && expectedId !== id) || payment.currency_id !== 'BRL') {
    return;
  }
  await rpc('payment', {
    id,
    paymentId: String(payment.id),
    priceCents: Math.round(payment.transaction_amount * 100),
    status: payment.status,
  });
}

function parseEntry(body = {}) {
  const clean = (key) => typeof body?.[key] === 'string' ? body[key].trim() : '';
  const entry = {
    team: clean('team'),
    athlete1: clean('athlete1'),
    athlete2: clean('athlete2'),
    whatsapp1: clean('whatsapp1').replace(/\D/g, ''),
    whatsapp2: clean('whatsapp2').replace(/\D/g, ''),
    category: clean('category'),
  };
  if (entry.team.length > 45 ||
      ![entry.athlete1, entry.athlete2].every(name => name.length >= 2 && name.length <= 70) ||
      ![entry.whatsapp1, entry.whatsapp2].every(phone => /^\d{10,11}$/.test(phone)) ||
      !['Open', 'Performance'].includes(entry.category)) return null;
  return entry;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET' && !req.query.id) {
      return res.json(await rpc('summary'));
    }
    if (req.method === 'GET' && uuid.test(req.query.id)) {
      const id = req.query.id;
      const entry = await rpc('status', { id });
      if (!entry) return res.status(404).json({ error: 'Inscrição não encontrada.' });
      if (['Pendente', 'Expirada'].includes(entry.status)) {
        const payments = await mercadoPago('/v1/payments/search?external_reference=' + id);
        for (const payment of payments.results ?? []) await reconcile(payment, id);
        return res.json(await rpc('status', { id }));
      }
      return res.json(entry);
    }
    if (req.method === 'POST' && req.query.notification === 'mercadopago') {
      const paymentId = String(req.query['data.id'] ?? req.body?.data?.id ?? '');
      if (/^\d{1,24}$/.test(paymentId) && (req.query.type ?? req.body?.type) === 'payment') {
        await reconcile(await mercadoPago('/v1/payments/' + paymentId));
      }
      return res.status(200).end();
    }
    if (req.method !== 'POST') return res.status(400).json({ error: 'Solicitação inválida.' });

    const entry = parseEntry(req.body);
    if (!entry) return res.status(400).json({ error: 'Confira os nomes, WhatsApps e categoria.' });
    previewToken();
    if (!process.env.VERCEL_URL) {
      throw new Error('Missing checkout configuration');
    }
    const order = await rpc('create', entry);
    if (!order.id) return res.status(409).json({ error: 'Inscrições indisponíveis no momento.' });

    try {
      const origin = 'https://' + process.env.VERCEL_URL;
      const returnUrl = origin + '/?inscricao=' + order.id + '#inscricao';
      const expiresAt = new Date(Date.now() + 20 * 60_000).toISOString();
      const preference = await mercadoPago('/checkout/preferences', {
        items: [{
          id: 'HYROX-OX-2026-12',
          title: 'Simulado HYROX OX — inscrição da dupla',
          quantity: 1,
          currency_id: 'BRL',
          unit_price: order.priceCents / 100,
        }],
        payment_methods: {
          excluded_payment_types: [{ id: 'ticket' }],
        },
        external_reference: order.id,
        notification_url: origin + '/api/checkout?notification=mercadopago&source_news=webhooks',
        back_urls: { success: returnUrl, pending: returnUrl, failure: returnUrl },
        auto_return: 'approved',
        expires: true,
        expiration_date_from: new Date().toISOString(),
        expiration_date_to: expiresAt,
        date_of_expiration: expiresAt,
      });
      const url = preference.sandbox_init_point;
      if (!url) throw new Error('Missing Mercado Pago checkout URL');
      return res.json({ url });
    } catch (error) {
      await rpc('release', { id: order.id });
      throw error;
    }
  } catch (error) {
    console.error(error.message);
    return res.status(503).json({ error: 'Serviço indisponível. Tente novamente em instantes.' });
  }
}
