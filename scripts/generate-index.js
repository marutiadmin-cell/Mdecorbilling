import { readdirSync, writeFileSync } from "fs";

const assets = readdirSync("dist/client/assets");

const css = assets.find((f) => f.startsWith("styles") && f.endsWith(".css"));
const js = assets.find((f) => f.startsWith("index") && f.endsWith(".js"));

if (!js) {
  console.error("Could not find client entry JS in dist/client/assets/");
  process.exit(1);
}

const cssTag = css ? `\n    <link rel="stylesheet" href="/assets/${css}" />` : "";

const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>M Décor — Billing &amp; Inventory ERP</title>
    <meta name="description" content="Keyboard-first desktop billing, inventory, and accounting software." />${cssTag}
    <link rel="icon" href="/icon-32.png" type="image/png" sizes="32x32" />
    <link rel="icon" href="/icon-192.png" type="image/png" sizes="192x192" />
  </head>
  <body>
    <script type="module" src="/assets/${js}"></script>
  </body>
</html>
`;

writeFileSync("dist/client/index.html", html);
console.log(`Generated dist/client/index.html (js: ${js}${css ? `, css: ${css}` : ""})`);
