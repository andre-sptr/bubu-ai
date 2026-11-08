# P3 — WhatsApp Multimodal Intelligence

## Important provider constraint
The official Sumopod OpenAI-compatible API guide currently states that models exposed through its AI gateway generate text only. P3 therefore preserves the user's `sumopod_only` provider decision and performs media preprocessing locally on the Ubuntu VPS. Extracted OCR/transcripts are passed to the existing Sumopod text agent. This release does not claim native vision or audio reasoning through Sumopod.

## Features
- Image and screenshot OCR with Tesseract (`ind+eng`).
- Voice-note/audio transcription with local `whisper-cli` (whisper.cpp).
- Video processing with FFmpeg: sampled keyframes + OCR + optional audio transcription.
- Optional voice replies with Piper TTS, FFmpeg Opus conversion and WAHA `sendVoice`.
- Owner-only `/voice on`, `/voice off`, `/voice` preferences persisted in SQLite.
- Media size, audio duration, video duration and frame-count limits.
- Media downloads constrained to configured WAHA host; temporary source files are deleted after processing.

## Supported input
- Images: JPG/JPEG, PNG, WEBP, BMP, TIFF.
- Audio: OGG/OGA/OPUS, MP3, M4A, AAC, WAV, FLAC, AMR, audio WEBM.
- Video: MP4, MOV, MKV, AVI, video WEBM, 3GP.
- Existing P1 document support remains PDF, DOCX, XLSX, XLSM, CSV and TXT.

## Local dependencies
- FFmpeg: media conversion and video frame sampling.
- Tesseract OCR: image text extraction. Install Indonesian and English language packs.
- whisper.cpp `whisper-cli`: local speech recognition. A model file path is required.
- Piper: local speech synthesis. A compatible voice model file path is required.

These local tools are not AI API providers. Sumopod remains the only remote LLM provider.

## Ubuntu install outline

```bash
sudo apt update
sudo apt install -y ffmpeg tesseract-ocr tesseract-ocr-ind tesseract-ocr-eng cmake build-essential
```

Build whisper.cpp from its official repository, then download a multilingual `small` GGML model:

```bash
cd /opt
sudo git clone https://github.com/ggml-org/whisper.cpp.git
sudo chown -R "$USER":"$USER" /opt/whisper.cpp
cd /opt/whisper.cpp
cmake -B build
cmake --build build -j --config Release
sh ./models/download-ggml-model.sh small
```

Set `WHISPER_MODEL_PATH` to the downloaded model and `WHISPER_BIN` to `build/bin/whisper-cli`.

Install Piper in a dedicated Python virtual environment, then download a voice model and its matching `.onnx.json` file from the official voice catalog. Review the model license and confirm the voice supports Indonesian before enabling voice reply.

Check local binaries:

```bash
ffmpeg -version
tesseract --version
whisper-cli --help
piper --help
```

## Minimal P3 environment

```env
MEDIA_INTELLIGENCE_ENABLED=true
MAX_MEDIA_BYTES=26214400
MAX_AUDIO_SECONDS=900
MAX_VIDEO_SECONDS=180
MAX_VIDEO_FRAMES=8

TESSERACT_BIN=tesseract
FFMPEG_BIN=ffmpeg
WHISPER_BIN=whisper-cli
WHISPER_MODEL_PATH=/opt/whisper.cpp/models/ggml-small.bin
WHISPER_LANGUAGE=auto
PIPER_BIN=piper
PIPER_MODEL_PATH=/opt/piper/voices/id_ID-model.onnx
VOICE_REPLY_DEFAULT=false
```

`WHISPER_MODEL_PATH` and `PIPER_MODEL_PATH` may be left empty. Image OCR can still work if Tesseract is installed; audio transcription and voice reply will return clear setup instructions until their model files are configured.

## WhatsApp usage
- Send an image with a question/caption, or address Bubu in a group. Bubu normalizes the image to a bounded JPEG for Sumopod visual analysis (`claude-sonnet-5-5`) alongside supplemental Tesseract OCR, and falls back to labeled `[OCR_FALLBACK]` if visual processing is disabled or unavailable.
- Send a PTT voice note or ordinary audio file. Bubu normalizes audio to 16 kHz mono WAV, filters silence with Silero VAD (`WHISPER_VAD_MODEL_PATH`), and transcribes locally with `whisper-cli`. PTT transcripts act as current user voice instructions within chat permissions; ordinary audio is treated as untrusted attachment evidence.
- Send a short video with a caption/instruction. Bubu samples up to the configured number of timestamped frames (`Frame #k [t=MM:SS.s]`), sends bounded frame images to the vision model alongside per-frame OCR, and combines them with soundtrack transcription when speech is present.
- In DM or group (owner-only), `/voice on` enables voice-only replies (fail-closed if TTS fails), `/voice both` enables text + voice replies, `/voice off` sets text-only, `/voice status` reports the active mode, and `/voice reset` restores the configured default.

## Honest limitations
- Image processing in this release is OCR, not full scene understanding/object recognition.
- Video processing extracts frame text and speech; it does not understand motion, actions or visual relationships.
- Audio transcription requires a local Whisper model. Indonesian accuracy depends on model size and audio quality.
- Voice replies require a local Piper voice model. Voice quality/language depends on the selected voice.
- Scanned PDFs continue to use the P1 PDF parser; PDF page OCR is not yet added.
- Long audio/video is capped to protect VPS CPU, RAM and disk.
- Voice replies are optional and disabled by default.

## Database
P3 migration v7 adds `chat_preferences` for owner voice-reply preferences. P2 migration v6 is retained for episodic-memory idempotency. Existing messages, memories, projects, tasks and documents are retained.

Official local engines: whisper.cpp (https://github.com/ggml-org/whisper.cpp) and Piper (https://github.com/OHF-Voice/piper1-gpl).
