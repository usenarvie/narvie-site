NARVIE V3.1 — SITE + PAINEL PRIVADO + FRETE + PEDIDOS

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
- Carrinho local no navegador; checkout com endereço, frete calculado por cidade e pagamento pela InfinitePay (Pix/cartão). WhatsApp continua disponível para atendimento e para cidades ainda não atendidas.

NOVO NESTA VERSÃO
------------------
- Estoque por tamanho: no painel, cada peça agora tem um campo de quantidade para cada tamanho (P, M, G, GG, U), em vez de apenas marcar quais tamanhos existem. A loja pública só deixa a cliente escolher tamanhos com estoque disponível e nunca deixa o carrinho passar da quantidade cadastrada.
- Editar peça já publicada: cada peça na lista do painel tem um botão "Editar" que carrega os dados no formulário (nome, descrição, preço, categoria, estoque, data de lançamento e imagem). Trocar a imagem é opcional — se nada for escolhido, a imagem atual é mantida. O status (publicado/rascunho) continua sendo alterado pelos botões da lista, não pelo formulário de edição.

NOVO NA V3.1: FRETE, ENDEREÇO E ABA DE PEDIDOS
------------------------------------------------
- Frete editável: aba "Frete" no painel. Dois valores, os dois em reais:
  "Entrega própria" (Nossa Senhora da Glória e Cristinápolis) e "Envio via
  Coopertalse/Correios" (as demais ~63 cidades atendidas). Mudar aqui já
  vale para o carrinho da loja e para o próximo checkout automaticamente.
- Endereço no checkout: antes de ir para o pagamento, a cliente agora
  preenche nome, WhatsApp, cidade (lista suspensa com as cidades
  atendidas) e endereço completo. Se a cidade não estiver na lista, o
  site mostra o aviso "ainda não atendemos essa região" com um link
  direto para o WhatsApp, e bloqueia o botão de finalizar compra.
- Cidades atendidas: a lista fica em api/_lib/shipping.js (usada pelo
  servidor para validar) e duplicada no <select> de index.html (para a
  cliente escolher). Se um dia vocês passarem a atender mais cidades,
  as duas listas precisam ser editadas juntas.
- Aba "Pedidos" no painel: mostra todos os pedidos pagos, com nome,
  telefone, cidade, endereço, itens e valores. Um selo vermelho ao lado
  da aba "Pedidos" mostra quantos pedidos estão pagos e ainda aguardando
  envio. Quando o pedido for despachado, clique em "Marcar como
  enviado" — ele passa para a aba "Enviados".
- Aviso por e-mail de pedido pago: assim que a InfinitePay confirma o
  pagamento, o sistema grava o pedido como "pago" e envia um e-mail
  automático para contatomoonbooks0@gmail.com com os detalhes do
  pedido. Isso é feito em duas camadas para não depender de uma coisa só:
  1) um webhook que a InfinitePay chama assim que aprova o pagamento;
  2) uma conferência extra quando a cliente volta para a página de
     "pagamento concluído", caso o webhook atrase ou falhe.
  As duas formas são seguras contra duplicidade: o pedido só é marcado
  como pago (e o e-mail só é enviado) uma única vez.

CONFIGURAÇÃO DO FRETE/PEDIDOS/E-MAIL (variáveis de ambiente do servidor)
--------------------------------------------------------------------------
Estas variáveis são configuradas na hospedagem (ex.: Vercel > Settings >
Environment Variables), NUNCA dentro de um arquivo do site. Diferente da
chave ANON/PUBLISHABLE, a service_role key dá acesso total ao banco —
por isso ela só pode existir aqui, como variável de ambiente do
servidor, nunca em supabase-config.js nem em nenhum arquivo enviado ao
navegador.

Obrigatórias para pedidos funcionarem:
  NARVIE_SUPABASE_URL               -> URL do projeto Supabase
  NARVIE_SUPABASE_ANON_KEY          -> chave ANON/PUBLISHABLE (mesma do supabase-config.js)
  NARVIE_SUPABASE_SERVICE_ROLE_KEY  -> Settings > API > service_role, no painel do Supabase

Para o e-mail de aviso funcionar (opcional, mas recomendado):
  NARVIE_RESEND_API_KEY   -> crie uma conta grátis em resend.com e gere uma API key
  NARVIE_RESEND_FROM      -> remetente do e-mail, ex.: "Narvie <pedidos@seudominio.com>"
                              (sem domínio verificado, dá pra usar o remetente de
                              testes do próprio Resend enquanto isso)
  NARVIE_ADMIN_NOTIFY_EMAIL -> para onde vai o aviso (padrão: contatomoonbooks0@gmail.com)

Sem a NARVIE_RESEND_API_KEY, os pedidos continuam sendo salvos e aparecem
normalmente na aba "Pedidos" do painel — só o e-mail automático não é
enviado.

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

Se vocês já tinham a V3 (com estoque por tamanho, mas sem frete/pedidos) rodando,
basta executar o schema.sql inteiro de novo: todos os comandos novos (tabelas
"settings" e "orders") usam "if not exists"/"on conflict", então rodar de novo não
apaga nem duplica nada do que já existia.

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
7. Configure as variáveis de ambiente do servidor (service_role key e, se quiser o e-mail automático, o Resend) — veja a seção "CONFIGURAÇÃO DO FRETE/PEDIDOS/E-MAIL" mais acima neste arquivo.
8. Publique os arquivos em uma hospedagem que rode funções serverless (Vercel é a mais direta, já que os arquivos em api/ já seguem o formato dela).

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
index.html                    -> loja pública (catálogo, carrinho, checkout com endereço/frete)
maintenance.html              -> painel privado (catálogo, pedidos, frete)
pagamento-concluido.html      -> página de retorno da InfinitePay (faz a checagem de segurança do pagamento)
supabase-config.js            -> configuração do projeto (URL + chave ANON, usadas no navegador)
schema.sql                    -> banco + RLS + Storage policies (produtos, admins, settings, orders)
api/create-checkout.js        -> cria o link de pagamento e registra o pedido como "aguardando_pagamento"
api/webhook-infinitepay.js    -> recebe a confirmação de pagamento da InfinitePay e marca o pedido como "pago"
api/confirm-payment.js        -> checagem extra de segurança chamada pela página de retorno
api/_lib/shipping.js          -> lista oficial de cidades atendidas e método de entrega (usada pelo servidor)
api/_lib/orders.js            -> funções de servidor para ler o frete e gravar/atualizar pedidos + enviar e-mail
package.json                  -> só declara o projeto como módulo ES (necessário para os arquivos em api/_lib)
assets/                       -> imagens reaproveitadas da V2

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
