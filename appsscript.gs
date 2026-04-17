// ─────────────────────────────────────────────────────────────────
// VERA Image Rater — Google Apps Script backend
// Paste this entire file into the Apps Script editor, then Deploy.
// ─────────────────────────────────────────────────────────────────

function doPost(e) {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();

    // Write header row if the sheet is empty
    if (sheet.getLastRow() === 0) {
      sheet.appendRow([
        'filename', 'rater', 'overall',
        'pleasantness', 'ai_obvious', 'weirdness',
        'comment', 'timestamp'
      ]);
      // Bold the header row
      sheet.getRange(1, 1, 1, 8).setFontWeight('bold');
    }

    // Parse the incoming JSON
    const data = JSON.parse(e.postData.contents);

    sheet.appendRow([
      data.filename    || '',
      data.rater       || '',
      data.overall     || '',
      data.pleasantness !== '' ? Number(data.pleasantness) : '',
      data.ai_obvious   !== '' ? Number(data.ai_obvious)   : '',
      data.weirdness    !== '' ? Number(data.weirdness)     : '',
      data.comment     || '',
      data.timestamp   || new Date().toISOString()
    ]);

    return ContentService
      .createTextOutput(JSON.stringify({ status: 'ok' }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch(err) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: 'error', message: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// Optional: run this once manually to test that the sheet is reachable
function testSetup() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  Logger.log('Sheet name: ' + sheet.getName());
  Logger.log('Last row: ' + sheet.getLastRow());
  Logger.log('Setup OK');
}
