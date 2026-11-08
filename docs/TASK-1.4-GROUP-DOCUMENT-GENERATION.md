# Task 1.4 — Group document generation

## Supported DOCX document types

`business_proposal`, `business_plan`, `project_proposal`, `report`, `financial_report`, `market_research`, `sop`, `work_instruction`, `meeting_minutes`, `memo`, `formal_letter`, `invoice`, `quotation`, `project_plan`, `executive_summary`, `general`.

DOCX generation supports title/subtitle, document type label, heading levels, bullet and numbered lists, quote paragraphs, horizontal dividers, Markdown pipe tables, header/footer, page number and document metadata.

## Supported XLSX workbook types

The model can generate finance/budget/cash-flow/P&L, inventory/stock opname, sales reports, project trackers, KPI dashboards, HR attendance/leave/payroll worksheets, customer databases and custom workbooks.

XLSX supports up to 12 worksheets and 5,000 total rows including headers, formulas by cell address, column number formats, frozen rows, auto-filters, styled headers and automatic column widths. KPI dashboards are currently worksheet-based (tables and formulas); embedded Excel charts are not included yet.

Formula safeguards reject HYPERLINK, WEBSERVICE, RTD, DDE, CALL, REGISTER.ID, EXEC, external workbook references and common DDE command patterns. Formulas are stored as formulas and are not evaluated by Bubu on the server.

## Group behavior

- `create_document` and `create_spreadsheet` are now available in `personal` and `group` scopes.
- Group-generated files are stored as document records in the originating group workspace. The file path is retrievable only with a matching scope and group ID.
- Group generation returns `deliveryStatus=ready_for_group_delivery`. It does not send the file yet; automatic group delivery is Task 1.5.
- Personal generation retains the existing owner approval flow before sending.
- Group-generated documents are not stored in the owner's personal document workspace.
- File size is limited by `MAX_DOCUMENT_BYTES` (default 15 MB).

## Tool catalogue

`list_document_templates` lets the agent list available DOCX and XLSX variations when asked what Bubu can create.

## Deployment

Apply the Task 1.4 files over the Task 1.3 deployment. No database migration or new dependency is required. Existing `docx` and `exceljs` dependencies are used.

## Acceptance tests

1. In a group, ask Bubu to create an SOP DOCX. Verify it is saved in the group document scope and reports ready for group delivery.
2. In a group, ask Bubu to create a multi-sheet financial XLSX with formulas. Verify the workbook generation tool receives all sheets/formulas and is stored in group scope.
3. Verify generated group files are not visible from another group's document scope or the owner's personal scope.
4. In a personal DM, create a DOCX and confirm the previous owner approval flow still runs.
5. Ask what document types Bubu supports; verify `list_document_templates` is available and returns the catalogue.
6. Verify oversized generated files are rejected.
7. Open generated DOCX in Microsoft Word or LibreOffice; inspect headings, tables, page number and layout.
8. Open generated XLSX in Microsoft Excel or LibreOffice; inspect worksheets, formulas, number formats, frozen rows and filters.
9. Confirm no group file is automatically delivered in this task; that is intentionally Task 1.5.

## Not included

Automatic group file delivery, delivery retry/idempotency and delivery status are Task 1.5.
