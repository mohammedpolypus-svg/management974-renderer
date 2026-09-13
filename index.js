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

const FONT_DIR = path.join(__dirname, 'fonts');
const F = {
  head: 'PlexCondBold',
  body: 'PlexSans',
  bodyBold: 'PlexSansBold',
  italic: 'PlexSansItalic',
};

function registerFonts(doc) {
  doc.registerFont(F.head, path.join(FONT_DIR, 'PlexSansCondensed-Bold.ttf'));
  doc.registerFont(F.body, path.join(FONT_DIR, 'PlexSans-Regular.ttf'));
  doc.registerFont(F.bodyBold, path.join(FONT_DIR, 'PlexSans-Bold.ttf'));
  doc.registerFont(F.italic, path.join(FONT_DIR, 'PlexSans-Italic.ttf'));
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
  doc.fillColor(fg).font(F.bodyBold).fontSize(12).text(author, LX, 40);
  doc.fillColor(sub).font(F.body).fontSize(9.5).text(authorTitle, LX, 57);
  doc.fillColor(sub).font(F.body).fontSize(9.5).text(`Brief ${pageNum} of ${total}`, PAGE.width - 156, 40, { width: 100, align: 'right' });
  doc.moveTo(LX, 82).lineTo(PAGE.width - LX, 82).lineWidth(0.75).strokeColor(dark ? '#333436' : C.hairline).stroke();
}

function footer(doc, dark, title) {
  const y = FOOTER_TOP;
  doc.moveTo(LX, y).lineTo(PAGE.width - LX, y).lineWidth(0.75).strokeColor(dark ? '#333436' : C.hairline).stroke();
  doc.fillColor(dark ? C.onDarkSub : C.graphite).font(F.body).fontSize(8.5).text(title, LX, y + 12, { width: CW - 140 });
  doc.fillColor(dark ? C.onDarkSub : C.graphite).font(F.body).fontSize(8.5).text('management.974', PAGE.width - 176, y + 12, { width: 120, align: 'right' });
}

// Left-edge tab marker in place of an ALL-CAPS eyebrow: a small filled rule
// plus a sentence-case label, like a folder tab on a case file.
function tabMarker(doc, label, ruleColor, dark) {
  const y = 108;
  doc.rect(LX, y, 28, 4).fill(ruleColor || (dark ? '#F1F0EC' : C.ink));
  doc.fillColor(dark ? '#F1F0EC' : C.ink).font(F.bodyBold).fontSize(11).text(label, LX + 38, y - 5);
  return y + 30;
}

function headline(doc, text, x, y, w, dark, size) {
  doc.fillColor(dark ? '#F1F0EC' : C.ink).font(F.head).fontSize(size || 34);
  doc.text(text, x, y, { width: w, lineGap: 0 });
  return doc.y + 18;
}

function bodyText(doc, text, x, y, w, dark, size) {
  doc.fillColor(dark ? '#D8D6D0' : '#2B2C2E').font(F.body).fontSize(size || 14.5);
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
    const rowH = Math.max(doc.heightOfString(t, { width: w - 44, lineGap: 3 }), size + 4);
    doc.fillColor(numColor).font(F.head).fontSize(size + 2).text(String(i + 1).padStart(2, '0'), x, y);
    doc.fillColor(C.ink).font(F.body).fontSize(size).text(t, x + 44, y, { width: w - 44, lineGap: 3 });
    y += rowH + gap;
    if (i < items.length - 1) {
      doc.moveTo(x, y - gap / 2).lineTo(x + w, y - gap / 2).lineWidth(0.5).strokeColor(C.hairline).stroke();
    }
  });
  return y;
}

// ---------- per-type slide drawing ----------
function drawSlide(doc, slide, meta, pageNum, total) {
  const dark = DARK_TYPES.has(slide.type);
  background(doc, dark);
  header(doc, pageNum, total, dark, meta.author, meta.authorTitle);

  if (slide.type === 'hero') {
    let y = headline(doc, slide.headline, LX, 150, CW, true, 40);
    if (slide.body) y = bodyText(doc, slide.body, LX, y + 4, CW - 60, true) + 20;
    const imgTop = y + 10;
    const imgBottom = FOOTER_TOP - 24;
    const imgH = Math.max(imgBottom - imgTop, 60);
    safeImage(doc, slide.image_base64, LX, imgTop, CW, imgH);
  } else if (slide.type === 'reality') {
    const meta2 = SECTION_META.reality;
    let y = tabMarker(doc, meta2.tab, meta2.rule, false);
    y = headline(doc, slide.headline, LX, y, CW, false, 28);
    y = bodyText(doc, slide.body, LX, y, CW, false) + 20;
    const imgTop = y;
    const imgBottom = FOOTER_TOP - 24;
    const imgH = Math.max(imgBottom - imgTop, 60);
    safeImage(doc, slide.image_base64, LX, imgTop, CW, imgH);
  } else if (slide.type === 'list') {
    const meta2 = resolveListTab(slide);
    let y = tabMarker(doc, meta2.tab, meta2.rule, false);
    y = headline(doc, slide.headline, LX, y, CW, false, 26);
    y += 8;
    doc.rect(LX, y, CW, 1).fill(meta2.rule);
    y += 20;
    const listH = measureRows(doc, slide.list_items, CW - 44, F.body, 12.5, 18);
    y = drawRegisterList(doc, slide.list_items, LX, y, CW, 12.5, 18, meta2.rule);
    const imgTop = y + 12;
    const imgBottom = FOOTER_TOP - 24;
    const imgH = Math.max(imgBottom - imgTop, 60);
    safeImage(doc, slide.image_base64, LX, imgTop, CW, imgH);
  } else if (slide.type === 'cta') {
    let y = headline(doc, slide.headline, LX, 170, CW - 40, true, 32);
    y = bodyText(doc, slide.body, LX, y + 4, CW - 60, true) + 24;
    if (slide.link_text) {
      doc.rect(LX, y, CW - 60, 1).fill('#F1F0EC');
      y += 16;
      doc.fillColor('#F1F0EC').font(F.bodyBold).fontSize(13.5).text(slide.link_text, LX, y, { width: CW - 60, lineGap: 3 });
      y = doc.y + 20;
    }
    const imgTop = y;
    const imgBottom = FOOTER_TOP - 24;
    const imgH = Math.max(imgBottom - imgTop, 60);
    safeImage(doc, slide.image_base64, LX, imgTop, CW, imgH);
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

  try {
    const doc = new PDFDocument({ size: [PAGE.width, PAGE.height], margin: 0 });
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
    res.status(500).json({ detail: `Render failed: ${e.message}` });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Management.974 renderer listening on ${port}`));
