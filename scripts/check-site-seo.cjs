const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runInNewContext } = require('node:vm');
const directory = path.resolve(__dirname, '../docs');
const base = 'https://rvelabs.github.io/soundcloud-rpc/';
const read = (name) => fs.readFileSync(path.join(directory, name), 'utf8');
const html = read('index.html');
const attributes = (tag) => Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
const metas = [...html.matchAll(/<meta\s[^>]+>/g)].map((m) => attributes(m[0]));
const meta = (key) => {
    const found = metas.filter((m) => (m.name || m.property) === key);
    assert.equal(found.length, 1, `Expected exactly one ${key}`);
    return found[0].content;
};
const title = html.match(/<title>([^<]+)<\/title>/)[1];
assert(title.length <= 60);
assert(meta('description').length <= 160);
assert.equal(meta('og:title'), title);
assert.equal(meta('twitter:title'), title);
assert.equal(meta('og:description'), meta('description'));
assert.equal(meta('twitter:description'), meta('description'));
assert.equal(meta('og:url'), base);
assert.equal(meta('og:type'), 'website');
assert.equal(meta('og:image'), base + 'og-banner.png');
assert.equal(meta('twitter:image'), meta('og:image'));
assert.equal(meta('twitter:card'), 'summary_large_image');
assert(meta('og:image:alt').length > 20);
assert(!meta('robots').includes('noindex'));
const links = [...html.matchAll(/<link\s[^>]+>/g)].map((m) => attributes(m[0]));
assert.deepEqual(
    links.filter((l) => l.rel === 'canonical').map((l) => l.href),
    [base],
);
assert(links.some((l) => l.rel === 'sitemap' && l.href === base + 'sitemap.xml'));
const headings = [...html.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
assert.equal(headings.filter((level) => level === 1).length, 1);
assert.equal(headings[0], 1);
headings.forEach((level, index) => assert(index === 0 || level <= headings[index - 1] + 1, 'Skipped heading level'));
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
assert.equal(new Set(ids).size, ids.length, 'Duplicate HTML IDs');
for (const [, href] of html.matchAll(/(?:href|src)="([^"#]+)"/g)) {
    if (!href.startsWith('./')) continue;
    assert(fs.existsSync(path.join(directory, href.split('?')[0])), `Missing asset: ${href}`);
}
for (const [, id] of html.matchAll(/href="#([^"]+)"/g)) assert(ids.includes(id), `Missing fragment: ${id}`);
const schemaSource = html.match(/<script type="application\/ld\+json" id="software-schema">([\s\S]*?)<\/script>/)[1];
const schema = JSON.parse(schemaSource);
assert.equal(schema['@type'], 'SoftwareApplication');
assert.equal(schema.url, base);
assert.equal(schema.image, meta('og:image'));
assert.equal(schema.description, meta('description'));
const image = fs.readFileSync(path.join(directory, 'og-banner.png'));
assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
assert.equal(image.readUInt32BE(16), 1200);
assert.equal(image.readUInt32BE(20), 630);
assert(read('robots.txt').includes('User-agent: *\nAllow: /'));
assert(read('robots.txt').includes('Sitemap: ' + base + 'sitemap.xml'));
const sitemap = read('sitemap.xml');
assert.deepEqual(
    [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]),
    [base],
);
assert.match(sitemap, /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
assert(sitemap.includes('<changefreq>weekly</changefreq>') && sitemap.includes('<priority>1.0</priority>'));
for (const name of ['google-verification.html', 'yandex-verification.html'])
    assert.equal(read(name).trim(), '<!-- Сюда ИИ или пользователь вставит код верификации по запросу -->');
const code = read('site.js');
const seoSource = code.match(/const seo = (\{[\s\S]*?\n    \});/)[1];
const seo = runInNewContext('(' + seoSource + ')');
for (const language of ['ru', 'en']) {
    assert(seo[language].title.length <= 60);
    assert(seo[language].description.length <= 160);
    const apply = code
        .match(/const metadata = seo\[language\];([\s\S]*?)\n        updateSource\(\);/)[0]
        .replace(/\n        updateSource\(\);$/, '');
    const values = new Map();
    const document = {
        querySelector: (selector) => ({ setAttribute: (_, value) => values.set(selector, value) }),
        getElementById: () => ({ textContent: schemaSource }),
    };
    runInNewContext(apply, { seo, language, document });
    assert.equal(document.title, seo[language].title);
    assert.equal(values.get('meta[name="description"]'), seo[language].description);
    assert.equal(values.get('meta[property="og:title"]'), document.title);
    assert.equal(values.get('meta[property="og:locale"]'), seo[language].locale);
}
console.log(
    JSON.stringify({
        pages: [base],
        h1: 1,
        languages: ['ru', 'en'],
        ogImage: '1200x630',
        titleLength: title.length,
        descriptionLength: meta('description').length,
        success: true,
    }),
);
