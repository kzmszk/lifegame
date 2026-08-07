import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const indexUrl = new URL('../web/index.html', import.meta.url);
const manifestUrl = new URL('../web/public/manifest.json', import.meta.url);

async function pngDimensions(url) {
  const image = await readFile(url);
  assert.deepEqual(
    [...image.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
    `${url.pathname} は PNG ではありません`,
  );
  return {
    width: image.readUInt32BE(16),
    height: image.readUInt32BE(20),
  };
}

test('認証済み Android Chrome が共有先対応 PWA をインストールできる', async () => {
  const index = await readFile(indexUrl, 'utf8');
  assert.match(
    index,
    /<link\s+rel="manifest"\s+href="\/manifest\.json"\s+crossorigin="use-credentials"\s*\/?>/,
  );

  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
  assert.deepEqual(manifest.share_target, {
    action: '/reading/share',
    method: 'GET',
    params: { title: 'title', text: 'text', url: 'url' },
  });

  for (const size of [192, 512]) {
    const icon = manifest.icons.find(
      (candidate) => candidate.sizes === `${size}x${size}`,
    );
    assert.ok(icon, `${size}x${size} のアイコンがありません`);
    assert.equal(icon.type, 'image/png');
    assert.deepEqual(
      await pngDimensions(new URL(`../web/public${icon.src}`, import.meta.url)),
      { width: size, height: size },
    );
  }
});
