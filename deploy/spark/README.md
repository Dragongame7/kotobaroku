# DGX Sparkへの配備（v1.0）

Windows端末はブラウザとNode.jsだけを動かし、SparkでASR・Nemotron-3-Diarization・vLLMを実行します。共通ゲートウェイがAPIキー認証と端末間の同時1会議を制御します。ここにある構成は配備用テンプレートです。Spark実機でのGPU動作・モデル同居性能・話者精度は未検証です。

## 0. 閉域環境へ持ち込む資材と取得先

以下はオンライン端末で取得するための一覧です（取得先確認日：2026-10-18）。対象はDGX Sparkの **Linux Arm64 / aarch64** です。Windows版・Linux x86_64版は使用しません。既存のDGX上のGemma 4サービスを再利用する場合、LLMモデルとvLLMイメージの新規取得は不要です。音声サービスと共通ゲートウェイは別途用意します。

この一覧は資材の取得先をまとめたものです。後続の手順にある `npm ci`、`setup-spark.mjs`、コンテナー起動時のイメージ取得・モデル取得にはオンライン処理が含まれます。閉域側では、持ち込んだ依存物・イメージ・モデルを配置して使用してください。資材の取得・アーカイブ作成はこの文書更新では実行していません。

### 0.1 必須：音声ランタイムと2つの音声モデル

| 資材 | 取得対象 | ファイル取得先 |
|---|---|---|
| NeMo-Speech.cpp v0.2.0 / CUDA 13 | `nemo-speech-0.2.0-linux-aarch64-cuda13.tar.gz` と対応する `.sha256` | [本体](https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v0.2.0/nemo-speech-0.2.0-linux-aarch64-cuda13.tar.gz) / [SHA-256](https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v0.2.0/nemo-speech-0.2.0-linux-aarch64-cuda13.tar.gz.sha256) |
| NeMo-Speech.cpp v0.2.0 / CUDA 12 | CUDA 12を使用する環境の場合のみ。CUDA 13版との両方の取得は不要 | [本体](https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v0.2.0/nemo-speech-0.2.0-linux-aarch64-cuda12.tar.gz) / [SHA-256](https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v0.2.0/nemo-speech-0.2.0-linux-aarch64-cuda12.tar.gz.sha256) |
| Nemotron 3.5 ASR | `nemotron-3.5-asr-streaming-0.6b.q8_0.gguf`（741,548,352 bytes、約707 MiB） | [版を固定したGGUF本体](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b/resolve/1c8deaecc64b91f034d73e08dd8b64625eb3395d/nemotron-3.5-asr-streaming-0.6b.q8_0.gguf) |
| Nemotron-3-Diarization | `Nemotron-3-Diarization.q8_0.gguf`（107,012,128 bytes、約102 MiB） | [版を固定したGGUF本体](https://huggingface.co/nvidia/Nemotron-3-Diarization/resolve/f667ed73aee57d40cc39428eb768b4fd87a0a29e/Nemotron-3-Diarization.q8_0.gguf) |
| 音声モデルの配布情報 | `models/index.json`（上記2モデルのrevision・サイズ・SHA-256の参照元） | [v0.2.0の公式モデル索引](https://raw.githubusercontent.com/NVIDIA/NeMo-Speech.cpp/v0.2.0/models/index.json) |

この構成のASR・話者分離には上記2つのGGUFを使います。各モデルの `.nemo` や `model.safetensors` を重複して取得する必要はありません。ランタイムは `bin/` だけでなく、アーカイブ内の同梱ライブラリを含むディレクトリ全体を持ち込みます。

### 0.2 LLMを新設する場合：モデルとコンテナー

| 資材 | 取得対象 | 取得先 |
|---|---|---|
| Gemma 4 E4B | `google/gemma-4-E4B` の同一revisionのモデル一式。確認時のrevisionは `411aa17b749aa952df1359d2dcea73917a544d9a` | [版を固定したファイル一覧](https://huggingface.co/google/gemma-4-E4B/tree/411aa17b749aa952df1359d2dcea73917a544d9a) |
| Qwen3.5 9B | Gemmaの代わりに採用する場合のみ。取得するコミットを固定したモデル一式 | [公式ファイル一覧](https://huggingface.co/Qwen/Qwen3.5-9B/tree/main) |
| vLLMコンテナー | 採用モデルとArm64 / Blackwellに対応するタグ・digestの **linux/arm64イメージ全レイヤー**。オンライン端末でイメージを保存したアーカイブを持ち込む | [公式イメージのタグ・digest一覧](https://hub.docker.com/r/vllm/vllm-openai/tags) / [NVIDIAのSpark用選定手順](https://build.nvidia.com/spark/vllm/instructions) |

Gemmaの上記revisionでは `model.safetensors`、`config.json`、`generation_config.json`、`processor_config.json`、`tokenizer.json`、`tokenizer_config.json` を含むモデル一式を取得します。別モデルで重みが分割されている場合は全シャードとindexも必要です。Git LFSのポインタではなく重み本体を取得してください。Ollama用のモデル名 `gemma4:latest` と、vLLM用のHugging Faceモデル一式は取得形式が異なります。

`MODEL_REVISION` は実際に持ち込むコミットと一致させます。既存のCompose定義を使う場合は、そのコミットのHugging Faceキャッシュを `.runtime/huggingface/` へ、リンク先の実体も含めて持ち込みます。通常のモデルフォルダーとして持ち込む場合は、別途Composeのマウントとモデル指定をローカルパスへ合わせてください。vLLMの採用タグ・digestはDGX実機での確認前のため、この一覧では特定のイメージを検証済みとして固定していません。

### 0.3 アプリ・ゲートウェイの実行に必要な資材

| 資材 | 取得対象 | 取得先 |
|---|---|---|
| アプリ・ゲートウェイのソース | このリポジトリの `nemotron-web/` 一式。`server/`、`spark-gateway/`、`scripts/`、`deploy/`、`package.json`、`package-lock.json` を含む | 本プロジェクトのソース。外部配布URLは未設定 |
| Node.js / npm | Node.js 22.18以上。取得例：`node-v24.14.0-linux-arm64.tar.xz`（npm同梱）と検証用ファイル。導入済みなら追加不要 | [Arm64本体](https://nodejs.org/dist/v24.14.0/node-v24.14.0-linux-arm64.tar.xz) / [SHASUMS256.txt](https://nodejs.org/dist/v24.14.0/SHASUMS256.txt) / [署名](https://nodejs.org/dist/v24.14.0/SHASUMS256.txt.asc) |
| npm依存パッケージ | 同梱の `package-lock.json` が指定する `.tgz` とintegrity。Linux Arm64 / glibc向けの個別URLを付録へ記載 | [npm資材取得先一覧](offline-npm-sources.tsv) / [npm公式レジストリー](https://registry.npmjs.org/) |

付録は現在の `package-lock.json` から抽出した141件です。`runtime` の75件は本番依存、`build-test` の66件はビルド・テスト用です。パッケージの更新時は付録も更新します。DGXで音声サービスとゲートウェイだけを実行する場合、フロントエンドのビルド・ブラウザテスト用資材は不要です。

閉域でnpmを使うには、一覧のURLから得たファイルをnpmキャッシュまたは社内レジストリーとして利用できる形に準備する必要があります。`.tgz` を任意のフォルダーに置くだけでは通常の `npm ci` は完了しません。準備済みの `node_modules/` を持ち込む場合はLinux Arm64環境で用意し、Windowsの `node_modules/` は流用しません。Windows端末自身も閉域の場合は、その端末用のNode.jsとnpm依存物を別に準備してください。

### 0.4 未導入の場合のみ必要な基盤資材

DGXに既存のGPU対応コンテナー環境がある場合、この節の再導入は不要です。OS用パッケージは対象のUbuntuリリース・Arm64・既存バージョンに合わせ、未導入の依存パッケージも含めて取得します。

| 資材 | 取得対象 | 取得先 |
|---|---|---|
| Docker Engine / CLI / containerd / Composeプラグイン | `docker-ce`、`docker-ce-cli`、`containerd.io`、`docker-compose-plugin`。Buildxを使用する場合は `docker-buildx-plugin` も含む | [Ubuntu 24.04（noble）Arm64の公式deb一覧](https://download.docker.com/linux/ubuntu/dists/noble/pool/stable/arm64/) / [対象OSの確認と公式配布案内](https://docs.docker.com/engine/install/ubuntu/) |
| NVIDIA Container Toolkit | `nvidia-container-toolkit`、`nvidia-container-toolkit-base`、`libnvidia-container-tools`、`libnvidia-container1` の対応するArm64版 | [Arm64のdebファイル索引](https://nvidia.github.io/libnvidia-container/stable/deb/arm64/Packages) / [公式リポジトリー定義](https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list) / [署名鍵](https://nvidia.github.io/libnvidia-container/gpgkey) / [パッケージの選定元](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) |
| HTTPS用Caddy | LAN公開で同梱のCaddy設定例を使用する場合のみ。Linux Arm64本体とチェックサム。SSHトンネルなら不要 | [公式リリース資材](https://github.com/caddyserver/caddy/releases) |

DGXのNVIDIAドライバーとOSは導入済みの対応環境を前提とします。更新が必要な場合の資材はDGXの機種・OS版で変わるため、この一覧で汎用ドライバーへ置き換えません。Whisper large-v3、追加の翻訳専用LLM、TTSモデル、PythonのNeMo環境は、この配備構成の通常利用には不要です。

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

以下はオンライン取得が可能な環境でのセットアップ例です。閉域へ持ち込むファイルは「0. 閉域環境へ持ち込む資材と取得先」を参照してください。Sparkで実際に使用するCUDAメジャーに合わせ、12または13を明示します。同じ専用ユーザーとモデルディレクトリを使ってセットアップ・サービス起動を行います。

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
