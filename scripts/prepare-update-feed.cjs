const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yaml = require('js-yaml');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const metadata = require(path.join(root, 'package.json'));
const directory = path.resolve(root, process.argv[2] || 'build');
const feedFile = path.join(directory, 'latest.yml');
const feed = yaml.load(fs.readFileSync(feedFile, 'utf8'));
assert.equal(feed.version, metadata.version);
const installer = feed.files.find(
    (file) => typeof file.url === 'string' && /^soundcloud-[\d.]+-installer-win\.exe$/.test(file.url),
);
assert(installer, 'Expected Windows installer in the update feed');
const data = fs.readFileSync(path.join(directory, installer.url));
assert.equal(installer.size, data.length);
assert.equal(installer.sha512, crypto.createHash('sha512').update(data).digest('base64'));
feed.workerProtocolRevision = metadata.workerProtocolRevision;
fs.writeFileSync(feedFile, yaml.dump(feed, { lineWidth: 120, noRefs: true }));
console.log(
    JSON.stringify({
        version: feed.version,
        installer: installer.url,
        sha512Verified: true,
        workerProtocolRevision: feed.workerProtocolRevision,
    }),
);
