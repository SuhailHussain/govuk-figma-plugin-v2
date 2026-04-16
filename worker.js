const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key, anthropic-version'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
  });
}

// GET /?url=https://www.gov.uk/... — scrape GOV.UK page and return component classes in DOM order with grid context
async function scrape(request) {
  const pageUrl = new URL(request.url).searchParams.get('url');
  if (!pageUrl) return json({ error: 'Missing url parameter' }, 400);

  const GRID_COLUMNS = new Set([
    '.govuk-grid-column-full',
    '.govuk-grid-column-one-half',
    '.govuk-grid-column-one-third',
    '.govuk-grid-column-two-thirds',
    '.govuk-grid-column-one-quarter',
    '.govuk-grid-column-three-quarters',
    '.govuk-grid-column-two-thirds-from-desktop',
    '.govuk-grid-column-one-third-from-desktop'
  ]);

  // Page-level structural components: captured once as a unit, children not scanned.
  // These live outside the grid content area and are always full-width.
  const STRUCTURAL_CLASSES = new Set([
    'gem-c-layout-super-navigation-header',
    'gem-c-layout-header',
    'gem-c-cross-service-header',
    'govuk-header',
    'govuk-phase-banner',
    'govuk-service-navigation',
    'govuk-breadcrumbs',
    'govuk-footer',
    'gem-c-feedback'
  ]);

  // Fully ignored zones — self and all children skipped (not visible on initial load)
  const SKIP_CONTAINERS = new Set(['govuk-cookie-banner']);

  const govukResp = await fetch(pageUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-GB,en;q=0.9'
    }
  });

  if (!govukResp.ok) {
    return json({ error: 'Failed to fetch page: HTTP ' + govukResp.status }, 502);
  }

  const components   = [];
  const spacingStack = [];
  const contextStack = [];
  const seenStructural = new Set();
  let skipDepth      = 0;    // inside a fully-ignored container
  let structDepth    = 0;    // inside a structural component (children skipped)
  let columnDepth    = 0;    // inside a grid column (content capture zone)
  let govspeakMarker = null; // active govspeak component marker
  let govspeakBuf    = '';   // accumulated inner HTML for active govspeak block

  await new HTMLRewriter()
    .on('[class]', {
      element(el) {
        const classList = (el.getAttribute('class') || '').split(/\s+/);

        // ── Fully ignored zones ───────────────────────────────
        if (classList.some(c => SKIP_CONTAINERS.has(c))) {
          skipDepth++;
          el.onEndTag(() => { skipDepth--; });
          return;
        }
        if (skipDepth > 0) return;

        // ── Hidden elements ───────────────────────────────────
        const isHidden =
          el.getAttribute('hidden') !== null ||
          el.getAttribute('aria-hidden') === 'true' ||
          classList.includes('govuk-visually-hidden') ||
          classList.includes('js-hidden') ||
          classList.includes('hidden');
        if (isHidden) return;

        // ── Structural components ─────────────────────────────
        // Capture the component itself once, then skip all its children.
        if (structDepth === 0) {
          const structClass = classList.find(c => STRUCTURAL_CLASSES.has(c));
          if (structClass && !seenStructural.has(structClass)) {
            seenStructural.add(structClass);
            components.push({ candidates: ['.' + structClass], gridColumn: null, marginBottom: null });
            structDepth++;
            el.onEndTag(() => { structDepth--; });
            return;
          }
        }
        if (structDepth > 0) return;

        // ── Grid column context ───────────────────────────────
        // Track which column we're in; the column element itself is not a component.
        const gridClass = classList.find(c => GRID_COLUMNS.has('.' + c));
        if (gridClass) {
          const dotClass = '.' + gridClass;
          contextStack.push(dotClass);
          columnDepth++;
          el.onEndTag(() => {
            columnDepth--;
            const idx = contextStack.lastIndexOf(dotClass);
            if (idx !== -1) contextStack.splice(idx, 1);
          });
          return;
        }

        // ── Only capture elements inside a grid column ────────
        if (columnDepth === 0) return;

        // ── Govspeak content block ────────────────────────────
        // Detect the govspeak wrapper: mark its position in the component list,
        // then collect its inner structure via the dedicated handlers below.
        // Children are skipped from the regular class scanner.
        if (classList.includes('gem-c-govspeak') || classList.includes('govuk-govspeak')) {
          const gridColumn = contextStack.length > 0 ? contextStack[contextStack.length - 1] : null;
          govspeakMarker = { isGovspeak: true, govspeakHtml: '', gridColumn, marginBottom: null };
          govspeakBuf    = '';
          components.push(govspeakMarker);
          el.onEndTag(() => {
            govspeakMarker.govspeakHtml = govspeakBuf;
            govspeakMarker = null;
            govspeakBuf    = '';
          });
          return;
        }
        if (govspeakMarker) return; // children handled by structural element handlers below

        // ── Spacing context ───────────────────────────────────
        let ownMargin = null;
        classList.forEach(c => {
          let m = c.match(/^govuk-!-margin-bottom-(\d)$/);
          if (m) ownMargin = { scale: m[1], static: false };
          m = c.match(/^govuk-!-static-margin-bottom-(\d)$/);
          if (m) ownMargin = { scale: m[1], static: true };
        });
        if (ownMargin) {
          spacingStack.push(ownMargin);
          el.onEndTag(() => { spacingStack.pop(); });
        }

        // ── Emit component candidates ─────────────────────────
        const gridColumn   = contextStack.length > 0 ? contextStack[contextStack.length - 1] : null;
        const marginBottom = ownMargin || (spacingStack.length > 0 ? spacingStack[spacingStack.length - 1] : null);
        const gemClasses   = classList.filter(c => c.startsWith('gem-c-'));
        const govukClasses = classList.filter(c => c.startsWith('govuk-'));
        const candidates   = [...gemClasses, ...govukClasses].map(c => '.' + c);
        if (candidates.length) {
          components.push({ candidates, gridColumn, marginBottom });
        }
      }
    })
    // ── Govspeak: list/table containers (structure only, no text) ─
    .on('ul, ol, table', {
      element(el) {
        if (!govspeakMarker) return;
        const tag = el.tagName;
        govspeakBuf += `<${tag}>`;
        el.onEndTag(() => { govspeakBuf += `</${tag}>`; });
      }
    })
    // ── Govspeak: content elements (structure + text) ─────────────
    .on('p, h1, h2, h3, h4, h5, h6, li, blockquote', {
      element(el) {
        if (!govspeakMarker) return;
        const tag = el.tagName;
        govspeakBuf += `<${tag}>`;
        el.onEndTag(() => { govspeakBuf += `</${tag}>`; });
      },
      text(chunk) {
        if (!govspeakMarker) return;
        govspeakBuf += chunk.text;
      }
    })
    .transform(govukResp)
    .text();

  return json({ components });
}

// POST / — Anthropic API proxy
async function anthropicProxy(request) {
  const apiKey = request.headers.get('x-api-key');
  if (!apiKey) return json({ error: 'Missing x-api-key header' }, 400);

  const body = await request.text();
  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body
  });

  const data = await upstream.text();
  return new Response(data, {
    status: upstream.status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
  });
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method === 'GET') return scrape(request);
    if (request.method === 'POST') return anthropicProxy(request);
    return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
  }
};
