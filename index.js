// Management.974 Renderer — "Field Briefing" template
// POST /render  { title, slides: [...] }  ->  200 PDF file
//                                          ->  422 { detail: { validation_errors: [...] } }
// GET  /health  ->  200 "ok"
// Auth: header "X-API-Key" must match process.env.RENDERER_API_KEY

const express = require('express');
const PDFDocument = require('pdfkit');
const path = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));

const PAGE = { width: 800, height: 1000, margin: 56 };
const CW = PAGE.width - PAGE.margin * 2;
const LX = PAGE.margin;
const FOOTER_TOP = PAGE.height - 56;

// Meaning-driven palette: problem pages read oxblood, solution pages read green.
const C = {
  paper: '#F1F0EC',
  ink: '#17181A',
  graphite: '#4A4D52',
  hairline: '#D6D3CB',
  oxblood: '#7A2E2E',
  oxbloodTint: '#EFE3E1',
  ledger: '#2F4F3D',
  ledgerTint: '#E4EAE4',
  darkPage: '#17181A',
  onDarkSub: '#9A9C9F',
};

const FONT_DIR = __dirname;
const F = {
  head: 'PlexCondBold',
  body: 'PlexSans',
  bodyBold: 'PlexSansBold',
  italic: 'PlexSansItalic',
};

const fs = require('fs');

// Resilient to either layout: fonts flat at repo root, or inside a fonts/
// subfolder. Whichever exists at boot is used, so a stray file reorganization
// doesn't silently break every render with an ENOENT deep in a request.
function resolveFontPath(filename) {
  const flat = path.join(FONT_DIR, filename);
  if (fs.existsSync(flat)) return flat;
  const nested = path.join(FONT_DIR, 'fonts', filename);
  if (fs.existsSync(nested)) return nested;
  throw new Error(`Font file not found in either location: ${flat} or ${nested}`);
}

function registerFonts(doc) {
  doc.registerFont(F.head, resolveFontPath('PlexSansCondensed-Bold.ttf'));
  doc.registerFont(F.body, resolveFontPath('PlexSans-Regular.ttf'));
  doc.registerFont(F.bodyBold, resolveFontPath('PlexSans-Bold.ttf'));
  doc.registerFont(F.italic, resolveFontPath('PlexSans-Italic.ttf'));
}

const DEFAULT_AUTHOR = 'MANAGEMENT.974';
const DEFAULT_AUTHOR_TITLE = 'Practical Management  \u2022  Leadership  \u2022  Workplace Reality';
const DARK_TYPES = new Set(['hero', 'cta']);

// Section metadata drives the tab marker + tint. Not decorative — it tells
// the reader what kind of page this is (problem vs. solution vs. framing).
const SECTION_META = {
  hero: { tab: 'Brief', tint: null },
  reality: { tab: 'Reality check', tint: C.oxbloodTint, rule: C.oxblood },
  list: { tab: null, tint: null }, // resolved per-slide below (warning vs playbook)
  cta: { tab: 'Takeaway', tint: null },
};

function resolveListTab(slide) {
  const label = (slide.eyebrow || slide.list_label || '').toLowerCase();
  if (label.includes('warning')) return { tab: 'Warning signs', tint: C.oxbloodTint, rule: C.oxblood };
  return { tab: "Manager's playbook", tint: C.ledgerTint, rule: C.ledger };
}

// ---------- validation ----------
function validateSpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== 'object') return ['Spec is not an object.'];
  if (typeof spec.title !== 'string' || !spec.title.trim()) errors.push('Missing or empty "title".');
  if (!Array.isArray(spec.slides) || spec.slides.length !== 5) {
    errors.push('"slides" must be an array of exactly 5 items.');
    return errors;
  }
  const VALID_TYPES = ['hero', 'reality', 'list', 'cta'];
  spec.slides.forEach((s, i) => {
    const n = `Slide ${i + 1} (${s?.type || 'unknown'})`;
    if (!s || typeof s !== 'object') { errors.push(`${n}: not an object.`); return; }
    if (!VALID_TYPES.includes(s.type)) { errors.push(`${n}: unknown slide type "${s.type}".`); return; }
    if (!s.headline) errors.push(`${n}: missing "headline".`);
    if (s.type === 'reality' && !s.body) errors.push(`${n}: missing "body".`);
    if (s.type === 'list' && (!Array.isArray(s.list_items) || !s.list_items.length)) errors.push(`${n}: "list_items" must be a non-empty array.`);
    if (s.type === 'cta' && !s.body) errors.push(`${n}: missing "body".`);
  });
  if (spec.slides[0]?.type !== 'hero') errors.push('First slide must be type "hero".');
  if (spec.slides[4]?.type !== 'cta') errors.push('Last slide must be type "cta".');
  return errors;
}

// ---------- drawing helpers ----------
function background(doc, dark) { doc.rect(0, 0, PAGE.width, PAGE.height).fill(dark ? C.darkPage : C.paper); }

function header(doc, pageNum, total, dark, author, authorTitle) {
  const fg = dark ? '#F1F0EC' : C.ink;
  const sub = dark ? C.onDarkSub : C.graphite;
  doc.fillColor(fg).font(F.bodyBold).fontSize(21).text(author, LX, 40);
  doc.fillColor(sub).font(F.body).fontSize(11).text(authorTitle, LX, doc.y + 2);
  doc.fillColor(sub).font(F.body).fontSize(11).text(`Brief ${pageNum} of ${total}`, PAGE.width - 166, 42, { width: 110, align: 'right' });
  doc.moveTo(LX, 92).lineTo(PAGE.width - LX, 92).lineWidth(0.75).strokeColor(dark ? '#333436' : C.hairline).stroke();
}

function footer(doc, dark, title) {
  const y = FOOTER_TOP;
  doc.moveTo(LX, y).lineTo(PAGE.width - LX, y).lineWidth(0.75).strokeColor(dark ? '#333436' : C.hairline).stroke();
  doc.fillColor(dark ? C.onDarkSub : C.graphite).font(F.body).fontSize(9.5).text(title, LX, y + 13, { width: CW - 150 });
  doc.fillColor(dark ? C.onDarkSub : C.graphite).font(F.body).fontSize(9.5).text('management.974', PAGE.width - 186, y + 13, { width: 130, align: 'right' });
}

// Left-edge tab marker in place of an ALL-CAPS eyebrow: a small filled rule
// plus a sentence-case label, like a folder tab on a case file.
function tabMarker(doc, label, ruleColor, dark) {
  const y = 110;
  doc.rect(LX, y, 28, 4).fill(ruleColor || (dark ? '#F1F0EC' : C.ink));
  doc.fillColor(dark ? '#F1F0EC' : C.ink).font(F.bodyBold).fontSize(12.5).text(label, LX + 40, y - 6);
  return y + 32;
}

function headline(doc, text, x, y, w, dark, size) {
  doc.fillColor(dark ? '#F1F0EC' : C.ink).font(F.head).fontSize(size || 36);
  doc.text(text, x, y, { width: w, lineGap: 0 });
  return doc.y + 18;
}

function bodyText(doc, text, x, y, w, dark, size) {
  doc.fillColor(dark ? '#D8D6D0' : '#2B2C2E').font(F.body).fontSize(size || 16);
  doc.text(text, x, y, { width: w, lineGap: 4 });
  return doc.y;
}

function safeImage(doc, base64, x, y, w, h) {
  try {
    if (base64) {
      const buf = Buffer.from(base64, 'base64');
      doc.save();
      doc.rect(x, y, w, h).clip();
      doc.image(buf, x, y, { width: w, height: h, cover: [w, h] });
      doc.restore();
      return;
    }
  } catch (e) { /* fall through */ }
  doc.save();
  doc.rect(x, y, w, h).lineWidth(1).strokeColor(C.hairline).stroke();
  doc.fillColor(C.graphite).font(F.body).fontSize(9).text('Image unavailable', x, y + h / 2 - 5, { width: w, align: 'center' });
  doc.restore();
}

function measureRows(doc, items, width, font, size, gap) {
  doc.font(font).fontSize(size);
  let h = 0;
  items.forEach(t => { h += Math.max(doc.heightOfString(t, { width, lineGap: 3 }), size + 4) + gap; });
  return h;
}

// Numbered rows with a hairline rule between each — a document register, not a card.
function drawRegisterList(doc, items, x, y, w, size, gap, numColor) {
  doc.font(F.body).fontSize(size);
  items.forEach((t, i) => {
    const rowH = Math.max(doc.heightOfString(t, { width: w - 48, lineGap: 3 }), size + 4);
    doc.fillColor(numColor).font(F.head).fontSize(size + 3).text(String(i + 1).padStart(2, '0'), x, y);
    doc.fillColor(C.ink).font(F.body).fontSize(size).text(t, x + 48, y, { width: w - 48, lineGap: 3 });
    y += rowH + gap;
    if (i < items.length - 1) {
      doc.moveTo(x, y - gap / 2).lineTo(x + w, y - gap / 2).lineWidth(0.5).strokeColor(C.hairline).stroke();
    }
  });
  return y;
}

// Three stacked, sourced fact/stat boxes in a left column, with the image
// filling the remaining width beside them. Reused on the Reality page and
// the Warning Signs page — real, cited numbers belong next to the art, not
// floating loose in the copy.
function drawFactBoxes(doc, facts, x, y, w, h, ruleColor) {
  const gap = 12;
  const boxH = (h - gap * 2) / 3;
  facts.slice(0, 3).forEach((f, i) => {
    const by = y + i * (boxH + gap);
    doc.rect(x, by, w, boxH).lineWidth(1).strokeColor(C.hairline).stroke();
    doc.fillColor(ruleColor).font(F.head).fontSize(36).text(f.value || '', x + 14, by + 12, { width: w - 28 });
    const labelY = doc.y + 4;
    if (f.label) {
      doc.fillColor(C.ink).font(F.body).fontSize(14).text(f.label, x + 14, labelY, { width: w - 28, lineGap: 1, height: boxH - (labelY - by) - 20 });
    }
    if (f.source) {
      doc.fillColor(C.graphite).font(F.italic).fontSize(7.5).text(f.source, x + 14, by + boxH - 16, { width: w - 28 });
    }
  });
}

// ---------- per-type slide drawing ----------
function drawSlide(doc, slide, meta, pageNum, total) {
  const dark = DARK_TYPES.has(slide.type);
  background(doc, dark);
  header(doc, pageNum, total, dark, meta.author, meta.authorTitle);

  if (slide.type === 'hero') {
    let y = headline(doc, slide.headline, LX, 150, CW, true, 44);
    if (slide.body) y = bodyText(doc, slide.body, LX, y + 4, CW - 60, true) + 20;
    const imgTop = y + 10;
    const imgBottom = FOOTER_TOP - 24;
    const imgH = Math.max(imgBottom - imgTop, 60);
    safeImage(doc, slide.image_base64, LX, imgTop, CW, imgH);
  } else if (slide.type === 'reality') {
    const meta2 = SECTION_META.reality;
    let y = tabMarker(doc, meta2.tab, meta2.rule, false);
    y = headline(doc, slide.headline, LX, y, CW, false, 30);
    y = bodyText(doc, slide.body, LX, y, CW, false) + 22;
    const areaTop = y;
    const areaBottom = FOOTER_TOP - 24;
    const areaH = Math.max(areaBottom - areaTop, 60);
    if (Array.isArray(slide.facts) && slide.facts.length) {
      // Reduced, deliberately smaller image beside three cited facts —
      // the numbers carry as much weight on this page as the picture.
      const factsW = Math.round(CW * 0.36);
      const gap = 16;
      const imgW = CW - factsW - gap;
      drawFactBoxes(doc, slide.facts, LX, areaTop, factsW, areaH, meta2.rule);
      safeImage(doc, slide.image_base64, LX + factsW + gap, areaTop, imgW, areaH);
    } else {
      // No facts supplied: still show a deliberately smaller image, not a
      // full-bleed one, so this page doesn't visually compete with the hero.
      const imgH = Math.min(areaH, areaH * 0.62);
      safeImage(doc, slide.image_base64, LX, areaTop, CW, imgH);
    }
  } else if (slide.type === 'list') {
    const meta2 = resolveListTab(slide);
    let y = tabMarker(doc, meta2.tab, meta2.rule, false);
    y = headline(doc, slide.headline, LX, y, CW, false, 28);
    y += 8;
    doc.rect(LX, y, CW, 1).fill(meta2.rule);
    y += 20;
    y = drawRegisterList(doc, slide.list_items, LX, y, CW, 14, 18, meta2.rule);
    const areaTop = y + 12;
    const areaBottom = FOOTER_TOP - 24;
    const areaH = Math.max(areaBottom - areaTop, 60);
    if (Array.isArray(slide.facts) && slide.facts.length) {
      // Three cited facts stacked on the left, image filling the rest.
      const factsW = Math.round(CW * 0.34);
      const gap = 16;
      const imgW = CW - factsW - gap;
      drawFactBoxes(doc, slide.facts, LX, areaTop, factsW, areaH, meta2.rule);
      safeImage(doc, slide.image_base64, LX + factsW + gap, areaTop, imgW, areaH);
    } else {
      safeImage(doc, slide.image_base64, LX, areaTop, CW, areaH);
    }
  } else if (slide.type === 'cta') {
    let y = headline(doc, slide.headline, LX, 165, CW - 40, true, 35);
    y = bodyText(doc, slide.body, LX, y + 4, CW - 60, true, 16) + 16;
    if (Array.isArray(slide.takeaway_points) && slide.takeaway_points.length) {
      doc.font(F.body).fontSize(14);
      slide.takeaway_points.forEach(pt => {
        const rowH = doc.heightOfString(pt, { width: CW - 80, lineGap: 3 });
        doc.fillColor('#F1F0EC').text('\u2013', LX, y);
        doc.fillColor('#D8D6D0').font(F.body).fontSize(14).text(pt, LX + 18, y, { width: CW - 80, lineGap: 3 });
        y += Math.max(rowH, 18) + 10;
      });
      y += 8;
    }
    const hasAdvice = !!slide.advice_text;
    const adviceH = hasAdvice ? 96 : 0;
    const adviceGap = hasAdvice ? 16 : 0;
    const imgTop = y;
    const imgBottom = FOOTER_TOP - 24 - adviceH - adviceGap;
    const imgH = Math.max(imgBottom - imgTop, 60);
    safeImage(doc, slide.image_base64, LX, imgTop, CW, imgH);
    if (hasAdvice) {
      const boxY = imgTop + imgH + adviceGap;
      doc.rect(LX, boxY, CW, adviceH).lineWidth(1).strokeColor('#3A3B3D').stroke();
      doc.fillColor('#8FBF9F').font(F.bodyBold).fontSize(10.5).text((slide.advice_label || 'Try this today').toUpperCase(), LX + 18, boxY + 14, { width: CW - 36 });
      doc.fillColor('#F1F0EC').font(F.body).fontSize(13).text(slide.advice_text, LX + 18, boxY + 34, { width: CW - 36, lineGap: 2 });
    }
  } else {
    doc.fillColor(dark ? '#F1F0EC' : C.ink).font(F.head).fontSize(22).text(slide.headline || '(untitled)', LX, 160, { width: CW });
  }

  footer(doc, dark, meta.topic);
}

// ---------- server ----------
app.get('/health', (_req, res) => res.status(200).send('ok'));

app.post('/render', (req, res) => {
  if (req.header('X-API-Key') !== process.env.RENDERER_API_KEY) {
    return res.status(401).json({ detail: 'Invalid API key.' });
  }

  const spec = req.body;
  const errors = validateSpec(spec);
  if (errors.length) {
    return res.status(422).json({ detail: { validation_errors: errors } });
  }

  let doc;
  try {
    doc = new PDFDocument({ size: [PAGE.width, PAGE.height], margin: 0 });
    registerFonts(doc);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${spec.title.replace(/[^a-z0-9]+/gi, '_')}.pdf"`);
    doc.pipe(res);
    const meta = {
      topic: spec.title,
      author: spec.author || DEFAULT_AUTHOR,
      authorTitle: spec.authorTitle || DEFAULT_AUTHOR_TITLE,
    };
    spec.slides.forEach((slide, i) => {
      if (i > 0) doc.addPage({ size: [PAGE.width, PAGE.height], margin: 0 });
      drawSlide(doc, slide, meta, i + 1, spec.slides.length);
    });
    doc.end();
  } catch (e) {
    // Log the real cause — this is what actually tells us what broke.
    console.error('Render error:', e && e.stack || e);
    // Stop the half-built PDF stream from writing into a response we're
    // about to end differently, which previously crashed the whole process
    // with an unhandled "write after end" error.
    if (doc) {
      try { doc.unpipe(res); } catch (_) { /* ignore */ }
      try { doc.destroy(); } catch (_) { /* ignore */ }
    }
    if (!res.headersSent) {
      res.status(500).json({ detail: `Render failed: ${e.message}` });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Management.974 renderer listening on ${port}`));
