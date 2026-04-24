(function() {
  'use strict';

  let backdrop = null;
  let panelObserver = null;
  let autoFillObserver = null;
  let autoFillObservedPanel = null;
  let autoFillItems = null;
  let currentPanel = null;
  let activeVideoId = '';
  let pendingAutoSubmit = null;
  let nextAutoSubmitRequestId = 1;
  let pendingSubmitFrame = 0;
  let isExtensionRunning = false;
  let isContextInvalidated = false;

  function isExtensionContextValid() {
    try {
      return Boolean(chrome && chrome.runtime && chrome.runtime.id);
    } catch (error) {
      return false;
    }
  }

  function getCurrentVideoId() {
    try {
      return new URLSearchParams(window.location.search).get('v') || '';
    } catch (error) {
      return '';
    }
  }

  function clearAutoFillObserver() {
    if (autoFillObserver) {
      autoFillObserver.disconnect();
      autoFillObserver = null;
      autoFillObservedPanel = null;
    }
  }

  function finishAutoFillObservation() {
    clearAutoFillObserver();
    autoFillItems = null;
  }

  function clearPendingSubmitFrame() {
    if (pendingSubmitFrame) {
      cancelAnimationFrame(pendingSubmitFrame);
      pendingSubmitFrame = 0;
    }
  }

  function clearAutoFillState() {
    clearPendingSubmitFrame();
    finishAutoFillObservation();
    pendingAutoSubmit = null;
  }

  function handleInvalidatedContext() {
    if (isContextInvalidated) return;
    isContextInvalidated = true;
    stopExtension();
    document.removeEventListener('yt-navigate-finish', navigateHandler);
  }

  function isSendButtonEnabled(button) {
    return Boolean(
      button &&
      !button.disabled &&
      button.getAttribute('aria-disabled') !== 'true' &&
      !button.classList.contains('ytSpecButtonShapeNextDisabled')
    );
  }

  function setInputValue(input, text) {
    // React/Polymerの内部状態を強制的に更新するためのハック
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
    if (nativeSetter && nativeSetter.set) {
      nativeSetter.set.call(input, text);
    } else {
      input.value = text;
    }

    const eventOptions = { bubbles: true, cancelable: true, composed: true };
    input.dispatchEvent(new Event('focus', eventOptions));
    input.dispatchEvent(new Event('input', eventOptions));
    input.dispatchEvent(new Event('change', eventOptions));
    input.dispatchEvent(new KeyboardEvent('keydown', { ...eventOptions, key: 'a' }));
    input.dispatchEvent(new KeyboardEvent('keyup', { ...eventOptions, key: 'a' }));
  }

  function focusInputEnd(input) {
    input.focus();
    if (typeof input.setSelectionRange === 'function') {
      const end = input.value.length;
      input.setSelectionRange(end, end);
    }
  }

  function getElementText(element) {
    return (element?.textContent || '').trim();
  }

  function isAskEntrypoint(element) {
    if (!element || typeof element.closest !== 'function') return false;

    const directButton = element.closest('.you-chat-entrypoint-button, button[aria-label="質問する"], button[aria-label="Ask"]');
    if (directButton) return true;

    const menuItem = element.closest('ytd-menu-service-item-renderer, tp-yt-paper-item, yt-list-item-view-model, a, button');
    if (!menuItem) return false;

    const ariaLabel = menuItem.getAttribute('aria-label') || '';
    const text = getElementText(menuItem);
    return ariaLabel === '質問する' || ariaLabel === 'Ask' || text === '質問する' || text === 'Ask';
  }

  function createPendingAutoSubmit(videoId) {
    pendingAutoSubmit = {
      requestId: nextAutoSubmitRequestId++,
      videoId: videoId
    };
  }

  function scheduleVisibleSubmit(requestId, videoId, sendBtn) {
    if (pendingSubmitFrame) return;

    const submitAfterPaint = () => {
      const secondFrame = requestAnimationFrame(() => {
        pendingSubmitFrame = 0;

        if (
          !pendingAutoSubmit ||
          pendingAutoSubmit.requestId !== requestId ||
          pendingAutoSubmit.videoId !== videoId ||
          getCurrentVideoId() !== videoId ||
          !isSendButtonEnabled(sendBtn)
        ) {
          return;
        }

        pendingAutoSubmit = null;
        finishAutoFillObservation();
        sendBtn.click();
      });
      // Keep the latest scheduled frame cancellable while still waiting two paints.
      pendingSubmitFrame = secondFrame;
    };

    pendingSubmitFrame = requestAnimationFrame(submitAfterPaint);
  }

  // ユーザーの明示的なクリック操作をトラッキングするハンドラー
  const clickHandler = (e) => {
    // クリックされた要素が「質問する」ボタン（またはその子要素）であるか確認
    const videoId = getCurrentVideoId();
    if (isAskEntrypoint(e.target) && videoId) {
      createPendingAutoSubmit(videoId);
      if (currentPanel && currentPanel.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED') {
        autoFillInput();
      }
    }
  };

  function createBackdrop(panel) {
    if (backdrop && !backdrop.isConnected) {
      backdrop = null;
    }

    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.className = 'yt-ask-modal-backdrop';

      // パネルの直前に挿入することで、同じZ-indexコンテキスト（階層）に配置する
      if (panel && panel.parentNode) {
        panel.parentNode.insertBefore(backdrop, panel);
      } else {
        document.body.appendChild(backdrop);
      }

      // Close the modal when clicking outside
      backdrop.addEventListener('click', () => {
        if (currentPanel) {
          // Find the close button inside the panel and click it
          const closeBtn = currentPanel.querySelector('#visibility-button button, #visibility-button yt-button-shape button');
          if (closeBtn) {
            closeBtn.click();
          }
        }
      });
    } else if (panel && panel.parentNode && backdrop.nextSibling !== panel) {
      // DOMツリーが再構築された場合に備えて位置を調整
      panel.parentNode.insertBefore(backdrop, panel);
    }

    return backdrop;
  }

  function handleVisibilityChange() {
    if (!currentPanel || !backdrop) return;

    const visibility = currentPanel.getAttribute('visibility');
    if (visibility === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED') {
      backdrop.classList.add('active');
      document.body.classList.add('yt-ask-modal-open');

      // テキストエリアにフォーカスし、空ならテキストを自動入力する
      autoFillInput();
    } else {
      clearAutoFillState();
      backdrop.classList.remove('active');
      document.body.classList.remove('yt-ask-modal-open');
    }
  }

  function ensureAutoFillObserver() {
    if (!currentPanel || autoFillObservedPanel === currentPanel) return;

    clearAutoFillObserver();
    autoFillObservedPanel = currentPanel;
    autoFillObserver = new MutationObserver(() => {
      if (!isExtensionContextValid()) {
        handleInvalidatedContext();
        return;
      }
      processAutoFill();
    });

    autoFillObserver.observe(currentPanel, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled', 'aria-disabled', 'class', 'visibility']
    });
  }

  function autoFillInput() {
    if (!isExtensionContextValid()) {
      handleInvalidatedContext();
      return;
    }

    // 拡張機能の動作を動画ページ(/watch)に限定し、それ以外での誤作動を防ぐ
    if (!window.location.pathname.startsWith('/watch')) return;

    // オプション画面で設定された値を読み込む
    try {
      chrome.storage.local.get({
        predefinedString: '動画を要約する',
        autoSubmit: false
      }, function(items) {
        if (!isExtensionContextValid()) {
          handleInvalidatedContext();
          return;
        }

        autoFillItems = items;
        ensureAutoFillObserver();
        processAutoFill();
      });
    } catch (error) {
      handleInvalidatedContext();
    }
  }

  function processAutoFill() {
    if (!autoFillItems || !currentPanel) return;

    if (!isExtensionContextValid()) {
      handleInvalidatedContext();
      return;
    }

    const currentVideoId = getCurrentVideoId();
    if (!window.location.pathname.startsWith('/watch') || !currentVideoId) {
      clearAutoFillState();
      return;
    }

    if (pendingAutoSubmit && pendingAutoSubmit.videoId !== currentVideoId) {
      clearAutoFillState();
      return;
    }

    if (currentPanel.getAttribute('visibility') !== 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED') {
      clearAutoFillState();
      return;
    }

    // テキストエリアを探す (完全に厳格なセレクタ)
    const input = currentPanel.querySelector('form.chatInputViewModelChatInputForm textarea.chatInputViewModelChatInput');
    if (!input) return;

    const text = autoFillItems.predefinedString || '';
    if (!text) {
      clearAutoFillState();
      return;
    }

    if (!input.value) {
      setInputValue(input, text);
    }

    focusInputEnd(input);

    if (input.value !== text) {
      clearAutoFillState();
      return;
    }

    if (!autoFillItems.autoSubmit) {
      clearAutoFillState();
      return;
    }

    if (!pendingAutoSubmit || pendingAutoSubmit.videoId !== currentVideoId) {
      finishAutoFillObservation();
      return;
    }

    const sendBtn = currentPanel.querySelector('form.chatInputViewModelChatInputForm button');
    if (!isSendButtonEnabled(sendBtn)) return;

    scheduleVisibleSubmit(pendingAutoSubmit.requestId, currentVideoId, sendBtn);
  }

  function setupPanelObserver(panel) {
    if (panelObserver) {
      panelObserver.disconnect();
    }

    currentPanel = panel;
    createBackdrop(panel);

    // Check initial state
    handleVisibilityChange();

    // Observe attribute changes on the panel
    panelObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.attributeName === 'visibility') {
          handleVisibilityChange();
        }
      }
    });

    panelObserver.observe(panel, { attributes: true, attributeFilter: ['visibility'] });
  }

  function resetPanelState() {
    clearAutoFillState();
    if (panelObserver) {
      panelObserver.disconnect();
      panelObserver = null;
    }
    currentPanel = null;
  }

  function findAndObservePanel() {
    const panel = document.querySelector('ytd-engagement-panel-section-list-renderer[target-id="PAyouchat"]');
    if (panel && panel !== currentPanel) {
      setupPanelObserver(panel);
    }
  }

  // Use a global observer to wait for the panel to be added to the DOM
  const globalObserver = new MutationObserver(() => {
    findAndObservePanel();
  });

  // 対象ページでのみ拡張機能を有効化する処理
  function startExtension() {
    if (isContextInvalidated || !isExtensionContextValid()) {
      handleInvalidatedContext();
      return;
    }
    if (!window.location.pathname.startsWith('/watch')) return;

    activeVideoId = getCurrentVideoId();
    if (isExtensionRunning) {
      findAndObservePanel();
      return;
    }

    isExtensionRunning = true;
    document.addEventListener('click', clickHandler, true);
    globalObserver.observe(document.body, { childList: true, subtree: true });
    findAndObservePanel();
  }

  // 対象外ページで拡張機能を完全に無効化する処理（不要なDOM監視などを防ぐ）
  function stopExtension() {
    clearAutoFillState();
    if (!isExtensionRunning) return;

    isExtensionRunning = false;
    activeVideoId = '';
    document.removeEventListener('click', clickHandler, true);
    globalObserver.disconnect();
    if (panelObserver) {
      panelObserver.disconnect();
      panelObserver = null;
    }

    // UIの後始末
    if (backdrop) {
      backdrop.remove();
      backdrop = null;
    }
    document.body.classList.remove('yt-ask-modal-open');
    currentPanel = null;
  }

  // YouTubeのSPA画面遷移完了イベントを監視して動的にオン/オフを切り替え
  function navigateHandler() {
    if (isContextInvalidated || !isExtensionContextValid()) {
      handleInvalidatedContext();
      return;
    }

    if (!window.location.pathname.startsWith('/watch')) {
      stopExtension();
      return;
    }

    const nextVideoId = getCurrentVideoId();
    // 初回ロードでは activeVideoId が空なので、startExtension() 側で初期化する。
    if (activeVideoId && nextVideoId && activeVideoId !== nextVideoId) {
      resetPanelState();
    }

    startExtension();
  }

  document.addEventListener('yt-navigate-finish', navigateHandler);

  // 初回読み込み時の起動チェック
  if (isExtensionContextValid() && window.location.pathname.startsWith('/watch')) {
    startExtension();
  }

})();
