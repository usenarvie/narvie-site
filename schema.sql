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

-- Configuração inicial de frete: cada cidade de entrega própria tem seu
-- próprio valor de frete (editável pelo painel, aba "Frete") e a lista de
-- cidades atendidas via Coopertalse/Correios (frete combinado no WhatsApp).
-- Qualquer cidade fora dessas duas listas cai automaticamente no aviso de
-- "não entregamos, fale no WhatsApp".
insert into public.settings (key, value) values (
  'shipping',
  jsonb_build_object(
    'local_cities', jsonb_build_object('Nossa Senhora da Glória', 0, 'Cristinápolis', 0),
    'neighbor_cities', jsonb_build_array(
      'Itabaiana','Lagarto','Moita Bonita','Ribeirópolis','Malhador','Macambira',
      'Campo do Brito','São Domingos','Pinhão','Pedra Mole','São Miguel do Aleixo',
      'Nossa Senhora Aparecida','Frei Paulo','Carira','Porto da Folha','Poço Redondo',
      'Canindé de São Francisco','Monte Alegre de Sergipe','Gararu',
      'Nossa Senhora de Lourdes','Itabi','Feira Nova','Estância','Boquim',
      'Tobias Barreto','Poço Verde','Riachão do Dantas','Pedrinhas','Arauá',
      'Itabaianinha','Umbaúba','Indiaroba','Santa Luzia do Itanhy','Tomar do Geru',
      'Propriá','Neópolis','Pacatuba','Japoatã','Aquidabã','Muribeca','Capela',
      'Nossa Senhora das Dores','Siriri','Japaratuba','Pirambu','Ilha das Flores',
      'Brejo Grande','Santana do São Francisco','Amparo de São Francisco',
      'Malhada dos Bois','Cedro de São João','Telha','Aracaju',
      'Nossa Senhora do Socorro','São Cristóvão','Barra dos Coqueiros','Laranjeiras',
      'Maruim','Riachuelo','Areia Branca','Divina Pastora','Santa Rosa de Lima',
      'Carmópolis','Rosário do Catete','General Maynard'
    )
  )
) on conflict (key) do nothing;

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
  delivery_type text not null default 'other' check (delivery_type in ('local','neighbor','other')),
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

-- MIGRAÇÃO: se você já tinha rodado uma versão anterior deste schema.sql
-- (sem a tabela de pedidos, ou com um único "local_fee" para todas as
-- cidades de entrega própria), rode os comandos abaixo no SQL Editor do
-- Supabase para atualizar sem perder o que já existe:
--
-- update public.settings
--   set value = jsonb_build_object(
--     'local_cities', jsonb_build_object('Nossa Senhora da Glória', 0, 'Cristinápolis', 0),
--     'neighbor_cities', coalesce(value->'neighbor_cities', '[]'::jsonb)
--   )
--   where key = 'shipping' and jsonb_typeof(value->'local_cities') = 'array';
