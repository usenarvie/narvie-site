-- Atualização da loja Narvie. Pode rodar mais de uma vez sem problema.
-- Cole tudo no SQL Editor do Supabase e clique em Run.

-- Tipo de peça (T-shirt, Short, Vestido, Blusa). As peças que já existem viram T-shirt.
alter table public.products add column if not exists type text not null default 'tshirt' check (type in ('tshirt','short','vestido','blusa'));

-- Preço no cartão por peça (vazio = usa o mesmo preço à vista).
alter table public.products add column if not exists price_card numeric(10,2) check (price_card is null or price_card >= 0);

-- Forma de pagamento do pedido (pix ou cartao).
alter table public.orders add column if not exists payment_method text check (payment_method in ('pix','cartao'));
