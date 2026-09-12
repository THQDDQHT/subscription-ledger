// 首帧前应用手动选择的深浅色；未选择时由 CSS 跟随系统。仅存偏好，不含任何账本数据。
(function(){try{var t=localStorage.getItem('ledger-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t;}catch(e){}})();
