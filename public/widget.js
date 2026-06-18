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
      border: 2px solid transparent;
      background: linear-gradient(#0c1318, #0c1318) padding-box, linear-gradient(135deg, #486c7c, #6b96a8, #5c5c5c) border-box;
      box-shadow: 0 4px 20px rgba(0,0,0,0.4), 0 0 18px rgba(72,108,124,0.5);
      cursor: pointer; display: flex; align-items: center; justify-content: center;
      transition: transform 0.2s ease;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    #vyz-widget-launcher:hover { transform: scale(1.06); }
    #vyz-widget-launcher .vyz-letter {
      width: 100%; height: 100%; border-radius: 50%;
      background: linear-gradient(135deg,#486c7c,#344e58);
      display: flex; align-items: center; justify-content: center;
      font-size: 22px; font-weight: 700; color: white;
    }
    #vyz-widget-launcher .vyz-dot {
      position: absolute; top: -2px; right: -2px;
      width: 14px; height: 14px; border-radius: 50%;
      background: #25D366; border: 2px solid #1a0000;
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
  launcher.innerHTML = '<div class="vyz-letter">R</div><div class="vyz-dot"></div>';

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
