#!/usr/bin/env node
// Google Calendar 用の refresh token を一度だけ取得するスクリプト。
// 手順の全体は docs/GCAL_SETUP.md を参照。
//
//   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/get-google-refresh-token.mjs
//
// ローカルで手動実行する前提なので、Worker 側にも npm scripts にも組み込まない。

import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

// Desktop app タイプのクライアントはループバックなら任意のポートを使えるが、
// 万一 Web application タイプで作った場合に登録すべき URI を一意にするため固定する。
const PORT = 8976;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;

// events スコープだけで、購読カレンダー(日本の祝日)も含めた読み書きができる。
// カレンダー一覧 API は使わないので calendarlist スコープは要求しない。
const SCOPE = 'https://www.googleapis.com/auth/calendar.events';

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(
    'GOOGLE_CLIENT_ID と GOOGLE_CLIENT_SECRET を環境変数で渡してください。',
  );
  process.exit(1);
}

const base64url = (buf) => buf.toString('base64url');
const verifier = base64url(randomBytes(32));
const challenge = base64url(createHash('sha256').update(verifier).digest());
const state = base64url(randomBytes(16));

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: REDIRECT_URI,
  response_type: 'code',
  scope: SCOPE,
  // この2つが揃って初めて refresh_token が返る。access_type だけでは返らない。
  access_type: 'offline',
  prompt: 'consent',
  code_challenge: challenge,
  code_challenge_method: 'S256',
  state,
}).toString();

/** 受け取った認可コードを refresh token に交換する。 */
async function exchange(code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
    }),
  });
  const body = await res.json();
  if (!res.ok)
    throw new Error(`token endpoint ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname !== '/callback') {
    res.writeHead(404).end();
    return;
  }

  const finish = (status, message) => {
    res
      .writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
      .end(message);
    server.close();
  };

  const error = url.searchParams.get('error');
  if (error) {
    console.error(`\n認可が拒否されました: ${error}`);
    finish(400, `認可が拒否されました: ${error}`);
    process.exitCode = 1;
    return;
  }

  // state を検証しないと、別タブで始まった認可の結果を掴まされうる。
  if (url.searchParams.get('state') !== state) {
    console.error('\nstate が一致しません。中断します。');
    finish(400, 'state mismatch');
    process.exitCode = 1;
    return;
  }

  try {
    const token = await exchange(url.searchParams.get('code'));
    if (!token.refresh_token) {
      // 同じクライアントで再認可すると Google は refresh_token を省くことがある。
      // その場合は https://myaccount.google.com/permissions でアクセス権を削除してやり直す。
      throw new Error(
        'refresh_token が返りませんでした。myaccount.google.com/permissions でこのアプリのアクセス権を削除してから再実行してください。',
      );
    }
    console.log('\n=== refresh token ===');
    console.log(token.refresh_token);
    console.log('\n次のコマンドで Worker に登録してください:');
    console.log('  npx wrangler secret put GOOGLE_REFRESH_TOKEN');
    finish(200, '取得できました。ターミナルに戻ってください。');
  } catch (err) {
    console.error(`\n${err.message}`);
    finish(500, String(err.message));
    process.exitCode = 1;
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(
    '次の URL をブラウザで開いて、自分の Google アカウントで承認してください:\n',
  );
  console.log(authUrl.toString());
  console.log('\n承認を待っています...');
});
