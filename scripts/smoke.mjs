#!/usr/bin/env node
// デプロイ後の外形チェック。Cloudflare Access の設定が生きているかを、未認証のまま
// 到達できる範囲だけで確認する。
//
//   npm run smoke                              # 本番
//   npm run smoke -- https://example.workers.dev
//
// JWT 検証の成否までは見えない(未認証だと Access が Worker の手前で止めるため、
// ACCESS_AUD が違っていても同じ 302 が返る)。そこはブラウザで開いて確かめる。
// 検証ロジック自体は src/routes/api.test.ts のユニットテストが押さえている。

const baseUrl = (process.argv[2] ?? 'https://lifegame.tachicoma.com').replace(
  /\/$/,
  '',
);

const checks = [
  { path: '/', expect: 302, why: 'SPA は Access の内側' },
  { path: '/api/tasks', expect: 302, why: 'API も Access の内側' },
  { path: '/mcp', expect: 401, why: 'Bypass 済み。認証は MCP の OAuth が持つ' },
  {
    path: '/.well-known/oauth-authorization-server',
    expect: 200,
    why: 'Bypass 済み。ここが 302 だと OAuth 探索が始まらない',
  },
  { path: '/register', expect: 405, why: 'Bypass 済み。DCR は POST のみ' },
  {
    path: '/csp-report',
    method: 'POST',
    expect: 204,
    why: 'Bypass 済み。違反レポートの受け口',
  },
  { path: '/csp-report', expect: 405, why: 'GET は受け付けない' },
];

/** リダイレクトを追うと Access のログイン画面の 200 を拾ってしまう。 */
async function status(path, method) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    redirect: 'manual',
  });
  return response;
}

let failures = 0;

for (const check of checks) {
  const method = check.method ?? 'GET';
  const label = `${method} ${check.path}`;
  try {
    const response = await status(check.path, method);
    const ok = response.status === check.expect;
    if (!ok) failures += 1;
    console.log(
      `${ok ? '✓' : '✗'} ${label.padEnd(44)} ${response.status} (期待 ${check.expect}) — ${check.why}`,
    );
  } catch (error) {
    failures += 1;
    console.log(`✗ ${label.padEnd(44)} 到達できません — ${String(error)}`);
  }
}

// Access ではなくデプロイ内容の確認。広告するスコープが古いと、探索で繋ぐ
// クライアントが calendar:read を要求できず、カレンダーが見えないままになる。
try {
  const metadata = await (
    await status('/.well-known/oauth-authorization-server', 'GET')
  ).json();
  const scopes = metadata.scopes_supported ?? [];
  const missing = ['tasks:read', 'tasks:write', 'calendar:read'].filter(
    (scope) => !scopes.includes(scope),
  );
  if (missing.length > 0) {
    failures += 1;
    console.log(`✗ scopes_supported に不足: ${missing.join(', ')}`);
  } else {
    console.log(`✓ scopes_supported ${JSON.stringify(scopes)}`);
  }
} catch (error) {
  failures += 1;
  console.log(`✗ OAuth メタデータを読めません — ${String(error)}`);
}

console.log(
  failures === 0
    ? `\n${baseUrl} は期待どおりです。`
    : `\n${failures} 件が期待と違います。`,
);
process.exit(failures === 0 ? 0 : 1);
