# Third-party notices

The application uses kuromoji.js 0.1.2 for local Japanese tokenization and
phonetic validation. It is not a user-editable word registration service.

- kuromoji.js: Apache License 2.0. See [license](licenses/kuromoji-LICENSE-2.0.txt).
- Bundled mecab-ipadic dictionary: see the complete upstream
  [copyright and license notice](licenses/kuromoji-NOTICE.md).

Other npm dependencies retain their licenses in `node_modules` and their
upstream distributions. Nemotron, NeMo-Speech.cpp, Ollama, Gemma and the
optional Whisper runtime/models retain their separate upstream terms.

Optional v1.0 speech components are downloaded separately, not bundled here:

- [NeMo-Speech.cpp v0.2.0](https://github.com/NVIDIA/NeMo-Speech.cpp/tree/v0.2.0): Apache License 2.0; see its upstream LICENSE and dependency notices.
- [Nemotron-3-Diarization](https://huggingface.co/nvidia/Nemotron-3-Diarization): Open Model, Data & Weights License 1.1 (OpenMDW 1.1); review the model repository's license before downloading or redistributing weights.
- [Nemotron 3.5 ASR](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b): retain the model repository's license and notices.
- Optional vLLM images and selected LLM weights have their own terms. Gemma requires review of the [Gemma terms](https://ai.google.dev/gemma/terms); choosing a model in the deployment template does not bundle or grant access to its weights.
