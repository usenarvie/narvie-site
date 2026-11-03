// Cotação de frete pelo SuperFrete, para pedidos fora da entrega própria.
// O token fica só no servidor (variável SUPERFRETE_TOKEN no Vercel) e o valor
// do frete é SEMPRE recalculado aqui, nunca confiado ao navegador.
const SUPABASE_URL = process.env.NARVIE_SUPABASE_URL || 'https://fzkkupeophllpxetfdjg.supabase.co';
const SUPABASE_ANON_KEY = process.env.NARVIE_SUPABASE_ANON_KEY || 'sb_publishable_bFpZAMgy6-cIbL3QkxTCMw_-Q3jY_lg';

const API_URL = process.env.SUPERFRETE_API_URL || 'https://api.superfrete.com/api/v0/calculator';
// 1 = PAC, 2 = SEDEX, 17 = Mini Envios (pode ser mudado no Vercel: SUPERFRETE_SERVICES).
const SERVICES = process.env.SUPERFRETE_SERVICES || '1,2,17';
const MINI_ENVIOS_ID = 17;
const MINI_ENVIOS_MAX_G = 300;

// De onde saem os pedidos. A cotação é feita nos dois e vale o mais barato de cada serviço.
export const ORIGINS = [
  { name: 'Nossa Senhora da Glória', cep: '49680000' },
  { name: 'Cristinápolis', cep: '49270000' }
];

// Peso médio embalado (gramas) quando a peça não tem peso próprio cadastrado.
const DEFAULT_WEIGHT_G = { tshirt: 200, blusa: 200, short: 300, vestido: 400 };

export function superfreteConfigured() {
  return Boolean(process.env.SUPERFRETE_TOKEN);
}

export function cleanCep(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length === 8 ? digits : '';
}

async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
  });
  if (!r.ok) throw new Error('supabase');
  return r.json();
}

// Peso por peça (g). Tolerante: se as colunas novas ainda não existirem, usa o padrão.
async function loadProductWeights(ids) {
  const filter = `(${ids.map((id) => encodeURIComponent(id)).join(',')})`;
  let rows = [];
  for (const select of ['id,type,weight_g', 'id,type', 'id']) {
    try {
      rows = await sbGet(`products?id=in.${filter}&select=${select}`);
      break;
    } catch (e) {
      rows = [];
    }
  }
  const map = new Map();
  for (const row of rows) {
    const own = Number(row.weight_g);
    const grams = own > 0 ? own : (DEFAULT_WEIGHT_G[row.type || 'tshirt'] || 250);
    map.set(String(row.id), grams);
  }
  return map;
}

// Pacote de roupa dobrada: a altura cresce a cada peça. Peso em kg, medidas em cm.
function buildPackage(pieces, weightG) {
  return {
    height: Math.min(60, 4 + 2 * Math.max(0, pieces - 1)),
    width: 22,
    length: 30,
    weight: Math.max(0.05, Math.round(weightG) / 1000)
  };
}

async function quoteFromOrigin(origin, destinationCep, pkg) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.SUPERFRETE_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'Narvie (usenarvie@gmail.com)'
      },
      body: JSON.stringify({
        from: { postal_code: origin.cep },
        to: { postal_code: destinationCep },
        services: SERVICES,
        options: { own_hand: false, receipt: false, insurance_value: 0, use_insurance_value: false },
        package: pkg
      }),
      signal: controller.signal
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !Array.isArray(data)) {
      console.error('SuperFrete respondeu com erro:', response.status, JSON.stringify(data).slice(0, 300));
      return [];
    }
    return data
      .filter((q) => q && !q.has_error && !q.error && Number(q.price ?? q.custom_price) > 0)
      .map((q) => {
        const range = q.delivery_range || {};
        const days = range.min && range.max && range.min !== range.max
          ? `${range.min} a ${range.max}`
          : String(range.max || q.delivery_time || '');
        return {
          service_id: Number(q.id),
          name: String(q.name || 'Envio'),
          company: String((q.company && q.company.name) || ''),
          price: Math.round(Number(q.price ?? q.custom_price) * 100) / 100,
          days,
          origin_cep: origin.cep,
          origin_name: origin.name
        };
      });
  } catch (e) {
    console.error('Falha ao consultar o SuperFrete:', e);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// items: [{ id, quantity }]. Devolve as opções (mais barata de cada serviço, entre as duas origens).
export async function quoteForItems(destinationCep, items) {
  const cep = cleanCep(destinationCep);
  if (!cep) return { error: 'CEP inválido. Digite os 8 números.' };
  if (!superfreteConfigured()) return { unavailable: true };

  const ids = [...new Set(items.map((i) => String(i.id)))];
  const weights = await loadProductWeights(ids);
  let pieces = 0;
  let weightG = 0;
  for (const item of items) {
    const qty = Math.max(1, Math.floor(Number(item.quantity) || 1));
    pieces += qty;
    weightG += (weights.get(String(item.id)) || 250) * qty;
  }
  if (!pieces) return { error: 'O pedido está vazio.' };

  const pkg = buildPackage(pieces, weightG);
  const perOrigin = await Promise.all(ORIGINS.map((o) => quoteFromOrigin(o, cep, pkg)));

  const best = new Map();
  for (const quote of perOrigin.flat()) {
    if (quote.service_id === MINI_ENVIOS_ID && weightG > MINI_ENVIOS_MAX_G) continue;
    const current = best.get(quote.service_id);
    if (!current || quote.price < current.price) best.set(quote.service_id, quote);
  }
  const options = [...best.values()].sort((a, b) => a.price - b.price);
  return { options, weight_g: Math.round(weightG), pieces };
}
