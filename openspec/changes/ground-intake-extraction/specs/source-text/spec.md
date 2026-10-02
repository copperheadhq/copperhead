## ADDED Requirements

### Requirement: Text layer read first

The system SHALL read each selected page's text from the PDF's own text layer with pdf.js on the server before considering OCR. It SHALL group text items into lines by baseline, order each line by position, and join items separated by more than the cell gap with ` | `, so that a table row arrives as a pipe row. Each line SHALL carry a bounding box: the union of its items, normalised to 0..1 of the page.

#### Scenario: Born-digital datasheet page

- **WHEN** page 3 of the LM555 datasheet, which has a text layer, is selected
- **THEN** its lines are read from the text layer, no OCR job is created, and each line carries a bounding box on page 3

#### Scenario: Table row with columns

- **WHEN** a page holds an electrical characteristics row whose MIN, TYP and MAX cells are separated by wide gaps
- **THEN** the row is read as one line with its cells joined by ` | `, in the order of their columns

### Requirement: Usable text layer test

A page's text layer SHALL be usable when it has at least 200 characters, and fewer than 2 percent of them are the Unicode replacement character, private-use characters or control characters. A page whose text layer is not usable SHALL be read by OCR. The test SHALL be deterministic and use no model.

#### Scenario: Image-only page

- **WHEN** a selected page has no text layer
- **THEN** the page is sent to OCR and is marked as read by OCR

#### Scenario: Garbled text layer

- **WHEN** a page's text layer is mostly private-use characters from a font without a Unicode map
- **THEN** the page is not usable as text and is sent to OCR

### Requirement: OCR fallback and page marking

For a page read by OCR, the system SHALL convert the OCR output's tables to pipe rows, keep each region's bounding box, and treat the result as that page's lines. Every page SHALL record its text source, `pdf-text` or `ocr`, and the version of the reader that produced it: the pdf.js version and the row builder version, or the OCR provider, language and output format. A `forceOcr` option SHALL send every selected page to OCR, and its pages SHALL be marked as read by OCR.

#### Scenario: Marked text source

- **WHEN** a document has two selected pages, one with a usable text layer and one without
- **THEN** the first page is marked `pdf-text` and the second `ocr`, each with its reader version

#### Scenario: Forced OCR

- **WHEN** the 2N3055 datasheet is ingested with `forceOcr`
- **THEN** every selected page is read by OCR, even though the document has a text layer, and each is marked `ocr`

### Requirement: Evidence units minted by the core

The core SHALL mint one evidence unit for every line of every selected page. A unit SHALL have:

- an id of the form `ev-<first 8 hex digits of the document sha256>-p<page>-l<line>`
- its text
- its context: the table header row above it and any footnote it references
- its section, page and bounding box

Ids SHALL be deterministic for the same document, pages and reader version. No extractor SHALL mint or alter an evidence unit.

#### Scenario: Same document twice

- **WHEN** the same PDF and pages are read twice with the same reader version
- **THEN** both reads produce identical units with identical ids

#### Scenario: Footnote attached by reference

- **WHEN** a table row's cell carries the footnote marker (1) and the page has a footnote beginning "(1)"
- **THEN** the row's unit carries that footnote's text in its context
