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
      `products?id=in.${filter}&status=eq.published&select=id,name,price,stock`,
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
      const priceCents = Math.round(Number(product.price) * 100); // preço oficial, em centavos
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

    // ---------- Link de pagamento na InfinitePay ----------
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
    const checkoutUrl = data.url || data.checkout_url || data.link;

    if (!response.ok || !checkoutUrl) {
      return res.status(response.status || 502).json({
        error: data.message || data.error || 'Não foi possível criar o checkout.'
      });
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

    return res.status(200).json({ url: checkoutUrl, order_nsu: nsu, total: totalCents / 100 });
  } catch (error) {
    console.error(error);
    return res.status(error.status || 500).json({ error: error.status ? error.message : 'Erro ao criar o checkout.' });
  }
}
