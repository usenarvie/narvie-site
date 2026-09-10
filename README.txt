NARVIE V3 — SITE + PAINEL PRIVADO 

O que mudou
------------
Esta versão usa os arquivos visuais da V2 como base, mas troca o catálogo fixo/local por:
- Supabase Auth para login real das administradoras.
- Banco PostgreSQL para produtos.
- RLS (Row Level Security) para separar catálogo público de administração.
- Bucket privado "draft-images" para fotos de rascunhos.
- Bucket público "product-images" somente para peças publicadas.
- Painel administrativo com criação, upload, rascunho, publicação, ocultação e exclusão.
- Carrinho continua local no navegador e o checkout continua pelo WhatsApp.

IMPORTANTE
----------
Sem um projeto Supabase e as duas contas administrativas, não existe como deixar a autenticação "real" já conectada. O pacote está preparado para conexão: basta configurar as credenciais e executar o schema.

CONFIGURAÇÃO
------------
1. Crie um projeto no Supabase.
2. Abra supabase-config.js e coloque:
   - URL do projeto
   - chave ANON/PUBLISHABLE
   A chave ANON/PUBLISHABLE pode ficar no frontend. NUNCA coloque service_role key neste projeto.
3. No SQL Editor, execute schema.sql inteiro.
4. Em Authentication > Users, crie as duas contas de administradoras.
5. Copie os UUIDs das duas contas e execute no SQL Editor:
   insert into public.admins (user_id, email)
   values
     ('UUID-ADMIN-1', 'email1@exemplo.com'),
     ('UUID-ADMIN-2', 'email2@exemplo.com');
6. Em index.html, preencha WHATSAPP_NUMBER com o número da loja no formato internacional, sem +, espaços ou pontuação.
7. Publique os arquivos em uma hospedagem estática (Netlify, Vercel, Cloudflare Pages etc.).

COMO O LANÇAMENTO FUNCIONA
--------------------------
- Ao criar como Rascunho, a imagem vai para draft-images, que é privado.
- O produto fica no banco com status "draft".
- O site público consulta somente status = "published".
- Ao publicar, o painel copia a imagem para product-images e muda o produto para "published".
- Ao ocultar, o fluxo inverso é feito e a imagem volta para o bucket privado.
- Assim, uma foto de rascunho não é enviada ao navegador das clientes pelo catálogo público.

DATA DE LANÇAMENTO
------------------
O painel permite registrar data/hora de lançamento. O status continua sendo a chave de publicação: escolher uma data não publica sozinho o produto. Isso evita que uma peça apareça no site apenas porque a data chegou sem uma decisão explícita de publicação.

ESTRUTURA
----------
index.html             -> loja pública
maintenance.html       -> painel privado
supabase-config.js     -> configuração do projeto
schema.sql             -> banco + RLS + Storage policies
assets/                -> imagens reaproveitadas da V2

SEGURANÇA
---------
- Senhas não ficam no HTML.
- O frontend usa somente a chave ANON/PUBLISHABLE.
- O acesso administrativo depende do Supabase Auth + tabela admins + RLS.
- A service_role key nunca deve ser colocada no navegador.
- O bucket de rascunhos é privado.

OBSERVAÇÃO TÉCNICA
------------------
O catálogo público precisa ter imagens publicadas acessíveis. Por isso a arquitetura usa dois buckets: rascunho privado e publicado público. Isso mantém o segredo durante a preparação e permite que o site público carregue as peças publicadas sem depender de login.
