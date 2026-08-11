# calcunt

1. Faça um fork deste repositório: https://github.com/ocabra/calcunt
2. Coloque o fork no seu GitHub Pages, direto ou como submodule dentro do seu repositório de Pages:

```sh
git submodule add -b main https://github.com/<SEU-USUARIO>/calcunt.git calcunt
```
3. Crie um projeto no Supabase com o schema descrito em `calcunt-database-schema.md` (o ChatGPT/Claude fazem isso sem necessidade de intervenção, basta conectar os apps).
4. Crie o seu arquivo de configuração:

```sh
cp config.example.js config.js
```

5. Edite `config.js` e coloque a URL do seu projeto Supabase e a sua publishable key:

```js
export const SUPABASE_URL = "https://SEU-PROJETO.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "SUA-PUBLISHABLE-KEY";
```

6. Publique no GitHub Pages.
7. Crie um novo projeto no ChatGPT ou no Claude chamado `calcunt` apontando para a sua conta Supabase.
8. Coloque estes dois arquivos no projeto:

- `calcunt-entry-guide.md`
- `calcunt-database-schema.md`

Pronto. Use o projeto do ChatGPT/Claude para inserir comidas no Supabase e
abra o GitHub Pages para ver o dashboard.

AVISO: Não use `service_role` key no frontend. O `config.js` deve ter apenas a publishable key.
