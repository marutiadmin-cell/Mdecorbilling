/**
 * Builds the screen tests for the browser and runs them in headless Chrome.
 *
 * A browser (rather than jsdom) because Chrome is already required by the PDF
 * pipeline, so this adds no dependency — and because it runs the same engine
 * the client's shop actually uses.
 */
const esbuild = require("esbuild");
const puppeteer = require("puppeteer-core");
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");

const OUT_DIR = path.resolve(__dirname, "../node_modules/.cache/screens");
const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

/** Two things a plain esbuild call can't express:
 *  - `@/lib/firebase` → the stub, so a test can never reach the live database.
 *  - CSS imports (`@/styles.css?url`) → nothing; the pages import a stylesheet
 *    URL that Vite understands and a bare bundler does not. */
const stubs = {
  name: "screen-test-stubs",
  setup(build) {
    build.onResolve({ filter: /^@\/lib\/firebase$/ }, () => ({
      path: path.resolve(__dirname, "stubs/firebase.ts"),
    }));
    // Server-only islands. Vite strips these from the client build via
    // createServerFn; a plain bundler follows them straight into
    // firebase-admin, puppeteer and node: builtins, none of which belong in
    // (or can even build for) a browser.
    build.onResolve({ filter: /^@\/lib\/firebaseAdmin$/ }, () => ({
      path: path.resolve(__dirname, "stubs/firebaseAdmin.ts"),
    }));
    build.onResolve({ filter: /^@\/hooks\/usePermissions$/ }, () => ({
      path: path.resolve(__dirname, "stubs/usePermissions.ts"),
    }));
    build.onResolve(
      { filter: /^(puppeteer-core|@sparticuz\/chromium|firebase-admin(\/.*)?|node:.*)$/ },
      (args) => ({ path: args.path, namespace: "empty-module" }),
    );
    build.onLoad({ filter: /.*/, namespace: "empty-module" }, () => ({
      contents: [
        "export default {};",
        "export const existsSync = () => false;",
        // TanStack's SSR storage context imports this even on the client path.
        "export class AsyncLocalStorage {",
        "  getStore() { return undefined; }",
        "  run(_s, fn) { return fn(); }",
        "}",
      ].join("\n"),
      loader: "js",
    }));
    build.onResolve({ filter: /\.css(\?\S*)?$/ }, (args) => ({
      path: args.path,
      namespace: "empty-css",
    }));
    build.onLoad({ filter: /.*/, namespace: "empty-css" }, () => ({
      contents: 'export default "/test.css";',
      loader: "js",
    }));
  },
};

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  fs.writeFileSync(
    path.join(OUT_DIR, "entry.tsx"),
    `import { run } from "${path.resolve(__dirname, "screens.test.tsx").replace(/\\/g, "/")}";
run().then((r) => { (window as any).__RESULT__ = r; })
     .catch((e) => { (window as any).__RESULT__ = { passed: 0, failed: 1, fails: ["harness: " + ((e && e.stack) || (e && e.message) || e)] }; });
`,
    "utf8",
  );

  await esbuild.build({
    entryPoints: [path.join(OUT_DIR, "entry.tsx")],
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
    // Some dependency reaches for `process` at runtime, which a browser has
    // no notion of; a minimal shim is enough to get through module init.
    banner: {
      js: "globalThis.process = globalThis.process || { env: {}, argv: [], platform: 'browser', version: '', cwd: () => '/' };",
    },
    outfile: path.join(OUT_DIR, "bundle.js"),
    alias: { "@": path.resolve(__dirname, "../src") },
    plugins: [stubs],
    logLevel: "error",
  });

  // Load the REAL compiled stylesheet when one is available, so layout
  // assertions (heights, scrolling, whether a popup stays capped) measure
  // what the shop actually sees. Without it every element renders unstyled
  // and any visual assertion is meaningless — which silently made an earlier
  // dropdown-scroll check report nonsense. Falls back to unstyled if the app
  // hasn't been built; only the visual checks depend on it.
  const builtCss = (() => {
    const dir = path.resolve(__dirname, "../.vercel/output/static/assets");
    if (!fs.existsSync(dir)) return null;
    const name = fs.readdirSync(dir).find((n) => /^styles-.*\.css$/.test(n));
    return name ? path.join(dir, name) : null;
  })();
  if (!builtCss) {
    console.warn("! No compiled CSS found (build first) — visual checks are skipped.");
  } else {
    // A stale stylesheet is worse than none: a Tailwind class added since the
    // last build simply won't exist, so a layout assertion measures the OLD
    // design and quietly passes. Cost me a wrong conclusion once already.
    const cssTime = fs.statSync(builtCss).mtimeMs;
    const newestSrc = (function walk(dir) {
      let newest = 0;
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        const st = fs.statSync(p);
        newest = Math.max(newest, st.isDirectory() ? walk(p) : st.mtimeMs);
      }
      return newest;
    })(path.resolve(__dirname, "../src"));
    if (newestSrc > cssTime) {
      console.warn(
        "! The compiled CSS is OLDER than src/ — run a production build first, or any " +
          "layout assertion here is measuring the previous design.",
      );
    }
  }
  fs.writeFileSync(
    path.join(OUT_DIR, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>screen tests</title>` +
      (builtCss ? `<link rel="stylesheet" href="${pathToFileURL(builtCss).href}">` : "") +
      `<body><script src="./bundle.js"></script></body>`,
    "utf8",
  );

  const exe = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!exe) {
    console.error("No Chrome/Edge found — cannot run screen tests.");
    process.exit(2);
  }

  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: true,
    args: ["--no-sandbox", "--allow-file-access-from-files"],
  });
  const page = await browser.newPage();
  /* The window these tests run in.
   *
   * It defaulted to Chromium's 800x600 and nothing could change it, which
   * quietly put two whole classes of layout out of reach: anything gated at
   * Tailwind's lg: breakpoint (1024px) never applied, and the phone layout
   * the shop actually bills on was never rendered at all. Both have now
   * shipped bugs that no assertion here could have seen.
   *
   * SCREENS_VIEWPORT=390x844 runs the suite as a phone. */
  const vp = String(process.env.SCREENS_VIEWPORT || "").match(/^([0-9]+)x([0-9]+)$/);
  if (vp) {
    await page.setViewport({ width: Number(vp[1]), height: Number(vp[2]) });
    console.log(`  viewport: ${vp[1]}x${vp[2]}`);
  }
  const pageErrors = [];
  // A native confirm()/alert() BLOCKS the page until something answers it, so
  // one stray prompt hangs the entire suite and prints nothing at all — which
  // is exactly what a leftover mounted form's "leave without saving?" did.
  // Dismiss them, and record them: a test that trips one wants to know.
  page.on("dialog", (d) => {
    pageErrors.push(`[dialog] ${d.type()}: ${d.message()}`);
    d.dismiss().catch(() => {});
  });
  page.on("pageerror", (e) =>
    pageErrors.push((e && e.stack ? e.stack : String(e)).split("\n").slice(0, 4).join("\n")),
  );
  // React act() warnings are an artefact of driving mounts from a test
  // harness (router/timer updates land just outside the act block), not a
  // defect in the page — everything else is treated as a hard failure.
  const HARNESS_NOISE = /not wrapped in act|configured to support act|ERR_FILE_NOT_FOUND/;
  page.on("console", (m) => {
    if (m.type() !== "error" && m.type() !== "warning") return;
    const text = m.text();
    if (HARNESS_NOISE.test(text)) return;
    // Where it came from matters more than the message: React's warnings
    // name the problem ("Received NaN") but never the component, and hunting
    // for it by reading code is exactly the guessing this harness exists to
    // replace.
    const frames = (m.stackTrace?.() ?? [])
      .filter((f) => f && f.url && !f.url.includes("/bundle.js:0"))
      .slice(0, 4)
      .map((f) => `${f.url.split("/").pop()}:${f.lineNumber}:${f.columnNumber}`)
      .join(" < ");
    pageErrors.push(`[${m.type()}] ${text}${frames ? ` @ ${frames}` : ""}`);
  });

  await page.goto("file://" + path.join(OUT_DIR, "index.html").replace(/\\/g, "/"), {
    waitUntil: "domcontentloaded",
  });
  try {
    await page.waitForFunction("window.__RESULT__ !== undefined", { timeout: 120000 });
  } catch {
    console.error("\nThe test page never reported a result. Errors seen:");
    [...new Set(pageErrors)].slice(0, 15).forEach((e) => console.error("  ! " + e));
    if (!pageErrors.length) console.error("  (none — the run is hanging, not throwing)");
    await browser.close();
    process.exit(2);
  }
  const result = await page.evaluate("window.__RESULT__");
  await browser.close();

  console.log("\n══════════════════════════════════════");
  console.log(`  SCREEN TESTS: ${result.passed} passed, ${result.failed} failed`);
  if (result.fails.length) {
    console.log("\nFailures:");
    result.fails.forEach((f) => console.log("  ✗ " + f));
  }
  if (pageErrors.length) {
    console.log(`\nUncaught page errors (${pageErrors.length}):`);
    [...new Set(pageErrors)].slice(0, 10).forEach((e) => console.log("  ! " + e));
  }
  if (!result.failed && !pageErrors.length) {
    console.log("  ✅ ALL SCREENS RENDER REAL DATA");
  }
  console.log("══════════════════════════════════════\n");
  process.exit(result.failed || pageErrors.length ? 1 : 0);
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(2);
});
