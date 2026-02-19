#!/usr/bin/env node
/**
 * deepcrawl MCP: Clone websites, scrape to markdown, crawl entire sites.
 * Free Firecrawl alternative. No API keys needed.
 * 
 * Tools:
 * - deepcrawl_scrape: Single page → clean markdown
 * - deepcrawl_clone: Full page clone with all assets (HTML/CSS/JS/images/fonts)
 * - deepcrawl_crawl: Crawl entire site → all pages as markdown
 * - deepcrawl_map: Discover all URLs from a site (sitemap + link crawl)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as cheerio from "cheerio";
import TurndownService from "turndown";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname, extname } from "path";
import { URL } from "url";
import { homedir } from "os";

const SERVER_NAME = "deepcrawl-mcp";
const SERVER_VERSION = "1.0.0";
const MAX_CONCURRENT = 5;
const DEFAULT_TIMEOUT = 15000;
const MAX_PAGES = 100;

// ─── HTTP Fetch ───────────────────────────────────────────────────────

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
  "Accept-Encoding": "identity",
};

async function fetchPage(url: string, timeoutMs = DEFAULT_TIMEOUT): Promise<{ html: string; finalUrl: string; status: number } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "follow", headers: HEADERS });
    clearTimeout(timer);
    if (!res.ok) return null;
    const html = await res.text();
    return { html, finalUrl: res.url, status: res.status };
  } catch { clearTimeout(timer); return null; }
}

async function fetchBinary(url: string, timeoutMs = DEFAULT_TIMEOUT): Promise<Buffer | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "follow", headers: { "User-Agent": HEADERS["User-Agent"] } });
    clearTimeout(timer);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch { clearTimeout(timer); return null; }
}

// ─── Turndown (HTML → Markdown) ──────────────────────────────────────

function createTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  // Remove script/style/nav/footer noise
  td.remove("script");
  td.remove("style");
  td.remove("noscript");
  td.remove("iframe");
  td.addRule("removeSvg", { filter: "svg" as any, replacement: () => "" });
  return td;
}

// ─── Clean HTML ──────────────────────────────────────────────────────

function cleanHtml($: cheerio.CheerioAPI): void {
  // Remove noise elements
  $("script, style, noscript, iframe, link[rel='preload'], link[rel='prefetch']").remove();
  $("[aria-hidden='true']").remove();
  // Remove hidden elements
  $("[style*='display:none'], [style*='display: none'], [hidden]").remove();
  // Remove tracking pixels
  $("img[width='1'], img[height='1']").remove();
  // Remove empty elements (but keep br, hr, img, input)
  $("div:empty, span:empty, p:empty, section:empty").remove();
  // Strip data attributes and tracking attrs
  $("*").each(function() {
    const el = $(this);
    const attrs = (this as any).attribs || {};
    for (const attr of Object.keys(attrs)) {
      if (attr.startsWith("data-") && attr !== "data-src") el.removeAttr(attr);
      if (["onclick", "onload", "onerror", "onmouseover"].includes(attr)) el.removeAttr(attr);
    }
  });
}


// ─── SCRAPE: Single page → markdown ──────────────────────────────────

interface ScrapeResult {
  url: string;
  title: string;
  description: string;
  markdown: string;
  links: string[];
  images: string[];
  metadata: Record<string, string>;
}

async function scrapePage(url: string, options: { includeLinks?: boolean; includeImages?: boolean; mainContentOnly?: boolean } = {}): Promise<ScrapeResult> {
  const page = await fetchPage(url);
  if (!page) throw new Error(`Failed to fetch ${url}`);
  
  const $ = cheerio.load(page.html);
  cleanHtml($);
  
  // Extract metadata
  const title = $("title").text().trim() || $("h1").first().text().trim() || "";
  const description = $('meta[name="description"]').attr("content") || $('meta[property="og:description"]').attr("content") || "";
  const metadata: Record<string, string> = {};
  $("meta[property^='og:']").each(function() {
    const prop = $(this).attr("property") || "";
    metadata[prop] = $(this).attr("content") || "";
  });
  $("meta[name]").each(function() {
    const name = $(this).attr("name") || "";
    if (["author", "keywords", "viewport", "robots"].includes(name)) {
      metadata[name] = $(this).attr("content") || "";
    }
  });
  
  // Extract links
  const links: string[] = [];
  if (options.includeLinks !== false) {
    $("a[href]").each(function() {
      try {
        const href = $(this).attr("href") || "";
        if (href && !href.startsWith("#") && !href.startsWith("javascript:")) {
          links.push(new URL(href, page.finalUrl).href);
        }
      } catch {}
    });
  }
  
  // Extract images
  const images: string[] = [];
  if (options.includeImages !== false) {
    $("img[src], img[data-src]").each(function() {
      try {
        const src = $(this).attr("src") || $(this).attr("data-src") || "";
        if (src) images.push(new URL(src, page.finalUrl).href);
      } catch {}
    });
  }
  
  // Main content extraction
  let contentHtml: string;
  if (options.mainContentOnly !== false) {
    // Try to find main content container
    const mainEl = $("main, article, [role='main'], .content, .post-content, .entry-content, #content, #main").first();
    contentHtml = mainEl.length ? mainEl.html() || $.html() : $.html();
  } else {
    contentHtml = $.html();
  }
  
  const td = createTurndown();
  let markdown = td.turndown(contentHtml);
  // Clean up excessive whitespace
  markdown = markdown.replace(/\n{3,}/g, "\n\n").trim();
  
  return { url: page.finalUrl, title, description, markdown, links: [...new Set(links)], images: [...new Set(images)], metadata };
}


// ─── CLONE: Full page with all assets ────────────────────────────────

interface CloneResult {
  outputDir: string;
  pagesCloned: number;
  assetsDownloaded: number;
  totalSize: string;
  files: string[];
}

function sanitizeFilename(url: string, base: string): string {
  try {
    const u = new URL(url, base);
    let path = u.pathname;
    if (path === "/" || path === "") path = "/index.html";
    if (!extname(path)) path += "/index.html";
    // Remove leading slash, replace special chars
    return path.replace(/^\//, "").replace(/[?#&=]/g, "_");
  } catch {
    return "asset_" + Math.random().toString(36).slice(2, 8);
  }
}

async function clonePage(url: string, outputDir: string, options: { depth?: number; sameOriginOnly?: boolean } = {}): Promise<CloneResult> {
  const depth = options.depth ?? 0; // 0 = single page, 1+ = follow links
  const sameOriginOnly = options.sameOriginOnly ?? true;
  const baseUrl = new URL(url);
  const visited = new Set<string>();
  const assetUrls = new Set<string>();
  const files: string[] = [];
  let totalBytes = 0;
  
  mkdirSync(outputDir, { recursive: true });
  
  // Queue of pages to process: [url, currentDepth]
  const queue: [string, number][] = [[url, 0]];
  
  while (queue.length > 0) {
    const [pageUrl, currentDepth] = queue.shift()!;
    if (visited.has(pageUrl)) continue;
    visited.add(pageUrl);
    
    const page = await fetchPage(pageUrl);
    if (!page) continue;
    
    const $ = cheerio.load(page.html);
    
    // Collect all asset URLs
    const assets: { el: cheerio.Cheerio<any>; attr: string; url: string }[] = [];
    
    // CSS
    $("link[rel='stylesheet'][href]").each(function() {
      const href = $(this).attr("href");
      if (href) { try { assets.push({ el: $(this), attr: "href", url: new URL(href, page.finalUrl).href }); } catch {} }
    });
    
    // JS
    $("script[src]").each(function() {
      const src = $(this).attr("src");
      if (src) { try { assets.push({ el: $(this), attr: "src", url: new URL(src, page.finalUrl).href }); } catch {} }
    });
    
    // Images
    $("img[src]").each(function() {
      const src = $(this).attr("src");
      if (src) { try { assets.push({ el: $(this), attr: "src", url: new URL(src, page.finalUrl).href }); } catch {} }
    });
    $("img[data-src]").each(function() {
      const src = $(this).attr("data-src");
      if (src) { try { assets.push({ el: $(this), attr: "data-src", url: new URL(src, page.finalUrl).href }); } catch {} }
    });
    
    // Favicons and icons
    $("link[rel*='icon'][href]").each(function() {
      const href = $(this).attr("href");
      if (href) { try { assets.push({ el: $(this), attr: "href", url: new URL(href, page.finalUrl).href }); } catch {} }
    });
    
    // Fonts and other preloaded assets
    $("link[rel='preload'][href]").each(function() {
      const href = $(this).attr("href");
      if (href) { try { assets.push({ el: $(this), attr: "href", url: new URL(href, page.finalUrl).href }); } catch {} }
    });
    
    // OG images
    $("meta[property='og:image'][content]").each(function() {
      const content = $(this).attr("content");
      if (content) { try { assets.push({ el: $(this), attr: "content", url: new URL(content, page.finalUrl).href }); } catch {} }
    });
    
    // Background images in inline styles
    $("[style*='background']").each(function() {
      const style = $(this).attr("style") || "";
      const matches = style.match(/url\(['"]?(.*?)['"]?\)/g);
      if (matches) {
        for (const m of matches) {
          const imgUrl = m.replace(/url\(['"]?/, "").replace(/['"]?\)/, "");
          try { assetUrls.add(new URL(imgUrl, page.finalUrl).href); } catch {}
        }
      }
    });
    
    // Download assets and rewrite URLs
    for (const asset of assets) {
      if (assetUrls.has(asset.url)) continue;
      assetUrls.add(asset.url);
      
      const localPath = sanitizeFilename(asset.url, page.finalUrl);
      const fullPath = join(outputDir, localPath);
      
      try {
        const data = await fetchBinary(asset.url);
        if (data) {
          mkdirSync(dirname(fullPath), { recursive: true });
          writeFileSync(fullPath, data);
          totalBytes += data.length;
          files.push(localPath);
          
          // Rewrite URL in HTML
          asset.el.attr(asset.attr, localPath);
        }
      } catch {}
    }
    
    // Save HTML
    const pagePath = sanitizeFilename(pageUrl, url);
    const pageFullPath = join(outputDir, pagePath);
    mkdirSync(dirname(pageFullPath), { recursive: true });
    const finalHtml = $.html();
    writeFileSync(pageFullPath, finalHtml);
    totalBytes += Buffer.byteLength(finalHtml);
    files.push(pagePath);
    
    // Follow links if depth > 0
    if (currentDepth < depth) {
      $("a[href]").each(function() {
        try {
          const href = $(this).attr("href") || "";
          const linkUrl = new URL(href, page.finalUrl);
          if (sameOriginOnly && linkUrl.origin !== baseUrl.origin) return;
          if (!visited.has(linkUrl.href) && visited.size < MAX_PAGES) {
            queue.push([linkUrl.href, currentDepth + 1]);
          }
        } catch {}
      });
    }
  }
  
  const sizeMb = (totalBytes / 1024 / 1024).toFixed(2);
  return { outputDir, pagesCloned: visited.size, assetsDownloaded: assetUrls.size, totalSize: `${sizeMb} MB`, files };
}


// ─── CRAWL: Full site → markdown pages ───────────────────────────────

interface CrawlResult {
  pages: Array<{ url: string; title: string; markdown: string }>;
  totalPages: number;
  errors: string[];
}

async function crawlSite(url: string, options: { maxPages?: number; sameOriginOnly?: boolean; includeImages?: boolean } = {}): Promise<CrawlResult> {
  const maxPages = Math.min(options.maxPages ?? 20, MAX_PAGES);
  const sameOriginOnly = options.sameOriginOnly ?? true;
  const baseUrl = new URL(url);
  const visited = new Set<string>();
  const queue: string[] = [url];
  const pages: CrawlResult["pages"] = [];
  const errors: string[] = [];
  
  while (queue.length > 0 && visited.size < maxPages) {
    // Process batch
    const batch = queue.splice(0, MAX_CONCURRENT);
    const results = await Promise.allSettled(
      batch.filter(u => !visited.has(u)).map(async (pageUrl) => {
        visited.add(pageUrl);
        try {
          const result = await scrapePage(pageUrl, { includeLinks: true, includeImages: options.includeImages ?? false, mainContentOnly: true });
          pages.push({ url: result.url, title: result.title, markdown: result.markdown });
          
          // Add discovered links to queue
          for (const link of result.links) {
            try {
              const linkUrl = new URL(link);
              if (sameOriginOnly && linkUrl.origin !== baseUrl.origin) continue;
              // Skip non-HTML resources
              const ext = extname(linkUrl.pathname).toLowerCase();
              if ([".pdf", ".jpg", ".png", ".gif", ".svg", ".css", ".js", ".zip", ".mp4", ".mp3", ".webp"].includes(ext)) continue;
              if (!visited.has(linkUrl.href) && visited.size + queue.length < maxPages) {
                queue.push(linkUrl.href);
              }
            } catch {}
          }
        } catch (err: any) {
          errors.push(`${pageUrl}: ${err.message}`);
        }
      })
    );
  }
  
  return { pages, totalPages: pages.length, errors };
}

// ─── MAP: Discover all URLs ──────────────────────────────────────────

interface MapResult {
  urls: string[];
  fromSitemap: number;
  fromCrawl: number;
  total: number;
}

async function mapSite(url: string, options: { maxUrls?: number } = {}): Promise<MapResult> {
  const maxUrls = options.maxUrls ?? 200;
  const baseUrl = new URL(url);
  const urls = new Set<string>();
  let fromSitemap = 0;
  let fromCrawl = 0;
  
  // Try sitemap.xml
  const sitemapUrls = [
    `${baseUrl.origin}/sitemap.xml`,
    `${baseUrl.origin}/sitemap_index.xml`,
    `${baseUrl.origin}/sitemap-index.xml`,
  ];
  
  for (const sitemapUrl of sitemapUrls) {
    try {
      const page = await fetchPage(sitemapUrl, 10000);
      if (!page) continue;
      // Parse sitemap XML
      const $ = cheerio.load(page.html, { xmlMode: true });
      // Standard sitemap
      $("url > loc").each(function() {
        const loc = $(this).text().trim();
        if (loc && urls.size < maxUrls) { urls.add(loc); fromSitemap++; }
      });
      // Sitemap index
      $("sitemap > loc").each(function() {
        const loc = $(this).text().trim();
        if (loc) {
          // Could recursively fetch sub-sitemaps, but keep it simple
          urls.add(loc);
        }
      });
      if (urls.size > 0) break; // Found sitemap, stop trying
    } catch {}
  }
  
  // Also try robots.txt for sitemap references
  try {
    const robotsPage = await fetchPage(`${baseUrl.origin}/robots.txt`, 5000);
    if (robotsPage) {
      const sitemapMatches = robotsPage.html.match(/Sitemap:\s*(.+)/gi);
      if (sitemapMatches) {
        for (const match of sitemapMatches) {
          const smUrl = match.replace(/Sitemap:\s*/i, "").trim();
          if (!sitemapUrls.includes(smUrl)) {
            const page = await fetchPage(smUrl, 10000);
            if (page) {
              const $ = cheerio.load(page.html, { xmlMode: true });
              $("url > loc").each(function() {
                const loc = $(this).text().trim();
                if (loc && urls.size < maxUrls) { urls.add(loc); fromSitemap++; }
              });
            }
          }
        }
      }
    }
  } catch {}
  
  // Crawl homepage for additional links
  try {
    const result = await scrapePage(url, { includeLinks: true, includeImages: false });
    for (const link of result.links) {
      try {
        const linkUrl = new URL(link);
        if (linkUrl.origin === baseUrl.origin && urls.size < maxUrls) {
          if (!urls.has(linkUrl.href)) { urls.add(linkUrl.href); fromCrawl++; }
        }
      } catch {}
    }
  } catch {}
  
  return { urls: [...urls], fromSitemap, fromCrawl, total: urls.size };
}


// ─── CSS Asset Extraction from stylesheets ───────────────────────────

async function downloadCssAssets(cssUrl: string, cssContent: string, outputDir: string): Promise<number> {
  let count = 0;
  // Find url() references in CSS (fonts, images, etc.)
  const urlMatches = cssContent.match(/url\(['"]?([^'")\s]+)['"]?\)/g) || [];
  for (const match of urlMatches) {
    const assetPath = match.replace(/url\(['"]?/, "").replace(/['"]?\)/, "");
    if (assetPath.startsWith("data:")) continue; // Skip data URIs
    try {
      const assetUrl = new URL(assetPath, cssUrl).href;
      const localPath = sanitizeFilename(assetUrl, cssUrl);
      const fullPath = join(outputDir, localPath);
      if (!existsSync(fullPath)) {
        const data = await fetchBinary(assetUrl);
        if (data) {
          mkdirSync(dirname(fullPath), { recursive: true });
          writeFileSync(fullPath, data);
          count++;
        }
      }
    } catch {}
  }
  return count;
}

// ─── MCP Server ──────────────────────────────────────────────────────

const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

// Tool 1: Scrape single page to markdown
server.tool(
  "deepcrawl_scrape",
  "Scrape une page web et retourne son contenu en markdown propre. Extrait le titre, la description, les liens, les images et les métadonnées. Idéal pour lire le contenu d'une page sans bruit (pubs, navigation, footer). Alternative gratuite à Firecrawl /scrape.",
  {
    url: z.string().describe("URL de la page à scraper"),
    mainContentOnly: z.boolean().optional().describe("Extraire uniquement le contenu principal, pas la nav/footer (défaut: true)"),
    includeLinks: z.boolean().optional().describe("Inclure les liens trouvés (défaut: true)"),
    includeImages: z.boolean().optional().describe("Inclure les URLs des images (défaut: true)"),
  },
  async ({ url, mainContentOnly, includeLinks, includeImages }) => {
    try {
      const result = await scrapePage(url, { mainContentOnly, includeLinks, includeImages });
      const lines = [
        `# ${result.title}`,
        result.description ? `> ${result.description}` : "",
        `**URL:** ${result.url}`,
        "",
        result.markdown,
      ];
      if (result.images.length > 0) {
        lines.push("", "---", "## Images", ...result.images.map(img => `- ${img}`));
      }
      if (result.links.length > 0) {
        lines.push("", "---", `## Links (${result.links.length})`, ...result.links.slice(0, 50).map(l => `- ${l}`));
        if (result.links.length > 50) lines.push(`... and ${result.links.length - 50} more`);
      }
      return { content: [{ type: "text" as const, text: lines.filter(Boolean).join("\n") }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Erreur: ${err.message}` }], isError: true };
    }
  }
);

// Tool 2: Clone page with all assets
server.tool(
  "deepcrawl_clone",
  "Clone une page web complète avec tous ses assets (HTML, CSS, JS, images, fonts, favicons). Télécharge tout dans un dossier local prêt à ouvrir dans un navigateur. Peut suivre les liens internes pour cloner plusieurs pages. Parfait pour copier un site et l'adapter.",
  {
    url: z.string().describe("URL de la page à cloner"),
    outputDir: z.string().optional().describe("Dossier de sortie (défaut: ~/deepcrawl-clones/<domaine>)"),
    depth: z.number().optional().describe("Profondeur de suivi des liens: 0 = page seule, 1 = page + liens directs, 2+ = plus profond (défaut: 0)"),
  },
  async ({ url, outputDir, depth }) => {
    try {
      const baseUrl = new URL(url);
      const dir = outputDir || join(homedir(), "deepcrawl-clones", baseUrl.hostname.replace(/\./g, "_"));
      const result = await clonePage(url, dir, { depth: depth ?? 0, sameOriginOnly: true });
      
      const lines = [
        `# Clone terminé`,
        "",
        `**Source:** ${url}`,
        `**Dossier:** ${result.outputDir}`,
        `**Pages clonées:** ${result.pagesCloned}`,
        `**Assets téléchargés:** ${result.assetsDownloaded}`,
        `**Taille totale:** ${result.totalSize}`,
        "",
        "## Fichiers",
        ...result.files.slice(0, 50).map(f => `- ${f}`),
      ];
      if (result.files.length > 50) lines.push(`... et ${result.files.length - 50} autres`);
      lines.push("", `💡 Ouvre \`${result.outputDir}/index.html\` dans un navigateur pour voir le clone.`);
      
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Erreur: ${err.message}` }], isError: true };
    }
  }
);

// Tool 3: Crawl entire site to markdown
server.tool(
  "deepcrawl_crawl",
  "Crawle un site entier en suivant les liens internes. Retourne chaque page en markdown propre. Idéal pour indexer tout le contenu d'un site, analyser la concurrence, ou alimenter un RAG. Alternative gratuite à Firecrawl /crawl.",
  {
    url: z.string().describe("URL de départ du crawl"),
    maxPages: z.number().optional().describe("Nombre max de pages à crawler (défaut: 20, max: 100)"),
    includeImages: z.boolean().optional().describe("Inclure les URLs des images (défaut: false)"),
  },
  async ({ url, maxPages, includeImages }) => {
    try {
      const result = await crawlSite(url, { maxPages, includeImages });
      const lines = [
        `# Crawl terminé: ${result.totalPages} pages`,
        "",
      ];
      for (const page of result.pages) {
        lines.push(`---`, `## ${page.title || page.url}`, `**URL:** ${page.url}`, "", page.markdown.slice(0, 2000), "");
        if (page.markdown.length > 2000) lines.push(`... (${page.markdown.length} chars total, tronqué)`);
      }
      if (result.errors.length > 0) {
        lines.push("", "## Erreurs", ...result.errors.map(e => `- ${e}`));
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Erreur: ${err.message}` }], isError: true };
    }
  }
);

// Tool 4: Map site URLs
server.tool(
  "deepcrawl_map",
  "Découvre toutes les URLs d'un site via le sitemap.xml et le crawl des liens. Retourne la liste complète des pages. Utile avant un crawl pour voir l'étendue du site. Alternative gratuite à Firecrawl /map.",
  {
    url: z.string().describe("URL du site à mapper"),
    maxUrls: z.number().optional().describe("Nombre max d'URLs à découvrir (défaut: 200)"),
  },
  async ({ url, maxUrls }) => {
    try {
      const result = await mapSite(url, { maxUrls });
      const lines = [
        `# Site Map: ${new URL(url).hostname}`,
        "",
        `**Total URLs:** ${result.total}`,
        `**Depuis sitemap.xml:** ${result.fromSitemap}`,
        `**Depuis crawl liens:** ${result.fromCrawl}`,
        "",
        "## URLs",
        ...result.urls.map(u => `- ${u}`),
      ];
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Erreur: ${err.message}` }], isError: true };
    }
  }
);

// ─── Start ────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`${SERVER_NAME} v${SERVER_VERSION} running on stdio`);
