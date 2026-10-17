# DGX Sparkへの配備（v1.0）

Windows端末はブラウザとNode.jsだけを動かし、SparkでASR・Nemotron-3-Diarization・vLLMを実行します。共通ゲートウェイがAPIキー認証と端末間の同時1会議を制御します。ここにある構成は配備用テンプレートです。Spark実機でのGPU動作・モデル同居性能・話者精度は未検証です。

## 1. 前提とソースの配置

SparkのLinux Arm64環境、NVIDIAドライバー、GPU対応Docker Compose、Node.js 22.18以上を用意します。vLLMイメージは[公式Spark手順](https://build.nvidia.com/spark/vllm/instructions)を基にArm64/Blackwell対応を確認し、使用するイメージのdigestを固定してください。Windows版の音声実行ファイルはコピーしません。

以下は専用ユーザー`kotoba`が所有する`/opt/kotoba`へ、このリポジトリを配置した例です。別のパスやユーザーを使う場合はサービス定義も合わせて変更します。

```bash
cd /opt/kotoba
npm ci
cp deploy/spark/spark.env.example deploy/spark/spark.env
chmod 600 deploy/spark/spark.env
```

`spark.env`を編集し、`GATEWAY_API_KEY`と`GATEWAY_LLM_API_KEY`には別々のランダムキー（例：`openssl rand -hex 32`）を設定します。前者は端末用、後者はゲートウェイとvLLM間専用です。`MODEL_ID`、モデルのコミットSHAである`MODEL_REVISION`、digest付き`VLLM_IMAGE`も実値に置き換えます。このファイルをGitへ追加しないでください。

## 2. 音声モデルを準備する

Sparkで実際に使用するCUDAメジャーに合わせ、12または13を明示します。同じ専用ユーザーとモデルディレクトリを使ってセットアップ・サービス起動を行います。

```bash
cd /opt/kotoba
export NEMO_SPEECH_MODEL_DIR=/opt/kotoba/.runtime/models
SPARK_CUDA_MAJOR=13 node scripts/setup-spark.mjs
```

スクリプトはNeMo-Speech.cpp v0.2.0 Linux Arm64版のアーカイブとSHA-256を取得・検証し、ASRと話者モデルを取得します。モデル取得の検証はNeMoのモデル管理機能が担当します。配備記録は`.runtime/spark-manifest.json`です。既存の`NEMO_SPEECH_BIN`を使う場合は、そのバイナリの版・取得元・ハッシュを別途記録してください。

## 3. vLLMと音声サービスを起動する

```bash
docker compose --env-file deploy/spark/spark.env -f deploy/spark/compose.yaml config --quiet
docker compose --env-file deploy/spark/spark.env -f deploy/spark/compose.yaml up -d
```

モデルは`meeting-llm`というAPI名で公開します。初期値は文脈8192・同時生成1・GPUメモリ利用率0.5です。これは同居評価の開始値であり、成功を保証する推奨値ではありません。ASR・話者モデルを同時起動した状態でメモリと遅延を測って調整します。Gemmaの取得に同意・認証が必要な場合は、専用ユーザー側で利用条件を確認し、マウント先のHugging Faceキャッシュへ認証を準備してください。

systemdの例を使用する場合は、`/usr/bin/node`が実際のNode.js 22.18以上を指すこと、実行ユーザーがGPUとモデルキャッシュへアクセスできることを確認します。

```bash
sudo cp deploy/spark/kotoba-speech.service deploy/spark/kotoba-gateway.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kotoba-speech kotoba-gateway
journalctl -u kotoba-speech -u kotoba-gateway -n 100 --no-pager
```

ASRは`127.0.0.1:8081`、vLLMは`127.0.0.1:8000`、ゲートウェイは`127.0.0.1:8001`です。ゲートウェイの`/health`は最小限の稼働確認、音声の準備確認は認証付き`/speech/ready`です。ASR・話者モデルが準備できるまで会議開始は拒否します。

ゲートウェイ再起動は利用権と進行中の接続を失います。会議中のサービス再起動・モデル更新は避けてください。切断後の再録音は別セッションとなり、話者番号の対応を引き継ぎません。

## 4. 端末から接続する

Windows端末にもソースとNode.js 22.18以上を配置し、`npm ci`、`npm run build`を実行します。Sparkへ接続する構成では端末にGPU、Ollama、ASRモデルは不要です。ブラウザは端末自身の`http://127.0.0.1:3210`を開きます。

最初の試用はSSHトンネルで接続できます。端末の空きポート8001を使用する例です。

```powershell
ssh -N -L 8001:127.0.0.1:8001 USER@SPARK_IP
```

この場合のゲートウェイURLは`http://127.0.0.1:8001`です。LANへ常設公開する場合は`Caddyfile.example`などでTLSを終端し、端末のNode.jsが信頼する証明書を使用してください。独自CAは`NODE_EXTRA_CA_CERTS`で指定できます。TLS検証を無効にしないでください。[Caddyの中継](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)はWebSocketとSSEを扱えます。Caddy例ではHTTPSの8443番を使います。

起動前の端末`.env`へ次を一組で指定すると、ローカルASRやOllamaを起動せずSparkを使えます。画面で保存済みの設定がある場合はそちらを優先します。

```dotenv
SPEECH_MODE=spark
SPARK_GATEWAY_URL=http://127.0.0.1:8001
SPEECH_URL=http://127.0.0.1:8001/speech
SPEECH_API_KEY=ゲートウェイのキー
SPEAKER_DIARIZATION=true
AUDIO_INPUT_PROFILE=conference
LLM_PROVIDER=openai
LLM_BASE_URL=http://127.0.0.1:8001/v1
LLM_MODEL=meeting-llm
LLM_API_KEY=ゲートウェイのキー
LLM_DISABLE_THINKING=true
```

`npm start`で起動します。画面から移行する場合は、先に「音声認識・話者分離」をSparkへ切り替え、URL・キー・話者分離ON・会議用マイクを指定して動作確認・適用します。次にLLMをOpenAI互換へ切り替え、同じゲートウェイの`/v1`、`meeting-llm`、端末用キーを指定し、テスト・保存します。音声設定の保存前にゲートウェイLLMだけをテストすると、利用権がなく拒否されます。Thinking無効化は対応モデルでのみONにし、実際のJSON出力テストで確認してください。

同じゲートウェイを通さないLLMとの混在はSparkモードでは認めません。別端末で会議やAI処理中なら利用中と表示し、失効した利用権で処理を続けません。

## 5. 採用判定と実機試験

LLMの候補は`google/gemma-4-E4B`と`Qwen/Qwen3.5-9B`です。採用モデルごとにイメージdigest・モデルrevision・起動値を記録し、同じ日本語会議素材でJSON Schema適合、日英翻訳、同音語補正、発話確定後の翻訳待ち、ASR同居時のメモリを比較します。どちらもこの環境での採用・速度は未確定です。

3人・8人、長い沈黙後の再発言、似た声、軽い重なりを含む同意済み評価音声で話者混同・話者不明・原文欠落を確認してください。開始時の無音テストはオプション受理の確認であり、話者精度の合格判定ではありません。

```powershell
# アプリをSpark設定で起動し、他の録音・処理を停止して実行
node scripts/smoke-spark.mjs C:\evaluation\meeting-mono-pcm16.wav
```

このスクリプトは既存のモノラルPCM16 WAVを実時間で送り、`.runtime/spark-smoke-*.json`へ遅延・待機件数・エラーを記録します。まず短い素材、次に60分の素材で、切断・利用権更新・待ち行列・メモリを確認します。話者正解率は正解ラベルと別途照合してください。アプリの会議ジャーナルはWindows端末の`.local/sessions/`に置かれ、音声を記録しません。実機試験が済むまでは本番会議向けの性能保証を行いません。
