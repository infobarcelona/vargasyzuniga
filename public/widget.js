(function () {
  // Detecta automaticamente desde donde se cargo este script para saber
  // a que dominio apuntar el chat (funciona sin configuracion adicional
  // siempre que el <script> se cargue directamente desde el dominio del bot).
  var currentScript = document.currentScript || (function () {
    var scripts = document.getElementsByTagName('script');
    return scripts[scripts.length - 1];
  })();
  var origin = currentScript.dataset.botUrl || new URL(currentScript.src).origin;

  var styleTag = document.createElement('style');
  styleTag.textContent = `
    #vyz-widget-launcher {
      position: fixed; bottom: 20px; right: 20px; z-index: 999999;
      width: 60px; height: 60px; border-radius: 50%;
      background: #344e58;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
      cursor: pointer; display: flex; align-items: center; justify-content: center;
      transition: transform 0.2s ease;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    #vyz-widget-launcher:hover { transform: scale(1.06); }
    #vyz-widget-launcher::before {
      content: ''; position: absolute; inset: -8px; border-radius: 50%;
      background: #344e58; opacity: 0.35; z-index: -1;
      animation: vyz-breathe 2.4s ease-out infinite;
    }
    @keyframes vyz-breathe {
      0%   { transform: scale(0.85); opacity: 0.4; }
      70%  { transform: scale(1.35); opacity: 0; }
      100% { transform: scale(1.35); opacity: 0; }
    }
    #vyz-widget-launcher .vyz-icon { width: 26px; height: 26px; }
    #vyz-widget-launcher .vyz-dot {
      position: absolute; top: -2px; right: -2px;
      width: 14px; height: 14px; border-radius: 50%;
      background: #25D366;
      animation: vyz-pulse 2s ease-in-out infinite;
    }
    @keyframes vyz-pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }

    #vyz-widget-panel {
      position: fixed; bottom: 92px; right: 20px; z-index: 999998;
      width: 380px; height: 600px; max-height: 80vh;
      border-radius: 18px; overflow: hidden;
      box-shadow: 0 10px 40px rgba(0,0,0,0.5);
      border: 1px solid rgba(72,108,124,0.3);
      display: none; flex-direction: column;
      background: #0c1318;
    }
    #vyz-widget-panel.vyz-open { display: flex; }
    #vyz-widget-panel iframe { width: 100%; height: 100%; border: none; }

    #vyz-widget-close {
      position: absolute; top: 8px; right: 8px; z-index: 2;
      width: 26px; height: 26px; border-radius: 50%;
      background: rgba(0,0,0,0.5); border: none; color: #fff;
      font-size: 14px; line-height: 1; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
    }

    @media (max-width: 480px) {
      #vyz-widget-panel {
        bottom: 0; right: 0; left: 0; top: 0;
        width: 100%; height: 100%; max-height: 100%;
        border-radius: 0;
      }
      #vyz-widget-launcher { bottom: 16px; right: 16px; }
    }
  `;
  document.head.appendChild(styleTag);

  var launcher = document.createElement('div');
  launcher.id = 'vyz-widget-launcher';
  launcher.innerHTML =
    '<svg class="vyz-icon" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>' +
    '</svg>' +
    '<div class="vyz-dot"></div>';

  var panel = document.createElement('div');
  panel.id = 'vyz-widget-panel';
  panel.innerHTML =
    '<button id="vyz-widget-close" aria-label="Cerrar">✕</button>' +
    '<iframe src="' + origin + '/" title="Chat Vargas y Zuñiga Abogados"></iframe>';

  document.body.appendChild(panel);
  document.body.appendChild(launcher);

  function toggle() {
    panel.classList.toggle('vyz-open');
  }

  launcher.addEventListener('click', toggle);
  document.getElementById('vyz-widget-close').addEventListener('click', toggle);
})();
