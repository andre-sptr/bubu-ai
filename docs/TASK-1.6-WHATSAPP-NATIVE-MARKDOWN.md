# Task 1.6 — WhatsApp Native Markdown Formatter

## Scope

Convert model-generated Markdown into WhatsApp-readable text immediately before WAHA text delivery. The formatter is used by the main Agent response path (text-only and text+voice modes) and the AI-generated conversation summary command.

The original Agent response remains unchanged in conversation history and is passed unchanged to TTS. Only the text sent to WhatsApp is formatted.

## Supported conversions

- Markdown headings (`#` through `######`) become WhatsApp bold headings.
- Markdown bold (`**text**`, `__text__`) becomes WhatsApp `*text*`.
- Markdown italic (`*text*`) becomes WhatsApp `_text_`.
- Underscore italic (`_text_`) is preserved.
- Markdown strikethrough (`~~text~~`) becomes WhatsApp `~text~`.
- Unordered lists (`-`, `+`, `*`) become `•` bullets.
- Ordered lists are normalized to `1.`, `2.`, etc.
- Markdown pipe tables become numbered records with bold field labels for mobile readability.
- Markdown links become `label: URL`; the actual URL remains visible and copyable.
- Blockquotes retain WhatsApp `>` quote prefix.
- Horizontal rules become a plain Unicode divider.
- Fenced code blocks become WhatsApp triple-backtick blocks with language hint removed; code content is protected from Markdown conversion.
- Inline code is preserved.
- Emoji, plain URLs, and normal line breaks are preserved; excessive blank lines are collapsed.

A standalone single-star line such as `*Konfirmasi pengiriman file Bubu*` is preserved as existing WhatsApp bold, so approval prompts are not accidentally converted to italics.

## Deliberate limitations

- WhatsApp does not render Markdown tables, heading sizes, syntax highlighting, or HTML layout. Tables are therefore converted into readable records rather than aligned columns.
- Complex nested Markdown, embedded HTML/CSS, footnotes, mathematical layout and embedded images are not fully supported.
- Single-star emphasis is inherently ambiguous between Markdown italic and WhatsApp bold. Inline single-star spans are treated as Markdown italic; a standalone single-star line is preserved as WhatsApp bold.
- No document content, DOCX/XLSX generation, code file content or stored conversation history is modified by this formatter.

## Deployment

Apply the Task 1.6 ZIP over the current Task 1.5 deployment, including all previously deployed hotfixes. Preserve `.env`, SQLite, storage and PM2 configuration. No new dependency, database migration, or port change is required.

## Acceptance tests

1. Send a response containing Markdown headings and bold; verify WhatsApp displays native bold.
2. Test italic and strikethrough.
3. Test unordered and ordered lists.
4. Test a Markdown pipe table; verify it becomes numbered labeled records.
5. Test Markdown links; verify the actual URL is retained.
6. Test fenced and inline code; verify code content is not altered.
7. Test an approval prompt; verify standalone WhatsApp bold remains bold and approval commands remain intact.
8. Test text-only mode; verify formatted text is sent.
9. Test both mode; verify formatted text is sent and TTS receives the original unformatted response.
10. Test voice-only; verify no text is sent.
11. Test `/summary`; verify its AI-generated output is formatted.
12. Verify DOCX/XLSX file contents and delivery are unaffected.
