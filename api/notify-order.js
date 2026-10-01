// Chamado quando a cliente volta do pagamento no site (InfinitePay).
// O pedido já foi registrado por /api/create-checkout com status
// "aguardando_pagamento". Aqui só confirmamos: o banco marca o pedido como
// pago ("novo" = aguardando envio) e baixa o estoque, tudo em uma única
// operação (função confirm_order_payment). Chamar de novo — por exemplo,
// recarregando a página — não baixa o estoque duas vezes.
// Não envia e-mail — a própria InfinitePay já avisa o pagamento.
// Nunca deve travar a experiência da cliente: qualquer erro aqui só é
// registrado no log do Vercel, a resposta sempre volta 200.
const SUPABASE_URL = process.env.NARVIE_SUPABASE_URL || 'https://fzkkupeophllpxetfdjg.supabase.co';
const SUPABASE_ANON_KEY = process.env.NARVIE_SUPABASE_ANON_KEY || 'sb_publishable_bFpZAMgy6-cIbL3QkxTCMw_-Q3jY_lg';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido.' });
  }

  try {
    const order_nsu = String((req.body || {}).order_nsu || '').trim();
    if (!order_nsu) {
      return res.status(200).json({ skipped: true });
    }

    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/confirm_order_payment`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ p_nsu: order_nsu })
    });

    if (!response.ok) {
      const data = await response.text().catch(() => '');
      console.error('Falha ao confirmar o pagamento do pedido:', order_nsu, data);
      return res.status(200).json({ saved: false });
    }

    const result = await response.json().catch(() => null); // 'confirmed' | 'already' | 'not_found'
    if (result === 'not_found') {
      console.error('Pedido não encontrado ao confirmar o pagamento:', order_nsu);
    }
    return res.status(200).json({ saved: result === 'confirmed' || result === 'already', result });
  } catch (error) {
    console.error('Erro ao confirmar o pagamento do pedido:', error);
    return res.status(200).json({ saved: false });
  }
}
