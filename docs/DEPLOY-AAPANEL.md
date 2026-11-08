# Deploy Bubu v2 P0 on Ubuntu + aaPanel

## Recommended layout

```text
/www/wwwroot/bubu/
  app/       # application source
  data/      # SQLite database (persistent)
  logs/      # PM2 logs
  backups/   # SQLite backups
```

Use a dedicated Linux user if your aaPanel setup permits it. Keep `.env` outside public web roots or set restrictive permissions (`chmod 600 .env`). Do not expose SQLite files, logs, or media through a public website.

## Prerequisites

- Ubuntu VPS.
- Node.js 22 LTS.
- WAHA running separately (Docker is recommended).
- aaPanel Node.js Project Manager or PM2 available from the shell.
- Network access from Bubu to WAHA and Sumopod.

Install build tools if better-sqlite3 needs native compilation:

```bash
sudo apt update
sudo apt install -y build-essential python3
```

## Install

```bash
mkdir -p /www/wwwroot/bubu/app /www/wwwroot/bubu/data /www/wwwroot/bubu/logs /www/wwwroot/bubu/backups
cd /www/wwwroot/bubu/app
# Upload and extract the Bubu-V2-P0 archive here.
cp .env.example .env
chmod 600 .env
npm install --omit=dev
```

Edit `.env` and set:
- `OWNER_JID` to the owner's canonical WhatsApp phone JID (`628...@c.us`).
- `WAHA_BASE_URL` to an address reachable from the Bubu Node.js process.
- `WAHA_SESSION` to the actual WAHA session.
- `WAHA_API_KEY` if configured.
- `WAHA_WEBHOOK_TOKEN` to a long random secret.
- `SUMOPOD_API_KEY`.
- Keep `DATABASE_PATH=../data/bubu.sqlite` and `BACKUP_DIR=../backups` for the recommended directory layout.
- Optional model overrides only if you want to change benchmark-informed defaults.

The model defaults are already configured in `src/config/env.js`. To inspect the Sumopod catalog:

```bash
npm run models
```

No per-model capability flags or additional validation commands are required.

## Run tests and start

```bash
npm test
npm start
```

Health checks:
- `GET http://127.0.0.1:3088/health`
- `GET http://127.0.0.1:3088/ready`

## PM2

Adjust `ecosystem.config.cjs` `cwd` if your application path differs, then:

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

Use aaPanel's Node.js Project Manager instead if you prefer GUI process management. Do not run the same app simultaneously in aaPanel and PM2.

## WAHA webhook

Configure the WAHA session webhook to:
`http://<BUBU_HOST>:3088/webhook`

Ensure the request includes header:
`x-webhook-token: <same value as WAHA_WEBHOOK_TOKEN>`

If WAHA is in Docker and Bubu runs directly on the host, `127.0.0.1` inside the WAHA container refers to the container itself, not the VPS host. Use a Docker host-gateway address or a shared Docker network, and bind Bubu to a reachable interface. Restrict the Bubu port with the Ubuntu/Tencent firewall to only trusted sources. Alternatively, put the webhook behind a reverse proxy that can add/forward the secret header.

## Backup

Use the supplied backup script. It backs up SQLite and the document storage directory:

```bash
npm run backup
```

Schedule it daily through aaPanel Cron. It uses SQLite's online backup API. Do not copy only the main `.sqlite` file while WAL writes are active.

## Operations

- Restart: `pm2 restart bubu-v2`
- Logs: `pm2 logs bubu-v2`
- Status: `pm2 status`
- Stop: `pm2 stop bubu-v2`

Never paste `.env`, WAHA API keys, or Sumopod API keys into chat or logs.


## P1 document and web tools
- Create `STORAGE_DIR` outside any public website root (recommended `../storage`).
- Ensure the Bubu service user can write to `STORAGE_DIR`.
- In WAHA, subscribe to the `message` webhook event and ensure incoming media is downloaded (`WAHA_EVENTS_DOWNLOAD_MEDIA=true` if you have disabled the default). Bubu expects `payload.media.url`; it downloads the file from the configured WAHA host using the WAHA API key.
- If you want web search, create a Tavily API key and set `TAVILY_API_KEY`. Without it, `web_search` is disabled; `web_fetch` remains available.
- P1 dependencies are installed through `npm install`; no separate Python service is required.
- Generated DOCX/XLSX files are sent only after `/approve <id>` from the owner DM.


## P3 local multimodal dependencies
P3 does not add a second AI provider. Sumopod remains the only remote LLM provider. The VPS performs OCR/STT/TTS preprocessing locally.

Install the system packages:

```bash
sudo apt update
sudo apt install -y ffmpeg tesseract-ocr tesseract-ocr-ind tesseract-ocr-eng cmake build-essential
```

`ffmpeg` installs both `ffmpeg` and `ffprobe`. `tesseract-ocr-ind` and `tesseract-ocr-eng` provide the OCR language packs.

Build whisper.cpp (official instructions: https://github.com/ggml-org/whisper.cpp):

```bash
cd /opt
sudo git clone https://github.com/ggml-org/whisper.cpp.git
sudo chown -R "$USER":"$USER" /opt/whisper.cpp
cd /opt/whisper.cpp
cmake -B build
cmake --build build -j --config Release
sh ./models/download-ggml-model.sh small
```

Set the P3 environment:

```env
WHISPER_BIN=/opt/whisper.cpp/build/bin/whisper-cli
WHISPER_MODEL_PATH=/opt/whisper.cpp/models/ggml-small.bin
WHISPER_LANGUAGE=auto
```

Install Piper in a dedicated virtual environment (official project docs: https://github.com/OHF-Voice/piper1-gpl):

```bash
python3 -m venv /opt/piper-venv
/opt/piper-venv/bin/pip install --upgrade pip
/opt/piper-venv/bin/pip install piper-tts
```

Download a Piper voice model and its matching `.onnx.json` configuration file from the official voice catalog. Review its license and verify that it supports Indonesian before using it for Indonesian voice replies.

```env
PIPER_BIN=/opt/piper-venv/bin/piper
PIPER_MODEL_PATH=/opt/piper-voices/your-voice.onnx
```

Check binaries and model paths:

```bash
ffmpeg -version
ffprobe -version
tesseract --list-langs
/opt/whisper.cpp/build/bin/whisper-cli --help
/opt/piper-venv/bin/piper --help
```

After editing `.env`, restart Bubu. Voice replies remain disabled until `/voice on` is sent by the owner in private DM. If no Piper model is configured, `/voice on` explains what is missing.

The `storage` directory must be outside the public web root and writable by the Bubu service account. Incoming P3 media is deleted after extraction; temporary processing files are also removed.
