# calcunt

Instalacao bem simples:

1. Faca um fork deste repositorio: https://github.com/ocabra/calcunt
2. Coloque o fork no seu GitHub Pages, direto ou como submodule dentro do seu repositorio de Pages:

```sh
git submodule add -b main https://github.com/SEU-USUARIO/calcunt.git calcunt
```
3. Crie um projeto no Supabase com o schema descrito em `calcunt-database-schema.md`.
4. Edite `config.js` e coloque a URL do seu projeto Supabase e a sua publishable key:

```js
export const SUPABASE_URL = "https://SEU-PROJETO.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "SUA-PUBLISHABLE-KEY";
```

5. Publique no GitHub Pages.
6. Crie um projeto no ChatGPT ou no Claude apontando para a sua conta Supabase.
7. Coloque estes dois arquivos nesse projeto:

- `calcunt-entry-guide.md`
- `calcunt-database-schema.md`

Pronto. Use o projeto do ChatGPT/Claude para inserir comidas no Supabase e abra o GitHub Pages para ver o dashboard.

Nao use `service_role` key no frontend. O `config.js` deve ter apenas a publishable key.
