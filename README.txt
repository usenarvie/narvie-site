NARVIE V3 — SITE + PAINEL PRIVADO

O que mudou
------------
Esta versão usa os arquivos visuais da V2 como base, mas troca o catálogo fixo/local por:
- Supabase Auth para login real das administradoras.
- Banco PostgreSQL para produtos.
- RLS (Row Level Security) para separar catálogo público de administração.
- Bucket privado "draft-images" para fotos de rascunhos.
- Bucket público "product-images" somente para peças publicadas.
- Painel administrativo com criação, upload, edição, rascunho, publicação, ocultação e exclusão.
- Estoque por tamanho: cada peça tem uma quantidade própria para P, M, G, GG e U. Tamanho com 0 unidades some das opções da cliente automaticamente.
- Carrinho continua local no navegador e o checkout continua pelo WhatsApp.

NOVO NESTA VERSÃO
------------------
- Estoque por tamanho: no painel, cada peça agora tem um campo de quantidade para cada tamanho (P, M, G, GG, U), em vez de apenas marcar quais tamanhos existem. A loja pública só deixa a cliente escolher tamanhos com estoque disponível e nunca deixa o carrinho passar da quantidade cadastrada.
- Editar peça já publicada: cada peça na lista do painel tem um botão "Editar" que carrega os dados no formulário (nome, descrição, preço, categoria, estoque, data de lançamento e imagem). Trocar a imagem é opcional — se nada for escolhido, a imagem atual é mantida. O status (publicado/rascunho) continua sendo alterado pelos botões da lista, não pelo formulário de edição.
- Frete por cidade + WhatsApp: no carrinho, a cliente escolhe a cidade de entrega. Se for uma cidade de entrega própria, o frete daquela cidade (cadastrado no painel) é somado e o pagamento continua no site. Se for uma cidade atendida via Coopertalse/Correios, o site não libera pagamento automático — abre o WhatsApp com o pedido pronto para combinar o frete. Cidade fora das duas listas mostra aviso de "não entregamos automaticamente" com opção de perguntar no WhatsApp mesmo assim.
- Aba "Frete" no painel: cada cidade de entrega própria tem seu valor de frete editável a qualquer momento (o site sempre usa o valor mais recente). Dá para cadastrar novas cidades de entrega própria e editar a lista de cidades atendidas via Coopertalse/Correios.
- Aba "Pedidos" no painel: todo pedido (pago no site ou combinado no WhatsApp) fica registrado com os itens, cidade e total. Pedidos começam como "Aguardando envio"; a administradora marca como "Enviado" quando despachar. Dá para reabrir um pedido marcado como enviado por engano.

CONFIGURAÇÃO DO FRETE E DOS PEDIDOS
--------------------------------------------------
Frete e pedidos usam só o Supabase — não é preciso configurar nada além do schema.sql
e das credenciais do supabase-config.js. Não há notificação por e-mail: a InfinitePay já
avisa o pagamento, e a aba "Pedidos" do painel é onde a administradora acompanha tudo.

SE VOCÊ JÁ TEM ESTE SITE RODANDO NO VERCEL/SUPABASE
-----------------------------------------------------
Este pacote adiciona a tabela "orders" (pedidos) e muda o formato do frete de um valor
único para um valor por cidade. Se o seu Supabase já tinha uma versão anterior deste
schema.sql, rode no SQL Editor os comandos de migração comentados no final do arquivo
schema.sql (logo abaixo da criação da tabela "orders") — eles criam a tabela de pedidos
que faltava e ajustam o formato do frete sem apagar o que já existia. Depois disso, é só
subir os arquivos novos (index.html, maintenance.html, schema.sql e as pastas api/) no
GitHub, que o Vercel republica sozinho.

IMPORTANTE
----------
Sem um projeto Supabase e as duas contas administrativas, não existe como deixar a autenticação "real" já conectada. O pacote está preparado para conexão: basta configurar as credenciais e executar o schema.

SE VOCÊ JÁ TINHA UM PROJETO SUPABASE CONFIGURADO ANTES
-------------------------------------------------------
Se o schema.sql antigo (sem estoque por tamanho) já foi executado no seu Supabase, rode
os 3 comandos de migração comentados perto da criação da tabela "products" em schema.sql
(no SQL Editor) antes de publicar este site — eles adicionam a coluna de estoque
aproveitando os tamanhos que já existiam. Se este for um projeto novo, ignore essa parte
e apenas rode o schema.sql inteiro normalmente.

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
index.html                  -> loja pública
maintenance.html            -> painel privado (catálogo, pedidos, frete)
supabase-config.js          -> configuração do projeto
schema.sql                  -> banco + RLS + Storage policies
api/create-checkout.js      -> abre o pagamento na InfinitePay (site, entrega própria)
api/notify-order.js         -> registra o pedido pago no site (após voltar da InfinitePay)
api/register-order.js       -> registra o pedido combinado no WhatsApp (sem e-mail)
assets/                     -> imagens reaproveitadas da V2

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
