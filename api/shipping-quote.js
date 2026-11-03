// Simulação de frete (SuperFrete) para a cliente, a partir do CEP.
import { quoteForItems, superfreteConfigured } from '../lib/superfrete.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido.' });
  }
  try {
    if (!superfreteConfigured()) {
      return res.status(503).json({ error: 'O cálculo de frete automático não está disponível agora.' });
    }
    const body = req.body || {};
    const items = (Array.isArray(body.items) ? body.items : [])
      .map((i) => ({ id: String(i.id || '').trim(), quantity: Math.max(1, Math.floor(Number(i.quantity) || 1)) }))
      .filter((i) => i.id)
      .slice(0, 50);
    if (!items.length) return res.status(400).json({ error: 'O carrinho está vazio.' });

    const result = await quoteForItems(body.cep, items);
    if (result.error) return res.status(400).json({ error: result.error });
    if (!result.options.length) {
      return res.status(404).json({ error: 'Não encontramos opções de envio para esse CEP. Confira o CEP ou fale com a gente no WhatsApp.' });
    }
    return res.status(200).json({ options: result.options.map(({ service_id, name, company, price, days }) => ({ service_id, name, company, price, days })) });
  } catch (error) {
    console.error('Erro na simulação de frete:', error);
    return res.status(500).json({ error: 'Não foi possível calcular o frete agora. Tente novamente.' });
  }
}
