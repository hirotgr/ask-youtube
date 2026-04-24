// Saves options to chrome.storage
function saveOptions() {
  const predefinedString = document.getElementById('predefinedString').value;
  const autoSubmit = document.getElementById('autoSubmit').checked;
  
  chrome.storage.local.set({
    predefinedString: predefinedString,
    autoSubmit: autoSubmit
  }, function() {
    // Update status to let user know options were saved.
    const status = document.getElementById('status');
    if (chrome.runtime.lastError) {
      status.textContent = 'エラー: ' + chrome.runtime.lastError.message;
      return;
    }

    status.textContent = '設定を保存しました。';
    setTimeout(function() {
      status.textContent = '';
    }, 3000);
  });
}

// Restores select box and checkbox state using the preferences
// stored in chrome.storage.
function restoreOptions() {
  // Use default value predefinedString = '動画を要約する' and autoSubmit = false.
  chrome.storage.local.get({
    predefinedString: '動画を要約する',
    autoSubmit: false
  }, function(items) {
    if (chrome.runtime.lastError) {
      console.warn('Failed to restore options:', chrome.runtime.lastError.message);
      return;
    }

    document.getElementById('predefinedString').value = items.predefinedString;
    document.getElementById('autoSubmit').checked = items.autoSubmit;
  });
}

document.addEventListener('DOMContentLoaded', restoreOptions);
document.getElementById('save').addEventListener('click', saveOptions);
