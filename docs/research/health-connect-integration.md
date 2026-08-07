# Health Connect 連携調査

調査日: 2026-08-07

## 結論

連携は可能。ただし、現在の React Web アプリ/PWA だけでは Health Connect を直接読めない。Health Connect は Android 端末上のストアであり、公式クライアントは Android の `Context` から IPC で接続する Jetpack API である。Health Connect 自体も Android/Google Play 専用であるため、ブラウザに同等の Web API はない。[HealthConnectClient](https://developer.android.com/reference/androidx/health/connect/client/HealthConnectClient) [対応端末](https://developer.android.com/health-and-fitness/health-connect/availability)

したがって、lifegame には次の構成が適する。

1. 小さな Android companion アプリが端末上で Health Connect の権限を得る。
2. companion が体重・運動・睡眠を読み、lifegame Worker の専用 API へ HTTPS で同期する。
3. Worker/D1 が正規化した値と同期元 ID を保持し、既存の `/health` で表示する。

WebView で既存 UI を包む案でも、Health Connect 部分にはネイティブ Kotlin コードと JavaScript bridge が必要になるため、結局は Android アプリである。最初は既存 Web UI と分離した「同期専用 companion」にする方が境界が明確で小さい。

## ブラウザ/PWAから直接アクセスできるか

できない。これは公式文書の次の事実からの判断である。

- Health Connect は Android/Google Play 専用で、Android 9（API 28）以上かつ Google Play services のあるモバイル端末を必要とする。Android 14 以上ではシステムモジュール、Android 13 以下では Play Store の Health Connect アプリとして提供される。[対応端末](https://developer.android.com/health-and-fitness/health-connect/availability)
- アプリは `androidx.health.connect:connect-client` を組み込み、`HealthConnectClient.getOrCreate(context)` で Android の `Context` から「IPC-backed client」を取得する。[開始ガイド](https://developer.android.com/health-and-fitness/health-connect/get-started) [API reference](https://developer.android.com/reference/androidx/health/connect/client/HealthConnectClient)
- 権限要求は Android manifest と Android Activity Result Contract を使って Health Connect の権限画面を表示する。[開始ガイド](https://developer.android.com/health-and-fitness/health-connect/get-started)

つまり、通常の Web Fetch、PWA、ブラウザ拡張だけでは Android の IPC と Health Connect 権限フローに到達できない。Cloudflare Worker から端末上の Health Connect を直接読むこともできない。

## ネイティブ Android 側の要件

- Kotlin/Android アプリに Health Connect Jetpack SDK を追加する。SDK 自体は API 26 以上をサポートするが、Health Connect の利用可能端末は API 28 以上。[開始ガイド](https://developer.android.com/health-and-fitness/health-connect/get-started)
- Android 13 以下では `com.google.android.apps.healthdata` のインストール/更新状態を、Android 14 以上ではシステム側の機能状態を確認する。機能ごとに `getFeatureStatus()` も確認する。[開始ガイド](https://developer.android.com/health-and-fitness/health-connect/get-started)
- 必要なデータ型ごとの read permission を manifest に宣言し、実行時にもユーザーへ要求する。権限はいつでも取り消せるため、利用のたびに確認して `SecurityException` を扱う。[開始ガイド](https://developer.android.com/health-and-fitness/health-connect/get-started)
- 権限画面のプライバシーポリシーから開く rationale Activity を実装する。Android 13 以下用の `ACTION_SHOW_PERMISSIONS_RATIONALE` と Android 14 以上用の `VIEW_PERMISSION_USAGE` activity-alias が必要。[開始ガイド](https://developer.android.com/health-and-fitness/health-connect/get-started)
- 設定画面には同期の停止/再開と Health Connect の「アクセスを管理」への導線を設ける。権限拒否や取り消しを正常な状態として扱う。[権限UIガイド](https://developer.android.com/health-and-fitness/health-connect/ui/permissions)

## 対象データと権限

初期連携は読み取り専用にする。lifegame から Health Connect へ書き戻す必要はまだないため、WRITE 系権限は要求しない。

| lifegameで扱うもの | Health Connect record   | 必須 read permission                      | 主な値                                              | 現行モデルとの対応                                                                                |
| ------------------ | ----------------------- | ----------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 体重測定           | `WeightRecord`          | `android.permission.health.READ_WEIGHT`   | 測定時刻、zone offset、kg、metadata                 | `weight_kg` は直接対応。現在は日付しかないため測定時刻と同期元を追加したい                        |
| 運動実績           | `ExerciseSessionRecord` | `android.permission.health.READ_EXERCISE` | 開始/終了時刻、運動種別、title、notes、metadata     | `activity` と `duration_minutes` に縮約可能。ただし正確な時刻・標準種別・同期元を失わない列が必要 |
| 睡眠               | `SleepSessionRecord`    | `android.permission.health.READ_SLEEP`    | 開始/終了時刻、zone offset、title、notes、睡眠stage | 現在の `health_entries` に種類がないため、新しい睡眠モデルが必要                                  |

公式のデータ型一覧と権限対応は [Health Connect data types](https://developer.android.com/health-and-fitness/health-connect/data-types) にある。個々の構造は [WeightRecord](https://developer.android.com/reference/androidx/health/connect/client/records/WeightRecord)、[ExerciseSessionRecord](https://developer.android.com/reference/androidx/health/connect/client/records/ExerciseSessionRecord)、[SleepSessionRecord](https://developer.android.com/reference/androidx/health/connect/client/records/SleepSessionRecord) を参照。

睡眠は単なる「何分寝た」ではない。1つの `SleepSessionRecord` が開始/終了時刻を持ち、その内側に awake/light/deep/REM 等の stage 区間を持てる。最小表示では合計時間だけでもよいが、同期層では元の session ID と時刻を保持し、将来 stage を追加できる形にするのがよい。[SleepSessionRecord](https://developer.android.com/reference/androidx/health/connect/client/records/SleepSessionRecord)

運動ルートは別の機微情報であり、追加権限 `READ_EXERCISE_ROUTE` と追加同意が関わる。今回の目的は運動種別と時間なので、ルート、心拍、歩数、カロリーは初期スコープから明示的に外す。[workout guide](https://developer.android.com/health-and-fitness/health-connect/experiences/workouts)

## 読み取り範囲、バックグラウンド、変更追跡の制約

### 履歴

通常は、初回に権限が付与された時点から遡って30日分まで他アプリのデータを読める。30日より前を初回インポートしたい場合は追加の `android.permission.health.READ_HEALTH_DATA_HISTORY` を manifest と実行時権限に加える必要がある。アプリを削除すると権限は取り消され、再インストール時には新しい権限付与日を基準に同じ制限が適用される。[raw data read guide](https://developer.android.com/health-and-fitness/health-connect/read-data)

最小プロトタイプでは history 権限を要求せず「直近30日」を明示する。長期履歴の価値を確認してから追加申請する方が、minimum scope 原則に合う。

### フォアグラウンド/バックグラウンド

通常の読み取りはアプリがフォアグラウンドにいる間だけ行える。バックグラウンド同期には追加の `android.permission.health.READ_HEALTH_DATA_IN_BACKGROUND`、対応機能の availability 確認、WorkManager が必要になる。[raw data read guide](https://developer.android.com/health-and-fitness/health-connect/read-data)

最初はユーザーが companion を開いて「今すぐ同期」を押すフォアグラウンド同期にする。これならバックグラウンド権限も定期ジョブも不要で、挙動とデータ送信が見えやすい。自動同期を後から追加する場合も、Android は正確な即時同期を保証しないため「最終同期時刻」を表示する。

### 差分同期

Health Connect は changes token と `getChanges()` を提供する。upsert には record の Health Connect `id` と `lastModifiedTime`、削除には `id` を使う。削除 change は record type を含まないため、型ごとに token と ID 対応を保持するのが安全である。token は未使用のまま30日経つと失効するため、失効時は直近範囲を再読込して ID で重複排除する。[sync guide](https://developer.android.com/health-and-fitness/health-connect/sync-data)

Android 側または D1 に最低限、次を保持する。

- record type
- Health Connect record `id`
- `lastModifiedTime`
- `dataOrigin.packageName`（表示上の出典にも使える）
- lifegame側 record ID
- 型ごとの changes token と最終成功同期時刻

Worker の batch endpoint は `(record_type, health_connect_id)` を一意キーにして冪等 upsert する。端末から同じ batch を再送しても重複しないこと、Health Connect で削除された record を tombstone として送れることが必要である。

## Play Console と公開時の制約

公開版は「APKが動いた」だけでは足りない。

- Play Console の Data safety と Health apps declaration を完了し、使用する各データ型についてユーザー利益を具体的に説明する。新しいデータ型を追加する際は宣言も更新する。[公開ガイド](https://developer.android.com/health-and-fitness/health-connect/publish)
- package name ごとにデータ型アクセスが allow-list される。公開アプリが宣言/承認されていない型へアクセスすると、ユーザーにはアクセス不可のダイアログが出る。[公開ガイド](https://developer.android.com/health-and-fitness/health-connect/publish)
- Play Store listing と Health Connect 権限画面から開くものは同一の、公開アクセス可能なプライバシーポリシーでなければならない。アプリ内にもリンクまたは本文が必要。[Health Apps policy](https://support.google.com/googleplay/android-developer/answer/16679511)
- 要求する権限はユーザー向け機能に必要な最小範囲に限定する。体重・運動・睡眠を実際に表示することが説明可能なので、lifegame は fitness/wellness の approved use case に適合しうるが、承認を保証するものではない。[Health Connect policy](https://support.google.com/googleplay/android-developer/answer/16558241)
- headless app は禁止される。同期専用でもランチャーアイコンと、接続状態・権限・同期操作・プライバシー説明を見られる明確な UI が必要。[Health Connect policy](https://support.google.com/googleplay/android-developer/answer/16558241)

開発中は実機への debug APK sideload と公式 Health Connect Toolbox で入出力を検証できる。[Toolbox](https://developer.android.com/health-and-fitness/health-connect/test/health-connect-toolbox) 公開/継続配布へ進む時点で Play Console 審査と宣言を工程に含める。

## 単一ユーザー Worker への認証・同期方式

### 推奨: ブラウザでペアリングし、端末固有tokenを発行

1. Access で認証済みの `/health` 設定から、短命・一回限りのペアリング code/QR を発行する。
2. Android companion に code を入力またはQRで渡す。
3. companion が code を交換し、`health:sync` だけを許すランダムな端末 token を受け取る。
4. token は Android Keystore で保護し、Worker/D1 には hash、端末名、作成日、最終利用日、失効日だけを保存する。
5. Worker は dedicated endpoint で token、scope、期限、replay/idempotency key、payload size を検証する。
6. Web UI から端末 token を個別に失効できるようにする。

この方式なら既存のブラウザ Access 認証を「端末を信頼する最初の操作」に再利用でき、Android アプリへメールログインや Access cookie を恒久保存する必要がない。単一ユーザー前提にも合う。

### 代案

- **Androidのブラウザログインをそのまま使う:** Custom Tab で Access にログインし、アプリ用 callback で Worker 発行tokenへ交換する。将来複数ユーザー化するなら自然だが、最初の companion には OAuth相当の実装量が大きい。
- **Cloudflare Access service tokenをAPKに埋め込む:** 採用しない。service token は Client ID と Client Secret の静的な machine credential である。[Cloudflare service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/) APKに共通secretを置くと抽出された1つの資格情報ですべての端末が偽装され、個別失効もできない。
- **エクスポートファイルを手動アップロード:** ネットワーク認証は単純だが、Health Connectに汎用Web export APIはなく、結局 Android reader が必要。初回のデータ形状検証用には使えるが、継続同期には向かない。

Access で保護した既存APIとは別に `/api/health-sync/*` の service-auth 経路を作る場合、経路を狭く保ち、Worker自身でも端末 token を検証する。Cloudflare Access の到達制御だけをデータ認可の代わりにしない。

## データモデルへの影響

現行 `health_entries` は手入力の最小モデルとしては十分だが、Health Connect 同期には情報が足りない。

- `occurred_on` しかなく、体重の測定時刻や運動の開始/終了を保持できない。
- source ID がないので再同期で重複する。
- `kind` は `weight|exercise` のみで睡眠を表せない。
- Health Connect 側の修正/削除を安全に反映する欄がない。

実装前に、手入力を壊さず同期データを保持する設計を決める。推奨は、表示用の `health_entries` を無理に拡張して外部同期状態まで背負わせず、`health_source_records` のような同期境界を別テーブルに置く案である。source record に原形（時刻、型、origin、external ID、last modified）を保持し、UI用の健康記録へ投影する。睡眠はセッション本体を新しい表示対象にし、stage は初期版では保存しないか別子テーブルにする。

体重と運動を既存行へ投影する場合、Health Connect由来の行をWebで編集すると次回同期との競合が起きる。初期版は「連携データは閲覧・削除元への案内のみ」「手入力だけ編集可」が最も理解しやすい。Health Connect由来データの削除は、lifegameだけから消すのか、Health Connectからも消すのかを曖昧にしない。読み取り専用権限しかない初期版では前者しかできないため、「同期対象から除外」のtombstone/ignore状態が必要になる。

## セキュリティとプライバシー

Health Connectデータは personal and sensitive user data である。Google Play policy は用途をUIに見える承認済み機能へ限定し、HTTPS等の現代的暗号化、明確な収集・利用・削除説明、最小権限を要求する。広告、データブローカー、信用力評価などへの転用は禁止される。[Health Connect policy](https://support.google.com/googleplay/android-developer/answer/16558241)

lifegameでは最低限、次を満たす。

- 送信前画面で「体重・運動・睡眠を端末から lifegame の D1 へ複製する」こと、用途、保存期間、削除方法を明示する。
- データ型を個別に opt-in でき、同期停止、端末token失効、サーバー側コピー削除を提供する。
- 読み取り専用、ルート/心拍等を要求しない、payload/logへ不要なデータを入れない。
- tokenや生データをconsole/analytics/crash reportへ記録しない。Workerはbodyをエラーログへ出さない。
- HTTPS、短命ペアリングcode、hash化token、rate limit、batch上限、schema validation、冪等性を実装する。
- `dataOrigin` を保持・表示し、同じ運動が複数アプリ由来で重複しうることを扱う。Health Connectのmetadataは出典と変更追跡に使える。[data format](https://developer.android.com/health-and-fitness/health-connect/data-format)
- MCPや朝ブリーフィングへ自動的に流用しない。別用途へ広げる際は、現在のHealth Connect同意とは別にlifegame側で明示同意と最小scopeを設計する。

## 推奨する最小プロトタイプ

公開アプリを最初から作らず、1台の実機で end-to-end の不確実性を潰す。

### スコープ

- Kotlin + Jetpack Compose のランチャーアイコン付き Android companion。
- Health Connect availability、3つのread permission状態、公開プライバシー説明へのリンクを表示。
- `READ_WEIGHT`、`READ_EXERCISE`、`READ_SLEEP` を個別に要求可能。
- history/background permission は要求しない。フォアグラウンドの「直近30日をプレビュー」「選択した型を今すぐ同期」のみ。
- ルート、心拍、歩数、カロリー、WRITE権限、睡眠stageのサーバー保存は対象外。
- まずは実際に送信せず、端末上で record数と正規化後のプレビューを確認する。その後に一回限りcodeでWorkerとペアリングする。
- Workerは新しい同期endpointでbatch upsertし、Web UIに出典と最終同期時刻を表示する。

### 実装順

1. **端末read spike:** debug APKで3 record型を読み、実データの `dataOrigin`、時刻、重複、欠損をJSONではなく画面に表示する。公式 Toolbox のテストデータでも検証する。
2. **モデル決定:** 実データを見て、source record、睡眠session、既存 `health_entries` への投影規則と削除規則を決める。
3. **安全なpairing:** Access認証済みWebで一回限りcodeを発行し、端末tokenを個別失効できるようにする。
4. **foreground sync:** 型別changes token、idempotent batch、削除change、token失効時の直近30日再読込を実装する。
5. **受け入れ確認:** 権限の一部拒否/途中取消、二重送信、Health Connect側の修正/削除、ネットワーク中断、token失効を実機で確認する。公式は権限取消やページング等のテスト項目も公開している。[test cases](https://developer.android.com/health-and-fitness/health-connect/test/test-cases) [testing library](https://developer.android.com/health-and-fitness/health-connect/test/unit-tests)
6. **価値確認後に公開準備:** privacy policy、Data safety、Health apps declaration、型ごとの説明、Play配布を行う。その後にだけ background/history permission を検討する。

### 成功条件

- 同じ同期を2回実行してもWeb上で重複しない。
- Health Connectで更新/削除した体重・運動・睡眠が次回同期で一致する。
- 3権限の一部だけでも残りが同期できる。
- companionを閉じていても「同期していない」ことが誤解なく表示される。
- Android端末の権限取消とlifegame側端末token失効が独立して機能する。
- MCP/朝ブリーフィングには健康データが露出しないままである。

## 推奨判断

「連携できるか」への回答は **できるが、ネイティブAndroid companionが必須**。次の設計チケットでは、いきなり自動同期やPlay公開まで含めず、まず「foreground read spike + 実データの形の確認」を切り出す。1台・単一ユーザーで成立することを確認した後、同期DB/APIと公開申請を別チケットに分けるのが妥当である。
