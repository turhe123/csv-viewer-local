# Large CSV Viewer and Search — specification

**Tagline:** Open big CSV files in your browser, sort, filter and search rows quickly, with nothing uploaded.

**Category:** Data & Files

**Free alternative to:** ConvertCSV Viewer and Datablist online CSV viewers (upload or account needed, free row limits of a few thousand rows, ads, Excel struggles with large CSV files)

**Search phrases:** csv viewer online, open large csv file, csv file reader, view csv without excel, csv viewer with search and filter, open csv more than 1 million rows

**Allowed libraries:** papaparse

**Published at:** https://turhe123.github.io/csv-viewer-local/

## Acceptance checks (each must have a test)

- dropping sample-orders.csv shows a table with the header row and a row count
- clicking a column header sorts the rows and clicking again reverses the order
- typing in the search box filters to matching rows and shows the match count
- the delimiter is detected automatically for a semicolon file
- scrolling a 100,000 row sample stays responsive because rows are virtualised
- works at 390px wide

## Spec

Search demand: csv viewer online, open large csv file and csv file reader are frequent searches by people who receive exports and just want to look at them, search them or sort them without a spreadsheet. Excel silently mangles IDs and dates and caps at 1,048,576 rows web viewers often upload the file, impose small free row limits, or ask for an account to filter and sort. Data exports from banks, shops and CRMs are sensitive, so uploading is a poor option.

Our version does one job: view and explore a CSV or TSV file locally. Features: open by drop or file picker, automatic delimiter and header detection with override, a virtualised table that renders only visible rows so hundreds of thousands of rows scroll smoothly, click-to-sort per column with numeric, text and date aware comparison, a global search box that highlights matches, per column filters (contains, equals, empty) added through a small filter row, column hiding, a freeze header, row numbers, copy of a selected cell or row, and a statistics line with row count, column count and file size. A column details popover shows distinct count, empty count and min and max. Export of the current filtered and sorted view to CSV is included, but no editing.

UI: a drop zone first after loading it becomes a compact toolbar with file name, delimiter selector, header toggle and search box, and the table occupies the rest of the screen with a sticky header. Cell click selects, and a detail drawer shows the full row as key and value pairs, which is the friendliest way to read wide files on a phone. Empty state mentions privacy. Error state explains if the file looks binary or an encoding problem occurred. Keyboard: slash focuses search, arrow keys move selection, Escape clears the search, and Control or Command plus C copies the selected cell.

Technical approach: read the file with the File API and parse in a Web Worker using the allowed papaparse library in chunk mode to avoid freezing, appending rows to a typed index structure. Keep rows as arrays of strings in memory for sorting create an index array of row positions and sort by comparing parsed keys cached per column, so the underlying data is not moved. Filtering produces a new index array. Virtual scrolling uses a tall spacer element and renders around 60 row elements positioned by transform, recomputed on scroll. Search uses lowercase comparison with a debounce of 150 milliseconds and escapes highlighted text through textContent. Export builds the CSV with papaparse unparse and a Blob download. Encoding is detected by trying UTF-8 strictly and falling back to Windows-1252.

Edge cases: files above 300 MB may exhaust memory on phones, so warn early and offer a preview of the first 100,000 rows quoted line breaks inside cells are handled by the parser ragged rows are padded byte order marks are stripped extremely wide files get horizontal scrolling and a column picker dates are compared as text unless detected as ISO numbers with comma decimals are handled by a locale toggle mobile Safari scroll performance relies on transform positioning.

Demo data: a generated fictional CSV of fifty thousand orders from a made up store called North Pier Supply with columns order_id, date, customer, city, item, qty and total, including a few empty cells and a customer name with an accent.
