-- ============================================================================
-- NARVIE — OPÇÃO DE CORES NAS PEÇAS
-- ============================================================================
-- Rode INTEIRO no SQL Editor do Supabase ANTES de publicar o site novo.
-- Pode rodar mais de uma vez: não apaga nada e não mexe nos produtos que já existem.
-- ============================================================================

-- ============================================================================
-- CORES DA PEÇA
-- ============================================================================
-- products.colors guarda o nome e a cor de cada opção (só para mostrar a bolinha
-- na loja): [{"name":"Preto","hex":"#111111"}].
-- O estoque de peça COM cores fica em products.stock assim:
--   {"Preto": {"P": 3, "M": 2}, "Branco": {"P": 1}}
-- Peça SEM cores continua como antes: {"P": 3, "M": 2}.
alter table public.products add column if not exists colors jsonb not null default '[]'::jsonb;

-- Baixa de estoque de uma cor + tamanho (só é chamada por dentro do banco,
-- pela função confirm_order_payment).
create or replace function public.decrement_stock_color(product_id uuid, item_color text, item_size text, qty int)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.products
  set stock = jsonb_set(
    coalesce(stock, '{}'::jsonb),
    array[item_color, item_size],
    to_jsonb(greatest(0, coalesce((stock->item_color->>item_size)::int, 0) - qty))
  ),
  updated_at = now()
  where id = product_id
    and jsonb_typeof(stock->item_color) = 'object';
end;
$$;
revoke execute on function public.decrement_stock_color(uuid, text, text, integer) from public, anon, authenticated;

-- Confirmação de pagamento: agora baixa o estoque da cor certa quando o item tem cor.
create or replace function public.confirm_order_payment(p_nsu text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  o public.orders;
  it jsonb;
begin
  update public.orders
     set status = 'novo', updated_at = now()
   where order_nsu = p_nsu and status = 'aguardando_pagamento'
  returning * into o;

  if not found then
    if exists (select 1 from public.orders where order_nsu = p_nsu) then
      return 'already';
    end if;
    return 'not_found';
  end if;

  for it in select * from jsonb_array_elements(o.items) loop
    if coalesce(it->>'id','') not in ('', 'frete')
       and coalesce(it->>'size','') <> '' then
      if coalesce(it->>'color','') <> '' then
        perform public.decrement_stock_color(
          (it->>'id')::uuid,
          it->>'color',
          it->>'size',
          greatest(1, coalesce((it->>'quantity')::int, 1))
        );
      else
        perform public.decrement_stock(
          (it->>'id')::uuid,
          it->>'size',
          greatest(1, coalesce((it->>'quantity')::int, 1))
        );
      end if;
    end if;
  end loop;

  return 'confirmed';
end;
$$;
grant execute on function public.confirm_order_payment(text) to anon, authenticated;
