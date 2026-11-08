# P1 — Advanced Agent Tools

## Included
1. Web research:
   - `web_search` via Tavily Search API (optional API key).
   - `web_fetch` for readable public HTTP/HTTPS pages.
   - Search results retain title, URL, snippet and publication date when supplied.
2. Document intelligence:
   - Incoming WhatsApp PDF, DOCX, XLSX, XLSM, CSV and TXT attachments.
   - Extraction and private workspace storage.
   - `list_documents`, `read_document`, `search_document`, `analyze_spreadsheet`.
3. Document generation:
   - `list_document_templates` lists supported document and spreadsheet variations.
   - `create_document` generates professionally formatted DOCX files for proposals, business plans, reports, SOPs, meeting minutes, memos, formal letters, invoices, quotations, project plans and executive summaries.
   - `create_spreadsheet` generates XLSX workbooks for finance, budgets, cash flow, inventory, sales, project tracking, KPI, HR and custom data.
   - XLSX supports up to 12 worksheets, formulas, number formats, frozen rows and filters.
   - Generated files are saved in the current workspace. Personal DM file sending retains owner approval; group delivery is handled separately by the group file-delivery task.
4. Task management:
   - `create_task`, `list_tasks`, `update_task`, `complete_task`.
   - Tasks are scoped to personal owner or current group.
5. Reminder management:
   - `list_reminders`, `cancel_reminder` for the owner in the current DM.

## Minimal configuration
The only new optional environment variable is:
```env
TAVILY_API_KEY=
```
Without this key, `web_search` is not registered. `web_fetch`, document tools, task management, and reminder management remain available. Sumopod remains the only LLM provider.

## WAHA media prerequisites
WAHA must download incoming media (`WAHA_EVENTS_DOWNLOAD_MEDIA=true` if media download was disabled) and include `payload.media.url`, `payload.media.mimetype`, and ideally `payload.media.filename` in its `message` webhook. See WAHA receive messages documentation. Bubu downloads the file from the configured WAHA host, checks extension/MIME and size, extracts text, stores the original under `STORAGE_DIR`, and stores extracted text in SQLite.

Supported formats: PDF, DOCX, XLSX, XLSM, CSV, TXT. Scanned/image-only PDFs are not OCR'd in P1 and will return an extraction notice.

## Security
- Documents are scoped to personal owner or one group chat.
- Web page and document content are treated as untrusted data in the agent prompt.
- `web_fetch` rejects localhost/private IPs, credentials in URLs, unsupported schemes, non-HTML/plain-text responses and oversized responses.
- WAHA media download is constrained to the configured WAHA host.
- Upload size is capped by `MAX_DOCUMENT_BYTES` (default 15 MB).
- Generated file send is an external action. Personal DM delivery requires owner approval; group file delivery follows the dedicated group delivery policy.
- Generated documents are recorded in the current personal/group document workspace and the stored file path can only be retrieved within that same scope.
- Document files are stored outside the public web root with restrictive permissions.

## Task model
User tasks are separate from internal agent execution tasks. Fields include title, description, status, priority and optional due date. Personal tasks are only visible to the owner; group tasks are only visible within their originating group.

## Notes and limitations
- Tavily is an external search provider; it is not an LLM provider. Sumopod remains the only model provider.
- `web_search` requires a Tavily API key. Obtain one from https://tavily.com/.
- Web fetch is a lightweight HTML text extractor, not a full browser or JavaScript renderer.
- XLSX/CSV analysis is text extraction plus model reasoning; it does not execute spreadsheet formulas.
- OCR, images, audio, PPTX, XLS and PDF generation are not part of P1.
- DOCX generation supports structured Markdown headings, lists, quotes and pipe tables; it does not yet support embedded images or complex page-layout design.
- XLSX formulas are stored as Excel formulas and recalculated by spreadsheet software when opened; Bubu does not execute Excel formulas on the server.
- Document retention/automatic cleanup policy should be configured before long-term high-volume use.
- File sending uses WAHA `POST /api/sendFile` with base64 file data.
