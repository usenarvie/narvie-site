// Chamado depois que a cliente volta do pagamento no site (InfinitePay).
// Registra o pedido na tabela "orders" para aparecer na aba "Pedidos" do
// painel. Não envia e-mail — a própria InfinitePay já avisa o pagamento.
// Nunca deve travar a experiência da cliente: qualquer erro aqui só é
// registrado no log do Vercel, a resposta sempre volta 200.
const SUPABASE_URL = process.env.NARVIE_SUPABASE_URL || 'https://fzkkupeophllpxetfdjg.supabase.co';
const SUPABASE_ANON_KEY = process.env.NARVIE_SUPABASE_ANON_KEY || 'sb_publishable_bFpZAMgy6-cIbL3QkxTCMw_-Q3jY_lg';

function normalizeCity(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

async function fetchOfficialProducts(ids) {
  if (!ids.length) return [];
  const filter = encodeURIComponent(`(${ids.join(',')})`);
  const url = `${SUPABASE_URL}/rest/v1/products?id=in.${filter}&select=id,name,price`;
  const response = await fetch(url, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
  });
  if (!response.ok) return [];
  return response.json().catch(() => []);
}

async function fetchShippingSettings() {
  const url = `${SUPABASE_URL}/rest/v1/settings?key=eq.shipping&select=value`;
  const response = await fetch(url, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
  });
  if (!response.ok) return null;
  const rows = await response.json().catch(() => []);
  return rows[0]?.value || null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido.' });
  }

  try {
    const { order_nsu = '', items: rawItems = [], city = '' } = req.body || {};

    const cleanItems = (Array.isArray(rawItems) ? rawItems : [])
      .map((item) => ({
        id: String(item.id || '').trim(),
        size: String(item.size || '').trim(),
        quantity: Math.max(1, Math.floor(Number(item.quantity) || 1))
      }))
      .filter((item) => item.id);

    if (!order_nsu || !cleanItems.length) {
      return res.status(200).json({ skipped: true });
    }

    const cleanCity = String(city || '').trim();
    const ids = [...new Set(cleanItems.map((item) => item.id))];
    const [officialProducts, shipping] = await Promise.all([
      fetchOfficialProducts(ids),
      fetchShippingSettings()
    ]);
    const productMap = new Map(officialProducts.map((p) => [String(p.id), p]));

    let total = 0;
    const itemsForRecord = [];
    for (const item of cleanItems) {
      const product = productMap.get(item.id);
      const name = product ? product.name : 'Peça';
      const price = product ? Number(product.price) : 0;
      total += price * item.quantity;
      itemsForRecord.push({ id: item.id, name, size: item.size, quantity: item.quantity, price });
    }

    // Frete da entrega própria, se a cidade bater com alguma cadastrada.
    let freightFee = 0;
    if (cleanCity && shipping?.local_cities) {
      const matchKey = Object.keys(shipping.local_cities).find((c) => normalizeCity(c) === normalizeCity(cleanCity));
      if (matchKey) freightFee = Number(shipping.local_cities[matchKey] || 0);
    }
    if (freightFee > 0) {
      total += freightFee;
      itemsForRecord.push({ id: 'frete', name: 'Frete', size: '', quantity: 1, price: freightFee });
    }

    const response = await fetch(`${SUPABASE_URL}/rest/v1/orders?on_conflict=order_nsu`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=ignore-duplicates,return=minimal'
      },
      body: JSON.stringify([{
        order_nsu,
        items: itemsForRecord,
        city: cleanCity,
        delivery_type: 'local',
        channel: 'site',
        total,
        status: 'novo'
      }])
    });

    if (!response.ok) {
      const data = await response.text().catch(() => '');
      console.error('Falha ao registrar pedido pago no site:', data);
      return res.status(200).json({ saved: false });
    }

    return res.status(200).json({ saved: true });
  } catch (error) {
    console.error('Erro ao registrar pedido pago no site:', error);
    return res.status(200).json({ saved: false });
  }
}
