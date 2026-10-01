-- NARVIE V3 — banco, autenticação, RLS e storage
-- Execute este arquivo no SQL Editor do Supabase.

create extension if not exists pgcrypto;

create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text unique not null,
  created_at timestamptz not null default now()
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  price numeric(10,2) not null default 0 check (price >= 0),
  category text not null default 'estampa' check (category in ('estampa','classica')),
  -- stock guarda a quantidade disponível por tamanho, ex.: {"P": 3, "M": 5, "G": 0}
  -- os tamanhos ativos da peça são as chaves deste objeto.
  stock jsonb not null default '{}'::jsonb,
  image_path text,
  status text not null default 'draft' check (status in ('draft','published')),
  launch_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- MIGRAÇÃO: se este projeto já existia com a coluna antiga "sizes text[]",
-- rode os comandos abaixo no SQL Editor para migrar sem perder dados
-- (cada tamanho existente recebe estoque inicial de 5 unidades; ajuste depois no painel):
--
-- alter table public.products add column if not exists stock jsonb not null default '{}'::jsonb;
-- update public.products
--   set stock = (select coalesce(jsonb_object_agg(s, 5), '{}'::jsonb) from unnest(sizes) as s)
--   where stock = '{}'::jsonb and sizes is not null and array_length(sizes,1) > 0;
-- alter table public.products drop column if exists sizes;

-- Baixa de estoque: usada pelo checkout depois que um pagamento é
-- confirmado. É "security definer" para poder atualizar a peça mesmo sem
-- ser a administradora logada, e faz a conta inteira em um único UPDATE —
-- isso é o que garante que, mesmo se duas pessoas comprarem a última
-- unidade ao mesmo tempo, o Postgres processa uma de cada vez e o estoque
-- nunca fica negativo.
create or replace function public.decrement_stock(product_id uuid, item_size text, qty int)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.products
  set stock = jsonb_set(
    coalesce(stock, '{}'::jsonb),
    array[item_size],
    to_jsonb(greatest(0, coalesce((stock->>item_size)::int, 0) - qty))
  ),
  updated_at = now()
  where id = product_id;
end;
$$;

-- (O acesso direto a decrement_stock é fechado mais abaixo, na seção de
-- frete v2: a baixa passa a ser feita só por confirm_order_payment.)

-- Diz se o usuário logado é administradora (usada em todas as políticas).
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admins a
    where a.user_id = auth.uid()
  );
$$;

alter table public.admins enable row level security;
alter table public.products enable row level security;

drop policy if exists "admins can read own admin row" on public.admins;
create policy "admins can read own admin row"
on public.admins for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "public sees published products" on public.products;
create policy "public sees published products"
on public.products for select
to anon, authenticated
using (status = 'published');

drop policy if exists "admins manage products" on public.products;
create policy "admins manage products"
on public.products for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

-- Buckets:
-- product-images = público, somente para fotos de peças já publicadas.
-- draft-images   = privado, usado enquanto a peça estiver em rascunho.
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do update set public = true;

insert into storage.buckets (id, name, public)
values ('draft-images', 'draft-images', false)
on conflict (id) do update set public = false;

drop policy if exists "admins upload product images" on storage.objects;
create policy "admins upload product images"
on storage.objects for insert
to authenticated
with check (
  bucket_id in ('product-images','draft-images')
  and public.is_admin()
);

drop policy if exists "admins read product images" on storage.objects;
create policy "admins read product images"
on storage.objects for select
to authenticated
using (
  bucket_id in ('product-images','draft-images')
  and public.is_admin()
);

drop policy if exists "admins update product images" on storage.objects;
create policy "admins update product images"
on storage.objects for update
to authenticated
using (
  bucket_id in ('product-images','draft-images')
  and public.is_admin()
)
with check (
  bucket_id in ('product-images','draft-images')
  and public.is_admin()
);

drop policy if exists "admins delete product images" on storage.objects;
create policy "admins delete product images"
on storage.objects for delete
to authenticated
using (
  bucket_id in ('product-images','draft-images')
  and public.is_admin()
);

drop policy if exists "public reads published product images" on storage.objects;
create policy "public reads published product images"
on storage.objects for select
to anon, authenticated
using (bucket_id = 'product-images');

-- Depois de criar as duas contas no Authentication > Users,
-- substitua os valores abaixo pelos UUIDs/e-mails reais:
--
-- insert into public.admins (user_id, email)
-- values
--   ('UUID-DA-ADMIN-1', 'email-da-admin-1'),
--   ('UUID-DA-ADMIN-2', 'email-da-admin-2');

-- FRETE / ENTREGA
-- Tabela de configurações gerais (guardamos como chave/valor em jsonb para
-- poder editar tudo pelo painel sem precisar mexer no banco de novo).
create table if not exists public.settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.settings enable row level security;

drop policy if exists "public reads settings" on public.settings;
create policy "public reads settings"
on public.settings for select
to anon, authenticated
using (true);

drop policy if exists "admins manage settings" on public.settings;
create policy "admins manage settings"
on public.settings for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

-- (A configuração de frete deixou de ficar nesta tabela: agora as cidades,
-- bairros e valores ficam em shipping_cities / shipping_neighborhoods, criadas
-- na seção "FRETE POR CIDADE/BAIRRO" no fim deste arquivo. A tabela settings
-- continua existindo; se ela ainda tiver o frete do painel antigo, os valores
-- são trazidos para as tabelas novas automaticamente.)

-- PEDIDOS
-- Fica registrado tanto o pedido pago no site quanto o que caiu no WhatsApp,
-- para aparecer na aba "Pedidos" do painel. Qualquer visitante pode criar
-- (inserir) um pedido — é assim que o próprio site registra a compra da
-- cliente — mas só a administradora logada pode ver, alterar ou apagar.
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_nsu text not null unique,
  items jsonb not null default '[]'::jsonb,
  city text,
  delivery_type text not null default 'other' check (delivery_type in ('local','neighbor','other','retirada')),
  channel text not null default 'site' check (channel in ('site','whatsapp')),
  total numeric(10,2) not null default 0,
  status text not null default 'novo' check (status in ('novo','enviado')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.orders enable row level security;

drop policy if exists "public can create orders" on public.orders;
create policy "public can create orders"
on public.orders for insert
to anon, authenticated
with check (true);

drop policy if exists "admins manage orders" on public.orders;
create policy "admins manage orders"
on public.orders for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

-- GRANT (privilégios de tabela, separados das políticas de RLS acima):
-- o RLS decide QUEM pode fazer o quê, mas o Postgres também exige que o
-- papel (anon/authenticated) tenha acesso básico à tabela pra sequer
-- tentar. Sem isso, dá erro "permission denied" mesmo com a política certa.
grant select, insert, update, delete on public.orders to anon, authenticated;
grant select, insert, update, delete on public.settings to anon, authenticated;
-- Aplica a mesma regra a qualquer tabela nova criada depois deste comando,
-- pra este problema nunca mais acontecer:
alter default privileges in schema public
  grant select, insert, update, delete on tables to anon, authenticated;

-- MIGRAÇÃO: se você já tinha rodado uma versão anterior deste schema.sql
-- (sem a tabela de pedidos, com um único "local_fee" para todas as cidades
-- de entrega própria, ou com "neighbor_cities" como lista de nomes sem
-- valor de frete), rode o comando abaixo no SQL Editor do Supabase para
-- converter a lista de cidades Coopertalse/Correios em uma lista com valor
-- de frete (0 para começar — edite os valores depois pelo painel):
--
-- update public.settings
--   set value = jsonb_set(
--     value,
--     '{neighbor_cities}',
--     (select coalesce(jsonb_object_agg(city, 0), '{}'::jsonb)
--      from jsonb_array_elements_text(value->'neighbor_cities') as city)
--   )
--   where key = 'shipping' and jsonb_typeof(value->'neighbor_cities') = 'array';


-- ============================================================================
-- NARVIE — FRETE POR CIDADE/BAIRRO + ENDEREÇO NO PEDIDO (v2)
-- ============================================================================
-- Pode ser executado quantas vezes quiser: não apaga nada que já existe e
-- preserva os valores de frete que você já tinha cadastrado no painel antigo.
-- Execute INTEIRO no SQL Editor do Supabase ANTES de publicar o site novo.
-- ============================================================================

-- 0. BASE: cria o que ainda não existir no seu Supabase (nada é apagado nem alterado
--    se já existir). Isso cobre projetos que nunca receberam a tabela de pedidos.
create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text unique not null,
  created_at timestamptz not null default now()
);

-- Função que diz se o usuário logado é administradora.
-- (A linha de criação dela estava faltando no schema.sql anterior — sem
-- essa função, o painel não consegue salvar frete, produtos nem pedidos.)
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admins a
    where a.user_id = auth.uid()
  );
$$;
grant execute on function public.is_admin() to anon, authenticated;

-- Baixa de estoque (mesma conta de sempre; só é chamada por dentro do banco).
create or replace function public.decrement_stock(product_id uuid, item_size text, qty int)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.products
  set stock = jsonb_set(
    coalesce(stock, '{}'::jsonb),
    array[item_size],
    to_jsonb(greatest(0, coalesce((stock->>item_size)::int, 0) - qty))
  ),
  updated_at = now()
  where id = product_id;
end;
$$;

-- Configurações gerais (o painel antigo guardava o frete aqui).
create table if not exists public.settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.settings enable row level security;
drop policy if exists "public reads settings" on public.settings;
create policy "public reads settings" on public.settings for select to anon, authenticated using (true);
drop policy if exists "admins manage settings" on public.settings;
create policy "admins manage settings" on public.settings for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
grant select on public.settings to anon, authenticated;
grant insert, update, delete on public.settings to authenticated;

-- Pedidos. Qualquer visitante pode CRIAR um pedido (é assim que a loja registra a compra),
-- mas só a administradora logada pode ver, alterar ou apagar.
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_nsu text not null unique,
  items jsonb not null default '[]'::jsonb,
  city text,
  delivery_type text not null default 'other' check (delivery_type in ('local','neighbor','other','retirada')),
  channel text not null default 'site' check (channel in ('site','whatsapp')),
  total numeric(10,2) not null default 0,
  status text not null default 'novo',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.orders enable row level security;
drop policy if exists "public can create orders" on public.orders;
create policy "public can create orders" on public.orders for insert to anon, authenticated with check (true);
drop policy if exists "admins manage orders" on public.orders;
create policy "admins manage orders" on public.orders for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
grant insert on public.orders to anon;
grant select, insert, update, delete on public.orders to authenticated;

-- 1. CIDADES DE FRETE ---------------------------------------------------------
-- kind = 'entrega_propria' -> entrega direta; o valor depende do bairro.
-- kind = 'envio'           -> envio por transporte/rodoviária; valor único.
-- fee  = valor do frete. Vazio (null) = "sem valor": a cidade NÃO aparece no
--        site até você informar um valor. 0 = frete grátis.
--        Em cidade de entrega própria, fee é o "valor padrão", usado pelos
--        bairros que ficarem sem valor próprio.
create table if not exists public.shipping_cities (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null default 'envio' check (kind in ('entrega_propria','envio')),
  fee numeric(10,2) check (fee is null or fee >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists shipping_cities_name_key
  on public.shipping_cities (lower(name));

-- 2. BAIRROS (só para cidades de entrega própria) ----------------------------
-- fee vazio = usa o valor padrão da cidade.
create table if not exists public.shipping_neighborhoods (
  id uuid primary key default gen_random_uuid(),
  city_id uuid not null references public.shipping_cities(id) on delete cascade,
  name text not null,
  fee numeric(10,2) check (fee is null or fee >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists shipping_neighborhoods_city_name_key
  on public.shipping_neighborhoods (city_id, lower(name));

-- 3. PERMISSÕES: todo mundo lê (a loja precisa); só administradora altera.
alter table public.shipping_cities enable row level security;
alter table public.shipping_neighborhoods enable row level security;

drop policy if exists "public reads shipping cities" on public.shipping_cities;
create policy "public reads shipping cities"
on public.shipping_cities for select
to anon, authenticated
using (true);

drop policy if exists "admins manage shipping cities" on public.shipping_cities;
create policy "admins manage shipping cities"
on public.shipping_cities for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "public reads shipping neighborhoods" on public.shipping_neighborhoods;
create policy "public reads shipping neighborhoods"
on public.shipping_neighborhoods for select
to anon, authenticated
using (true);

drop policy if exists "admins manage shipping neighborhoods" on public.shipping_neighborhoods;
create policy "admins manage shipping neighborhoods"
on public.shipping_neighborhoods for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

grant select on public.shipping_cities, public.shipping_neighborhoods to anon, authenticated;
grant insert, update, delete on public.shipping_cities, public.shipping_neighborhoods to authenticated;
revoke insert, update, delete on public.shipping_cities, public.shipping_neighborhoods from anon;

-- 4. CIDADES PRÉ-CADASTRADAS --------------------------------------------------
-- 4a. Traz o que você já tinha no painel antigo (settings -> shipping).
--     Valor 0 do painel antigo significava "ainda não definido" e vira vazio.
insert into public.shipping_cities (name, kind, fee)
select t.k, 'entrega_propria', nullif(t.v::numeric, 0)
from public.settings s,
     jsonb_each_text(case when jsonb_typeof(s.value->'local_cities') = 'object'
                          then s.value->'local_cities' else '{}'::jsonb end) as t(k, v)
where s.key = 'shipping'
on conflict do nothing;

insert into public.shipping_cities (name, kind, fee)
select t.k, 'envio', nullif(t.v::numeric, 0)
from public.settings s,
     jsonb_each_text(case when jsonb_typeof(s.value->'neighbor_cities') = 'object'
                          then s.value->'neighbor_cities' else '{}'::jsonb end) as t(k, v)
where s.key = 'shipping'
on conflict do nothing;

-- 4b. Entrega própria (garante as duas cidades, caso não existissem).
insert into public.shipping_cities (name, kind, fee) values
  ('Nossa Senhora da Glória', 'entrega_propria', null),
  ('Cristinápolis',           'entrega_propria', null)
on conflict do nothing;

-- 4c. Os 75 municípios de Sergipe (as duas de entrega própria já estão acima).
--     Sem valor: aparecem no painel para você preencher.
insert into public.shipping_cities (name, kind, fee)
select c, 'envio', null
from unnest(array[
  'Amparo de São Francisco','Aquidabã','Aracaju','Arauá','Areia Branca','Barra dos Coqueiros',
  'Boquim','Brejo Grande','Campo do Brito','Canhoba','Canindé de São Francisco','Capela','Carira',
  'Carmópolis','Cedro de São João','Cumbe','Divina Pastora','Estância','Feira Nova','Frei Paulo',
  'Gararu','General Maynard','Gracho Cardoso','Ilha das Flores','Indiaroba','Itabaiana',
  'Itabaianinha','Itabi','Itaporanga d''Ajuda','Japaratuba','Japoatã','Lagarto','Laranjeiras',
  'Macambira','Malhada dos Bois','Malhador','Maruim','Moita Bonita','Monte Alegre de Sergipe',
  'Muribeca','Neópolis','Nossa Senhora Aparecida','Nossa Senhora das Dores',
  'Nossa Senhora de Lourdes','Nossa Senhora do Socorro','Pacatuba','Pedra Mole','Pedrinhas',
  'Pinhão','Pirambu','Poço Redondo','Poço Verde','Porto da Folha','Propriá','Riachão do Dantas',
  'Riachuelo','Ribeirópolis','Rosário do Catete','Salgado','Santa Luzia do Itanhy',
  'Santa Rosa de Lima','Santana do São Francisco','Santo Amaro das Brotas','São Cristóvão',
  'São Domingos','São Francisco','São Miguel do Aleixo','Simão Dias','Siriri','Telha',
  'Tobias Barreto','Tomar do Geru','Umbaúba'
]) as c
on conflict do nothing;

-- 4d. Bairro inicial "Centro" nas cidades de entrega própria que ainda não têm
--     bairro nenhum (sem valor próprio: usa o valor padrão da cidade).
insert into public.shipping_neighborhoods (city_id, name)
select c.id, 'Centro'
from public.shipping_cities c
where c.kind = 'entrega_propria'
  and not exists (select 1 from public.shipping_neighborhoods n where n.city_id = c.id)
on conflict do nothing;

-- 5. PEDIDOS: dados do cliente, endereço e valores --------------------------
alter table public.orders add column if not exists customer_name text;
alter table public.orders add column if not exists customer_whatsapp text;
alter table public.orders add column if not exists neighborhood text;
alter table public.orders add column if not exists street text;
alter table public.orders add column if not exists house_number text;
alter table public.orders add column if not exists complement text;
alter table public.orders add column if not exists reference text;
alter table public.orders add column if not exists subtotal numeric(10,2);
alter table public.orders add column if not exists shipping_fee numeric(10,2) not null default 0;

-- Novo status: o pedido nasce "aguardando_pagamento" (registrado antes de a
-- cliente ir para a InfinitePay) e vira "novo" quando o pagamento é confirmado.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.orders'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%status%'
  loop
    execute format('alter table public.orders drop constraint %I', c.conname);
  end loop;
  alter table public.orders
    add constraint orders_status_check
    check (status in ('aguardando_pagamento','novo','enviado'));
end $$;

-- 6. CONFIRMAÇÃO DE PAGAMENTO + BAIXA DE ESTOQUE ------------------------------
-- Em uma única operação: marca o pedido como pago ("novo") e baixa o estoque.
-- Só baixa na primeira vez, então recarregar a página de "pagamento concluído"
-- (ou clicar duas vezes em "Confirmar pagamento" no painel) nunca baixa duas vezes.
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
      perform public.decrement_stock(
        (it->>'id')::uuid,
        it->>'size',
        greatest(1, coalesce((it->>'quantity')::int, 1))
      );
    end if;
  end loop;

  return 'confirmed';
end;
$$;
grant execute on function public.confirm_order_payment(text) to anon, authenticated;

-- A baixa de estoque agora só é feita por dentro do banco (função acima).
-- Fechar o acesso direto impede que qualquer visitante zere o estoque.
do $$
begin
  if to_regprocedure('public.decrement_stock(uuid,text,integer)') is not null then
    revoke execute on function public.decrement_stock(uuid, text, integer) from public, anon, authenticated;
  end if;
end $$;
