#!/usr/bin/env node
/** Versioned responsive audit. Dynamic browser measurements first; honest static fallback. */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const viewports = [360, 414, 768, 1024, 1280, 1920];
const routes = [];
function discover(dir, segments = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) discover(full, [...segments, e.name]);
    else if (e.name === "page.tsx") routes.push(segments.length ? `/${segments.join("/")}` : "/");
  }
}
discover(path.join(root, "app"));
routes.sort();
const report = { version: "1.0.0", generatedAt: new Date().toISOString(), mode: "static", dynamicError: null, viewports, auditedRoutes: [], routes: [], inaccessibleRoutes: [] };
const add = (route, viewport, type, selector, evidence) => report.routes.push({ route, viewport, type, selector, evidence });

async function dynamic() {
  process.env.HOME = process.env.HOME || "/home/deploy";
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync("/home/deploy/.cache/ms-playwright")) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = "/home/deploy/.cache/ms-playwright";
  }
  let pw;
  try { pw = await import("playwright"); } catch (e) { throw new Error(`Playwright indisponível: ${e.message}`); }
  const child = spawn("npm", ["run", "dev"], { cwd: root, env: { ...process.env, PORT: "3200" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", (d) => { output += d; }); child.stderr.on("data", (d) => { output += d; });
  try {
    const browser = await pw.chromium.launch({ headless: true });
    const page = await browser.newPage();
    const deadline = Date.now() + 15000; let ready = false;
    while (Date.now() < deadline) { try { const r = await fetch("http://127.0.0.1:3200"); if (r.ok || r.status < 500) { ready = true; break; } } catch {} await new Promise((r) => setTimeout(r, 500)); }
    if (!ready) throw new Error(`painel não iniciou em 15s. Saída real:\n${output.slice(-4000)}`);
    for (const route of routes) for (const width of viewports) {
      await page.setViewportSize({ width, height: 800 });
      const response = await page.goto(`http://127.0.0.1:3200${route}`, { waitUntil: "domcontentloaded", timeout: 10000 }).catch((error) => { report.inaccessibleRoutes.push({ route, reason: `navegação falhou: ${error.message}` }); return null; });
      await page.waitForTimeout(250);
      if (!response || response.status() >= 400) { report.inaccessibleRoutes.push({ route, reason: `HTTP ${response?.status() ?? "sem resposta"}` }); continue; }
      // Uma rota que responde 200 mas redirecionou para /login NÃO foi auditada:
      // o que está na tela é o formulário de login, não o módulo. Sem essa
      // checagem o auditor mede 32x a mesma tela de login e conclui "0 defeitos".
      const landed = await page.evaluate(() => location.pathname);
      if (route !== "/login" && landed === "/login") {
        report.auditedRoutes = report.auditedRoutes.filter((r) => r !== route);
        if (!report.inaccessibleRoutes.some((r) => r.route === route)) {
          report.inaccessibleRoutes.push({ route, reason: "redirecionou para /login: requer sessão autenticada e backend disponível" });
        }
        continue;
      }
      const findings = await page.evaluate(() => {
        const visible = [...document.querySelectorAll("body *")].filter((e) => { const s=getComputedStyle(e), r=e.getBoundingClientRect(); return e.textContent?.trim() && s.display!=="none" && s.visibility!=="hidden" && r.width>0 && r.height>0; });
        const leaves = visible.filter(e=>!e.children.length), overlaps=[];
        for(let i=0;i<leaves.length;i++){const a=leaves[i].getBoundingClientRect(); for(let j=i+1;j<leaves.length;j++){const b=leaves[j].getBoundingClientRect(); if(a.left<b.right-1&&a.right>b.left+1&&a.top<b.bottom-1&&a.bottom>b.top+1) overlaps.push([leaves[i].tagName,leaves[j].tagName]);}}
        const clipped = leaves.filter(e=>{const r=e.getBoundingClientRect(), s=getComputedStyle(e); return (e.scrollWidth>e.clientWidth+1 || r.right>document.documentElement.clientWidth+1) && ![...Array(10)].some((_,i)=>{const a=e.parentElement; return a && ((getComputedStyle(a).overflowX==="auto"||getComputedStyle(a).overflowX==="scroll") && a.scrollWidth>a.clientWidth);});}).length;
        const buttons=[...document.querySelectorAll("button")].filter(b=>b.scrollWidth>b.clientWidth+1||b.scrollHeight>b.clientHeight+1).length;
        const iconGap=[...document.querySelectorAll("button")].filter(b=>{ const icon=[...b.children].find(c=>c.tagName.toLowerCase()==="svg"), text=[...b.childNodes].find(n=>n.nodeType===Node.TEXT_NODE&&n.textContent.trim()); if(!icon||!text) return false; const ir=icon.getBoundingClientRect(), tr=document.createRange(); tr.selectNodeContents(text); const xr=tr.getBoundingClientRect(); return xr.left-ir.right<1 && getComputedStyle(b).gap==="normal"; }).length;
        return { overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth+1, overlaps:overlaps.slice(0,10), clipped, buttons, iconGap };
      });
      if (findings.overflow) add(route,width,"document-horizontal-overflow","html","scrollWidth > clientWidth");
      if (findings.clipped) add(route,width,"text-clipping","body *",`${findings.clipped} text node(s) clipped without scrollable ancestor`);
      findings.overlaps.forEach((p)=>add(route,width,"text-overlap",p.join(" + "),"intersecting client rects"));
      if(findings.buttons) add(route,width,"button-label-overflow","button",`${findings.buttons} button(s)`);
      if(findings.iconGap) add(route,width,"button-icon-no-gap","button","icon adjacent to text without explicit gap");
    }
    await browser.close(); report.mode="dynamic";
  } finally { child.kill("SIGTERM"); }
}
function stat() {
  report.mode = "static-structural";
  const files = [];
  function walk(dir) { for (const e of fs.readdirSync(dir,{withFileTypes:true})) { const p=path.join(dir,e.name); if(e.isDirectory()) walk(p); else if(/\.tsx$/.test(e.name) || e.name==="globals.css") files.push(p); } }
  walk(path.join(root,"app")); walk(path.join(root,"components"));
  const cssText = fs.readFileSync(path.join(root, "app/globals.css"), "utf8");
  const cssHas = (name, property, values) => {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) return false;
    return cssText.split("." + name).slice(1).some((chunk) => {
      const body = chunk.slice(chunk.indexOf("{") + 1, chunk.indexOf("}"));
      return body.includes(property + ":") && new RegExp("(?:" + values + ")").test(body);
    });
  };
  const addStatic = (file, line, type, evidence, selector = null) => report.routes.push({ route: "[static]", viewport: null, type, selector: selector || evidence.split(/\\s+/)[0] || "source", file: path.relative(root,file), line, evidence });
  const classes = (text) => [...text.matchAll(/className=(?:"([^"]*)"|{`([^`]*)`})/g)].flatMap((m) => (m[1] || m[2] || "").split(/\\s+/));
  const hasCssGap = (text) => classes(text).some((c) => cssHas(c, "gap", "[^;]+"));
  for (const file of files) {
    const lines = fs.readFileSync(file,"utf8").split(/\n/);
    lines.forEach((text, i) => {
      const hasButtonIconText = /<button[\s\S]*?<\/button>/.test(text) && /<[A-Z][A-Za-z]+[^>]*>/.test(text) && /[>}][A-Za-zÀ-ÿ]/.test(text) && !/\bgap(?:-|\s|=)/.test(text) && !hasCssGap(text);
      if (hasButtonIconText) addStatic(file,i+1,"button-icon-no-gap",text.trim(),"button");
      if (/grid-cols-(?:[3-9]|1[0-2])\b/.test(text) && !/\bsm:grid-cols/.test(text) && /(?:grid-cols-1|md:grid-cols)/.test(text)) addStatic(file,i+1,"grid-missing-intermediate-breakpoint",text.trim());
      if (/<table\b|grid-cols-/.test(text) && /min-w-\[(\d+)px\]|w-\[(\d+)px/.test(text)) {
        const prior = lines.slice(Math.max(0, i - 12), i).join(" ");
        const wrappers = classes(prior).filter((c) => cssHas(c, "overflow-x", "(?:auto|scroll)"));
        if (!wrappers.length && !/overflow-x-(?:auto|scroll)/.test(text)) addStatic(file,i+1,"wide-container-without-scroll-wrapper",text.trim(),"table");
      }
      if (/className="[^"]*\bflex\b/.test(text) && /\{[^}]*\b(?:description|summary|title|name|email|label|children)\b[^}]*\}/i.test(text) && !/\bmin-w-0\b/.test(text)) addStatic(file,i+1,"long-text-flex-without-min-w-0",text.trim());
    });
    let inDialog = false;
    lines.forEach((text,i) => { if (/ModalDialog|role="dialog"/.test(text)) inDialog=true; const fixed = /(?:min-w-(\d+)|w-\[(\d+)px\])/.exec(text); if (inDialog && fixed && Number(fixed[1] || fixed[2]) > 0) addStatic(file,i+1,"fixed-min-width-inside-dialog",text.trim(),"dialog-width"); if (inDialog && /<\/ModalDialog>|<\/section>/.test(text)) inDialog=false; });
  }
}
try { if (process.env.UI_AUDIT_STATIC === "1") throw new Error("static structural audit requested"); await dynamic(); } catch (e) { report.dynamicError = String(e.stack || e); stat(); }
const out = process.env.UI_AUDIT_OUTPUT || path.join(root,"ui-responsive-audit.json"); fs.writeFileSync(out, JSON.stringify(report,null,2)+"\n"); console.log(JSON.stringify({ output: out, mode: report.mode, dynamicError: report.dynamicError, findings: report.routes.length }, null, 2));
