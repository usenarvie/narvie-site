const SUPABASE_URL = process.env.NARVIE_SUPABASE_URL || 'https://fzkkupeophllpxetfdjg.supabase.co';
const SUPABASE_ANON_KEY = process.env.NARVIE_SUPABASE_ANON_KEY || 'sb_publishable_bFpZAMgy6-cIbL3QkxTCMw_-Q3jY_lg';

async function fetchOfficialProducts(ids) {
  const filter = encodeURIComponent(`(${ids.join(',')})`);
  const url = `${SUPABASE_URL}/rest/v1/products?id=in.${filter}&status=eq.published&select=id,name,price`;
  const response = await fetch(url, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`
    }
  });
  if (!response.ok) throw new Error('Falha ao consultar o catálogo.');
  return response.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido.' });
  }

  try {
    const { items: rawItems = [], order_nsu = '' } = req.body || {};

    if (!Array.isArray(rawItems) || !rawItems.length) {
      return res.status(400).json({ error: 'O pedido está vazio.' });
    }

    const cleanItems = rawItems
      .map((item) => ({
        id: String(item.id || '').trim(),
        size: String(item.size || '').trim(),
        quantity: Math.max(1, Math.floor(Number(item.quantity) || 1))
      }))
      .filter((item) => item.id);

    if (!cleanItems.length) {
      return res.status(400).json({ error: 'Itens do pedido inválidos.' });
    }

    const ids = [...new Set(cleanItems.map((item) => item.id))];
    const officialProducts = await fetchOfficialProducts(ids);
    const productMap = new Map(officialProducts.map((p) => [String(p.id), p]));

    const normalizedItems = [];
    for (const item of cleanItems) {
      const product = productMap.get(item.id);
      if (!product) {
        return res.status(400).json({ error: 'Uma das peças do pedido não está mais disponível.' });
      }
      normalizedItems.push({
        quantity: item.quantity,
        price: Math.round(Number(product.price) * 100),
        description: item.size ? `${product.name} — tamanho ${item.size}` : product.name
      });
    }

    if (normalizedItems.some((item) => item.price <= 0 || item.quantity <= 0)) {
      return res.status(400).json({ error: 'Itens do pedido inválidos.' });
    }

    const nsu = order_nsu || `narvie-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const host = req.headers.host;
    const protocol = req.headers['x-forwarded-proto'] || 'https';

    const payload = {
      handle: 'narvie',
      items: normalizedItems,
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

    return res.status(200).json({ url: checkoutUrl, order_nsu: nsu });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erro ao criar o checkout.' });
  }
}
