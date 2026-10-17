Windows 64bit用のDGX接続クライアントです。

1. Assetsから `kotobaroku-*-windows-x64.zip` をダウンロードします。
2. ZIPを「すべて展開」し、`start-client.cmd` をダブルクリックします。
3. 初回は管理者から受け取ったDGX接続先・公開モデル名・APIキーを設定します。

Node.jsと依存物は同梱済みです。GPU・Python・AIモデルの個別導入は不要です。
DGXへのネットワーク接続が必要です。操作の詳細は同梱の `START-HERE.txt` を参照してください。

更新時はアプリを停止し、以前の `.local` フォルダーと、独自の `.env` がある場合はそれも新しい展開先へコピーしてください。
