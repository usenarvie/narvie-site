// Preço, frete e total SEMPRE são calculados aqui, no servidor, a partir do
// Supabase (fonte oficial). Nunca confiamos em valor enviado pelo navegador,
// para impedir que alguém altere o preço de uma peça ou o frete antes de pagar.
//
// Fluxo:
//   1. valida itens, estoque, cidade, bairro e dados do cliente;
//   2. calcula o total exato (produtos + entrega/envio), em centavos;
//   3. cria o link de pagamento na InfinitePay com exatamente esse total;
//   4. REGISTRA o pedido (cliente, endereço, itens, valores) no Supabase com
//      status "aguardando_pagamento" — antes de a cliente ir pagar;
//   5. devolve o link. Quando a cliente volta do pagamento, /api/notify-order
//      confirma o pedido e baixa o estoque.
const SUPABASE_URL = process.env.NARVIE_SUPABASE_URL || 'https://fzkkupeophllpxetfdjg.supabase.co';
const SUPABASE_ANON_KEY = process.env.NARVIE_SUPABASE_ANON_KEY || 'sb_publishable_bFpZAMgy6-cIbL3QkxTCMw_-Q3jY_lg';

const SB_HEADERS = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`
};

async function sbGet(path, errorMessage) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: SB_HEADERS });
  if (!response.ok) throw new Error(errorMessage);
  return response.json();
}

function normalizeText(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function cleanText(s, max) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Aceita (79) 99999-9999, 79999999999, +55 79 99999-9999 etc. Devolve só
// dígitos com o código do país (55), ou '' se não parecer um celular/telefone BR.
function normalizeWhatsapp(s) {
  let digits = String(s || '').replace(/\D/g, '');
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) {
    digits = digits.slice(2);
  }
  if (digits.length !== 10 && digits.length !== 11) return '';
  if (Number(digits.slice(0, 2)) < 11) return '';
  return `55${digits}`;
}


// ---------- Pix próprio (QR Code / copia e cola) ----------
// Chave Pix que recebe os pagamentos feitos direto pelo site. Pode ser trocada
// no Vercel (variáveis NARVIE_PIX_KEY, NARVIE_PIX_NAME, NARVIE_PIX_CITY).
const PIX_KEY = process.env.NARVIE_PIX_KEY || 'usenarvie@gmail.com';
const PIX_NAME = process.env.NARVIE_PIX_NAME || 'NATHALY RODRIGUES SANTOS'; // até 25 letras, sem acento
const PIX_CITY = process.env.NARVIE_PIX_CITY || 'NS DA GLORIA'; // até 15 letras, sem acento

function pixField(id, value) {
  return id + String(value.length).padStart(2, '0') + value;
}

// CRC16/CCITT-FALSE exigido pelo padrão do Pix (BR Code).
function pixCrc16(text) {
  let crc = 0xffff;
  for (let i = 0; i < text.length; i++) {
    crc ^= text.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function buildPixPayload(amountCents, orderNsu) {
  const txid = String(orderNsu || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***';
  const body =
    pixField('00', '01') +
    pixField('01', '11') +
    pixField('26', pixField('00', 'br.gov.bcb.pix') + pixField('01', PIX_KEY)) +
    pixField('52', '0000') +
    pixField('53', '986') +
    pixField('54', (amountCents / 100).toFixed(2)) +
    pixField('58', 'BR') +
    pixField('59', PIX_NAME.slice(0, 25)) +
    pixField('60', PIX_CITY.slice(0, 15)) +
    pixField('62', pixField('05', txid)) +
    '6304';
  return body + pixCrc16(body);
}


// ---------- E-mail do pedido (Resend) ----------
// Para ligar: crie a chave em resend.com (com o MESMO e-mail que vai receber os pedidos)
// e coloque no Vercel como variável RESEND_API_KEY. Sem a chave, o site funciona normalmente, só não envia e-mail.
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const ORDER_EMAIL_TO = process.env.NARVIE_ORDER_EMAIL_TO || 'usenarvie@gmail.com';
const ORDER_EMAIL_FROM = process.env.NARVIE_ORDER_EMAIL_FROM || 'Narvie Pedidos <onboarding@resend.dev>';

const htmlEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const brl = (n) => 'R$ ' + Number(n || 0).toFixed(2).replace('.', ',');

async function sendEmail(subject, html) {
  if (!RESEND_API_KEY) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: ORDER_EMAIL_FROM, to: [ORDER_EMAIL_TO], subject, html }),
      signal: controller.signal
    });
    if (!r.ok) console.error('Falha ao enviar e-mail do pedido:', r.status, await r.text().catch(() => ''));
  } catch (e) {
    console.error('Erro ao enviar e-mail do pedido:', e);
  } finally {
    clearTimeout(timer);
  }
}

function orderEmailHtml(o) {
  const row = (k, v) => (v ? `<tr><td style="padding:6px 12px 6px 0;color:#777;vertical-align:top">${k}</td><td style="padding:6px 0"><b>${htmlEsc(v)}</b></td></tr>` : '');
  const items = (o.items || []).filter((i) => i.id !== 'frete').map((i) =>
    `<tr><td style="padding:6px 0">${htmlEsc(i.name)}${i.color ? ' — ' + htmlEsc(i.color) : ''}${i.size ? ' — tam. ' + htmlEsc(i.size) : ''}</td><td style="padding:6px 0;text-align:center">${i.quantity}x</td><td style="padding:6px 0;text-align:right">${brl(i.price * i.quantity)}</td></tr>`
  ).join('');
  const pix = o.payment_method === 'pix';
  const wa = String(o.customer_whatsapp || '').replace(/\D/g, '');
  return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#222">
<h2 style="margin:0 0 4px">${pix ? '🟡 Novo pedido — Pix' : '🟡 Novo pedido — Cartão'}</h2>
<p style="margin:0 0 18px;color:#777">${pix ? 'Aguardando o pagamento. Confira se o Pix caiu antes de confirmar.' : 'A cliente foi levada ao pagamento no cartão (InfinitePay). Ainda não está pago.'}</p>
<table style="width:100%;border-collapse:collapse;font-size:14px">
${row('Pedido', o.order_nsu)}${row('Forma de pagamento', pix ? 'Pix (valor à vista)' : 'Cartão (até 3x)')}
${row('Cliente', o.customer_name)}${wa ? `<tr><td style="padding:6px 12px 6px 0;color:#777">WhatsApp</td><td style="padding:6px 0"><b><a href="https://wa.me/${wa}">${htmlEsc(o.customer_whatsapp)}</a></b></td></tr>` : ''}
${row('Entrega', ({ local: 'Entrega própria na cidade', neighbor: 'Envio por transporte', retirada: 'Retirada pessoalmente' })[o.delivery_type] || o.delivery_type)}${row('Cidade', o.city)}${row('Bairro', o.neighborhood)}${row('Rua', o.street)}${row('Número', o.house_number)}${row('Complemento', o.complement)}${row('Ponto de referência', o.reference)}
</table>
<h3 style="margin:22px 0 6px">Itens</h3>
<table style="width:100%;border-collapse:collapse;font-size:14px;border-top:1px solid #eee">${items}</table>
<table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:10px;border-top:1px solid #eee">
<tr><td style="padding:6px 0;color:#777">Subtotal</td><td style="text-align:right">${brl(o.subtotal)}</td></tr>
<tr><td style="padding:6px 0;color:#777">Frete</td><td style="text-align:right">${brl(o.shipping_fee)}</td></tr>
<tr><td style="padding:6px 0;font-size:16px"><b>Total</b></td><td style="text-align:right;font-size:16px"><b>${brl(o.total)}</b></td></tr></table>
<p style="margin-top:22px;font-size:13px;color:#777">${pix ? 'Quando o Pix cair, abra o painel (Pedidos) e toque em “Confirmar pagamento”.' : 'Quando o pagamento for confirmado, você recebe outro e-mail avisando.'}</p>
</div>`;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido.' });
  }

  try {
    const body = req.body || {};
    // 'pix' = preço à vista, pago por QR Code do próprio site; 'cartao' = preço no cartão, pago pela InfinitePay.
    const paymentMethod = String(body.payment_method || '').trim() === 'pix' ? 'pix' : 'cartao';
    const rawItems = Array.isArray(body.items) ? body.items : [];

    if (!rawItems.length) {
      return res.status(400).json({ error: 'O pedido está vazio.' });
    }

    // Do navegador aceitamos apenas: qual peça, qual tamanho, quantas
    // unidades. Nada de preço ou descrição vindos do cliente.
    const cleanItems = rawItems
      .map((item) => ({
        id: String(item.id || '').trim(),
        size: String(item.size || '').trim(),
        color: String(item.color || '').trim(),
        quantity: Math.max(1, Math.floor(Number(item.quantity) || 1))
      }))
      .filter((item) => item.id);

    if (!cleanItems.length) {
      return res.status(400).json({ error: 'Itens do pedido inválidos.' });
    }

    // ---------- Produtos e estoque (oficial, direto do banco) ----------
    const ids = [...new Set(cleanItems.map((item) => item.id))];
    const filter = encodeURIComponent(`(${ids.join(',')})`);
    const officialProducts = await sbGet(
      `products?id=in.${filter}&status=eq.published&select=id,name,price,price_card,stock`,
      'Falha ao consultar o catálogo.'
    );
    const productMap = new Map(officialProducts.map((p) => [String(p.id), p]));

    const lineItems = []; // o que vai para a InfinitePay (preço em centavos)
    const recordItems = []; // o que fica salvo no pedido (preço em reais)
    let subtotalCents = 0;

    for (const item of cleanItems) {
      const product = productMap.get(item.id);
      if (!product) {
        return res.status(400).json({ error: 'Uma das peças do pedido não está mais disponível.' });
      }
      // Checa o estoque de verdade no banco, não o que a cliente via na
      // tela quando abriu o site — evita vender a mesma peça duas vezes.
      // Peça com cores: stock = { "Preto": { "P": 3 } }. Sem cores: stock = { "P": 3 }.
      const stockObj = product.stock || {};
      const colored = Object.values(stockObj).some((v) => v && typeof v === 'object');
      const color = colored ? item.color : '';
      if (colored && !color) {
        return res.status(400).json({ error: `Escolha a cor de ${product.name}.` });
      }
      const sizeStock = colored ? (stockObj[color] || {}) : stockObj;
      const available = Number(sizeStock[item.size] || 0);
      const label = `${product.name}${color ? ` (${color})` : ''}`;
      if (available < item.quantity) {
        return res.status(409).json({
          error: `${label} (tamanho ${item.size}) não tem mais estoque suficiente. Restam ${available} unidade(s).`
        });
      }
      // Preço oficial, em centavos: à vista (Pix) ou o do cartão (se a peça não tiver preço de cartão, usa o mesmo).
      const cardPrice = Number(product.price_card);
      const unitPrice = paymentMethod === 'cartao' && cardPrice > 0 ? cardPrice : Number(product.price);
      const priceCents = Math.round(unitPrice * 100);
      if (!(priceCents > 0)) {
        return res.status(400).json({ error: 'Itens do pedido inválidos.' });
      }
      subtotalCents += priceCents * item.quantity;
      lineItems.push({
        quantity: item.quantity,
        price: priceCents,
        description: item.size ? `${product.name}${color ? ` — ${color}` : ''} — tamanho ${item.size}` : product.name
      });
      recordItems.push({
        id: item.id,
        name: product.name,
        size: item.size,
        color,
        quantity: item.quantity,
        price: priceCents / 100
      });
    }

    // ---------- Cidade, bairro e frete (oficial, vem do painel) ----------
    // Retirada pessoalmente: sem frete e sem endereço (a cliente retira no local).
    const isPickup = String(body.delivery_method || '').trim() === 'retirada';

    const cityInput = cleanText(body.city, 120);
    if (!cityInput && !isPickup) {
      return res.status(400).json({ error: 'Selecione a cidade de entrega.' });
    }

    const cities = await sbGet(
      'shipping_cities?select=id,name,kind,fee',
      'Falha ao consultar o frete.'
    );
    const city = cities.find((c) => normalizeText(c.name) === normalizeText(cityInput));
    if (!city && !isPickup) {
      return res.status(400).json({ error: 'Essa cidade não está disponível para pagamento no site.' });
    }

    // Dados do cliente (obrigatórios nos dois tipos de logística).
    const customerName = cleanText(body.customer_name, 120);
    if (!/\S{2,}\s+\S{2,}/.test(customerName)) {
      return res.status(400).json({ error: 'Informe seu nome completo.' });
    }
    const customerWhatsapp = normalizeWhatsapp(body.customer_whatsapp);
    if (!customerWhatsapp) {
      return res.status(400).json({ error: 'Informe um WhatsApp válido, com DDD.' });
    }

    let feeValue = null; // em reais; null = valor ainda não cadastrado no painel
    let neighborhoodName = '';
    let street = '';
    let houseNumber = '';
    let complement = '';
    let reference = '';
    let deliveryType = 'neighbor';
    let freightDescription = '';

    if (isPickup) {
      // Frete zero: nenhuma linha de frete vai para a InfinitePay nem para o pedido.
      deliveryType = 'retirada';
      feeValue = 0;
    } else if (city.kind === 'entrega_propria') {
      deliveryType = 'local';
      street = cleanText(body.street, 160);
      houseNumber = cleanText(body.house_number, 20);
      complement = cleanText(body.complement, 120);
      reference = cleanText(body.reference, 160);

      const neighborhoodInput = cleanText(body.neighborhood, 120);
      if (!neighborhoodInput) {
        return res.status(400).json({ error: 'Selecione o bairro.' });
      }
      if (!street) {
        return res.status(400).json({ error: 'Informe a rua ou avenida.' });
      }
      if (!houseNumber) {
        return res.status(400).json({ error: 'Informe o número (ou "s/n").' });
      }

      const neighborhoods = await sbGet(
        `shipping_neighborhoods?city_id=eq.${encodeURIComponent(city.id)}&select=id,name,fee`,
        'Falha ao consultar os bairros.'
      );
      const neighborhood = neighborhoods.find(
        (n) => normalizeText(n.name) === normalizeText(neighborhoodInput)
      );
      if (!neighborhood) {
        return res.status(400).json({ error: 'Esse bairro não está disponível para entrega.' });
      }
      neighborhoodName = neighborhood.name;
      // Valor do bairro; se o bairro estiver sem valor próprio, usa o padrão da cidade.
      feeValue = neighborhood.fee !== null && neighborhood.fee !== undefined
        ? Number(neighborhood.fee)
        : (city.fee !== null && city.fee !== undefined ? Number(city.fee) : null);
      freightDescription = `Entrega — ${neighborhood.name}, ${city.name}`;
    } else {
      // Envio por transporte/rodoviária: nada de endereço.
      feeValue = city.fee !== null && city.fee !== undefined ? Number(city.fee) : null;
      freightDescription = `Envio — ${city.name}`;
    }

    if (feeValue === null || !Number.isFinite(feeValue) || feeValue < 0) {
      return res.status(409).json({
        error: 'O valor de entrega para esse local ainda não foi definido. Fale com a gente pelo WhatsApp.'
      });
    }

    const feeCents = Math.round(feeValue * 100);
    if (feeCents > 0) {
      lineItems.push({ quantity: 1, price: feeCents, description: freightDescription });
      recordItems.push({ id: 'frete', name: freightDescription, size: '', quantity: 1, price: feeCents / 100 });
    }

    // ---------- Total exato ----------
    const totalCents = subtotalCents + feeCents;
    const sentToPaymentCents = lineItems.reduce((sum, i) => sum + i.price * i.quantity, 0);
    if (!(totalCents > 0) || sentToPaymentCents !== totalCents) {
      // Não deveria acontecer; se acontecer, melhor não cobrar do que cobrar errado.
      console.error('Total inconsistente', { totalCents, sentToPaymentCents });
      return res.status(500).json({ error: 'Não foi possível calcular o total do pedido.' });
    }

    const requestedNsu = String(body.order_nsu || '').trim();
    const nsu = /^[A-Za-z0-9_-]{8,80}$/.test(requestedNsu)
      ? requestedNsu
      : `narvie-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const host = req.headers.host;
    const protocol = req.headers['x-forwarded-proto'] || 'https';

    // ---------- Link de pagamento na InfinitePay (só cartão) ----------
    let checkoutUrl = null;
    if (paymentMethod === 'cartao') {
      const payload = {
        handle: 'narvie',
        items: lineItems,
        order_nsu: nsu,
        redirect_url: `${protocol}://${host}/pagamento-concluido.html`
      };

      const response = await fetch('https://api.checkout.infinitepay.io/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await response.json().catch(() => ({}));
      checkoutUrl = data.url || data.checkout_url || data.link;

      if (!response.ok || !checkoutUrl) {
        return res.status(response.status || 502).json({
          error: data.message || data.error || 'Não foi possível criar o checkout.'
        });
      }
    }

    // ---------- Registra o pedido ANTES de mandar a cliente pagar ----------
    const orderResponse = await fetch(`${SUPABASE_URL}/rest/v1/orders`, {
      method: 'POST',
      headers: {
        ...SB_HEADERS,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({
        order_nsu: nsu,
        items: recordItems,
        city: city ? city.name : (cityInput || null),
        neighborhood: neighborhoodName || null,
        street: street || null,
        house_number: houseNumber || null,
        complement: complement || null,
        reference: reference || null,
        customer_name: customerName,
        customer_whatsapp: customerWhatsapp,
        delivery_type: deliveryType,
        channel: 'site',
        subtotal: subtotalCents / 100,
        shipping_fee: feeCents / 100,
        total: totalCents / 100,
        payment_method: paymentMethod,
        status: 'aguardando_pagamento'
      })
    });

    if (!orderResponse.ok) {
      const detail = await orderResponse.text().catch(() => '');
      console.error('Falha ao registrar o pedido antes do pagamento:', orderResponse.status, detail);
      return res.status(500).json({
        error: 'Não foi possível registrar o seu pedido. Nada foi cobrado — tente novamente.'
      });
    }

    // Aviso por e-mail com todos os dados do pedido (nunca atrapalha a cliente se falhar).
    await sendEmail(
      `${paymentMethod === 'pix' ? '🟡 Novo pedido Pix' : '🟡 Pedido no cartão (aguardando pagamento)'} — ${customerName} — ${brl(totalCents / 100)}`,
      orderEmailHtml({
        order_nsu: nsu,
        items: recordItems,
        city: city ? city.name : (cityInput || ''),
        neighborhood: neighborhoodName,
        street,
        house_number: houseNumber,
        complement,
        reference,
        customer_name: customerName,
        customer_whatsapp: customerWhatsapp,
        delivery_type: deliveryType,
        subtotal: subtotalCents / 100,
        shipping_fee: feeCents / 100,
        total: totalCents / 100,
        payment_method: paymentMethod
      })
    );

    if (paymentMethod === 'pix') {
      return res.status(200).json({
        pix: { payload: buildPixPayload(totalCents, nsu), amount: totalCents / 100 },
        order_nsu: nsu,
        total: totalCents / 100
      });
    }

    return res.status(200).json({ url: checkoutUrl, order_nsu: nsu, total: totalCents / 100 });
  } catch (error) {
    console.error(error);
    return res.status(error.status || 500).json({ error: error.status ? error.message : 'Erro ao criar o checkout.' });
  }
}
