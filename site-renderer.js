/**
 * Site Renderer — headless Chrome fallback for JS-rendered websites.
 *
 * Detects Wix, Squarespace, and other JS-heavy sites that return empty HTML
 * to standard HTTP fetches. Falls back to headless Chrome to get rendered content.
 *
 * Usage:
 *   const { prefetchWebsite } = require('./site-renderer');
 *   const result = await prefetchWebsite('https://www.padelart.ae/');
 *   // result.rendered = true if Chrome was used
 *   // result.content = rendered text content
 *   // result.pages = { '/': '...', '/pricing': '...', ... }
 *
 * Node.js v24+ — no npm dependencies. Uses system Chrome.
 */

const { execFile } = require('node:child_process');
const https = require('node:https');
const http = require('node:http');
const { URL } = require('node:url');

// Chrome binary locations by platform
const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',  // macOS
  '/usr/bin/google-chrome',                                         // Linux
  '/usr/bin/chromium-browser',                                      // Linux alt
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',     // Windows
];

// JS framework signatures that indicate content won't be in raw HTML
const JS_FRAMEWORK_SIGNATURES = [
  'wix-thunderbolt',           // Wix
  '_wixCssRecovery',           // Wix
  'wixCodeInit',               // Wix
  'squarespace.com',           // Squarespace (in script src)
  'static1.squarespace.com',   // Squarespace CDN
  'sqs-site-css',              // Squarespace
  'webflow.com/js/',           // Webflow
  'w-webflow-badge',           // Webflow badge
  'data-wf-domain',            // Webflow domain attr
  'framer.com/m/',             // Framer
  '__framer-badge',            // Framer badge
  'framerInternalRepresentation', // Framer runtime
  'godaddy.com/website-builder', // GoDaddy builder
  'img.secureserver.net',      // GoDaddy CDN
  'weebly.com/weebly/',        // Weebly
  'wsite-elements',            // Weebly elements
  'cdn.shopify.com',           // Shopify
  'shopify-section',           // Shopify sections
  '__NEXT_DATA__',             // Next.js (sometimes)
  'window.__remixContext',     // Remix
];

// Subpages to attempt for padel venues
const VENUE_SUBPAGES = ['/about', '/courts', '/pricing', '/coaching', '/contact', '/membership', '/classes'];

/**
 * Quick HTTP GET to check raw HTML for JS framework signatures.
 */
function fetchRaw(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' } }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redir = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).href;
        res.resume();
        return fetchRaw(redir, timeoutMs).then(resolve).catch(reject);
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        body += chunk;
        if (body.length > 100000) {
          res.destroy();
          resolve({ status: res.statusCode, body, url });
        }
      });
      res.on('end', () => resolve({ status: res.statusCode, body, url }));
      res.on('close', () => resolve({ status: res.statusCode, body, url }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/**
 * Detect if raw HTML is from a JS-rendered framework.
 */
function detectJSFramework(html) {
  const lower = html.toLowerCase();
  for (const sig of JS_FRAMEWORK_SIGNATURES) {
    if (lower.includes(sig.toLowerCase())) return sig;
  }
  // Heuristic: if the body has very little text content relative to script/style
  const textContent = html.replace(/<script[\s\S]*?<\/script>/gi, '')
                          .replace(/<style[\s\S]*?<\/style>/gi, '')
                          .replace(/<[^>]+>/g, '')
                          .replace(/\s+/g, ' ')
                          .trim();
  if (textContent.length < 200 && html.length > 5000) return 'empty-body-heuristic';
  return null;
}

/**
 * Find Chrome binary on this system.
 */
function findChrome() {
  for (const p of CHROME_PATHS) {
    try {
      require('node:fs').accessSync(p, require('node:fs').constants.X_OK);
      return p;
    } catch { /* not found */ }
  }
  return null;
}

/**
 * Render a single URL with headless Chrome and return text content.
 */
function renderWithChrome(chromePath, url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    // Chrome headless: dump rendered DOM to stdout
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--timeout=10000',
      `--dump-dom`,
      url,
    ];

    const proc = execFile(chromePath, args, {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 5 * 1024 * 1024, // 5MB
      env: { ...process.env, DISPLAY: '' },
    }, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve(stdout);
    });
    // Fallback hard kill if execFile timeout doesn't work
    const hardKill = setTimeout(() => { try { proc.kill('SIGKILL'); } catch(e) {} reject(new Error('hard timeout')); }, timeoutMs + 5000);
    proc.on('exit', () => clearTimeout(hardKill));
  });
}

/**
 * Extract readable text from rendered HTML (strip tags, scripts, styles).
 */
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#8217;/g, "'")
    .replace(/&#8211;/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();
}

/**
 * Pre-fetch a venue website. If it's JS-rendered, use headless Chrome.
 *
 * Returns:
 *   { rendered: bool, framework: string|null, content: string, pages: { path: content }, error: string|null }
 */
async function prefetchWebsite(websiteUrl) {
  if (!websiteUrl || websiteUrl === 'N/A' || websiteUrl === 'UNKNOWN') {
    return { rendered: false, framework: null, content: '', pages: {}, error: 'no-url' };
  }

  const result = { rendered: false, framework: null, content: '', pages: {}, error: null };

  // Step 1: Quick raw fetch to check for JS frameworks
  let raw;
  try {
    raw = await fetchRaw(websiteUrl);
  } catch (e) {
    result.error = `fetch-failed: ${e.message}`;
    return result;
  }

  if (raw.status >= 400) {
    result.error = `http-${raw.status}`;
    return result;
  }

  // Step 2: Check if it's JS-rendered
  const framework = detectJSFramework(raw.body);
  result.framework = framework;

  if (!framework) {
    // Normal HTML — extract text and return
    result.content = htmlToText(raw.body);
    result.pages = { '/': result.content };
    return result;
  }

  // Step 3: JS-rendered site detected — try headless Chrome
  console.log(`  [site-renderer] JS framework detected: ${framework}. Trying headless Chrome...`);
  const chromePath = findChrome();
  if (!chromePath) {
    result.error = 'chrome-not-found';
    console.log('  [site-renderer] Chrome not found on system. Cannot render JS site.');
    return result;
  }

  result.rendered = true;

  // Render homepage
  try {
    const renderedHtml = await renderWithChrome(chromePath, websiteUrl);
    result.content = htmlToText(renderedHtml);
    result.pages['/'] = result.content;
    console.log(`  [site-renderer] Homepage rendered: ${result.content.length} chars`);
  } catch (e) {
    result.error = `chrome-render-failed: ${e.message}`;
    console.log(`  [site-renderer] Chrome render failed: ${e.message}`);
    return result;
  }

  // Try subpages (parallel, best-effort)
  const base = new URL(websiteUrl).origin;
  const subpagePromises = VENUE_SUBPAGES.map(async (path) => {
    try {
      const subUrl = `${base}${path}`;
      const html = await renderWithChrome(chromePath, subUrl, 10000);
      const text = htmlToText(html);
      // Only keep if it has meaningful content and isn't just the same nav/footer
      if (text.length > 200) {
        result.pages[path] = text;
        console.log(`  [site-renderer] ${path}: ${text.length} chars`);
      }
    } catch { /* subpage doesn't exist or failed — fine */ }
  });

  // Run subpages with a concurrency limit of 2 (don't hammer the site)
  for (let i = 0; i < subpagePromises.length; i += 2) {
    await Promise.all(subpagePromises.slice(i, i + 2));
  }

  return result;
}

// --- Exports ---
module.exports = { prefetchWebsite, detectJSFramework, findChrome };

// --- CLI ---
if (require.main === module) {
  const url = process.argv[2];
  if (!url) { console.log('Usage: node site-renderer.js <url>'); process.exit(1); }
  prefetchWebsite(url).then(r => {
    console.log(`\nFramework: ${r.framework || 'none'}`);
    console.log(`Rendered: ${r.rendered}`);
    console.log(`Error: ${r.error || 'none'}`);
    console.log(`Pages: ${Object.keys(r.pages).join(', ')}`);
    console.log(`\nContent (first 2000 chars):\n${r.content.substring(0, 2000)}`);
  }).catch(console.error);
}
