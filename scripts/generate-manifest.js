#!/usr/bin/env node
/**
 * documents/ ফোল্ডার রিকার্সিভলি স্ক্যান করে manifest.json বানায়।
 * প্রতিটা ফোল্ডারের path কী (key) হিসেবে ব্যবহার হয়, ভ্যালু হলো সেই
 * ফোল্ডারের ভিতরের ফোল্ডার+ফাইলের তালিকা (অ্যাপের _ghDocsLoad যা আশা করে)।
 *
 * ফাইলের download_url সরাসরি jsDelivr CDN লিংক হিসেবে বসানো হয়, তাই
 * অ্যাপকে GitHub API বা কোনো টোকেন ছোঁয়া লাগে না।
 *
 * ⭐ পরিবর্তন (অফলাইন-cache আপডেট ঠিক রাখতে):
 *   ১. `sha` এখন ফাইলের কনটেন্ট + path থেকে তৈরি — ফাইল আপডেট হলে বদলায়,
 *      অ্যাপ এটা cache key হিসেবে ব্যবহার করে (আগে শুধু path-এর hash ছিল, তাই
 *      কনটেন্ট বদলালেও একই থাকত)।
 *   ২. `download_url` এখন ফাইলটা শেষবার যে commit-এ বদলেছে সেই commit-এ pin করা
 *      (jsDelivr @<commit>) — branch (@main) cache-এর ১২ ঘণ্টার দেরি এড়াতে।
 *      git history না পেলে (shallow clone) আগের মতো @BRANCH-এ ফিরে যায়।
 *
 * ⚠ GitHub Action-এ checkout ধাপে `fetch-depth: 0` দিতে হবে (নিচে দেখুন)।
 *
 * ব্যবহার: node scripts/generate-manifest.js
 * (GitHub Action থেকে অটোমেটিক চলে — ম্যানুয়ালি চালানোর দরকার নেই)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const DOCS_ROOT = 'documents'; // অ্যাপের GH_DOCS_ROOT-এর সাথে মিলতে হবে
const OWNER = process.env.GH_DOCS_OWNER || 'raihan-compliance';
const REPO = process.env.GH_DOCS_REPO || 'labourlawappdocs';
const BRANCH = process.env.GH_DOCS_BRANCH || 'main';

// ফাইলটা শেষবার যে commit-এ বদলেছে তার hash। পাওয়া না গেলে null।
let gitAvailable = true;
function lastCommitFor(relPath) {
  if (!gitAvailable) return null;
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%H', '--', relPath], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^[0-9a-f]{40}$/.test(out) ? out : null;
  } catch (e) {
    gitAvailable = false; // git নেই বা রিপো নয় — বাকিদের জন্য আর চেষ্টা করবে না
    return null;
  }
}

function cdnUrl(relPath) {
  const encoded = relPath.split('/').map(encodeURIComponent).join('/');
  const ref = lastCommitFor(relPath) || BRANCH;
  return `https://cdn.jsdelivr.net/gh/${OWNER}/${REPO}@${ref}/${encoded}`;
}

// path + কনটেন্ট থেকে ১২ অক্ষরের hash: প্রতিটা path-এ ইউনিক (DOM id-এর জন্য),
// আর কনটেন্ট বদলালে বদলে যায় (অ্যাপের cache key-এর জন্য)।
function shaFor(relPath, absPath) {
  return crypto
    .createHash('md5')
    .update(relPath)
    .update('\0')
    .update(fs.readFileSync(absPath))
    .digest('hex')
    .slice(0, 12);
}

function scanDir(absDir, relDir, manifest) {
  const entries = fs.readdirSync(absDir, { withFileTypes: true });
  const items = [];

  entries
    .filter((e) => e.name !== '.gitkeep' && !e.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name, 'bn'))
    .forEach((entry) => {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      const absPath = path.join(absDir, entry.name);

      if (entry.isDirectory()) {
        items.push({
          name: entry.name,
          path: relPath,
          type: 'dir',
        });
        scanDir(absPath, relPath, manifest); // সাব-ফোল্ডার রিকার্সিভলি
      } else if (entry.isFile()) {
        const stat = fs.statSync(absPath);
        items.push({
          name: entry.name,
          path: relPath,
          type: 'file',
          size: stat.size,
          sha: shaFor(relPath, absPath),
          download_url: cdnUrl(relPath),
        });
      }
    });

  // dir আগে, তারপর file (অ্যাপের রেন্ডারিং যেমন আশা করে)
  items.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, 'bn');
  });

  manifest[relDir || DOCS_ROOT] = items;
}

function main() {
  const docsAbs = path.join(REPO_ROOT, DOCS_ROOT);
  const manifest = {};

  if (!fs.existsSync(docsAbs)) {
    console.error(`"${DOCS_ROOT}" ফোল্ডার খুঁজে পাওয়া যায়নি: ${docsAbs}`);
    process.exit(1);
  }

  scanDir(docsAbs, DOCS_ROOT, manifest);

  const outPath = path.join(REPO_ROOT, 'manifest.json');
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

  const folderCount = Object.keys(manifest).length;
  const fileCount = Object.values(manifest).flat().filter((i) => i.type === 'file').length;
  console.log(`manifest.json তৈরি হয়েছে — ${folderCount}টা ফোল্ডার, ${fileCount}টা ফাইল।`);
  if (!gitAvailable) {
    console.warn('⚠ git history পাওয়া যায়নি — download_url @' + BRANCH + '-এ থাকল (fetch-depth: 0 দিন)।');
  }
}

main();
