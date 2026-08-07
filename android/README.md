# lifegame 健康確認 companion

Health Connectから体重測定・運動実績・睡眠実績を読み取り、直近30日の件数と代表項目を端末に表示する最小版です。

このアプリは次の3つの読み取り権限だけを宣言・要求します。

- `android.permission.health.READ_WEIGHT`
- `android.permission.health.READ_EXERCISE`
- `android.permission.health.READ_SLEEP`

Health Connectへの書き込み、履歴（30日より前）・バックグラウンド・運動ルートの権限、lifegameサーバーへの通信は実装していません。画面を閉じている間に同期もしません。

## debug APKを作る

1. Android Studio（Ladybug以降）をインストールし、Android SDK Platform 35を追加する。
2. Android Studioでこの `android/` ディレクトリを開く。
3. Gradle Syncが完了するまで待ち、`app` の `debug` ビルドを選ぶ。
4. メニューの **Build > Build Bundle(s) / APK(s) > Build APK(s)** を選ぶ。

コマンドラインからGradleを用意している場合は、リポジトリのルートで次を実行します。

```sh
gradle -p android :app:testDebugUnitTest
gradle -p android :app:assembleDebug
```

生成物は `android/app/build/outputs/apk/debug/app-debug.apk` です。`android/` にはGradle wrapperを含めていないため、Android Studio同梱のGradleまたは互換性のあるGradle 8.9以上を使ってください。

## Android 16実機で確認する

1. 端末で **設定 > デバイス情報** から開発者向けオプションを有効にし、**開発者向けオプション > USBデバッグ** をオンにする。
2. USBケーブルで端末をMac/PCへ接続し、端末側の「USBデバッグを許可」を承認する。
3. Android Studioの実行端末にAndroid 16実機を選び、Run（▶）で `app` を起動する。USBを使わない場合は、Android Studioの **Pair Devices Using Wi-Fi** でもよい。
4. 初回表示でHealth Connectが利用可能であることを確認し、**未許可の読み取り権限を設定** を押す。
5. Health Connectの権限画面で、体重測定・運動実績・睡眠実績を必要な範囲だけ許可する。部分的に拒否しても、許可した種類だけが読み取られる。
6. **再読み込み** を押し、各種類の直近30日件数と代表項目を確認する。データがない種類は「データはありません」と表示される。
7. Health Connectの「アクセスを管理」で1種類の権限を取り消してから再読み込みし、画面が「未許可」と変わることも確認する。

Health Connectが利用不可または更新必要と表示された場合は、Android 14以降の端末設定でHealth Connectを更新・有効化してから再実行してください。Health Connectのテストデータを使う場合は、公式のHealth Connect Toolboxでテストデータを追加してからアプリを再読み込みします。
