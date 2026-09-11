// Registra no Supabase os pedidos que caem no fluxo do WhatsApp (frete a
// combinar), só para aparecerem na aba "Pedidos" do painel. Não envia
// e-mail (o e-mail é só para pedidos pagos direto no site).
const SUPABASE_URL = process.env.NARVIE_SUPABASE_URL || 'https://fzkkupeophllpxetfdjg.supabase.co';
const SUPABASE_ANON_KEY = process.env.NARVIE_SUPABASE_ANON_KEY || 'sb_publishable_bFpZAMgy6-cIbL3QkxTCMw_-Q3jY_lg';

async function fetchOfficialProducts(ids) {
  if (!ids.length) return [];
  const filter = encodeURIComponent(`(${ids.join(',')})`);
  const url = `${SUPABASE_URL}/rest/v1/products?id=in.${filter}&select=id,name,price`;
  const response = await fetch(url, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`
    }
  });
  if (!response.ok) return [];
  return response.json().catch(() => []);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido.' });
  }

  try {
    const { order_nsu = '', items: rawItems = [], city = '', delivery_type = 'other' } = req.body || {};

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

    const ids = [...new Set(cleanItems.map((item) => item.id))];
    const officialProducts = await fetchOfficialProducts(ids);
    const productMap = new Map(officialProducts.map((p) => [String(p.id), p]));

    let total = 0;
    const itemsForRecord = cleanItems.map((item) => {
      const product = productMap.get(item.id);
      const name = product ? product.name : 'Peça';
      const price = product ? Number(product.price) : 0;
      total += price * item.quantity;
      return { id: item.id, name, size: item.size, quantity: item.quantity, price };
    });

    const safeType = ['local', 'neighbor', 'other'].includes(delivery_type) ? delivery_type : 'other';

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
        city: String(city || '').trim(),
        delivery_type: safeType,
        channel: 'whatsapp',
        total,
        status: 'novo'
      }])
    });

    if (!response.ok) {
      const data = await response.text().catch(() => '');
      console.error('Falha ao registrar pedido do WhatsApp:', data);
      return res.status(200).json({ saved: false });
    }

    return res.status(200).json({ saved: true });
  } catch (error) {
    console.error('Erro ao registrar pedido do WhatsApp:', error);
    return res.status(200).json({ saved: false });
  }
}
