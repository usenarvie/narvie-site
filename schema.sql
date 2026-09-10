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
