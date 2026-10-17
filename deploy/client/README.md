# Windowsメンバー向けの配布

AI処理は共通のDGXで実行し、メンバーにはNode.js同梱のWindows x64用ZIPを配布します。各PCでのnpm実行、ビルド、GPU、Python、AIモデルの導入は不要です。DGX側の準備は[別の配備手順](../spark/README.md)に従います。

## メンバーの操作

1. GitHubのReleasesから `kotobaroku-バージョン-windows-x64.zip` を取得します。`Source code (zip)` は実行用ZIPではありません。
2. ZIPを「すべて展開」し、`start-client.cmd` をダブルクリックします。
3. 初回は設定画面でDGXの接続先・モデル名・APIキーを確認します。音声側を動作確認して保存し、次にLLM側をテストして保存します。
4. ライブ翻訳画面で開始し、マイク使用を許可します。終了は起動ウィンドウで `Ctrl+C` です。

ブラウザは自動で開きます。初回は設定画面、音声・LLMの両方を保存済みならライブ画面へ移動します。接続先のモデルをPCへダウンロードしたり、ローカルのOllama・音声サービスを起動したりする処理はありません。

閉域の端末へZIP全体を持ち込んでも実行できます。実行時のnpmレジストリーやNode.js配布サイトへの接続は不要ですが、DGXゲートウェイへのネットワーク接続は必要です。現在のゲートウェイは同時1会議に制限しています。

## 管理者がZIPを作成する

オンラインのWindows x64ビルド端末で、Node.js 22.18以上とnpmを使用します。

```powershell
npm ci
npm test
npm run package:client -- --gateway-url https://DGXのホスト名:8443 --model meeting-llm
npm run test:client-package
```

`release/` にZIPと `.zip.sha256` が作成されます。共通URLと公開モデル名は `connection.json` に入るため、メンバーのURL入力を省けます。SSHトンネルを使う場合の起点は `http://127.0.0.1:8001` です。引数を省略した場合もこのURLと `meeting-llm` が初期値になります。実際に使用するURLへ置き換えてください。

ZIPにはビルド済み画面、サーバー、本番npm依存物、日本語辞書、Node.js 24.22.0 Windows x64の実行ファイルとLICENSEを含めます。Node.jsの公式ZIPを取得し、同じ版の公式 `SHASUMS256.txt` と照合します。個人の `.env`、`.local/`、会議履歴、モデル、Git履歴はコピーしません。`connection.json` にAPIキーやURL内の認証情報を指定することもできません。

Node.jsを別途取得済みの場合は、次の2ファイルを指定できます。本番npm依存物も事前にキャッシュされていなければ、ビルドにはネット接続が必要です。

```powershell
npm run package:client -- --node-archive C:\materials\node-v24.22.0-win-x64.zip --node-checksums C:\materials\SHASUMS256.txt
```

Node.jsの取得先は[本体](https://nodejs.org/dist/v24.22.0/node-v24.22.0-win-x64.zip)と[チェックサム](https://nodejs.org/dist/v24.22.0/SHASUMS256.txt)です。配布ZIPのスモークテストはZIPを別の一時フォルダーへ展開し、同梱Nodeだけを使って起動・辞書・画面配信・DGX設定を確認します。DGX部分は模擬サービスで検証するため、実機のモデル精度や性能の検証は別途必要です。

## GitHubから配布する

この `nemotron-web/` をGitHubリポジトリのルートとして登録します。`.github/workflows/windows-client.yml` はこの配置を前提としています。メンバー限定の配布にはPrivateリポジトリを使用し、メンバーへ読み取り権限を付与します。実際のAPIキーや会議データはリポジトリやActionsの入力へ登録しません。

1. リポジトリにソースとワークフローをpushします。
2. Settings → Secrets and variables → Actions → Variablesで、共通の `DGX_GATEWAY_URL` と `DGX_LLM_MODEL` を必要に応じて設定します。どちらもAPIキーを含めません。
3. 動作確認だけならActionsの「Windows client ZIP」→「Run workflow」を実行します。接続先とモデル名は実行時にも指定できます。完了後のArtifactsからZIPを取得できます。
4. 配布版を作る場合は `package.json` と `package-lock.json` の版をそろえ、`v1.0.0` のような一致するタグをpushします。
5. ワークフローがテスト・ZIP作成・ZIP検証を実行し、ZIPとチェックサムを添付した**下書きRelease**を作成します。管理者が内容を確認してPublishすると、メンバーがReleasesから取得できます。

GitHubのReleaseとファイル配布の扱いは[公式説明](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)を参照してください。ワークフローの追加だけではリポジトリ作成や公開は行われません。

## 接続先の変更・更新・保存

`connection.json` は初期値用で、`gatewayUrl`、`model`、`port`、`inputProfile`、`disableThinking` を指定できます。例は[connection.example.json](connection.example.json)にあります。思考モードの無効化は対応モデルに限って有効にし、接続テストで確認します。

設定画面で保存した内容は `.local/speech-settings.json` と `.local/llm-settings.json` に入り、共通初期値より優先されます。保存済み端末の接続先を変える場合は設定画面から再テスト・保存してください。高度な設定は個人の `.env` で上書きできます。

更新はアプリを終了してから新しいZIPを別フォルダーへ展開し、旧版の `.local/` と、使用していれば `.env` をコピーします。ポートは通常3210のままにします。ブラウザ側の保存データは同じブラウザ・同じ起点URLで引き継ぎます。APIキーと会議データを含むため、使用後のフォルダーをそのまま他のメンバーへ渡さないでください。

ZIPと `.zip.sha256` を同じ場所に置き、必要に応じて `Get-FileHash -Algorithm SHA256 ZIPのパス` で照合できます。`client-manifest.json` には同梱ファイルのSHA-256を記録しています。
