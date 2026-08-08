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
  { path: '/health', expect: 302, why: '健康画面も Access の内側' },
  { path: '/reading', expect: 302, why: '読む画面も Access の内側' },
  { path: '/api/tasks', expect: 302, why: 'API も Access の内側' },
  {
    path: '/api/health-entries',
    expect: 302,
    why: '健康 API も Access の内側',
  },
  {
    path: '/api/saved-links',
    expect: 302,
    why: '保存リンク API も Access の内側',
  },
  { path: '/mcp', expect: 401, why: 'Bypass 済み。認証は MCP の OAuth が持つ' },
  {
    path: '/.well-known/oauth-authorization-server',
    expect: 200,
    why: 'Bypass 済み。ここが 302 だと OAuth 探索が始まらない',
  },
  { path: '/register', expect: 405, why: 'Bypass 済み。DCR は POST のみ' },
  {
    // 中身が空なので 400 が返る。302 でなければ Worker に届いている証拠。
    // ここが Access に吸われると、クライアントはコード交換も refresh もできない。
    path: '/token',
    method: 'POST',
    expect: 400,
    why: 'Bypass 済み。OAuth のコード交換と refresh の入口',
  },
  {
    // Bypass に入れてはいけない唯一のパス。クライアント登録は誰でもできるが、
    // 認可を承認できるのは Access を通った自分だけ、という設計の要になっている。
    path: '/authorize',
    expect: 302,
    why: 'Access の内側のまま。ここが 400 なら誰でも承認できる',
  },
  {
    path: '/csp-report',
    method: 'POST',
    expect: 204,
    why: 'Bypass 済み。違反レポートの受け口',
  },
  { path: '/csp-report', expect: 405, why: 'GET は受け付けない' },
  {
    // Play とHealth Connect の権限画面から未認証で開ける必要がある唯一のページ。
    // not_found_handling が SPA なので、asset が消えていても 200 で SPA shell が
    // 返る。ステータスだけでは検出できないため本文の見出しまで確認する。
    path: '/privacy',
    expect: 200,
    contains: 'Health Connect から読み取るデータと利用目的',
    why: 'Bypass 済み。ここが 302 だと Play 審査と権限画面の導線が同時に壊れる',
  },
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
    const statusOk = response.status === check.expect;
    const bodyOk =
      !check.contains ||
      (statusOk && (await response.text()).includes(check.contains));
    const ok = statusOk && bodyOk;
    if (!ok) failures += 1;
    // 本文の確認は status が期待どおりのときだけ意味がある。302 のときに
    // 「本文がない」と出すと、Bypass 未設定を asset の欠落と読み違える。
    const detail = !statusOk
      ? `${response.status} (期待 ${check.expect})`
      : bodyOk
        ? `${response.status} (期待 ${check.expect})`
        : `200 だが本文に「${check.contains}」がない`;
    console.log(
      `${ok ? '✓' : '✗'} ${label.padEnd(44)} ${detail} — ${check.why}`,
    );
  } catch (error) {
    failures += 1;
    console.log(`✗ ${label.padEnd(44)} 到達できません — ${String(error)}`);
  }
}

// MCP クライアントは authorization-server より先に protected-resource の文書を読む。
// その場所は /mcp の 401 が WWW-Authenticate で名指しするので、パスを決め打ちせず
// 広告されたとおりに辿る。決め打ちだと、/.well-known/* の Bypass が1パスだけに
// 狭められた場合に、こちらは通るのにクライアントは探索の入口で止まる。
async function checkDiscovery() {
  const challenge = (await status('/mcp', 'GET')).headers.get(
    'www-authenticate',
  );
  const advertised = challenge?.match(/resource_metadata="([^"]+)"/)?.[1];
  if (!advertised) {
    failures += 1;
    console.log('✗ /mcp が resource_metadata を広告していません');
    return;
  }
  // ヘッダーの値をそのまま取りに行く前に、自分のホストであることを確かめる。
  if (!advertised.startsWith(`${baseUrl}/`)) {
    failures += 1;
    console.log(`✗ resource_metadata が別ホストを指しています: ${advertised}`);
    return;
  }

  const response = await fetch(advertised, { redirect: 'manual' });
  if (response.status !== 200) {
    failures += 1;
    console.log(
      `✗ ${advertised.slice(baseUrl.length)} ${response.status} (期待 200) — 探索の入口が Access に吸われている`,
    );
    return;
  }
  console.log(
    `✓ ${advertised.slice(baseUrl.length).padEnd(44)} 200 (期待 200) — Bypass 済み。探索はここから始まる`,
  );
  return response.json();
}

// Access ではなくデプロイ内容の確認。広告するスコープが古いと、探索で繋ぐ
// クライアントが calendar:read を要求できず、カレンダーが見えないままになる。
function checkScopes(label, scopes) {
  const missing = ['tasks:read', 'tasks:write', 'calendar:read'].filter(
    (scope) => !(scopes ?? []).includes(scope),
  );
  if (missing.length > 0) {
    failures += 1;
    console.log(`✗ ${label} の scopes_supported に不足: ${missing.join(', ')}`);
    return;
  }
  console.log(`✓ ${label} の scopes_supported ${JSON.stringify(scopes)}`);
}

try {
  const resource = await checkDiscovery();
  if (resource) checkScopes('protected-resource', resource.scopes_supported);
  const server = await (
    await status('/.well-known/oauth-authorization-server', 'GET')
  ).json();
  checkScopes('authorization-server', server.scopes_supported);
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
